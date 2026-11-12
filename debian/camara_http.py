#!/usr/bin/env python3
"""Webcam MJPEG -> HTTP local y descubrimiento C3. Python estándar + FFmpeg.

Una captura compartida, último fotograma en RAM, sin grabación en disco.
El navegador recibe el video de Debian; la C3 sólo anuncia su dirección.
"""
import argparse
import collections
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import selectors
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BUILD = 'debian-direct-v1.0.1'
MAX_JPEG = 512 * 1024
UDP_PORT = 40123
NO_FRAME = 0xffffffff
DEFAULTS = dict(camera='/dev/video0', width=320, height=240, capture_fps=25,
                send_fps=25, stall_timeout=8.0, bind='0.0.0.0', http_port=8080,
                c3_address='192.168.0.254', pair_group='ARS_CAJA1',
                max_streams=6, max_clients=16, frame_stale_ms=2500)
LOG = logging.getLogger('camara-caja')


def validate_config(values):
    unknown = set(values) - set(DEFAULTS)
    if unknown:
        raise ValueError('Opciones desconocidas: ' + ', '.join(sorted(unknown)))
    cfg = {**DEFAULTS, **values}
    bounds = dict(width=(16, 1920), height=(16, 1080), capture_fps=(1, 60),
                  send_fps=(1, 60), http_port=(1024, 65535), max_streams=(1, 6),
                  max_clients=(3, 32), frame_stale_ms=(500, 15000))
    for name, (minimum, maximum) in bounds.items():
        if type(cfg[name]) is not int or not minimum <= cfg[name] <= maximum:
            raise ValueError(f'{name}: debe ser entero entre {minimum} y {maximum}')
    if cfg['send_fps'] > cfg['capture_fps']:
        raise ValueError('send_fps no puede superar capture_fps')
    if cfg['max_clients'] < cfg['max_streams'] + 2:
        raise ValueError('max_clients debe dejar dos conexiones para diagnóstico')
    timeout = cfg['stall_timeout']
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 2 <= timeout <= 120:
        raise ValueError('stall_timeout: debe estar entre 2 y 120 segundos')
    if not isinstance(cfg['camera'], str) or not cfg['camera'].startswith('/dev/') or '\x00' in cfg['camera']:
        raise ValueError('camera debe ser una ruta /dev/...')
    for name in ('bind', 'c3_address'):
        ipaddress.IPv4Address(cfg[name])
    address = ipaddress.IPv4Address(cfg['c3_address'])
    if address.is_unspecified or address.is_multicast or address == ipaddress.IPv4Address('255.255.255.255'):
        raise ValueError('c3_address debe ser la IPv4 unicast de la C3')
    if not isinstance(cfg['pair_group'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,31}', cfg['pair_group']):
        raise ValueError('pair_group: 1–31 letras ASCII, números, guiones o guiones bajos')
    return cfg


def ffmpeg_command(cfg):
    # Mantener MJPEG nativo: no decodificar/recomprimir en esta PC de 2 GB.
    return ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin',
            '-f', 'v4l2', '-input_format', 'mjpeg',
            '-framerate', str(cfg['capture_fps']),
            '-video_size', f"{cfg['width']}x{cfg['height']}",
            '-i', cfg['camera'], '-an', '-c:v', 'copy',
            '-flush_packets', '1', '-f', 'mjpeg', 'pipe:1']


def jpeg_frames(chunks, oversized=None):
    """Extrae JPEG fragmentados, con un buffer acotado incluso ante datos dañados."""
    buffer = bytearray()
    for chunk in chunks:
        # Los lectores habituales entregan 32 KiB; también acotar llamadas externas.
        for offset in range(0, len(chunk), 32768):
            buffer.extend(chunk[offset:offset + 32768])
            while True:
                start = buffer.find(b'\xff\xd8')
                if start < 0:
                    del buffer[:-1]
                    break
                if start:
                    del buffer[:start]
                end = buffer.find(b'\xff\xd9', 2)
                if end >= 0:
                    length = end + 2
                    if length <= MAX_JPEG:
                        yield bytes(buffer[:length])
                    elif oversized:
                        oversized()
                    del buffer[:length]
                    continue
                if len(buffer) > MAX_JPEG:
                    if oversized:
                        oversized()
                    del buffer[:-1]
                break


class FramePacer:
    def __init__(self, fps):
        self.interval = 1.0 / fps
        self.deadline = None

    def accept(self, now):
        if self.deadline is not None and now + 1e-9 < self.deadline:
            return False
        if self.deadline is None or now - self.deadline >= self.interval:
            self.deadline = now + self.interval
        else:
            self.deadline += self.interval
        return True


class FrameStore:
    def __init__(self, cfg, clock=time.monotonic):
        self.cfg, self.clock = cfg, clock
        self.condition = threading.Condition()
        self.boot = secrets.randbits(32)
        self.sequence, self.frame, self.frame_at = 0, None, 0.0
        self.source_frames = self.published_frames = self.published_bytes = 0
        self.oversized_count = self.restarts = self.streams = self.clients = 0
        self.announcement_count = 0
        self.announcement_error = self.capture_error = ''
        self.local_address = ''
        self.samples = collections.deque(maxlen=600)
        self.last_stderr = collections.deque(maxlen=8)

    def source(self):
        with self.condition:
            self.source_frames += 1

    def oversized(self):
        with self.condition:
            self.oversized_count += 1

    def publish(self, jpeg):
        if not 4 <= len(jpeg) <= MAX_JPEG or not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
            raise ValueError('JPEG inválido o demasiado grande')
        with self.condition:
            self.frame, self.frame_at = jpeg, self.clock()
            self.sequence = (self.sequence + 1) & 0xffffffff
            self.published_frames += 1
            self.published_bytes += len(jpeg)
            self.capture_error = ''
            self.samples.append((self.frame_at, self.published_frames, self.published_bytes, self.source_frames))
            self.condition.notify_all()

    def _current(self):
        age = self.clock() - self.frame_at
        if self.frame is None or age * 1000 > self.cfg['frame_stale_ms']:
            return None
        return (self.sequence, self.frame, age)

    def current(self):
        with self.condition:
            return self._current()

    def wait_after(self, sequence, timeout=1.0):
        with self.condition:
            self.condition.wait_for(lambda: self.sequence != sequence or self.frame is None, timeout)
            current = self._current()
            return current if current and current[0] != sequence else None

    def age_ms(self):
        with self.condition:
            return NO_FRAME if self.frame is None else min(NO_FRAME - 1, int(max(0, self.clock() - self.frame_at) * 1000))

    def health(self):
        with self.condition:
            now = self.clock()
            fps = source_fps = mbps = 0.0
            recent = [s for s in self.samples if now - s[0] <= 5]
            if len(recent) >= 2:
                first, last = recent[0], recent[-1]
                elapsed = max(0.001, last[0] - first[0])
                fps = (last[1] - first[1]) / elapsed
                mbps = (last[2] - first[2]) * 8 / elapsed / 1_000_000
                source_fps = (last[3] - first[3]) / elapsed
            current = self._current()
            return dict(build=BUILD, active=current is not None, camera=self.cfg['camera'],
                        width=self.cfg['width'], height=self.cfg['height'],
                        capture_fps_requested=self.cfg['capture_fps'], send_fps_limit=self.cfg['send_fps'],
                        source_fps=round(source_fps, 2), published_fps=round(fps, 2),
                        mbps_per_view=round(mbps, 3), estimated_mbps_all_views=round(mbps * self.streams, 3),
                        jpeg_bytes=len(self.frame) if self.frame else 0,
                        frame_age_ms=None if self.frame is None else int(max(0, now - self.frame_at) * 1000),
                        boot=self.boot, sequence=self.sequence, source_frames=self.source_frames,
                        published_frames=self.published_frames, oversized=self.oversized_count,
                        streams=self.streams, stream_limit=self.cfg['max_streams'], clients=self.clients,
                        capture_restarts=self.restarts, capture_error=self.capture_error,
                        ffmpeg_stderr=list(self.last_stderr), announcement_count=self.announcement_count,
                        announcement_error=self.announcement_error, address=self.local_address,
                        http_port=self.cfg['http_port'], c3_address=self.cfg['c3_address'])


class CaptureWorker(threading.Thread):
    def __init__(self, cfg, store, stop, command=None):
        super().__init__(name='webcam', daemon=True)
        self.cfg, self.store, self.stop = cfg, store, stop
        self.command = command or ffmpeg_command(cfg)
        self.process = None
        self.progress = time.monotonic()

    def error(self, message):
        with self.store.condition:
            changed = self.store.capture_error != message
            self.store.capture_error = message[:500]
        if changed:
            LOG.warning('%s', message[:500])

    def chunks(self, proc):
        last_frame = time.monotonic()
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, 'video')
            selector.register(proc.stderr, selectors.EVENT_READ, 'error')
            while not self.stop.is_set():
                self.progress = time.monotonic()
                if self.store.frame_at:
                    last_frame = max(last_frame, self.store.frame_at)
                if self.progress - last_frame > self.cfg['stall_timeout']:
                    raise TimeoutError('Webcam sin fotogramas; reiniciando FFmpeg')
                events = selector.select(0.25)
                for key, _ in events:
                    data = os.read(key.fileobj.fileno(), 32768)
                    if not data:
                        if key.data == 'video':
                            return
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == 'video':
                        yield data
                    else:
                        with self.store.condition:
                            self.store.last_stderr.extend(data.decode('utf-8', 'replace')[-8192:].splitlines()[-8:])
                            # Cota también para una única línea sin saltos.
                            self.store.last_stderr = collections.deque((s[-1024:] for s in self.store.last_stderr), maxlen=8)

    def terminate(self):
        proc = self.process
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def run(self):
        while not self.stop.is_set():
            self.progress = time.monotonic()
            pacer = FramePacer(self.cfg['send_fps'])
            try:
                self.process = subprocess.Popen(self.command, stdin=subprocess.DEVNULL,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
                for jpeg in jpeg_frames(self.chunks(self.process), self.store.oversized):
                    self.store.source()
                    if pacer.accept(time.monotonic()):
                        self.store.publish(jpeg)
                if not self.stop.is_set():
                    self.error('FFmpeg terminó; se reintentará la webcam')
            except (OSError, TimeoutError) as error:
                self.error(str(error))
            finally:
                self.terminate()
                if self.process:
                    if self.process.stdout:
                        self.process.stdout.close()
                    if self.process.stderr:
                        self.process.stderr.close()
                self.process = None
                with self.store.condition:
                    self.store.restarts += 1
            self.stop.wait(2)


def announcement(cfg, store):
    with store.condition:
        return f"ARS_CAM1|{cfg['pair_group']}|{cfg['http_port']}|{store.boot}|{store.sequence}|{store.age_ms()}".encode('ascii')


class Announcer(threading.Thread):
    def __init__(self, cfg, store, stop):
        super().__init__(name='descubrimiento-c3', daemon=True)
        self.cfg, self.store, self.stop = cfg, store, stop
        self.progress = time.monotonic()

    def send(self):
        # Un socket nuevo toma la dirección/ruta DHCP actual después de cada corte.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.connect((self.cfg['c3_address'], UDP_PORT))
            address = sock.getsockname()[0]
            sock.send(announcement(self.cfg, self.store))
        with self.store.condition:
            self.store.local_address = address
            self.store.announcement_count += 1
            self.store.announcement_error = ''

    def run(self):
        while not self.stop.is_set():
            self.progress = time.monotonic()
            try:
                self.send()
            except OSError as error:
                with self.store.condition:
                    self.store.announcement_error = str(error)[:300]
            self.stop.wait(2)


class CameraHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, cfg, store, stop):
        self.cfg, self.store, self.stop = cfg, store, stop
        self.slots = threading.BoundedSemaphore(cfg['max_clients'])
        self.stream_slots = threading.BoundedSemaphore(cfg['max_streams'])
        super().__init__((cfg['bind'], cfg['http_port']), CameraHandler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        with self.store.condition:
            self.store.clients += 1
        try:
            super().process_request(request, address)
        except BaseException:
            self.release_slot()
            raise

    def release_slot(self):
        with self.store.condition:
            self.store.clients -= 1
        self.slots.release()

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.release_slot()

    def handle_error(self, request, address):
        LOG.debug('Conexión HTTP cerrada por %s', address[0], exc_info=True)


class CameraHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'CamaraCaja/1.0'
    sys_version = ''

    def setup(self):
        self.request.settimeout(2)
        self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.request.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32768)
        super().setup()

    def log_message(self, fmt, *args):
        # No escribir por fotograma ni por conexión: cuidar el USB de arranque.
        pass

    def send_headers(self, status, mime, length=None, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'ETag, X-Frame-Sequence')
        self.send_header('Connection', 'close')
        if length is not None:
            self.send_header('Content-Length', str(length))
        for key, value in (extra or {}).items():
            self.send_header(key, str(value))
        self.end_headers()
        self.close_connection = True

    def send_body(self, status, mime, body, extra=None):
        self.send_headers(status, mime, len(body), extra)
        if self.command != 'HEAD':
            self.wfile.write(body)

    def unavailable(self):
        self.send_body(503, 'application/json', b'{"active":false,"error":"Camara sin fotogramas recientes"}', {'Retry-After': '1'})

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        self.send_body(204, 'text/plain', b'', {'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'})

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == '/health':
                self.send_body(200, 'application/json', json.dumps(self.server.store.health()).encode())
            elif path in ('/capture', '/snapshot'):
                current = self.server.store.current()
                if not current:
                    return self.unavailable()
                seq, frame, _ = current
                self.send_body(200, 'image/jpeg', frame,
                               {'ETag': f'"{self.server.store.boot:08x}-{seq:08x}"', 'X-Frame-Sequence': seq})
            elif path in ('/stream', '/frames'):
                self.stream(raw=path == '/frames')
            elif path == '/':
                self.send_body(200, 'text/html; charset=utf-8', DIAGNOSTIC_PAGE)
            else:
                self.send_body(404, 'text/plain; charset=utf-8', b'No encontrado')
        except (OSError, ConnectionError):
            self.close_connection = True

    def stream(self, raw=False):
        store = self.server.store
        if not store.current():
            return self.unavailable()
        if not self.server.stream_slots.acquire(blocking=False):
            return self.send_body(503, 'application/json', b'{"error":"Limite de video alcanzado"}', {'Retry-After': '1'})
        with store.condition:
            store.streams += 1
        try:
            # WebKit rejects fetch() of multipart/x-mixed-replace. Native <img>
            # keeps /stream; the JS receiver reads the same framed bytes through
            # /frames without asking the browser to interpret them as multipart.
            mime = 'application/octet-stream' if raw else 'multipart/x-mixed-replace; boundary=frame'
            self.send_headers(200, mime)
            if self.command == 'HEAD':
                return
            previous = None
            while not self.server.stop.is_set():
                current = store.current() if previous is None else store.wait_after(previous)
                if not current:
                    if store.current() is None:
                        return
                    continue
                previous, frame, _ = current
                header = f'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\nX-Frame-Sequence: {previous}\r\n\r\n'.encode('ascii')
                self.wfile.write(header)
                self.wfile.write(frame)
                self.wfile.write(b'\r\n')
                self.wfile.flush()
        finally:
            with store.condition:
                store.streams -= 1
            self.server.stream_slots.release()


DIAGNOSTIC_PAGE = '''<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cámara Debian</title><style>body{background:#111827;color:#f9fafb;font:16px system-ui;max-width:900px;margin:24px auto;padding:16px}img{width:100%;max-height:65vh;object-fit:contain;background:#000}pre{white-space:pre-wrap}a{color:#93c5fd}</style><h1>Cámara Debian</h1><p>Video local directo. <a id="control">Abrir controles C3</a></p><img id="video" alt="Cámara sin señal"><p id="estado">Conectando…</p><pre id="datos"></pre><script>const v=document.querySelector('#video');let live=false;async function check(){try{const r=await fetch('/health',{cache:'no-store'});const h=await r.json();document.querySelector('#datos').textContent=JSON.stringify(h,null,2);document.querySelector('#control').href='http://'+h.c3_address+'/';document.querySelector('#estado').textContent=h.active?'Captura activa':'Cámara sin señal; reintentando';if(h.active&&!live){v.src='/stream?t='+Date.now();live=true}if(!h.active){v.removeAttribute('src');live=false}}catch{live=false}setTimeout(check,2000)}v.onerror=()=>{live=false};check();</script></html>'''.encode('utf-8')


def sd_notify(message):
    endpoint = os.environ.get('NOTIFY_SOCKET')
    if not endpoint:
        return False
    if endpoint.startswith('@'):
        endpoint = '\0' + endpoint[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.connect(endpoint)
            sock.sendall(message.encode())
        return True
    except OSError as error:
        LOG.debug('Notificación systemd: %s', error)
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    for name in ('camera', 'bind', 'c3-address', 'pair-group'):
        parser.add_argument('--' + name)
    for name in ('width', 'height', 'capture-fps', 'send-fps', 'http-port'):
        parser.add_argument('--' + name, type=int)
    parser.add_argument('--stall-timeout', type=float)
    parser.add_argument('--check-config', action='store_true')
    parser.add_argument('--version', action='version', version=BUILD)
    args = parser.parse_args(argv)
    try:
        profile = json.loads(args.config.read_text()) if args.config else {}
        for key in DEFAULTS:
            override = getattr(args, key, None)
            if override is not None:
                profile[key] = override
        cfg = validate_config(profile)
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f'Configuración inválida: {error}\n')
    if args.check_config:
        print(json.dumps(cfg, indent=2))
        return 0
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    stop = threading.Event()
    store = FrameStore(cfg)
    capture, announce = CaptureWorker(cfg, store, stop), Announcer(cfg, store, stop)
    try:
        server = CameraHTTPServer(cfg, store, stop)
    except OSError as error:
        parser.exit(1, f'No se pudo abrir HTTP {cfg["http_port"]}: {error}\n')
    http_thread = threading.Thread(target=server.serve_forever, name='http', daemon=True)
    def shutdown(signum, frame):
        stop.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    capture.start(); announce.start(); http_thread.start()
    sd_notify('READY=1\nSTATUS=HTTP disponible; esperando webcam y red local')
    LOG.info('%s HTTP :%d; captura %dx%d; envío limitado a %d FPS', BUILD, cfg['http_port'], cfg['width'], cfg['height'], cfg['send_fps'])
    code = 0
    try:
        while not stop.wait(1):
            now = time.monotonic()
            if (not all(t.is_alive() for t in (capture, announce, http_thread)) or
                    now - capture.progress > cfg['stall_timeout'] + 10 or now - announce.progress > 10):
                LOG.error('Un trabajador dejó de responder; systemd reiniciará el programa')
                code = 1
                break
            sd_notify('WATCHDOG=1')
    finally:
        stop.set()
        sd_notify('STOPPING=1')
        server.shutdown(); server.server_close()
        capture.join(timeout=4); announce.join(timeout=2)
        capture.terminate()
    return code


if __name__ == '__main__':
    raise SystemExit(main())
