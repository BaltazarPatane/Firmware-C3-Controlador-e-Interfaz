#include "../main/bridge_core.hpp"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

struct Rig {
  std::vector<bridge::Event> events;
  std::vector<std::string> tx;
  bridge::Core core;
  uint64_t now = 2000;
  Rig()
      : core([this](const auto &e) { events.push_back(e); },
             [this](const auto &s) {
               tx.push_back(s);
               return true;
             }) {}
  void rx(const std::string &s) { core.line(s, ++now); }
  void ready() {
    core.poll(now);
    assert(tx.back() == "M115\n");
    rx("FIRMWARE_NAME:Marlin 2.1.2.5");
    rx("Cap:AUTOREPORT_POS:1");
    rx("Cap:SDCARD:1");
    rx("ok");
    assert(core.ready());
    assert(tx.back() == "M154 S1\n");
    rx("ok");
    assert(tx.back() == "M114\n");
    rx("X:1.00 Y:2.00 Z:3.00 Count X:100 Y:200 Z:300");
    rx("ok");
    core.attach(10);
    events.clear();
    tx.clear();
  }
  void send(uint32_t id, const std::string &s, uint32_t owner = 10,
            bool job = false) {
    core.accept(owner, id, s, ++now, job);
  }
  int count(const std::string &type, uint32_t id = 0,
            uint32_t owner = 0) const {
    return std::count_if(events.begin(), events.end(), [&](const auto &e) {
      return e.type == type && (!id || e.id == id) &&
             (!owner || e.session == owner);
    });
  }
};
int main() {
  int scenarios = 0;
  auto test = [&](const char *name, auto fn) {
    fn();
    ++scenarios;
    std::cout << "OK " << name << '\n';
  };
  test("boot messages or bare ok cannot fabricate a Marlin handshake", [] {
    Rig r;
    r.core.poll(r.now);
    r.rx("echo:Marlin 2.1.2.5");
    r.rx("ok");
    assert(!r.core.ready());
  });
  test("late attach does not transmit, reset, or renumber", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.core.attach(12);
    assert(r.tx.empty() && r.core.clients() == 3 && r.core.ready());
  });
  test("new client receives cached position and console history", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    assert(r.count("rx", 0, 11) >= 1 && r.count("historyRx", 0, 11) >= 1);
  });
  test("only one ordinary command is in flight", [] {
    Rig r;
    r.ready();
    r.send(1, "G1 X10");
    r.send(2, "G1 X20");
    assert(r.tx.size() == 1);
    r.rx("echo:busy: processing");
    r.rx("X:2 Y:3 Z:4");
    assert(r.tx.size() == 1);
    r.rx("ok P15 B3");
    assert(r.tx.size() == 2 && r.count("ack", 1, 10) == 1);
  });
  test("two phones can both use ID 1 without crossing ACKs", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.send(1, "G1 X10");
    r.send(1, "M114", 11);
    assert(r.tx.size() == 1);
    r.rx("ok");
    assert(r.count("ack", 1, 10) == 1 && r.count("ack", 1, 11) == 0 &&
           r.tx.size() == 2);
    r.rx("ok");
    assert(r.count("ack", 1, 11) == 1);
  });
  test("relative-move batches cannot interleave across phones", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.core.acceptBatch(10, 1, {"G91", "G0 X1", "G90", "M114"}, ++r.now);
    r.send(1, "M119", 11);
    for (int i = 0; i < 4; ++i)
      r.rx("ok");
    assert((r.tx == std::vector<std::string>{"G91\n", "G0 X1\n", "G90\n",
                                             "M114\n", "M119\n"}));
  });
  test("invalid batch executes no prefix", [] {
    Rig r;
    r.ready();
    r.core.acceptBatch(10, 1, {"G91", "BAD", "G90"}, ++r.now);
    assert(r.tx.empty() && r.count("rejected") == 3);
  });
  test("closing one monitor preserves other clients and active command", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.send(1, "G1 X10");
    r.send(1, "M114", 11);
    r.core.detach(11);
    assert(r.core.ready() && r.core.clients() == 1);
    r.rx("ok");
    assert(r.tx.size() == 1 && r.count("ack", 1, 10) == 1);
  });
  test("closing command source discards only its unwritten commands", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.send(1, "G1 X10");
    r.send(2, "G1 X20");
    r.send(1, "M114", 11);
    r.core.detach(10);
    assert(r.count("discarded", 2, 10) == 1);
    r.rx("ok");
    assert(r.tx.back() == "M114\n");
    r.rx("ok");
    assert(r.count("ack", 1, 11) == 1);
  });
  test("duplicate IDs are rejected only within their own session", [] {
    Rig r;
    r.ready();
    r.send(1, "M114");
    r.send(1, "G1 X1");
    assert(r.tx.size() == 1 && r.count("rejected", 1, 10) == 1);
  });
  test("all clients see every UART transmission", [] {
    Rig r;
    r.ready();
    r.send(1, "M119");
    assert(r.count("tx") == 1);
    const auto &e = r.events.back();
    assert(e.type == "status");
    assert(std::any_of(r.events.begin(), r.events.end(), [](const auto &e) {
      return e.type == "tx" && e.session == 0 && e.origin == 10;
    }));
  });
  test("ten sessions allowed; eleventh cannot replace an existing session", [] {
    static_assert(bridge::MAX_CLIENTS == 10);
    Rig r;
    r.ready();
    for (uint32_t id = 11; id <= 20; ++id)
      r.core.attach(id);
    assert(r.core.clients() == 10 && !r.core.attached(20) &&
           r.core.attached(19) && r.core.attached(10));
  });
  test("M112 bypasses in-flight motion and broadcasts a latched stop", [] {
    Rig r;
    r.ready();
    for (uint32_t id = 11; id <= 19; ++id) r.core.attach(id);
    r.send(1, "G1 X10");
    r.send(2, "G1 X20");
    r.send(1, "M112", 19);
    assert(r.tx.size() == 2 && r.tx.back() == "M112\n" && !r.core.ready() &&
           r.core.emergency());
    r.core.poll(r.now + 20000);
    assert(r.tx.size() == 2);
    r.send(3, "G1 X30");
    assert(r.count("rejected", 3, 10) == 1);
  });
  test("stop clears only after real reset AND a fresh identity and ok", [] {
    Rig r;
    r.ready();
    r.send(1, "M112");
    r.rx("start");
    assert(r.core.emergency() && r.core.generation() == 1);
    r.now += 1300;
    r.core.poll(r.now);
    r.rx("FIRMWARE_NAME:Marlin 2.1.2.5");
    assert(!r.core.ready() && r.core.emergency());
    r.rx("ok");
    assert(r.core.ready() && !r.core.emergency());
  });
  test("reset discards all clients' waiting commands", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.send(1, "G1 X1");
    r.send(1, "G1 X2", 11);
    r.rx("start");
    assert(!r.core.ready() && r.count("discarded", 1, 10) == 1 &&
           r.count("discarded", 1, 11) == 1);
  });
  test("M0/M108 ordering stays correlated", [] {
    Rig r;
    r.ready();
    r.send(1, "M0");
    r.send(2, "M108");
    assert(r.tx.size() == 1);
    r.rx("echo:busy: paused for user");
    assert(r.core.paused() && r.tx.back() == "M108\n");
    r.send(3, "M114");
    r.rx("ok");
    assert(r.count("ack", 1, 10) == 1 && r.tx.size() == 2);
    r.rx("ok");
    assert(r.tx.size() == 3);
  });
  test("unknown ordinary command timeout is never replayed", [] {
    Rig r;
    r.ready();
    r.send(1, "G1 X10");
    r.core.poll(r.now + 16000);
    assert(!r.core.ready() && r.tx.size() == 1);
    r.now += 19000;
    r.core.poll(r.now);
    assert(r.tx.back() == "M115\n");
    assert(std::count(r.tx.begin(), r.tx.end(), "G1 X10\n") == 1);
  });
  test("busy keeps long operations alive", [] {
    Rig r;
    r.ready();
    r.send(1, "G1 X10");
    r.rx("echo:busy: processing");
    r.core.poll(r.now + 14000);
    assert(r.core.ready());
  });
  test("initial probe retries only read-only M115 and explains why", [] {
    Rig r;
    r.core.poll(r.now);
    r.core.poll(r.now + 16000);
    assert(r.tx.size() == 2 && r.tx[0] == "M115\n" && r.tx[1] == "M115\n");
    assert(r.core.reason().find("no confirmo") != std::string::npos);
  });
  test("checksum numbering starts only for a new WiFi file", [] {
    Rig r;
    r.ready();
    bridge::Job j;
    j.state = "starting";
    j.name = "test.gcode";
    j.total = 2;
    r.core.setJob(10, j);
    r.send(1, "M110 N0", 10, true);
    r.rx("ok");
    r.send(2, "G1 X10", 10, true);
    assert(r.tx.back() == bridge::numbered(1, "G1 X10") + "\n");
  });
  test("a checksum resend retransmits exactly once after its sync ok", [] {
    Rig r;
    r.ready();
    r.send(1, "M110 N0", 10, true);
    r.rx("ok");
    r.send(2, "G1 X10", 10, true);
    auto original = r.tx.back();
    r.rx("Error:checksum mismatch, Last Line: 0");
    r.rx("Resend: 1");
    auto size = r.tx.size();
    r.rx("ok");
    assert(r.tx.size() == size + 1 && r.tx.back() == original &&
           r.count("ack", 2, 10) == 0);
    r.rx("ok");
    assert(r.count("ack", 2, 10) == 1);
  });
  test("out-of-sequence resend cannot repeat a movement blindly", [] {
    Rig r;
    r.ready();
    r.send(1, "G1 X10");
    r.rx("Resend: 999");
    assert(!r.core.ready() && r.tx.size() == 1);
  });
  test("remote pause action targets the source client, not observers", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    bridge::Job j;
    j.state = "printing";
    j.name = "test.gcode";
    j.total = 5;
    r.core.setJob(10, j);
    r.core.jobAction(11, "pause");
    assert(r.count("jobAction", 0, 10) == 1 && r.core.job().owner == 10);
  });
  test("concurrent file sources cannot take over the active job", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    bridge::Job j;
    j.state = "printing";
    j.name = "one.gcode";
    r.core.setJob(10, j);
    j.name = "two.gcode";
    r.core.setJob(11, j);
    r.send(1, "M110 N0", 11, true);
    assert(r.core.job().owner == 10 && r.tx.empty() &&
           r.count("rejected", 1, 11) == 1);
  });
  test("manual console requests can join a running WiFi job", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    bridge::Job j;
    j.state = "printing";
    r.core.setJob(10, j);
    r.send(1, "M119", 11);
    assert(r.tx.back() == "M119\n");
  });
  test("source loss reports an interrupted file rather than fake progress", [] {
    Rig r;
    r.ready();
    bridge::Job j;
    j.state = "printing";
    r.core.setJob(10, j);
    r.core.detach(10);
    assert(r.core.job().state == "interrupted" && r.core.ready());
  });
  test("SD progress can be discovered after printing has started", [] {
    Rig r;
    r.ready();
    r.rx("SD printing byte 500/1000");
    r.core.attach(11);
    assert(r.core.sdPrinting() && r.core.sdDone() == 500 &&
           r.core.sdTotal() == 1000);
  });
  test("invalid, multiline and oversized commands never reach UART", [] {
    Rig r;
    r.ready();
    r.send(1, "G1 X1\nM112");
    r.send(2, "N1 G1 X1*1");
    r.send(3, std::string(79, 'X'));
    r.send(4, "G1 X1 ;comment");
    assert(r.tx.empty() && r.count("rejected") == 4);
  });
  test("shared queue enforces its memory limit", [] {
    Rig r;
    r.ready();
    for (uint32_t i = 1; i <= 34; ++i)
      r.send(i, "G1 X1");
    assert(r.core.pending() == 33 && r.count("rejected", 34, 10) == 1);
  });
  test("discard is scoped to the requesting client", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.send(1, "G1 X1");
    r.send(2, "G1 X2");
    r.send(1, "M114", 11);
    r.core.discard(10);
    r.rx("ok");
    assert(r.tx.back() == "M114\n" && r.count("discarded", 2, 10) == 1);
  });
  test("UART spaces and CR do not break Marlin identification", [] {
    Rig r;
    r.core.poll(r.now);
    r.rx("  FIRMWARE_NAME:Marlin 2.1.2.5  ");
    r.rx("  ok\r");
    assert(r.core.ready());
  });
  test("halting errors lock all clients until reset", [] {
    Rig r;
    r.ready();
    r.rx("Error:Printer halted. kill() called!");
    assert(!r.core.ready() && r.core.emergency());
    r.core.poll(r.now + 20000);
    assert(r.tx.empty());
  });
  test("closing the phone mid-jog still completes its already-started modal "
       "batch",
       [] {
         Rig r;
         r.ready();
         r.core.acceptBatch(10, 1, {"G91", "G0 X1", "G90", "M114"}, ++r.now);
         r.core.detach(10);
         for (int i = 0; i < 4; ++i)
           r.rx("ok");
         assert((r.tx == std::vector<std::string>{"G91\n", "G0 X1\n", "G90\n",
                                                  "M114\n"}));
       });
  test("a fault halfway through a modal batch cannot silently rearm", [] {
    Rig r;
    r.ready();
    r.core.acceptBatch(10, 1, {"G91", "G0 X1", "G90"}, ++r.now);
    r.rx("ok");
    r.core.fault("UART error", r.now);
    auto n = r.tx.size();
    r.core.poll(r.now + 30000);
    assert(!r.core.ready() && r.tx.size() == n);
  });
  test("a stray startup ok does not consume the real M115 probe", [] {
    Rig r;
    r.core.poll(r.now);
    r.rx("ok");
    r.rx("FIRMWARE_NAME:Marlin 2.1.2.5");
    r.rx("ok");
    assert(r.core.ready());
    assert(std::count(r.tx.begin(), r.tx.end(), "M115\n") == 1);
  });
  test("two simultaneous phone pauses create one M400 and one M0", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.core.machineControl(10, 1, "pause", ++r.now);
    r.core.machineControl(11, 1, "pause", ++r.now);
    assert(r.tx.size() == 1 && r.tx.back() == "M400\n");
    r.rx("ok");
    assert(r.tx.size() == 2 && r.tx.back() == "M0\n");
    r.rx("echo:busy: paused for user");
    assert(r.core.paused() && std::string(r.core.pausePhase()) == "paused");
    r.core.machineControl(10, 2, "resume", ++r.now);
    r.core.machineControl(11, 2, "resume", ++r.now);
    assert(std::count(r.tx.begin(), r.tx.end(), "M108\n") == 1);
    r.rx("ok");
    r.rx("ok");
    assert(!r.core.paused());
    assert(std::string(r.core.pausePhase()) == "running");
    assert(r.count("controlAccepted", 1, 10) == 1 &&
           r.count("controlAccepted", 1, 11) == 1);
  });
  test("shared pause survives closing its requester", [] {
    Rig r;
    r.ready();
    r.core.machineControl(10, 1, "pause", ++r.now);
    r.core.detach(10);
    r.rx("ok");
    r.rx("echo:busy: paused for user");
    r.core.attach(11);
    assert(r.core.paused());
    r.core.machineControl(11, 1, "resume", ++r.now);
    assert(r.tx.back() == "M108\n");
    r.rx("ok");
    r.rx("ok");
    assert(!r.core.paused());
  });
  test("a paused Mega can be resumed while the first identity is still pending",
       [] {
         Rig r;
         r.core.poll(r.now);
         r.rx("echo:busy: paused for user");
         r.core.attach(10);
         r.core.machineControl(10, 1, "resume", ++r.now);
         assert(r.tx.back() == "M108\n");
         r.rx("ok"); // a pre-existing M0 from the previous bridge session
         r.rx("FIRMWARE_NAME:Marlin 2.1.2.5");
         r.rx("ok");
         r.rx("ok");
         assert(r.core.ready() && !r.core.paused());
         assert(std::count(r.tx.begin(), r.tx.end(), "M115\n") == 1);
       });
  test("SD pause stops the card then drains motion exactly once", [] {
    Rig r;
    r.ready();
    r.core.attach(11);
    r.rx("SD printing byte 500/1000");
    r.core.machineControl(10, 1, "pause", ++r.now);
    r.core.machineControl(11, 1, "pause", ++r.now);
    assert(r.tx.back() == "M25\n");
    r.rx("ok");
    assert(r.tx.back() == "M400\n");
    assert(std::string(r.core.pausePhase()) == "waiting-for-motion-finish");
    r.rx("ok");
    r.rx("SD printing byte 800/1000"); // first report since M25, not proof of
                                       // resume
    assert(r.core.sdPaused() && std::string(r.core.pausePhase()) == "paused");
    r.core.machineControl(10, 2, "resume", ++r.now);
    r.core.machineControl(11, 2, "resume", ++r.now);
    assert(std::count(r.tx.begin(), r.tx.end(), "M24\n") == 1);
    r.rx("ok");
    assert(!r.core.sdPaused() && std::string(r.core.pausePhase()) == "running");
  });
  test("M25 on an idle card cannot fabricate a pause", [] {
    Rig r;
    r.ready();
    r.send(1, "M25");
    r.rx("ok");
    assert(!r.core.paused());
  });
  test("pause intent for a WiFi job routes to the source without inserting a "
       "second hold",
       [] {
         Rig r;
         r.ready();
         r.core.attach(11);
         bridge::Job j;
         j.state = "printing";
         r.core.setJob(10, j);
         r.core.machineControl(11, 1, "pause", ++r.now);
         assert(r.tx.empty() && r.count("jobAction", 0, 10) == 1 &&
                r.count("controlAccepted", 1, 11) == 1);
       });
  test("control request IDs share the session sequence with ordinary commands",
       [] {
         Rig r;
         r.ready();
         r.core.machineControl(10, 1, "pause", ++r.now);
         r.send(1, "G1 X1");
         assert(r.count("rejected", 1, 10) == 1);
       });
  test("manual M110 cannot renumber an external print", [] {
    Rig r;
    r.ready();
    r.send(1, "M110 N0");
    assert(r.tx.empty() && r.count("rejected", 1, 10) == 1);
    r.send(2, "M119");
    assert(r.tx.back() == "M119\n");
  });
  std::cout << scenarios << " scenarios passed\n";
}
