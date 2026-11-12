#!/usr/bin/env python3
"""Pruebas portables, sin conectar placas ni modificar la red del equipo."""
import shutil
import subprocess
import sys
import tempfile
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(arguments):
    subprocess.run([str(arg) for arg in arguments], cwd=ROOT, check=True)


def main():
    run([sys.executable, '-m', 'unittest', 'discover', '-s', 'debian', '-p', 'test_*.py', '-v'])
    run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'])
    if not shutil.which('g++'):
        raise SystemExit('Falta g++ para las pruebas de C3: sudo apt install g++')
    with tempfile.TemporaryDirectory(prefix='caja-tests-') as temporary:
        cjson = Path(temporary) / 'cjson.o'
        run(['cc', '-c', ROOT / 'c3/firmware/components/cjson/cJSON.c', '-o', cjson])
        for name, source in [('bridge', 'c3/firmware/tests/test_bridge.cpp'),
                             ('policy', 'c3/firmware/tests/test_policy.cpp'),
                             ('network', 'c3/firmware/tests/test_network.cpp'),
                             ('router', 'tests/test_router.cpp')]:
            executable = Path(temporary) / name
            run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread',
                 '-I', ROOT / 'c3/firmware/components/cjson', ROOT / source, cjson,
                 '-o', executable])
            run([executable])
        source = ROOT / 'debian/camara_http.py'
        spec = importlib.util.spec_from_file_location('camera_packet_test', source)
        camera = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(camera)
        store = camera.FrameStore(camera.DEFAULTS)
        store.sequence = 7
        packet = camera.announcement(camera.DEFAULTS, store).decode('ascii')
        executable = Path(temporary) / 'debian_packet'
        run(['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread',
             ROOT / 'tests/test_debian_packet.cpp', '-o', executable])
        run([executable, packet])
    print('Pruebas portables completadas. La web preparada ya está incluida; fuentes: c3/aplicacion.')


if __name__ == '__main__': main()
