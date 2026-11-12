#!/usr/bin/env python3
"""Configura la C3 para el router y el descubrimiento de Debian. La clave se ingresa solamente en tu PC."""
import argparse
import getpass
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
C3_IP = '192.168.0.254'
ROUTER_IP = '192.168.0.1'


def validate(ssid: str, password: str, group: str) -> None:
    if not 1 <= len(ssid.encode('utf-8')) <= 32 or any(ord(c) < 32 for c in ssid):
        raise ValueError('El SSID debe ocupar entre 1 y 32 bytes, sin caracteres de control')
    ordinary = 8 <= len(password) <= 63 and all(32 <= ord(c) <= 126 for c in password)
    hexadecimal = bool(re.fullmatch(r'[a-fA-F0-9]{64}', password))
    if not (ordinary or hexadecimal):
        raise ValueError('La clave WPA debe tener 8–63 caracteres ASCII, o 64 dígitos hexadecimales')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,31}', group):
        raise ValueError('El grupo debe tener 1–31 letras, números, guiones o guiones bajos')


def update_config(path: Path, values: dict[str, str]) -> None:
    old = path.read_text() if path.exists() else ''
    names = '|'.join(re.escape(name) for name in values)
    pattern = re.compile(rf'^(?:CONFIG_(?:{names})=|# CONFIG_(?:{names}) is not set)')
    lines = [line for line in old.splitlines() if not pattern.match(line)]
    lines.extend(f'CONFIG_{name}={json.dumps(value, ensure_ascii=False)}' for name, value in values.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.caja-tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write('\n'.join(lines) + '\n')
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def read_values(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if line.startswith('CONFIG_') and '=' in line:
            name, value = line[7:].split('=', 1)
            if value.startswith('"'):
                result[name] = json.loads(value)
    return result


def check(root: Path = ROOT) -> None:
    c3 = read_values(root / 'c3/firmware/sdkconfig.defaults')
    validate(c3['BRIDGE_ROUTER_SSID'], c3['BRIDGE_ROUTER_PASSWORD'], c3['BRIDGE_PAIR_GROUP'])
    network = json.loads((root / 'debian/red_camara.json').read_text())
    if network != dict(c3_address=c3['BRIDGE_STATIC_IP'], pair_group=c3['BRIDGE_PAIR_GROUP']):
        raise ValueError('C3 y Debian difieren; repetí configurar_red.py')
    for directory, defaults, keys in [
        ('c3/firmware', c3, ['BRIDGE_ROUTER_SSID', 'BRIDGE_ROUTER_PASSWORD',
                            'BRIDGE_PAIR_GROUP', 'BRIDGE_STATIC_IP', 'BRIDGE_NETMASK', 'BRIDGE_GATEWAY']),
    ]:
        path = root / directory / 'sdkconfig'
        if path.exists():
            current = read_values(path)
            if any(current.get(key) != defaults.get(key) for key in keys):
                raise ValueError(f'{directory}/sdkconfig difiere de la red común; repetí configurar_red.py')


def configure(root: Path, ssid: str, password: str, group: str) -> None:
    validate(ssid, password, group)
    for directory, values in [
        ('c3/firmware', dict(BRIDGE_ROUTER_SSID=ssid, BRIDGE_ROUTER_PASSWORD=password,
                            BRIDGE_STATIC_IP=C3_IP, BRIDGE_NETMASK='255.255.255.0',
                            BRIDGE_GATEWAY=ROUTER_IP, BRIDGE_PAIR_GROUP=group)),
    ]:
        base = root / directory
        defaults = base / 'sdkconfig.defaults'
        template = base / 'sdkconfig.defaults.example'
        if not defaults.exists() and template.is_file():
            defaults.write_bytes(template.read_bytes())
        update_config(base / 'sdkconfig.defaults', values)
        if (base / 'sdkconfig').exists():
            update_config(base / 'sdkconfig', values)
    network = root / 'debian/red_camara.json'
    network.parent.mkdir(parents=True, exist_ok=True)
    network.write_text(json.dumps(dict(c3_address=C3_IP, pair_group=group), indent=2) + '\n')
    network.chmod(0o644)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssid', default='DC9B65')
    parser.add_argument('--grupo', default='ARS_CAJA1')
    parser.add_argument('--comprobar', action='store_true')
    args = parser.parse_args()
    try:
        if args.comprobar:
            check()
        else:
            password = getpass.getpass(f'Clave WiFi de {args.ssid} (no se mostrará): ')
            confirmation = getpass.getpass('Repetí la clave: ')
            if password != confirmation:
                raise ValueError('Las claves no coinciden')
            configure(ROOT, args.ssid, password, args.grupo)
            check()
        print(f'Red configurada para C3 y Debian. Página C3: http://{C3_IP}/')
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f'Configuración pendiente: {error}\n')


if __name__ == '__main__':
    main()
