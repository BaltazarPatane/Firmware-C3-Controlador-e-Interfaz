#!/usr/bin/env python3
"""Compila C3 con tu ESP-IDF 6.1; opcionalmente graba la placa indicada."""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from configurar_red import ROOT, check


def command(args, cwd):
    print('+', ' '.join(map(str, args)), flush=True)
    environment = {**os.environ, 'NEXT_TELEMETRY_DISABLED': '1'}
    if args[0] == 'idf.py':
        # All project components are included locally or provided by ESP-IDF.
        environment['IDF_COMPONENT_MANAGER'] = '0'
    subprocess.run(list(map(str, args)), cwd=cwd, check=True, env=environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('placa', choices=['c3'], nargs='?', default='c3')
    parser.add_argument('--grabar', metavar='PUERTO', help='por ejemplo /dev/ttyACM0; solo una placa')
    parser.add_argument('--reconstruir-web', action='store_true',
                        help='recompilar la aplicación con npm; por defecto usa la página ya incluida')
    args = parser.parse_args()
    try:
        check()
        if not shutil.which('idf.py') or not os.environ.get('IDF_PATH'):
            raise ValueError('Primero ejecutá: source ~/esp/esp-idf-6.1/export.sh')
        version = subprocess.check_output(['idf.py', '--version'], text=True)
        if not re.search(r'v6\.1(?:\D|$)', version):
            raise ValueError('Este proyecto usa ESP-IDF 6.1. Activá esa versión antes de compilar')
        if args.reconstruir_web:
            if not shutil.which('npm'):
                raise ValueError('Falta Node.js 20.9 o posterior y npm para compilar la página C3')
            app = ROOT / 'c3/aplicacion'
            command(['npm', 'ci', '--no-audit', '--no-fund'], app)
            command(['npm', 'test'], app)
            command(['npm', 'run', 'build'], app)
            # Next creates its generated route types during a clean build.
            command(['npm', 'run', 'typecheck'], app)
            command([sys.executable, ROOT / 'c3/firmware/tools/prepare_web.py', app / 'out'], ROOT)
        if args.placa == 'c3':
            web = ROOT / 'c3/firmware/web'
            if not (web / 'index.html.gz').is_file() and not (web / 'index.html').is_file():
                raise ValueError('Falta la página; repetí con --reconstruir-web')
        for board in ['c3']:
            firmware = ROOT / 'c3/firmware'
            command(['idf.py', '-C', firmware, '-D', 'IDF_TARGET=esp32' + board,
                     'reconfigure', 'build'], ROOT)
            if args.grabar:
                command(['idf.py', '-C', firmware, '-p', args.grabar, 'flash'], ROOT)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'No se completó la compilación: {error}\n')


if __name__ == '__main__':
    main()
