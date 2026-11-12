// Host harness: the production Core and production JSON codec, with simulated
// UART replies. No browser-side substitute implements the printer state.
#include "../main/bridge_json.hpp"
#include "../main/bridge_protocol.hpp"
#include <deque>
#include <iomanip>
#include <iostream>
#include <memory>
#include <set>
#include <sstream>

static std::string string_at(const cJSON *o, const char *key) {
  const auto *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}
static double number_at(const cJSON *o, const char *key) {
  const auto *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsNumber(v) ? v->valuedouble : 0;
}
static void output(cJSON *message) {
  char *text = cJSON_PrintUnformatted(message);
  cJSON_Delete(message);
  if (text) {
    std::cout << text << '\n' << std::flush;
    cJSON_free(text);
  }
}
struct Simulator {
  std::unique_ptr<bridge::Core> core;
  bridge::NetworkPolicy network;
  std::string camera_url = bridge::CAMERA_URL;
  static bridge::Mac mac(int device) {
    return device == 255
               ? bridge::CAMERA_MAC
               : bridge::Mac{2, 0, 0, 0, 0, static_cast<uint8_t>(device)};
  }
  std::set<uint32_t> clients;
  std::deque<std::string> outgoing;
  struct Pending {
    std::string command;
    int line;
  };
  std::deque<Pending> marlin;
  uint64_t now = 2000, last_status = 0, last_busy = 0, last_auto = 0,
           last_tick = 2000, due = 0;
  uint32_t boot = 501;
  int last_line = 0;
  bool killed = false, hold = false, own_m0 = false, old_m0 = false,
       sd_active = false, sd_paused = false, usb_active = false,
       auto_position = false, corrupt_next = false, no_reply = false;
  unsigned long sd_done = 0, sd_total = 100000;
  double x = 12, y = 34, z = 56;
  int move_ms = 65;
  Simulator() { restartCore(); }
  void trace(const char *key, const std::string &text) {
    auto *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, key, text.c_str());
    cJSON_AddNumberToObject(j, "time", now);
    output(j);
  }
  void publish(const bridge::Event &e) {
    for (auto id : clients) {
      if (e.session && e.session != id)
        continue;
      auto *j = cJSON_CreateObject();
      cJSON_AddNumberToObject(j, "to", id);
      auto *message = bridge::makeMessage(*core, e, id, boot, network.state());
      if (e.type == "status")
        cJSON_ReplaceItemInObject(message, "cameraUrl",
                                  cJSON_CreateString(camera_url.c_str()));
      cJSON_AddItemToObject(j, "message", message);
      output(j);
    }
  }
  void restartCore() {
    ++boot;
    core = std::make_unique<bridge::Core>(
        [this](const auto &e) { publish(e); },
        [this](const std::string &s) {
          std::string line = s;
          while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
            line.pop_back();
          outgoing.push_back(line);
          trace("uart", line);
          return true;
        });
    for (auto id : clients)
      core->attach(id);
    core->poll(now);
  }
  void rx(const std::string &line) {
    if (!no_reply)
      core->line(line, now);
  }
  void position() {
    std::ostringstream s;
    s << std::fixed << std::setprecision(2) << "X:" << x << " Y:" << y
      << " Z:" << z << " Count X:120 Y:340 Z:560";
    rx(s.str());
  }
  void ingest() {
    while (!outgoing.empty()) {
      auto wire = outgoing.front();
      outgoing.pop_front();
      std::string body = wire;
      int line = -1;
      if (!body.empty() && body[0] == 'N') {
        line = std::atoi(body.c_str() + 1);
        const auto space = body.find(' '), star = body.rfind('*');
        if (space == std::string::npos || star == std::string::npos)
          continue;
        unsigned char sum = 0;
        for (size_t i = 0; i < star; ++i)
          sum ^= static_cast<unsigned char>(body[i]);
        body = wire.substr(space + 1, star - space - 1);
        if ((corrupt_next && bridge::code(body, "G1")) ||
            sum != std::atoi(wire.c_str() + star + 1) ||
            line != last_line + 1) {
          corrupt_next = false;
          rx("Error:checksum mismatch, Last Line: " +
             std::to_string(last_line));
          rx("Resend: " + std::to_string(last_line + 1));
          rx("ok");
          continue;
        }
        last_line = line;
      }
      if (bridge::code(body, "M112") || bridge::code(body, "M410")) {
        killed = true;
        hold = false;
        own_m0 = false;
        marlin.clear();
        due = 0;
        rx("Error:Printer halted. kill() called!");
        continue;
      }
      if (killed || no_reply)
        continue;
      if (bridge::code(body, "M108") && hold) {
        hold = false;
        if (own_m0 || old_m0) {
          own_m0 = false;
          old_m0 = false;
          rx("ok");
        }
      }
      marlin.push_back({body, line});
    }
  }
  void execute(Pending command) {
    const auto &s = command.command;
    trace("executed", s);
    if (bridge::code(s, "M115")) {
      rx("FIRMWARE_NAME:Marlin 2.1.2.5 SOURCE_CODE_URL:https://marlinfw.org "
         "PROTOCOL_VERSION:1.0");
      rx("Cap:AUTOREPORT_POS:1");
      rx("Cap:SDCARD:1");
      rx("Cap:EMERGENCY_PARSER:1");
    } else if (bridge::code(s, "M110"))
      last_line = 0;
    else if (bridge::code(s, "M154"))
      auto_position = true;
    else if (bridge::code(s, "M114"))
      position();
    else if (bridge::code(s, "M119"))
      rx("Reporting endstop status");
    else if (bridge::code(s, "M27")) {
      if (sd_active || sd_paused)
        rx("SD printing byte " + std::to_string(sd_done) + "/" +
           std::to_string(sd_total));
      else
        rx("Not SD printing");
    } else if (bridge::code(s, "M25")) {
      if (sd_active)
        sd_paused = true;
    } else if (bridge::code(s, "M24"))
      sd_paused = false;
    else if (bridge::code(s, "M524")) {
      sd_active = false;
      sd_paused = false;
    } else if (bridge::code(s, "M0") || bridge::code(s, "M1")) {
      hold = true;
      own_m0 = true;
      rx("echo:busy: paused for user");
      return;
    }
    rx("ok");
  }
  void step() {
    const auto elapsed = now - last_tick;
    last_tick = now;
    if (!killed && !hold) {
      if (usb_active)
        x += elapsed * 0.001;
      if (sd_active && !sd_paused) {
        sd_done =
            std::min(sd_total, sd_done + static_cast<unsigned long>(elapsed));
        if (sd_done == sd_total)
          sd_active = false;
      }
    }
    core->poll(now);
    ingest();
    if (hold) {
      if (now - last_busy >= 200) {
        last_busy = now;
        rx("echo:busy: paused for user");
      }
    } else if (!killed && !marlin.empty()) {
      if (!due) {
        bridge::Command command;
        command.text = marlin.front().command;
        due = now + (bridge::movement(command) ? move_ms : 10);
      }
      if (now >= due) {
        const auto next = marlin.front();
        marlin.pop_front();
        due = 0;
        execute(next);
        ingest();
      }
    }
    if (auto_position && now - last_auto >= 1000 && !killed) {
      last_auto = now;
      position();
    }
    if (now - last_status >= 250) {
      last_status = now;
      core->status();
    }
  }
  void request(cJSON *j) {
    now = std::max(now, static_cast<uint64_t>(number_at(j, "now")));
    const auto type = string_at(j, "type");
    const auto client = static_cast<uint32_t>(number_at(j, "client"));
    bool accepted = true;
    const int device = number_at(j, "device");
    if (type == "associate")
      accepted = network.associate(mac(device), number_at(j, "aid"));
    else if (type == "stationGone") {
      network.disconnect(mac(device), number_at(j, "aid"));
      for (auto it = clients.begin(); it != clients.end();) {
        if (network.validSession(*it)) {
          ++it;
          continue;
        }
        auto *close = cJSON_CreateObject();
        cJSON_AddNumberToObject(close, "close", *it);
        output(close);
        core->detach(*it);
        it = clients.erase(it);
      }
    } else if (type == "open")
      accepted = network.openSession(mac(device), client);
    else if (type == "detach") {
      core->detach(client);
      clients.erase(client);
      network.closeSession(client);
    } else if (type == "reset") {
      killed = false;
      hold = false;
      own_m0 = false;
      old_m0 = false;
      marlin.clear();
      outgoing.clear();
      due = 0;
      last_line = 0;
      sd_paused = false;
      core->line("start", now);
    } else if (type == "config") {
      if (cJSON_HasObjectItem(j, "cameraUrl"))
        camera_url = string_at(j, "cameraUrl");
      const auto setbool = [&](const char *k, bool &target) {
        const auto *v = cJSON_GetObjectItemCaseSensitive(j, k);
        if (cJSON_IsBool(v))
          target = cJSON_IsTrue(v);
      };
      setbool("sdActive", sd_active);
      setbool("usbActive", usb_active);
      setbool("hold", hold);
      setbool("oldM0", old_m0);
      setbool("corruptNext", corrupt_next);
      setbool("noReply", no_reply);
      if (cJSON_HasObjectItem(j, "sdDone"))
        sd_done = number_at(j, "sdDone");
      if (cJSON_HasObjectItem(j, "moveMs"))
        move_ms = number_at(j, "moveMs");
      if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "restartCore"))) {
        marlin.clear();
        outgoing.clear();
        due = 0;
        restartCore();
      }
    } else if (type != "tick") {
      bridge::Request r;
      r.session = client;
      accepted = network.validSession(client) && bridge::parseRequest(j, r);
      if (accepted) {
        if (r.op == bridge::Op::Attach) {
          clients.insert(client);
          core->attach(client);
        } else if (r.op == bridge::Op::Ping) {
        } else if (!core->attached(client))
          accepted = false;
        else if (r.op == bridge::Op::Command)
          core->accept(client, r.id, r.text[0], now);
        else if (r.op == bridge::Op::Batch) {
          std::vector<std::string> texts;
          for (size_t i = 0; i < r.count; ++i)
            texts.emplace_back(r.text[i]);
          core->acceptBatch(client, r.id, texts, now);
        } else if (r.op == bridge::Op::Control)
          core->machineControl(client, r.id, r.action, now);
        else if (r.op == bridge::Op::Discard)
          core->discard(client);
      }
      if (!accepted) {
        auto *close = cJSON_CreateObject();
        cJSON_AddNumberToObject(close, "close", client);
        output(close);
      }
    }
    step();
    const auto token = number_at(j, "request");
    if (token) {
      auto *ack = cJSON_CreateObject();
      cJSON_AddNumberToObject(ack, "request", token);
      cJSON_AddBoolToObject(ack, "ok", accepted);
      output(ack);
    }
  }
};
int main() {
  Simulator simulator;
  std::string line;
  while (std::getline(std::cin, line)) {
    auto *j = cJSON_Parse(line.c_str());
    if (!j)
      continue;
    simulator.request(j);
    cJSON_Delete(j);
  }
}
