#pragma once
#include "network_policy.hpp"
#include <algorithm>
namespace bridge {
// In station mode the router owns associations. Limit active controls by
// the source IPv4 obtained from the socket, not by a browser-provided ID.
class RouterPolicy {
  struct Peer { uint32_t address = 0; std::array<uint32_t, TABS_PER_PHONE> sessions{}; };
  mutable std::mutex mutex_;
  std::array<Peer, PHONE_LIMIT> peers_{};
  bool online_ = false;
public:
  void setOnline(bool value) {
    std::lock_guard<std::mutex> lock(mutex_);
    online_ = value;
    if (!value) peers_ = {};
  }
  bool openSession(uint32_t address, uint32_t session) {
    if (!address || !session) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!online_) return false;
    for (const auto &peer : peers_)
      for (auto id : peer.sessions) if (id == session) return false;
    Peer *selected = nullptr;
    for (auto &peer : peers_) if (peer.address == address) { selected = &peer; break; }
    if (!selected) for (auto &peer : peers_) if (!peer.address) { selected = &peer; break; }
    if (!selected) return false;
    for (auto &id : selected->sessions) if (!id) {
      selected->address = address;
      id = session;
      return true;
    }
    return false;
  }
  bool validSession(uint32_t session) const {
    if (!session) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!online_) return false;
    for (const auto &peer : peers_) for (auto id : peer.sessions)
      if (id == session) return true;
    return false;
  }
  void closeSession(uint32_t session) {
    if (!session) return;
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto &peer : peers_) {
      for (auto &id : peer.sessions) if (id == session) id = 0;
      if (std::all_of(peer.sessions.begin(), peer.sessions.end(), [](uint32_t id){return !id;})) peer = {};
    }
  }
  NetworkState state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    NetworkState result;
    for (const auto &peer : peers_) if (peer.address) ++result.phones;
    return result;
  }
};
}

