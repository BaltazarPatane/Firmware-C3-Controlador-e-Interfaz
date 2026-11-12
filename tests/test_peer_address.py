"""Execute the firmware's actual socket-address policy with controlled peers.

Only the ESP HTTP socket accessor, getpeername and logging are replaced.
The production peer_address function is compiled unchanged on the host.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('g++'), 'g++ is required for socket-policy tests')
class PeerAddressTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / 'c3/firmware/main/main.cpp').read_text()
        start = source.index('static bool peer_address(')
        end = source.index('\nstatic esp_err_t websocket_pre_handshake', start)
        function = source[start:end]
        cls.temporary = tempfile.TemporaryDirectory(prefix='peer-address-test-')
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        harness = r'''
#include <arpa/inet.h>
#include <sys/socket.h>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
struct httpd_req_t {};
static sockaddr_storage fixture{};
static socklen_t fixture_length = 0;
static int fixture_fd = 7, fixture_error = 0;
static uint32_t local_address = 0xc0a800fe, local_mask = 0xffffff00;
static int httpd_req_to_sockfd(httpd_req_t *) { return fixture_fd; }
static int fixture_getpeername(int, sockaddr *out, socklen_t *length) {
  if (fixture_error) { errno = EBADF; return -1; }
  std::memcpy(out, &fixture, fixture_length);
  *length = fixture_length;
  return 0;
}
#define getpeername fixture_getpeername
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
''' + function + r'''
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  const int family = std::atoi(argv[1]);
  if (family == 4) {
    auto *v4 = reinterpret_cast<sockaddr_in *>(&fixture);
    v4->sin_family = AF_INET;
    if (inet_pton(AF_INET, argv[2], &v4->sin_addr) != 1) return 3;
    fixture_length = sizeof(*v4);
  } else {
    auto *v6 = reinterpret_cast<sockaddr_in6 *>(&fixture);
    v6->sin6_family = AF_INET6;
    if (inet_pton(AF_INET6, argv[2], &v6->sin6_addr) != 1) return 3;
    fixture_length = sizeof(*v6);
  }
  const int mode = std::atoi(argv[3]);
  if (mode == 1) fixture_length = sizeof(sa_family_t);
  if (mode == 2) fixture_fd = -1;
  if (mode == 3) fixture_error = 1;
  httpd_req_t req{};
  uint32_t address = 0;
  const bool accepted = peer_address(&req, address);
  std::printf("%d %08x\n", accepted, address);
}
'''
        path = root / 'peer_address.cpp'
        path.write_text(harness)
        cls.executable = root / 'peer_address'
        subprocess.run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        str(path), '-o', str(cls.executable)], check=True)

    def peer(self, family, address, mode=0):
        result = subprocess.run([str(self.executable), str(family), address, str(mode)],
                                check=True, capture_output=True, text=True)
        accepted, normalized = result.stdout.split()
        return accepted == '1', int(normalized, 16)

    def test_ipv4_and_mapped_ipv4_identify_the_same_local_client(self):
        self.assertEqual(self.peer(4, '192.168.0.26'), (True, 0xc0a8001a))
        self.assertEqual(self.peer(6, '::ffff:192.168.0.26'), (True, 0xc0a8001a))

    def test_foreign_subnet_and_own_address_remain_rejected(self):
        for family, address in [(4, '192.168.1.26'), (6, '::ffff:192.168.1.26'),
                                (4, '192.168.0.254'), (6, '::ffff:192.168.0.254'),
                                (4, '0.0.0.0'), (6, '::ffff:0.0.0.0')]:
            with self.subTest(family=family, address=address):
                self.assertFalse(self.peer(family, address)[0])

    def test_native_and_nonmapped_ipv6_remain_rejected(self):
        for address in ['::1', '2001:db8::1', '::192.168.0.26', '::fffe:c0a8:1a']:
            with self.subTest(address=address):
                self.assertFalse(self.peer(6, address)[0])

    def test_truncated_address_and_socket_errors_remain_rejected(self):
        for family, address in [(4, '192.168.0.26'), (6, '::ffff:192.168.0.26')]:
            for mode in [1, 2, 3]:
                with self.subTest(family=family, mode=mode):
                    self.assertFalse(self.peer(family, address, mode)[0])


if __name__ == '__main__':
    unittest.main()
