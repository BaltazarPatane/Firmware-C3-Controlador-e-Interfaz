#pragma once
#include <cstddef>
#include <sys/socket.h>

namespace bridge {
// ESP-IDF's WebSocket sender does not retry positive partial writes. A slow
// peer is failed explicitly rather than blocking the common HTTP task.
inline int sendNonblockingFramePart(int fd, const char *data, size_t length,
                                    int flags) {
  const int written = ::send(fd, data, length, flags | MSG_DONTWAIT);
  return written == static_cast<int>(length) ? written : -1;
}
} // namespace bridge
