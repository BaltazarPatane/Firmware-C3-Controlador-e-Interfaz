#include "../main/bridge_outbox.hpp"
#include "../main/socket_io.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
#include <unistd.h>
#include <vector>

int main() {
  int scenarios = 0;
  const auto test = [&](const char *name, auto run) {
    run();
    ++scenarios;
    std::cout << "OK " << name << '\n';
  };
  test("console saturation leaves the command receipt reserve available", [] {
    bridge::Outbox box;
    assert(box.addClient(1));
    for (int i = 0; i < 64; ++i)
      assert(box.push({1, "console"}, bridge::NetworkKind::Telemetry));
    assert(!box.push({1, "console"}, bridge::NetworkKind::Telemetry));
    assert(box.push({1, "ack"}, bridge::NetworkKind::Control));
    assert(box.pop()->json == "ack");
  });
  test("byte limits reject oversize console and control without unbounded "
       "growth",
       [] {
         bridge::Outbox box;
         assert(box.addClient(1));
         assert(!box.push({1, std::string(16385, 'x')},
                          bridge::NetworkKind::Telemetry));
         assert(!box.push({1, std::string(16385, 'x')},
                          bridge::NetworkKind::Control));
         assert(box.push({1, std::string(16384, 'x')},
                         bridge::NetworkKind::Control));
         assert(!box.push({1, "x"}, bridge::NetworkKind::Control));
         assert(box.pop()->json.size() == 16384);
         assert(!box.pop());
       });
  test("only the latest status is kept and all ten sessions receive a turn",
       [] {
         bridge::Outbox box;
         for (unsigned id = 1; id <= bridge::MAX_CLIENTS; ++id) {
           assert(box.addClient(id));
           for (int i = 0; i < 1000; ++i)
             assert(box.push({id, std::to_string(i)},
                             bridge::NetworkKind::Status));
         }
         assert(!box.addClient(bridge::MAX_CLIENTS + 1));
         for (unsigned id = 1; id <= bridge::MAX_CLIENTS; ++id) {
           auto m = box.pop();
           assert(m && m->session == id && m->json == "999");
         }
         assert(!box.pop());
       });
  test("detaching one session preserves the others and their private receipts",
       [] {
         bridge::Outbox box;
         box.addClient(1);
         box.addClient(2);
         box.push({1, "old"}, bridge::NetworkKind::Control);
         box.push({2, "ack-1"}, bridge::NetworkKind::Control);
         box.push({2, "ack-2"}, bridge::NetworkKind::Control);
         box.push({1, "status"}, bridge::NetworkKind::Status);
         box.removeClient(1);
         assert(!box.push({1, "late"}, bridge::NetworkKind::Control));
         for (auto text : {"ack-1", "ack-2"}) {
           auto m = box.pop();
           assert(m && m->session == 2 && m->json == text);
         }
         assert(!box.pop());
         assert(box.addClient(3));
       });
  test("ten producers and one consumer do not lose accepted control messages",
       [] {
         bridge::Outbox box;
         std::atomic<int> accepted{0}, received{0}, finished{0};
         for (unsigned id = 1; id <= bridge::MAX_CLIENTS; ++id)
           box.addClient(id);
         std::thread consumer([&] {
           while (finished.load() < static_cast<int>(bridge::MAX_CLIENTS) || received.load() < accepted.load()) {
             if (auto m = box.pop()) {
               assert(m->session >= 1 && m->session <= bridge::MAX_CLIENTS);
               ++received;
             } else
               std::this_thread::yield();
           }
         });
         std::vector<std::thread> producers;
         for (unsigned id = 1; id <= bridge::MAX_CLIENTS; ++id)
           producers.emplace_back([&, id] {
             for (int i = 0; i < 2000; ++i) {
               while (!box.push({id, std::to_string(i)},
                                bridge::NetworkKind::Control))
                 std::this_thread::yield();
               ++accepted;
             }
             ++finished;
           });
         for (auto &p : producers)
           p.join();
         consumer.join();
         assert(accepted == 20000 && received == 20000 && !box.pop());
       });
  test("a full slow socket fails immediately and does not block a healthy "
       "socket",
       [] {
         int slow[2], healthy[2];
         assert(socketpair(AF_UNIX, SOCK_STREAM, 0, slow) == 0);
         assert(socketpair(AF_UNIX, SOCK_STREAM, 0, healthy) == 0);
         int capacity = 1024;
         setsockopt(slow[0], SOL_SOCKET, SO_SNDBUF, &capacity,
                    sizeof(capacity));
         const std::string data(4096, 'x');
         while (::send(slow[0], data.data(), data.size(),
                       MSG_DONTWAIT | MSG_NOSIGNAL) > 0) {
         }
         const auto start = std::chrono::steady_clock::now();
         assert(bridge::sendNonblockingFramePart(
                    slow[0], data.data(), data.size(), MSG_NOSIGNAL) == -1);
         assert(std::chrono::steady_clock::now() - start <
                std::chrono::milliseconds(100));
         assert(bridge::sendNonblockingFramePart(healthy[0], "ok", 2,
                                                 MSG_NOSIGNAL) == 2);
         char reply[2];
         assert(recv(healthy[1], reply, sizeof(reply), 0) == 2);
         assert(std::string(reply, 2) == "ok");
         for (auto fd : {slow[0], slow[1], healthy[0], healthy[1]})
           close(fd);
       });
  std::cout << scenarios << " network scenarios passed\n";
}
