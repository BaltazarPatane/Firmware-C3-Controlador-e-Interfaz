#!/usr/bin/env python3
"""Sólo pruebas: C3 HTTP simulada + dos capturas FFmpeg de colores.

No se instala en Debian. El servidor de producción no contiene /__qa.
"""
import functools
import json
import signal
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'debian'))
import camara_http as cam

done = threading.Event()
peer = {}
peer_lock = threading.Lock()


class SyntheticCamera:
    def __init__(self, color):
        self.cfg = {**cam.DEFAULTS, 'bind': '127.0.0.1', 'http_port': 0, 'c3_address': '127.0.0.1'}
        self.stop = threading.Event()
        self.store = cam.FrameStore(self.cfg)
        self.server = cam.CameraHTTPServer(self.cfg, self.store, self.stop)
        self.cfg['http_port'] = self.server.server_address[1]
        self.command = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-re',
                        '-f', 'lavfi', '-i', f'color=c={color}:s=320x240:r=25', '-an',
                        '-c:v', 'mjpeg', '-threads', '1', '-q:v', '4', '-flush_packets', '1', '-f', 'mjpeg', 'pipe:1']
        self.capture_stop = None
        self.worker = None
        self.http = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http.start()

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        self.capture_stop = threading.Event()
        self.worker = cam.CaptureWorker(self.cfg, self.store, self.capture_stop, self.command)
        self.worker.start()

    def pause(self):
        if self.capture_stop:
            self.capture_stop.set()
            self.worker.join(4)

    def close(self):
        self.pause()
        self.stop.set(); self.server.shutdown(); self.server.server_close()


first, second = SyntheticCamera('blue'), SyntheticCamera('green')
active = first
first.start(); second.start()


def receive():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1', cam.UDP_PORT)); sock.settimeout(0.25)
        while not done.is_set():
            try:
                data, source = sock.recvfrom(128)
            except socket.timeout:
                continue
            fields = data.decode().split('|')
            if len(fields) == 6 and fields[:2] == ['ARS_CAM1', 'ARS_CAJA1']:
                with peer_lock:
                    peer.update(available=True, baseUrl=f'http://{source[0]}:{int(fields[2])}', seen=time.monotonic())


def announce():
    while not done.wait(0.2):
        try:
            cam.Announcer(active.cfg, active.store, done).send()
        except OSError:
            pass


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def json(self, value):
        payload = json.dumps(value).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload))); self.send_header('Cache-Control', 'no-store')
        self.end_headers(); self.wfile.write(payload)

    def do_GET(self):
        global active
        target = urlsplit(self.path)
        if target.path == '/api/camera':
            with peer_lock:
                return self.json(dict(peer) if peer and time.monotonic()-peer['seen'] < 8 else dict(available=False))
        if target.path == '/__qa':
            action = parse_qs(target.query).get('action', ['status'])[0]
            if action == 'pause': first.pause()
            if action == 'resume': first.start()
            if action == 'switch': active = second
            return self.json(dict(first=first.store.health(), second=second.store.health()))
        if target.path == '/ws':
            self.send_error(503); return
        return super().do_GET()


threads = [threading.Thread(target=receive, daemon=True), threading.Thread(target=announce, daemon=True)]
for thread in threads: thread.start()
http = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT/'c3/aplicacion/out')))
serving = threading.Thread(target=http.serve_forever, daemon=True); serving.start()
for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, lambda *_: done.set())
print(json.dumps(dict(url=f'http://127.0.0.1:{http.server_address[1]}')), flush=True)
done.wait()
http.shutdown(); http.server_close(); first.close(); second.close()
