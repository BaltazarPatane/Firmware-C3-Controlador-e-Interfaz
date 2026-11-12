import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

import camara_http as cam

JPEG = b'\xff\xd8test-jpeg\xff\xd9'


def eventually(predicate, timeout=4):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class FramesTest(unittest.TestCase):
    def test_validation_and_limits(self):
        self.assertEqual(cam.validate_config({})['send_fps'], 25)
        for cfg in ({'send_fps': 30}, {'width': True}, {'width': 4000},
                    {'http_port': 80}, {'stall_timeout': float('nan')},
                    {'pair_group': 'a|b'}, {'c3_address': '0.0.0.0'},
                    {'max_clients': 6}, {'port': '/dev/ttyACM0'}):
            with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                cam.validate_config(cfg)

    def test_native_mjpeg_copy_no_reencode(self):
        args = cam.ffmpeg_command(cam.DEFAULTS)
        self.assertIn('mjpeg', args)
        self.assertEqual(args[args.index('-c:v') + 1], 'copy')
        self.assertEqual(args[args.index('-flush_packets') + 1], '1')

    def test_fragmentation_noise_multiple_frames(self):
        stream = b'noise' + JPEG + JPEG + b'\xff'
        self.assertEqual(list(cam.jpeg_frames(bytes([byte]) for byte in stream)), [JPEG, JPEG])
        self.assertEqual(list(cam.jpeg_frames([JPEG * 100])), [JPEG] * 100)

    def test_oversized_frame_recovery_bounded(self):
        errors = []
        result = list(cam.jpeg_frames([b'\xff\xd8' + b'x' * (cam.MAX_JPEG + 100), b'\xff\xd9', JPEG], lambda: errors.append(1)))
        self.assertEqual(result, [JPEG])
        self.assertTrue(errors)

    def test_pacer_actual_thirty_to_twentyfive(self):
        pacer = cam.FramePacer(25)
        accepted = sum(pacer.accept(n / 30) for n in range(300))
        self.assertEqual(accepted, 250)
        self.assertTrue(pacer.accept(1000))
        self.assertFalse(pacer.accept(1000.001))

    def test_freshness_sequence_rates(self):
        now = [10.0]
        store = cam.FrameStore(cam.DEFAULTS, lambda: now[0])
        self.assertIsNone(store.current())
        self.assertEqual(store.age_ms(), cam.NO_FRAME)
        for n in range(26):
            now[0] = 10 + n / 25
            store.source(); store.publish(JPEG)
        self.assertEqual(store.health()['published_fps'], 25)
        self.assertEqual(store.health()['source_fps'], 25)
        self.assertEqual(store.health()['jpeg_bytes'], len(JPEG))
        self.assertGreater(store.health()['mbps_per_view'], 0)
        now[0] += 3
        self.assertIsNone(store.current())
        self.assertFalse(store.health()['active'])
        store.publish(JPEG)
        self.assertTrue(store.health()['active'])

    def test_only_latest_frame_and_waiter(self):
        store = cam.FrameStore(cam.DEFAULTS)
        store.publish(JPEG)
        for n in range(100):
            store.publish(b'\xff\xd8' + str(n).encode() + b'\xff\xd9')
        self.assertEqual(store.current()[1], b'\xff\xd899\xff\xd9')
        self.assertEqual(store.current()[0], 101)
        self.assertIsNone(store.wait_after(101, timeout=0.001))

    def test_store_rejects_invalid_jpeg(self):
        store = cam.FrameStore(cam.DEFAULTS)
        for value in (b'', b'not jpeg', b'\xff\xd8' + b'x' * cam.MAX_JPEG + b'\xff\xd9'):
            with self.assertRaises(ValueError):
                store.publish(value)


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {**cam.DEFAULTS, 'bind': '127.0.0.1', 'http_port': 0, 'frame_stale_ms': 650}
        self.stop = threading.Event()
        self.store = cam.FrameStore(self.cfg)
        self.server = cam.CameraHTTPServer(self.cfg, self.store, self.stop)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.02})
        self.thread.start()
        self.connections = []

    def tearDown(self):
        self.stop.set()
        for conn in self.connections:
            conn.close()
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def request(self, path, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        self.connections.append(connection)
        connection.request(method, path)
        return connection, connection.getresponse()

    def test_no_camera_health_and_503(self):
        _, response = self.request('/health')
        self.assertEqual(response.status, 200)
        self.assertFalse(json.load(response)['active'])
        _, response = self.request('/capture')
        self.assertEqual(response.status, 503)
        self.assertEqual(response.getheader('Retry-After'), '1')

    def test_jpeg_cors_etag_and_head(self):
        self.store.publish(JPEG)
        _, response = self.request('/capture?timestamp=1')
        tag = response.getheader('ETag')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
        self.assertIn('ETag', response.getheader('Access-Control-Expose-Headers'))
        self.assertEqual(response.read(), JPEG)
        self.store.publish(JPEG)
        _, response = self.request('/capture', method='HEAD')
        self.assertNotEqual(tag, response.getheader('ETag'))
        self.assertEqual(response.read(), b'')
        self.assertEqual(int(response.getheader('Content-Length')), len(JPEG))

    def test_no_filesystem_and_preflight(self):
        for path in ('/etc/passwd', '/../camara_http.py', '/favicon.ico'):
            _, response = self.request(path)
            self.assertEqual(response.status, 404)
            response.read()
        _, response = self.request('/stream', method='OPTIONS')
        self.assertEqual(response.status, 204)
        response.read()

    def test_mjpeg_framing_and_latest_after_burst(self):
        self.store.publish(JPEG)
        _, response = self.request('/stream')
        self.assertEqual(response.status, 200)
        self.assertIn('boundary=frame', response.getheader('Content-Type'))
        def frame():
            while response.readline().strip() != b'--frame':
                pass
            headers = {}
            while True:
                line = response.readline().strip()
                if not line:
                    break
                key, value = line.split(b':', 1)
                headers[key] = value.strip()
            return headers, response.read(int(headers[b'Content-Length']))
        _, first = frame()
        self.assertEqual(first, JPEG)
        latest = b'\xff\xd8final\xff\xd9'
        for _ in range(100):
            self.store.publish(latest)
        headers, image = frame()
        self.assertEqual(image, latest)
        self.assertGreater(int(headers[b'X-Frame-Sequence']), 1)

    def test_raw_frames_can_be_read_without_multipart_browser_handling(self):
        self.store.publish(JPEG)
        _, response = self.request('/frames?client=0')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Type'), 'application/octet-stream')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
        expected = (b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
                    str(len(JPEG)).encode() + b'\r\nX-Frame-Sequence: 1\r\n\r\n' + JPEG + b'\r\n')
        self.assertEqual(response.read(len(expected)), expected)

    def test_six_streams_keep_health_and_seventh_503(self):
        self.store.publish(JPEG)
        for n in range(6):
            _, response = self.request('/frames' if n % 2 else '/stream')
            self.assertEqual(response.status, 200)
        _, response = self.request('/health')
        self.assertEqual(json.load(response)['streams'], 6)
        _, response = self.request('/frames')
        self.assertEqual(response.status, 503)
        response.read()

    def test_stale_not_served_and_returns_after_recovery(self):
        self.store.publish(JPEG)
        self.assertTrue(eventually(lambda: self.store.current() is None, 2))
        _, response = self.request('/capture')
        self.assertEqual(response.status, 503)
        response.read()
        self.store.publish(JPEG)
        _, response = self.request('/capture')
        self.assertEqual(response.read(), JPEG)

    def test_idle_socket_does_not_keep_client_slot(self):
        idle = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        try:
            self.assertTrue(eventually(lambda: self.store.clients == 1))
            self.assertTrue(eventually(lambda: self.store.clients == 0, 4))
        finally:
            idle.close()


class LifecycleTest(unittest.TestCase):
    def test_udp_packet_and_source_address(self):
        cfg = {**cam.DEFAULTS, 'c3_address': '127.0.0.1'}
        store = cam.FrameStore(cfg)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
            try:
                listener.bind(('127.0.0.1', cam.UDP_PORT))
            except OSError as error:
                self.skipTest(str(error))
            listener.settimeout(2)
            worker = cam.Announcer(cfg, store, threading.Event())
            worker.send()
            message, peer = listener.recvfrom(128)
        fields = message.decode().split('|')
        self.assertEqual(fields[:3], ['ARS_CAM1', 'ARS_CAJA1', '8080'])
        self.assertEqual(int(fields[-1]), cam.NO_FRAME)
        self.assertEqual(peer[0], store.health()['address'])
        self.assertEqual(store.health()['announcement_count'], 1)

    def test_notify_exact_format_with_abstract_socket(self):
        client = MagicMock()
        with patch.dict(os.environ, {'NOTIFY_SOCKET': '@test-caja'}), patch.object(cam.socket, 'socket') as constructor:
            constructor.return_value.__enter__.return_value = client
            self.assertTrue(cam.sd_notify('READY=1\nWATCHDOG=1'))
        client.connect.assert_called_once_with('\0test-caja')
        client.sendall.assert_called_once_with(b'READY=1\nWATCHDOG=1')

    def test_notify_real_datagram(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = str(Path(temporary) / 'notify.sock')
            try:
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
                listener.bind(path)
            except PermissionError as error:
                self.skipTest(f'El entorno no permite AF_UNIX SOCK_DGRAM: {error}')
            with listener, patch.dict(os.environ, {'NOTIFY_SOCKET': path}):
                listener.settimeout(1)
                self.assertTrue(cam.sd_notify('READY=1'))
                self.assertEqual(listener.recv(100), b'READY=1')

    def test_capture_watchdog_kills_stalled_process(self):
        cfg = {**cam.DEFAULTS, 'stall_timeout': 2}
        stop = threading.Event()
        store = cam.FrameStore(cfg)
        worker = cam.CaptureWorker(cfg, store, stop, [sys.executable, '-c', 'import time; time.sleep(30)'])
        worker.start()
        try:
            self.assertTrue(eventually(lambda: store.restarts >= 1, 5))
            self.assertIn('sin fotogramas', store.capture_error)
        finally:
            stop.set(); worker.join(4)
        self.assertFalse(worker.is_alive())

    def test_cli_without_camera_stays_up_then_sigterm(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        proc = subprocess.Popen([sys.executable, str(Path(cam.__file__).resolve()),
                                 '--camera', '/dev/camara-inexistente-caja', '--bind', '127.0.0.1',
                                 '--http-port', str(port), '--c3-address', '127.0.0.1'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def running():
            try:
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                conn.request('GET', '/health')
                value = json.load(conn.getresponse()); conn.close()
                return value['active'] is False and proc.poll() is None
            except OSError:
                return False
        try:
            self.assertTrue(eventually(running))
        finally:
            proc.terminate()
            proc.wait(timeout=8)
        self.assertEqual(proc.returncode, 0)


if __name__ == '__main__':
    unittest.main()
