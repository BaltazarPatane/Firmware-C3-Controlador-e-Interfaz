#!/usr/bin/env python3
"""Diagnóstico de sólo lectura: captura HTTP local y descubrimiento de la C3."""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen


def request(url):
    try:
        with urlopen(url, timeout=4) as response:
            value = json.load(response)
        print(url)
        print(json.dumps(value, indent=2, ensure_ascii=False))
        return value
    except (OSError, ValueError) as error:
        print(f'{url}: {error}')
        return {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/caja-ars/camara-http.json'))
    args = parser.parse_args()
    cfg = json.loads(args.config.read_text())
    local = request(f'http://127.0.0.1:{cfg["http_port"]}/health')
    c3 = request(f'http://{cfg["c3_address"]}/api/camera')
    if local.get('active') and c3.get('available'):
        print(f'Captura y descubrimiento OK. Abrí http://{cfg["c3_address"]}/ desde el celular.')
        return 0
    print('Pendiente: revisar webcam, Ethernet, WiFi o grupo. Mirá README.md.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
