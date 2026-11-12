// Política histórica del modo AP, conservada para pruebas de regresión.
// El firmware router actual usa RouterPolicy y CameraRegistry.
#pragma once
#include "client_limits.hpp"
#include <array>
#include <cstdint>
#include <mutex>

namespace bridge {
using Mac = std::array<uint8_t, 6>;
inline constexpr Mac CAMERA_MAC{0x02, 0x41, 0x52, 0x53, 0x00, 0x03};
inline constexpr char CAMERA_URL[] = "http://192.168.4.2/capture";
struct NetworkState {
  size_t phones = 0;
  bool camera = false;
};

// Identity comes from the AP driver, never from a browser-supplied label.
// An extra phone never borrows the camera slot, even when the S3 is absent.
class NetworkPolicy {
  struct Station {
    Mac mac{};
    uint16_t aid = 0;
    std::array<uint32_t, TABS_PER_PHONE> sessions{};
  };
  mutable std::mutex mutex_;
  std::array<Station, PHONE_LIMIT + 1> stations_{};

public:
  bool associate(const Mac &mac, uint16_t aid) {
    if (!aid)
      return false;
    std::lock_guard<std::mutex> lock(mutex_);
    const size_t begin = mac == CAMERA_MAC ? PHONE_LIMIT : 0;
    const size_t end = mac == CAMERA_MAC ? PHONE_LIMIT + 1 : PHONE_LIMIT;
    for (size_t i = begin; i < end; ++i) {
      auto &s = stations_[i];
      if (s.aid && s.mac == mac) {
        if (s.aid != aid)
          s = Station{mac, aid, {}};
        return true;
      }
    }
    for (size_t i = begin; i < end; ++i)
      if (!stations_[i].aid) {
        stations_[i] = Station{mac, aid, {}};
        return true;
      }
    return false;
  }
  void disconnect(const Mac &mac, uint16_t aid) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto &s : stations_)
      if (s.aid == aid && s.mac == mac)
        s = {};
  }
  bool openSession(const Mac &mac, uint32_t session) {
    if (!session || mac == CAMERA_MAC)
      return false;
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto &s : stations_)
      for (auto id : s.sessions)
        if (id == session)
          return false;
    for (size_t i = 0; i < PHONE_LIMIT; ++i) {
      auto &s = stations_[i];
      if (s.aid && s.mac == mac)
        for (auto &id : s.sessions)
          if (!id) {
            id = session;
            return true;
          }
    }
    return false;
  }
  bool validSession(uint32_t session) const {
    if (!session)
      return false;
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto &s : stations_)
      for (auto id : s.sessions)
        if (id == session)
          return true;
    return false;
  }
  void closeSession(uint32_t session) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto &s : stations_)
      for (auto &id : s.sessions)
        if (id == session)
          id = 0;
  }
  NetworkState state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    NetworkState out;
    for (size_t i = 0; i < PHONE_LIMIT; ++i)
      if (stations_[i].aid)
        ++out.phones;
    out.camera = stations_[PHONE_LIMIT].aid != 0;
    return out;
  }
};
} // namespace bridge
