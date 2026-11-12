#include "../c3/firmware/main/camera_registry.hpp"
#include <cassert>
#include <iostream>

int main(int argc, char **argv) {
  assert(argc == 2);
  bridge::CameraRegistry registry;
  assert(registry.update(argv[1], "ARS_CAJA1", 0xc0a800e3, 0xc0a800fe, 0xffffff00, 100));
  auto peer = registry.snapshot(101);
  assert(peer.available);
  assert(peer.baseUrl() == "http://192.168.0.227:8080");
  assert(peer.sequence == 7 && peer.frame_age_ms == ARS_CAMERA_NO_FRAME);
  assert(!registry.snapshot(100 + ARS_CAMERA_TTL_MS + 1).available);
  assert(!registry.update(argv[1], "OTRA_CAJA", 0xc0a800e3, 0xc0a800fe, 0xffffff00, 102));
  std::cout << "1 Python Debian -> C3 registry integration scenario passed\n";
}
