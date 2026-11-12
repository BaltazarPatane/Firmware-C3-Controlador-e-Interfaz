#pragma once
#include "camera_announce.h"
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>

namespace bridge {
struct CameraPeer {
  bool available = false;
  uint32_t address = 0; // Host-order IPv4; never supplied by the message body.
  uint16_t port = 80;
  uint32_t boot = 0, sequence = 0, frame_age_ms = ARS_CAMERA_NO_FRAME;
  uint64_t seen_at = 0;
  std::string baseUrl() const {
    if (!available) return "";
    char out[48];
    std::snprintf(out, sizeof(out), "http://%u.%u.%u.%u:%u",
                  static_cast<unsigned>((address >> 24) & 255),
                  static_cast<unsigned>((address >> 16) & 255),
                  static_cast<unsigned>((address >> 8) & 255),
                  static_cast<unsigned>(address & 255), static_cast<unsigned>(port));
    return out;
  }
};
class CameraRegistry {
  mutable std::mutex mutex_;
  CameraPeer peer_;
  bool seen_ = false;
public:
  bool update(const char *message, const char *group, uint32_t source,
              uint32_t local, uint32_t mask, uint64_t now) {
    const uint32_t host = source & ~mask;
    if ((source & mask) != (local & mask) || !host || host == ~mask || source == local) return false;
    ars_camera_announcement parsed = {};
    if (!ars_camera_parse(message, group, &parsed)) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    peer_ = CameraPeer{true, source, parsed.port, parsed.boot,
                       parsed.sequence, parsed.frame_age_ms, now};
    seen_ = true;
    return true;
  }
  CameraPeer snapshot(uint64_t now) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto out = peer_;
    out.available = seen_ && now >= out.seen_at && now-out.seen_at <= ARS_CAMERA_TTL_MS;
    return out;
  }
  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    peer_ = {};
    seen_ = false;
  }
};
}

