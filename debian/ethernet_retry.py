#!/usr/bin/env python3
"""Respaldo de ifupdown: reintenta DHCP solo si hay cable y falta una IPv4 útil."""
import ipaddress
import json
import re
import subprocess
import sys
import time
from pathlib import Path


def has_ipv4(addresses):
    for interface in addresses:
        for item in interface.get('addr_info', []):
            if item.get('family') != 'inet':
                continue
            ip = ipaddress.IPv4Address(item['local'])
            if not (ip.is_link_local or ip.is_loopback or ip.is_unspecified):
                return True
    return False


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', sys.argv[1]):
        raise SystemExit('Indicar una interfaz Ethernet válida')
    interface = sys.argv[1]
    try:
        if (Path('/sys/class/net') / interface / 'carrier').read_text().strip() != '1':
            return
        result = subprocess.run(['ip', '-j', '-4', 'address', 'show', 'dev', interface],
                                check=True, capture_output=True, text=True)
        if has_ipv4(json.loads(result.stdout)):
            return
    except (FileNotFoundError, OSError, ValueError, subprocess.CalledProcessError):
        return
    unit = f'caja-ethernet-dhcp@{interface}.service'
    state = subprocess.run(['systemctl', 'show', '-p', 'ActiveState', '--value', unit],
                           capture_output=True, text=True).stdout.strip()
    if state in ('activating', 'deactivating'):
        return
    if state == 'active':
        timestamp = subprocess.run(['systemctl', 'show', '-p', 'ActiveEnterTimestampMonotonic',
                                    '--value', unit], capture_output=True, text=True).stdout.strip()
        if timestamp.isdigit() and time.monotonic() - int(timestamp) / 1_000_000 < 90:
            return
    print(f'{interface}: enlace sin IPv4; reintentando el DHCP existente de ifupdown', flush=True)
    subprocess.run(['systemctl', 'restart', '--no-block', unit], check=True)


if __name__ == '__main__':
    main()
