// One UART owner, several independent clients. This engine runs in one task.
#pragma once
#include "client_limits.hpp"
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace bridge {
constexpr size_t MAX_TEXT = 78, MAX_QUEUE = 32;
struct Event {
  std::string type;
  uint32_t session = 0,
           id = 0; // session=0 broadcasts; ACKs always name an owner.
  std::string text = "";
  int line = -1;
  uint32_t origin = 0;
};
struct Command {
  enum class Control { None, PauseDrain, PauseHold, SdStop, SdDrain, Resume };
  uint32_t session = 0, id = 0;
  std::string text, wire;
  int line = -1, retries = 0;
  bool internal = false, urgent = false, job = false;
  uint64_t batch = 0;
  bool batch_end = false;
  Control control = Control::None;
};
struct Job {
  uint32_t owner = 0, total = 0, acknowledged = 0;
  double size = 0;
  std::string name, state = "idle", error;
  bool active() const {
    return state == "starting" || state == "printing" ||
           state == "pause-requested" || state == "waiting-for-motion-finish" ||
           state == "paused" || state == "resuming" || state == "cancelling" ||
           state == "finalizing";
  }
};
inline bool code(const std::string &s, const char *word) {
  size_t i = 0;
  for (; word[i]; ++i)
    if (i >= s.size() ||
        std::toupper(static_cast<unsigned char>(s[i])) != word[i])
      return false;
  return i == s.size() || !std::isdigit(static_cast<unsigned char>(s[i]));
}
inline bool ok(const std::string &s) {
  return s == "ok" || s.rfind("ok ", 0) == 0 || s.rfind("ok\t", 0) == 0;
}
inline bool movement(const Command &c) {
  if (c.text.empty() ||
      std::toupper(static_cast<unsigned char>(c.text[0])) != 'G')
    return false;
  const int n = std::atoi(c.text.c_str() + 1);
  return n <= 5 || n == 28 || n == 29 || n == 30 || n == 31;
}
inline std::string numbered(int n, const std::string &text) {
  const std::string body = "N" + std::to_string(n) + " " + text;
  unsigned char sum = 0;
  for (unsigned char c : body)
    sum ^= c;
  return body + "*" + std::to_string(sum);
}
class Core {
public:
  using Emit = std::function<void(const Event &)>;
  using Write = std::function<bool(const std::string &)>;
  Core(Emit emit, Write write)
      : emit_(std::move(emit)), write_(std::move(write)) {}
  bool ready() const { return stage_ == Stage::Ready; }
  bool paused() const { return paused_ || sd_paused_; }
  const char *pausePhase() const {
    switch (pause_stage_) {
    case PauseStage::Requested:
      return "pause-requested";
    case PauseStage::Draining:
      return "waiting-for-motion-finish";
    case PauseStage::Held:
      return "paused";
    case PauseStage::Resuming:
      return "resuming";
    default:
      return "running";
    }
  }
  bool emergency() const { return emergency_; }
  uint32_t generation() const { return generation_; }
  const std::string &reason() const { return reason_; }
  const std::string &position() const { return position_; }
  const Job &job() const { return job_; }
  size_t clients() const { return clients_.size(); }
  size_t pending() const { return waiting_.size() + wire_.size(); }
  size_t pendingMovements() const {
    return std::count_if(waiting_.begin(), waiting_.end(), movement) +
           std::count_if(wire_.begin(), wire_.end(), movement);
  }
  bool hasPending() const { return !wire_.empty(); }
  bool sdPrinting() const { return sd_printing_; }
  bool sdPaused() const { return sd_paused_; }
  unsigned long sdDone() const { return sd_done_; }
  unsigned long sdTotal() const { return sd_total_; }
  const char *stage() const {
    switch (stage_) {
    case Stage::Boot:
      return "boot";
    case Stage::Probe:
      return "probing";
    case Stage::Ready:
      return "ready";
    default:
      return "fault";
    }
  }
  bool attached(uint32_t id) const { return clients_.count(id) != 0; }
  void attach(uint32_t id) {
    if (!id || attached(id) || clients_.size() >= MAX_CLIENTS)
      return;
    clients_[id] = 0;
    // A page joining NEVER probes, resets Marlin, or changes a line counter.
    status();
    if (!position_.empty())
      emit_({"rx", id, 0, position_});
    for (const auto &e : history_) {
      Event h = e;
      h.session = id;
      h.type = e.type == "tx" ? "historyTx" : "historyRx";
      emit_(h);
    }
    if (job_.owner)
      emit_({"job", id});
  }
  void detach(uint32_t id) {
    if (!attached(id))
      return;
    discard(id);
    clients_.erase(id);
    if (resume_deferred_ && deferred_.session == id)
      resume_deferred_ = false;
    if (job_.owner == id && job_.active()) {
      job_.state = "interrupted";
      job_.error = "Se desconecto el dispositivo que envia el archivo";
      emit_({"job"});
    }
    // Already-written commands retain their original ACK owner.
    status();
  }
  void discard(uint32_t session) {
    for (auto it = waiting_.begin(); it != waiting_.end();) {
      if ((!session || it->session == session) &&
          (!session || !it->batch || it->batch != active_batch_)) {
        event("discarded", *it, "Comando pendiente descartado");
        it = waiting_.erase(it);
      } else
        ++it;
    }
  }
  void status() { emit_({"status"}); }
  void setJob(uint32_t session, Job next) {
    if (!attached(session))
      return;
    if (job_.active() && job_.owner != session) {
      emit_(
          {"notice", session, 0, "Otro dispositivo esta enviando un programa"});
      return;
    }
    if (!next.active() && job_.owner != session)
      return; // Local file selection is not a global print.
    next.owner = session;
    job_ = std::move(next);
    emit_({"job"});
    status();
  }
  void jobAction(uint32_t session, const std::string &action) {
    if (!attached(session) || !job_.active() || !attached(job_.owner))
      return;
    emit_({"jobAction", job_.owner, 0, action});
  }
  // These are shared UI intents, not fabricated acknowledgements of G-code.
  // Several phones requesting the same pause create exactly one hold.
  void machineControl(uint32_t session, uint32_t id, const std::string &action,
                      uint64_t now) {
    const auto reject_control = [&](const std::string &why) {
      emit_({"controlRejected", session, id, why});
    };
    auto client = clients_.find(session);
    if (client == clients_.end() || !id || id <= client->second) {
      reject_control("Sesion o identificador de control invalido");
      return;
    }
    client->second = id;
    if (action != "pause" && action != "resume") {
      reject_control("Accion invalida");
      return;
    }
    const bool resume_before_ready = action == "resume" && paused();
    if (emergency_ || requires_reset_ || (!ready() && !resume_before_ready)) {
      reject_control("Marlin no esta listo: " + reason_);
      return;
    }
    if (job_.active()) {
      jobAction(session, action);
      emit_({"controlAccepted", session, id});
      return;
    }
    if (action == "pause") {
      if (pause_stage_ == PauseStage::Resuming) {
        reject_control("Reanudacion en curso");
        return;
      }
      if (pause_stage_ != PauseStage::Running || paused()) {
        emit_({"controlAccepted", session, id});
        status();
        return;
      }
      pause_stage_ = PauseStage::Requested;
      const uint64_t batch =
          ++control_counter_; // session zero is reserved for firmware.
      Command first, last;
      first.internal = last.internal = true;
      first.batch = last.batch = batch;
      last.batch_end = true;
      if (sd_printing_) {
        first.text = "M25";
        first.control = Command::Control::SdStop;
        last.text = "M400";
        last.control = Command::Control::SdDrain;
      } else {
        first.text = "M400";
        first.control = Command::Control::PauseDrain;
        last.text = "M0";
        last.control = Command::Control::PauseHold;
      }
      waiting_.push_back(first);
      waiting_.push_back(last);
    } else {
      if (pause_stage_ == PauseStage::Resuming ||
          (!paused() && pause_stage_ == PauseStage::Running)) {
        emit_({"controlAccepted", session, id});
        status();
        return;
      }
      if (!paused()) {
        reject_control("La pausa todavia no se confirmo");
        return;
      }
      pause_stage_ = PauseStage::Resuming;
      Command resume;
      resume.internal = true;
      resume.control = Command::Control::Resume;
      resume.text = sd_paused_ ? "M24" : "M108";
      if (sd_paused_)
        waiting_.push_back(resume);
      else
        transmit(resume, now, false);
    }
    emit_({"controlAccepted", session, id});
    pump(now);
    status();
  }
  void accept(uint32_t session, uint32_t id, const std::string &text,
              uint64_t now, bool job = false) {
    acceptBatch(session, id, {text}, now, job);
  }
  void acceptBatch(uint32_t session, uint32_t first,
                   const std::vector<std::string> &texts, uint64_t now,
                   bool job = false) {
    Command rejected;
    rejected.session = session;
    rejected.id = first;
    auto client = clients_.find(session);
    if (client == clients_.end()) {
      reject(rejected, "Sesion no registrada");
      return;
    }
    if (!first || first <= client->second || texts.empty() ||
        texts.size() > 8 || first > UINT32_MAX - texts.size() + 1) {
      reject(rejected,
             "Identificador repetido, fuera de orden o lote invalido");
      return;
    }
    client->second = first + texts.size() - 1;
    const bool urgent =
        texts.size() == 1 && (code(texts[0], "M112") ||
                              code(texts[0], "M410") || code(texts[0], "M108"));
    std::string error;
    if (!urgent && !ready())
      error = "Marlin no esta listo: " + reason_;
    else if (!urgent && waiting_.size() + texts.size() > MAX_QUEUE)
      error = "Cola llena";
    else if (job && job_.active() && job_.owner != session)
      error = "Otro dispositivo envia el programa";
    else if (urgent && wire_.size() >= 4 && !code(texts[0], "M112"))
      error = "Demasiados comandos urgentes pendientes";
    for (const auto &text : texts) {
      if (!valid(text))
        error =
            "Una linea G/M/T sin comentarios ni checksum, hasta 78 bytes ASCII";
      if (texts.size() > 1 &&
          (code(text, "M112") || code(text, "M410") || code(text, "M108")))
        error = "Los comandos urgentes se envian individualmente";
      if (code(text, "M110") && (!job || text != "M110 N0" ||
                                 (job_.active() && job_.owner != session)))
        error = "M110 reservado; no permitido desde control manual";
    }
    if (!error.empty()) {
      for (size_t i = 0; i < texts.size(); ++i) {
        rejected.id = first + i;
        reject(rejected, error);
      }
      return;
    }
    for (size_t i = 0; i < texts.size(); ++i) {
      Command c;
      c.session = session;
      c.id = first + i;
      c.text = texts[i];
      c.job = job;
      c.urgent = urgent;
      if (texts.size() > 1) {
        c.batch = (static_cast<uint64_t>(session) << 32) | first;
        c.batch_end = i + 1 == texts.size();
      }
      event("accepted", c);
      if (!urgent) {
        waiting_.push_back(c);
        continue;
      }
      if (code(c.text, "M112") || code(c.text, "M410")) {
        transmit(c, now, false);
        emergency_ = true;
        fault(code(c.text, "M112")
                  ? "M112 enviado. Reiniciar Mega para recuperar"
                  : "M410 enviado. Reiniciar Mega para recuperar",
              now);
        return;
      }
      if (!paused_ && !wire_.empty() &&
          (code(wire_.front().text, "M0") || code(wire_.front().text, "M1"))) {
        if (resume_deferred_)
          reject(c, "Reanudacion ya solicitada");
        else {
          deferred_ = c;
          resume_deferred_ = true;
        }
      } else
        transmit(c, now, false);
    }
    pump(now);
    status();
  }
  void poll(uint64_t now) {
    if ((stage_ == Stage::Boot && now >= boot_at_) ||
        (stage_ == Stage::Fault && !emergency_ && !requires_reset_ &&
         now >= boot_at_)) {
      stage_ = Stage::Probe;
      seen_firmware_ = false;
      has_reports_ = false;
      has_sd_ = false;
      reason_ = "ESP conectada; consultando Marlin con M115";
      internal("M115", now, false);
      status();
    }
    if (!wire_.empty() && now - last_control_ > 15000 && !paused_) {
      if (stage_ == Stage::Probe) {
        wire_.clear();
        seen_firmware_ = false;
        reason_ =
            "ESP conectada; Marlin no confirmo M115. Reintentando consulta";
        internal("M115", now, false);
        status();
      } else if (stage_ != Stage::Fault)
        fault("Marlin no confirmo el comando; no se repite. Ver consola", now);
    }
    if (ready() && wire_.empty() && waiting_.empty() &&
        now - last_probe_ >= 5000) {
      last_probe_ = now;
      if (has_sd_ && now - last_sd_ >= 10000) {
        last_sd_ = now;
        internal("M27", now, numbering_);
      } else
        internal("M114", now, numbering_);
    }
    pump(now);
  }
  void line(const std::string &raw, uint64_t now) {
    const auto a = raw.find_first_not_of(" \t\r\n"),
               b = raw.find_last_not_of(" \t\r\n");
    if (a == std::string::npos)
      return;
    const std::string s = raw.substr(a, b - a + 1);
    remember({"rx", 0, 0, s});
    if (s == "start") {
      discard(0);
      for (const auto &c : wire_)
        event("discarded", c, "Reinicio de Mega");
      wire_.clear();
      active_batch_ = 0;
      requires_reset_ = false;
      resume_deferred_ = false;
      numbering_ = false;
      next_line_ = 1;
      paused_ = false;
      pause_stage_ = PauseStage::Running;
      position_.clear();
      sd_printing_ = sd_paused_ = false;
      sd_done_ = sd_total_ = 0;
      interruptJob("Mega reiniciado");
      ++generation_;
      stage_ = Stage::Boot;
      boot_at_ = now + 1200;
      reason_ = "Mega reiniciado; esperando respuesta de Marlin";
      status();
      return;
    }
    if (s.rfind("X:", 0) == 0 && s.find("Y:") != std::string::npos &&
        s.find("Z:") != std::string::npos)
      position_ = s;
    if (stage_ == Stage::Probe) {
      if (s.find("FIRMWARE_NAME:Marlin") != std::string::npos)
        seen_firmware_ = true;
      if (s.find("Cap:AUTOREPORT_POS:1") != std::string::npos)
        has_reports_ = true;
      if (s.find("Cap:SDCARD:1") != std::string::npos)
        has_sd_ = true;
    }
    unsigned long done = 0, total = 0;
    if (std::sscanf(s.c_str(), "SD printing byte %lu/%lu", &done, &total) ==
        2) {
      sd_printing_ = true;
      sd_done_ = done;
      sd_total_ = total;
      status();
    } else if (s == "Not SD printing") {
      sd_printing_ = false;
      if (sd_paused_) {
        paused_ = false;
        if (pause_stage_ == PauseStage::Held)
          pause_stage_ = PauseStage::Running;
      }
      sd_paused_ = false;
      status();
    }
    if (s.find("busy:") != std::string::npos) {
      last_control_ = now;
      if (s.find("paused for user") != std::string::npos) {
        paused_ = true;
        if (pause_stage_ != PauseStage::Resuming)
          pause_stage_ = PauseStage::Held;
        if (resume_deferred_) {
          resume_deferred_ = false;
          transmit(deferred_, now, false);
        }
        status();
      }
    }
    if (s.rfind("Error:", 0) == 0) {
      if (s.find("checksum") != std::string::npos ||
          s.find("Checksum") != std::string::npos ||
          s.find("Line Number") != std::string::npos)
        last_control_ = now;
      else {
        if (s.find("halted") != std::string::npos ||
            s.find("kill()") != std::string::npos)
          emergency_ = true;
        fault("Marlin: " + s, now);
        return;
      }
    }
    if (s.rfind("Resend:", 0) == 0 || s.rfind("rs ", 0) == 0) {
      const char *p = s.c_str() + (s.rfind("Resend:", 0) == 0 ? 7 : 3);
      while (*p == ' ' || *p == 'N')
        ++p;
      const int n = std::atoi(p);
      if (wire_.empty() || wire_.front().line != n || n < 0 ||
          ++wire_.front().retries > 3) {
        fault("Reenvio fuera de secuencia; comando no repetido", now);
        return;
      }
      resend_sync_ = true;
      last_control_ = now;
      return;
    }
    if (!ok(s) || wire_.empty())
      return;
    // Startup / an old M0 can emit an unsolicited ok before M115's identity.
    // It must not consume the actual probe or an urgent resume behind it.
    if (stage_ == Stage::Probe && !seen_firmware_)
      return;
    last_control_ = now;
    if (resend_sync_) {
      resend_sync_ = false;
      if (!write_(wire_.front().wire + "\n"))
        fault("Fallo TX UART", now);
      else
        event("resend", wire_.front());
      return;
    }
    Command c = wire_.front();
    wire_.pop_front();
    if (c.batch_end && c.batch == active_batch_)
      active_batch_ = 0;
    if (stage_ == Stage::Probe) {
      if (!seen_firmware_) {
        stage_ = Stage::Boot;
        boot_at_ = now + 2000;
        return;
      }
      stage_ = Stage::Ready;
      emergency_ = false;
      reason_.clear();
      last_probe_ = now;
      status();
      // No M110 on initial attach. Numbering is synchronized only for a NEW
      // WiFi file.
      if (has_reports_) {
        Command report;
        report.text = "M154 S1";
        report.internal = true;
        waiting_.push_back(report);
      }
      Command pos;
      pos.text = "M114";
      pos.internal = true;
      waiting_.push_back(pos);
      pump(now);
      return;
    }
    if (code(c.text, "M110")) {
      next_line_ = 1;
      numbering_ = c.job;
    }
    if (code(c.text, "M25") && sd_printing_) {
      sd_paused_ = true;
      paused_ = true;
      if (c.control == Command::Control::None)
        pause_stage_ = PauseStage::Held;
    }
    if (code(c.text, "M24")) {
      sd_paused_ = false;
      paused_ = false;
    }
    if (code(c.text, "M524")) {
      sd_printing_ = false;
      sd_paused_ = false;
      paused_ = false;
    }
    if (code(c.text, "M0") || code(c.text, "M1") || code(c.text, "M108"))
      paused_ = false;
    if (c.control == Command::Control::SdDrain)
      pause_stage_ = sd_paused_ ? PauseStage::Held : PauseStage::Running;
    else if (c.control == Command::Control::Resume || code(c.text, "M108") ||
             code(c.text, "M24") || code(c.text, "M524"))
      pause_stage_ = paused() ? PauseStage::Held : PauseStage::Running;
    else if ((code(c.text, "M0") || code(c.text, "M1")) &&
             pause_stage_ != PauseStage::Resuming)
      pause_stage_ = paused() ? PauseStage::Held : PauseStage::Running;
    event("ack", c);
    pump(now);
    status();
  }
  void fault(const std::string &reason, uint64_t now = 0) {
    stage_ = Stage::Fault;
    reason_ = reason;
    resume_deferred_ = false;
    pause_stage_ = PauseStage::Running;
    resend_sync_ = false;
    if (active_batch_) {
      requires_reset_ = true;
      reason_ += "; reiniciar Mega por lote incompleto";
    }
    discard(0);
    for (const auto &c : wire_)
      event("discarded", c, reason);
    wire_.clear();
    numbering_ = false;
    interruptJob(reason);
    boot_at_ = now + 2000;
    status();
  }

private:
  enum class PauseStage { Running, Requested, Draining, Held, Resuming };
  PauseStage pause_stage_ = PauseStage::Running;
  enum class Stage { Boot, Probe, Ready, Fault };
  Stage stage_ = Stage::Boot;
  std::map<uint32_t, uint32_t> clients_;
  std::deque<Command> waiting_, wire_;
  std::deque<Event> history_;
  Emit emit_;
  Write write_;
  uint64_t boot_at_ = 1500, last_control_ = 0, last_probe_ = 0, last_sd_ = 0;
  uint32_t generation_ = 0;
  uint64_t active_batch_ = 0;
  uint32_t control_counter_ = 0;
  bool requires_reset_ = false;
  int next_line_ = 1;
  bool seen_firmware_ = false, has_reports_ = false, has_sd_ = false,
       resend_sync_ = false, paused_ = false, resume_deferred_ = false,
       emergency_ = false, numbering_ = false, sd_printing_ = false,
       sd_paused_ = false;
  unsigned long sd_done_ = 0, sd_total_ = 0;
  Command deferred_;
  Job job_;
  std::string position_,
      reason_ = "ESP conectada; esperando respuesta de Marlin";
  static bool valid(const std::string &s) {
    if (s.size() < 2 || s.size() > MAX_TEXT)
      return false;
    const char first = std::toupper(static_cast<unsigned char>(s[0]));
    if ((first != 'G' && first != 'M' && first != 'T') ||
        !std::isdigit(static_cast<unsigned char>(s[1])))
      return false;
    for (unsigned char c : s)
      if (c < 32 || c > 126 || c == '*' || c == ';' || c == '(' || c == ')')
        return false;
    return true;
  }
  void remember(Event e) {
    emit_(e);
    if (e.text.size() > 384) {
      size_t limit = 384;
      while (limit &&
             (static_cast<unsigned char>(e.text[limit]) & 0xC0) == 0x80)
        --limit;
      e.text.resize(limit);
    }
    history_.push_back(std::move(e));
    if (history_.size() > 32)
      history_.pop_front();
  }
  void event(const char *type, const Command &c, const std::string &text = "") {
    if (!c.internal)
      emit_({type, c.session, c.id, text.empty() ? c.text : text, c.line});
  }
  void reject(const Command &c, const std::string &r) {
    event("rejected", c, r);
  }
  void interruptJob(const std::string &r) {
    if (job_.active()) {
      job_.state = "interrupted";
      job_.error = r;
      emit_({"job"});
    }
  }
  void internal(const std::string &t, uint64_t now, bool n) {
    Command c;
    c.text = t;
    c.internal = true;
    transmit(c, now, n);
  }
  void transmit(Command c, uint64_t now, bool n) {
    if (n && next_line_ > 999999999) {
      fault("Limite de numeracion", now);
      return;
    }
    c.line = n ? next_line_++ : -1;
    c.wire = n ? numbered(c.line, c.text) : c.text;
    if (!write_(c.wire + "\n")) {
      fault("Fallo TX UART", now);
      return;
    }
    wire_.push_back(c);
    last_control_ = now;
    if (c.batch)
      active_batch_ = c.batch;
    if (c.control == Command::Control::PauseDrain ||
        c.control == Command::Control::SdStop ||
        c.control == Command::Control::SdDrain)
      pause_stage_ = PauseStage::Draining;
    else if ((code(c.text, "M0") || code(c.text, "M1")) &&
             pause_stage_ == PauseStage::Running)
      pause_stage_ = PauseStage::Requested;
    event("written", c, c.wire);
    remember({"tx", 0, 0, c.wire, c.line, c.session});
  }
  void pump(uint64_t now) {
    if (!ready() || !wire_.empty() || waiting_.empty())
      return;
    Command c = waiting_.front();
    waiting_.pop_front();
    transmit(c, now, numbering_ && !code(c.text, "M110"));
  }
};
} // namespace bridge
