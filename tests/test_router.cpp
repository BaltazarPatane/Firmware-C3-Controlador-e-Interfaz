#include "../c3/firmware/main/router_policy.hpp"
#include "../c3/firmware/main/camera_registry.hpp"
#include "../c3/firmware/main/bridge_core.hpp"
#include "../c3/firmware/main/bridge_outbox.hpp"
#include "../c3/firmware/main/bridge_json.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
#include <random>
#include <thread>
#include <vector>

int main() {
  int count = 0;
  const auto test = [&](const char *name, auto body) {
    body(); ++count; std::cout << "OK " << name << '\n';
  };
  test("five actual source IPs, two tabs each; released slots can be reused", [] {
    bridge::RouterPolicy p;
    assert(!p.openSession(1, 1));
    p.setOnline(true);
    for (uint32_t phone = 1; phone <= 5; ++phone) {
      assert(p.openSession(phone, phone * 2));
      assert(p.openSession(phone, phone * 2 + 1));
      assert(!p.openSession(phone, phone * 2 + 10));
    }
    assert(p.state().phones == 5);
    for (int attempt = 0; attempt < 1000; ++attempt)
      assert(!p.openSession(6, 30));
    for (uint32_t session = 2; session <= 11; ++session)
      assert(p.validSession(session));
    assert(!p.openSession(3, 2));
    p.closeSession(2);
    assert(p.openSession(1, 20));
    p.closeSession(20); p.closeSession(3);
    assert(p.state().phones == 4);
    assert(p.openSession(6, 30));
    assert(p.validSession(4) && p.validSession(30));
  });
  test("five devices and camera coexist through every control layer", [] {
    bridge::RouterPolicy network;
    bridge::Outbox outbox;
    unsigned writes = 0;
    bridge::Core core([](const bridge::Event &) {}, [&](const std::string &) {
      ++writes; return true;
    });
    network.setOnline(true);
    for (uint32_t phone = 1; phone <= 5; ++phone) {
      for (uint32_t tab = 0; tab < 2; ++tab) {
        const auto id = phone * 2 + tab;
        assert(network.openSession(phone, id));
        assert(outbox.addClient(id));
        core.attach(id);
        assert(core.attached(id));
        assert(outbox.push({id, "state"}, bridge::NetworkKind::Status));
      }
    }
    assert(!writes && core.clients() == 10 && network.state().phones == 5);
    core.attach(99);
    assert(!core.attached(99) && !outbox.addClient(99));
    assert(!network.openSession(6, 99));
    bridge::CameraRegistry camera;
    assert(camera.update("ARS_CAM1|ARS_CAJA1|8080|1|5|10", "ARS_CAJA1",
                         0xc0a80005, 0xc0a800fe, 0xffffff00, 500));
    assert(camera.snapshot(501).available && network.state().phones == 5);
    auto *message = bridge::makeMessage(core, {"status"}, 2, 1, network.state());
    assert(message && cJSON_GetObjectItem(message, "phoneLimit")->valuedouble == 5);
    assert(cJSON_GetObjectItem(message, "clients")->valuedouble == 10);
    cJSON_Delete(message);
    for (uint32_t id = 2; id <= 11; ++id) {
      auto message = outbox.pop();
      assert(message && message->session == id && message->json == "state");
    }
    assert(!outbox.pop());
    network.closeSession(10); network.closeSession(11);
    core.detach(10); core.detach(11);
    outbox.removeClient(10); outbox.removeClient(11);
    assert(network.openSession(6, 99) && outbox.addClient(99));
    core.attach(99);
    assert(core.attached(99) && camera.snapshot(501).available);
    for (uint32_t id = 2; id <= 9; ++id) assert(network.validSession(id));
  });
  test("WiFi loss permanently invalidates old sessions, including after reconnection", [] {
    bridge::RouterPolicy p;
    p.setOnline(true); assert(p.openSession(1, 10));
    p.setOnline(false);
    assert(!p.validSession(10)); assert(p.state().phones == 0);
    p.setOnline(true);
    assert(!p.validSession(10));
    assert(p.openSession(1, 11)); assert(!p.validSession(10));
    assert(!p.openSession(0, 12)); assert(!p.openSession(1, 0));
  });
  test("Debian camera uses shared C wire format without assuming its DHCP address", [] {
    char message[ARS_CAMERA_MESSAGE_MAX];
    assert(ars_camera_format(message, sizeof(message), "ARS_CAJA1", 80, 123, 99, 40));
    bridge::CameraRegistry registry;
    assert(registry.update(message, "ARS_CAJA1", 0xc0a80005, 0xc0a800fe, 0xffffff00, 1000));
    auto peer = registry.snapshot(1000);
    assert(peer.baseUrl() == "http://192.168.0.5:80" && peer.sequence == 99);
    assert(registry.update(message, "ARS_CAJA1", 0xc0a8009f, 0xc0a800fe, 0xffffff00, 2000));
    assert(registry.snapshot(2000).baseUrl() == "http://192.168.0.159:80");
    assert(registry.snapshot(10000).available);
    assert(!registry.snapshot(10001).available);
    assert(registry.snapshot(10001).baseUrl().empty());
    registry.clear(); assert(!registry.snapshot(2000).available);
  });
  test("foreign subnet, local/broadcast addresses and wrong group cannot replace camera", [] {
    bridge::CameraRegistry registry;
    const char *message = "ARS_CAM1|ARS_CAJA1|80|1|0|4294967295";
    for (auto source : {0xc0a80105u, 0xc0a800feu, 0xc0a800ffu, 0xc0a80000u})
      assert(!registry.update(message, "ARS_CAJA1", source, 0xc0a800fe, 0xffffff00, 0));
    assert(!registry.update(message, "OTRA_CAJA", 0xc0a80005, 0xc0a800fe, 0xffffff00, 0));
    assert(registry.update(message, "ARS_CAJA1", 0xc0a80005, 0xc0a800fe, 0xffffff00, 0));
    assert(registry.snapshot(0).frame_age_ms == ARS_CAMERA_NO_FRAME);
  });
  test("announcement parser rejects truncation, overflow, signs and appended fields", [] {
    ars_camera_announcement parsed = {};
    for (const char *message : {"", "ARS_CAM1|", "ARS_CAM1|ARS_CAJA1|0|1|2|3",
      "ARS_CAM1|ARS_CAJA1|65536|1|2|3", "ARS_CAM1|ARS_CAJA1|80|4294967296|2|3",
      "ARS_CAM1|ARS_CAJA1|80|-1|2|3", "ARS_CAM1|ARS_CAJA1|80|1|+2|3",
      "ARS_CAM1|ARS_CAJA1|80|1|2|3|4", "ARS_CAM1|ARS_CAJA1|80|1|2|",
      "ARS_CAM1|ARS_CAJA1|80|999999999999999999999999999999999999|2|3"})
      assert(!ars_camera_parse(message, "ARS_CAJA1", &parsed));
    char small[5]; assert(!ars_camera_format(small, sizeof(small), "ARS_CAJA1", 80, 1, 2, 3));
    std::mt19937 generator(123);
    for (int i = 0; i < 10000; ++i) {
      char input[128] = {};
      const auto n = generator() % 127;
      for (size_t j = 0; j < n; ++j) input[j] = static_cast<char>(1 + generator() % 127);
      (void)ars_camera_parse(input, "ARS_CAJA1", &parsed);
    }
  });
  test("camera and control registry can be read concurrently without mixed addresses", [] {
    bridge::CameraRegistry camera;
    bridge::RouterPolicy network;
    network.setOnline(true);
    assert(network.openSession(1, 10));
    std::vector<std::thread> threads;
    for (int i = 0; i < 4; ++i) threads.emplace_back([&] {
      for (int j = 0; j < 2000; ++j) {
        assert(camera.update("ARS_CAM1|ARS_CAJA1|80|1|5|10", "ARS_CAJA1",
                              0xc0a80005, 0xc0a800fe, 0xffffff00, 500));
        assert(camera.snapshot(501).baseUrl() == "http://192.168.0.5:80");
        assert(network.validSession(10));
      }
    });
    for (auto &thread : threads) thread.join();
  });
  std::cout << count << " router integration tests passed\n";
}
