#pragma once
#include "client_limits.hpp"
#include <array>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>

namespace bridge {
struct NetworkMessage {
  uint32_t session;
  std::string json;
};
enum class NetworkKind { Control, Telemetry, Status };

// ACKs have their own byte budget. Console history cannot consume that reserve.
// Only the newest status for each client is retained. Producers never wait for
// WiFi or for an empty queue, and disconnecting one client preserves the rest.
class Outbox {
  struct Status {
    uint32_t session = 0;
    std::optional<NetworkMessage> message;
  };
  std::mutex mutex_;
  std::array<Status, MAX_CLIENTS> status_;
  std::deque<NetworkMessage> control_, telemetry_;
  size_t control_bytes_ = 0, telemetry_bytes_ = 0, next_status_ = 0;
  bool prefer_telemetry_ = false;
  static constexpr size_t BYTE_LIMIT = 16384, COUNT_LIMIT = 64;
  static std::optional<NetworkMessage> take(std::deque<NetworkMessage> &queue,
                                            size_t &bytes) {
    if (queue.empty())
      return {};
    NetworkMessage message = std::move(queue.front());
    queue.pop_front();
    bytes -= message.json.size();
    return message;
  }

public:
  bool addClient(uint32_t session) {
    std::lock_guard<std::mutex> guard(mutex_);
    for (auto &slot : status_)
      if (slot.session == session)
        return true;
    for (auto &slot : status_)
      if (!slot.session) {
        slot.session = session;
        return true;
      }
    return false;
  }
  void removeClient(uint32_t session) {
    std::lock_guard<std::mutex> guard(mutex_);
    for (auto &slot : status_)
      if (slot.session == session) {
        slot.message.reset();
        slot.session = 0;
      }
    const auto remove = [&](auto &queue, size_t &bytes) {
      for (auto it = queue.begin(); it != queue.end();) {
        if (it->session == session) {
          bytes -= it->json.size();
          it = queue.erase(it);
        } else
          ++it;
      }
    };
    remove(control_, control_bytes_);
    remove(telemetry_, telemetry_bytes_);
  }
  bool push(NetworkMessage message, NetworkKind kind) {
    std::lock_guard<std::mutex> guard(mutex_);
    Status *slot = nullptr;
    for (auto &candidate : status_)
      if (candidate.session == message.session)
        slot = &candidate;
    if (!slot)
      return false;
    if (kind == NetworkKind::Status) {
      slot->message = std::move(message);
      return true;
    }
    auto &queue = kind == NetworkKind::Control ? control_ : telemetry_;
    auto &bytes =
        kind == NetworkKind::Control ? control_bytes_ : telemetry_bytes_;
    if (queue.size() >= COUNT_LIMIT || bytes + message.json.size() > BYTE_LIMIT)
      return false;
    bytes += message.json.size();
    queue.push_back(std::move(message));
    return true;
  }
  std::optional<NetworkMessage> pop() {
    std::lock_guard<std::mutex> guard(mutex_);
    if (!control_.empty())
      return take(control_, control_bytes_);
    if (prefer_telemetry_ && !telemetry_.empty()) {
      prefer_telemetry_ = false;
      return take(telemetry_, telemetry_bytes_);
    }
    for (size_t i = 0; i < status_.size(); ++i) {
      const auto index = (next_status_ + i) % status_.size();
      auto &slot = status_[index];
      if (slot.message) {
        auto message = std::move(slot.message);
        slot.message.reset();
        next_status_ = (index + 1) % status_.size();
        prefer_telemetry_ = true;
        return message;
      }
    }
    return take(telemetry_, telemetry_bytes_);
  }
};
} // namespace bridge
