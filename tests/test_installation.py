import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'debian'))
import configurar_red as network
import configurar_ethernet as ethernet
import instalar as installer


class InstallationTest(unittest.TestCase):
    def test_fresh_clone_preserves_public_template_and_copies_build_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'c3/firmware'; base.mkdir(parents=True)
            template = base / 'sdkconfig.defaults.example'
            public_defaults = 'CONFIG_MARLIN_RX_GPIO=4\nCONFIG_HTTPD_WS_SUPPORT=y\n'
            template.write_text(public_defaults)
            network.configure(root, 'RedPrueba', 'clave-ficticia-solo-prueba', 'ARS_CAJA1')
            network.check(root)
            self.assertEqual(template.read_text(), public_defaults)
            generated = (base / 'sdkconfig.defaults').read_text()
            self.assertIn('CONFIG_MARLIN_RX_GPIO=4', generated)
            self.assertIn('CONFIG_HTTPD_WS_SUPPORT=y', generated)
            self.assertEqual(network.read_values(base / 'sdkconfig.defaults')['BRIDGE_ROUTER_PASSWORD'],
                             'clave-ficticia-solo-prueba')

    def test_legacy_json_drops_serial_and_preserves_video(self):
        cfg = installer.legacy_profile('', dict(port='/dev/ttyACM0', camera='/dev/video0',
                                                width=640, height=480, capture_fps=30, send_fps=25))
        self.assertNotIn('port', cfg)
        self.assertEqual((cfg['width'], cfg['height'], cfg['capture_fps'], cfg['send_fps']), (640, 480, 30, 25))

    def test_legacy_execstart_parsed_without_executing(self):
        cfg = installer.legacy_profile('ExecStart=/usr/bin/python3 /opt/old/camera_sender.py --width 640 --height 480 --send-fps 20 --port /dev/ttyACM0\n')
        self.assertEqual(cfg['width'], 640)
        self.assertEqual(cfg['send_fps'], 20)
        self.assertNotIn('port', cfg)

    def test_camera_ambiguity_and_stable_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('a', 'b'):
                (root / name).touch()
            with self.assertRaises(ValueError):
                installer.choose_camera(None, '/dev/video0', list(root.iterdir()))
            self.assertEqual(installer.choose_camera(None, '/dev/v4l/by-id/saved', []), '/dev/v4l/by-id/saved')
            with self.assertRaises(ValueError):
                installer.stable_device('video0', [])

    def test_network_separates_secret_preserves_uart_and_checks_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'c3/firmware'; base.mkdir(parents=True)
            (base / 'sdkconfig.defaults').write_text('CONFIG_MARLIN_RX_GPIO=4\nCONFIG_MARLIN_TX_GPIO=5\n')
            network.configure(root, 'DC9B65', 'clave-ficticia-solo-prueba', 'ARS_CAJA1')
            network.check(root)
            self.assertIn('CONFIG_MARLIN_RX_GPIO=4', (base / 'sdkconfig.defaults').read_text())
            self.assertEqual(os.stat(base / 'sdkconfig.defaults').st_mode & 0o777, 0o600)
            self.assertNotIn('clave', (root / 'debian/red_camara.json').read_text())
            (base / 'sdkconfig').write_text((base / 'sdkconfig.defaults').read_text().replace('DC9B65', 'otra'))
            with self.assertRaises(ValueError):
                network.check(root)
            network.configure(root, 'DC9B65', 'clave-ficticia-solo-prueba', 'ARS_CAJA1')
            network.check(root)

    def test_ifupdown_idempotent_and_conflicts(self):
        text = 'auto lo enp0s7\niface enp0s7 inet dhcp\n'
        self.assertEqual(ethernet.ifupdown_addition('enp0s7', [text]), '')
        addition = ethernet.ifupdown_addition('enp0s7', ['auto lo\niface lo inet loopback\n'])
        self.assertIn('iface enp0s7 inet dhcp', addition)
        with self.assertRaises(ValueError):
            ethernet.ifupdown_addition('enp0s7', ['iface enp0s7 inet static\n'])

    def test_install_migrates_and_enables_new_service_in_temporary_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile, legacy, service, dest = root/'new.json', root/'old.json', root/'camara-caja.service', root/'opt'
            legacy.write_text(json.dumps(dict(width=640, height=480, capture_fps=30, send_fps=25, port='/dev/ttyACM0')))
            calls = []
            def fake_run(*args, **kwargs):
                calls.append(args)
                out = 'User=trixie\nExecStart=/usr/bin/python3 /opt/camera_sender.py\n' if args[:3] == ('systemctl', 'cat', installer.LEGACY_SERVICE) else ''
                return SimpleNamespace(stdout=out, stderr='', returncode=1 if 'is-active' in args else 0)
            args = SimpleNamespace(usuario='trixie', camara=None, width=None, height=None,
                                   capture_fps=None, send_fps=None, stall_timeout=None, http_port=0)
            # Reserve a real free nonprivileged port for the installer preflight.
            import socket
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); args.http_port = sock.getsockname()[1]
            with patch.multiple(installer, PROFILE=profile, LEGACY_PROFILE=legacy, SERVICE=service, DESTINATION=dest), \
                 patch.object(installer.os, 'geteuid', return_value=0), \
                 patch.object(installer, 'choose_user', return_value='trixie'), \
                 patch.object(installer, 'choose_camera', return_value='/dev/v4l/by-id/test-video-index0'), \
                 patch.object(installer, 'backup', return_value=root/'backup'), \
                 patch.object(installer, 'run', side_effect=fake_run), \
                 patch.object(installer.shutil, 'which', return_value='/usr/bin/ffmpeg'):
                installer.install(args)
            cfg = json.loads(profile.read_text())
            self.assertEqual(cfg['width'], 640)
            self.assertNotIn('port', cfg)
            self.assertTrue((dest / 'camara_http.py').exists())
            self.assertIn(('systemctl', 'disable', '--now', 'camera-usb-s3.service'), calls)
            self.assertIn(('systemctl', 'enable', '--now', 'camara-caja.service'), calls)
            self.assertIn('SupplementaryGroups=video', service.read_text())


if __name__ == '__main__':
    unittest.main()
