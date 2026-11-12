#include "../main/bridge_protocol.hpp"
#include "../main/network_policy.hpp"
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

using namespace bridge;
Mac phone(int n) { return Mac{2, 0, 0, 0, 0, static_cast<uint8_t>(n)}; }
bool parse(const char *text) {
  Request r;
  auto *o = cJSON_Parse(text);
  const bool ok = parseRequest(o, r);
  cJSON_Delete(o);
  return ok;
}
int main() {
  int tests = 0;
  const auto test = [&](const char *name, auto fn) {
    fn();
    ++tests;
    std::cout << "OK " << name << '\n';
  };
  test("five phones reserve the camera slot while camera is off", [] {
    NetworkPolicy p;
    for (int i = 1; i <= 5; ++i)
      assert(p.associate(phone(i), i));
    assert(!p.associate(phone(6), 6));
    assert(p.state().phones == 5 && !p.state().camera);
  });
  test("camera can join after five phones", [] {
    NetworkPolicy p;
    for (int i = 1; i <= 5; ++i)
      assert(p.associate(phone(i), i));
    assert(p.associate(CAMERA_MAC, 6));
    assert(p.state().camera && p.state().phones == 5);
  });
  test("camera can join before five phones", [] {
    NetworkPolicy p;
    assert(p.associate(CAMERA_MAC, 1));
    for (int i = 1; i <= 5; ++i)
      assert(p.associate(phone(i), i + 1));
    assert(!p.associate(phone(6), 7));
  });
  test("repeated rejected phones do not evict current sessions", [] {
    NetworkPolicy p;
    for (int i = 1; i <= 5; ++i) {
      assert(p.associate(phone(i), i));
      assert(p.openSession(phone(i), i));
    }
    for (int i = 0; i < 1000; ++i) {
      assert(!p.associate(phone(6), 6));
      p.disconnect(phone(6), 6);
    }
    for (int i = 1; i <= 5; ++i)
      assert(p.validSession(i));
  });
  test("two tabs per phone, ten total, no third tab", [] {
    NetworkPolicy p;
    for (int i = 1; i <= 5; ++i) {
      p.associate(phone(i), i);
      assert(p.openSession(phone(i), 2 * i));
      assert(p.openSession(phone(i), 2 * i + 1));
      assert(!p.openSession(phone(i), 100 + i));
    }
    p.closeSession(2);
    assert(p.openSession(phone(1), 20));
    assert(p.validSession(7));
  });
  test("camera and unknown stations cannot get a control socket", [] {
    NetworkPolicy p;
    p.associate(CAMERA_MAC, 1);
    assert(!p.openSession(CAMERA_MAC, 9));
    assert(!p.openSession(phone(1), 10));
    assert(!p.associate(phone(1), 0));
  });
  test("phone disconnect releases slots without touching peers", [] {
    NetworkPolicy p;
    p.associate(phone(1), 1);
    p.associate(phone(2), 2);
    p.openSession(phone(1), 1);
    p.openSession(phone(2), 2);
    p.disconnect(phone(1), 1);
    assert(!p.validSession(1) && p.validSession(2));
    assert(p.associate(phone(4), 3));
  });
  test("stale disconnect cannot remove a newly associated AID", [] {
    NetworkPolicy p;
    p.associate(phone(1), 1);
    p.openSession(phone(1), 1);
    p.associate(phone(1), 5);
    assert(!p.validSession(1));
    p.openSession(phone(1), 2);
    p.disconnect(phone(1), 1);
    assert(p.validSession(2));
    assert(!p.openSession(phone(1), 2));
  });
  test("camera cycling never invalidates printer sessions", [] {
    NetworkPolicy p;
    p.associate(phone(1), 1);
    p.openSession(phone(1), 10);
    for (int i = 0; i < 1000; ++i) {
      p.associate(CAMERA_MAC, 4);
      p.disconnect(CAMERA_MAC, 4);
      assert(p.validSession(10));
    }
  });
  test("concurrent session readers and camera events stay consistent", [] {
    NetworkPolicy p;
    p.associate(phone(1), 1);
    p.openSession(phone(1), 10);
    std::vector<std::thread> threads;
    for (int n = 0; n < 8; ++n)
      threads.emplace_back([&] {
        for (int i = 0; i < 1000; ++i) {
          p.associate(CAMERA_MAC, 4);
          p.disconnect(CAMERA_MAC, 4);
          assert(p.validSession(10));
          assert(p.state().phones == 1);
        }
      });
    for (auto &t : threads)
      t.join();
  });
  test("protocol 3 accepts only supported messages", [] {
    for (auto text :
         {R"({"type":"hello","protocol":3})", R"({"type":"ping"})",
          R"({"type":"discard"})",
          R"({"type":"command","id":1,"text":"M119","job":false})",
          R"({"type":"batch","id":2,"texts":["G91","G1 X1","G90"]})",
          R"({"type":"control","id":4,"action":"pause"})"})
      assert(parse(text));
    for (auto text :
         {R"({"type":"hello","protocol":2})", R"({"type":"job","job":{}})",
          R"({"type":"jobAction","action":"pause"})",
          R"({"type":"command","id":1,"text":"G1 X1","job":true})"})
      assert(!parse(text));
  });
  test("malformed IDs, oversized batches and command strings are rejected", [] {
    for (auto text :
         {"[]", R"({"type":"command","id":0,"text":"M119"})",
          R"({"type":"command","id":1.5,"text":"M119"})",
          R"({"type":"batch","id":4294967295,"texts":["G91","G90"]})",
          R"({"type":"batch","id":1,"texts":[]})",
          R"({"type":"control","id":1,"action":"cancel"})",
          R"({"type":"command","id":1,"text":""})"})
      assert(!parse(text));
    std::string longline = "{\"type\":\"command\",\"id\":1,\"text\":\"M117 " +
                           std::string(80, 'x') + "\"}";
    assert(!parse(longline.c_str()));
  });
  std::cout << tests << " policy/protocol scenarios passed\n";
}
