#!/usr/bin/env python3
"""Activa Ethernet y DHCP al arrancar usando el gestor de red que ya tiene Debian.

El Technicolor crea la red WiFi. Debian se conecta a un puerto LAN por Ethernet.
No instala otro gestor, no crea un hotspot y no necesita Internet para funcionar.
"""
import argparse
import datetime
import os
import re
import shutil
import subprocess
from pathlib import Path


def run(*args, check=True):
    return subprocess.run(args, text=True, capture_output=True, check=check,
                          env={**os.environ, 'LC_ALL': 'C', 'SYSTEMD_COLORS': '0'})


def active(service):
    return run('systemctl', 'is-active', '--quiet', service, check=False).returncode == 0


def choose_interface(requested=None, sys_net=Path('/sys/class/net')):
    choices = []
    for path in sorted(sys_net.iterdir()):
        if path.name == 'lo' or (path / 'wireless').exists() or not (path / 'device').exists():
            continue
        if (path / 'type').read_text().strip() == '1':
            choices.append(path.name)
    if requested in choices:
        return requested
    if requested:
        raise ValueError(f'{requested} no es una interfaz Ethernet física disponible: {", ".join(choices)}')
    if len(choices) != 1:
        raise ValueError(f'Indicá --interfaz NOMBRE. Interfaces Ethernet: {", ".join(choices) or "ninguna"}')
    return choices[0]


def backup(paths):
    folder = Path('/var/backups/caja-ars') / datetime.datetime.now().strftime('red-%Y%m%d-%H%M%S-%f')
    folder.mkdir(parents=True, mode=0o700)
    for path in paths:
        if path.is_file():
            target = folder / str(path).lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    print(f'Copia de seguridad: {folder}')


def nm_profile(interface):
    result = run('nmcli', '-g', 'GENERAL.CON-UUID', 'device', 'show', interface, check=False)
    uuid = result.stdout.strip()
    if result.returncode == 0 and re.fullmatch(r'[a-fA-F0-9-]{36}', uuid):
        return uuid
    # Prefer an existing Ethernet profile explicitly bound to this interface.
    rows = run('nmcli', '-t', '-f', 'UUID,TYPE', 'connection', 'show').stdout.splitlines()
    for row in rows:
        identifier, kind = row.split(':', 1)
        if kind not in ('802-3-ethernet', 'ethernet'):
            continue
        bound = run('nmcli', '-g', 'connection.interface-name', 'connection', 'show', 'uuid', identifier).stdout.strip()
        if bound == interface:
            return identifier
    name = 'Caja Ethernet ' + interface
    run('nmcli', 'connection', 'add', 'type', 'ethernet', 'ifname', interface,
        'con-name', name, 'ipv4.method', 'auto')
    return run('nmcli', '-g', 'connection.uuid', 'connection', 'show', 'id', name).stdout.strip()


def configure_nm(interface):
    backup(list(Path('/etc/NetworkManager/system-connections').glob('*')))
    identifier = nm_profile(interface)
    run('nmcli', 'connection', 'modify', 'uuid', identifier,
        'connection.interface-name', interface, 'connection.autoconnect', 'yes',
        'connection.autoconnect-retries', '0', 'connection.autoconnect-priority', '100',
        'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '',
        'ipv4.dns', '', 'ipv4.ignore-auto-dns', 'no', 'ipv4.route-metric', '600')
    run('systemctl', 'enable', 'NetworkManager.service')
    result = run('nmcli', '--wait', '20', 'connection', 'up', 'uuid', identifier,
                 'ifname', interface, check=False)
    if result.returncode:
        print('Perfil guardado. Todavía sin enlace/DHCP; NetworkManager seguirá reintentando.')
        print(result.stderr.strip())
    return 'NetworkManager'


def interface_files():
    main = Path('/etc/network/interfaces')
    paths = {main}
    # Expand source patterns recursively without executing arbitrary config commands.
    todo = [main]
    import glob
    while todo:
        path = todo.pop()
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            tokens = line.split('#', 1)[0].split()
            if len(tokens) < 2:
                continue
            matches = []
            if tokens[0] == 'source':
                for pattern in tokens[1:]:
                    matches.extend(Path(p) for p in glob.glob(str(path.parent / pattern)))
            elif tokens[0] == 'source-directory':
                for directory in tokens[1:]:
                    folder = path.parent / directory
                    if folder.is_dir():
                        matches.extend(p for p in folder.iterdir() if re.fullmatch(r'[A-Za-z0-9_-]+', p.name))
            for found in matches:
                if found not in paths:
                    paths.add(found)
                    todo.append(found)
    return sorted(p for p in paths if p.is_file())


def ifupdown_addition(interface, contents):
    methods = []
    automatic = False
    for text in contents:
        for line in text.splitlines():
            tokens = line.split('#', 1)[0].split()
            if len(tokens) >= 4 and tokens[:3] == ['iface', interface, 'inet']:
                methods.append(tokens[3])
            if tokens and tokens[0] == 'auto' and interface in tokens[1:]:
                automatic = True
    if len(methods) > 1:
        raise ValueError(f'Hay varias definiciones IPv4 de {interface}; corregilas antes de continuar')
    if methods and methods[0] != 'dhcp':
        raise ValueError(f'{interface} tiene una configuración {methods[0]}. '
                         f'Cambiá su línea iface a "iface {interface} inet dhcp" y quitá '
                         'address/netmask/gateway de esa misma interfaz; después repetí este comando')
    addition = ''
    if not automatic:
        addition += f'auto {interface}\n'
    if not methods:
        addition += f'iface {interface} inet dhcp\n'
    return '\n# Caja ARS: Ethernet al Technicolor\n' + addition if addition else ''


def configure_ifupdown(interface):
    if not any(shutil.which(client) for client in ('dhclient', 'dhcpcd', 'udhcpc', 'pump')):
        raise ValueError('Falta un cliente DHCP para ifupdown. Ejecutá con Internet temporal: '
                         'sudo apt install dhcpcd-base')
    files = interface_files()
    text = [p.read_text() for p in files]
    addition = ifupdown_addition(interface, text)
    helper = Path('/usr/local/lib/caja-ars/ethernet_retry.py')
    unit_names = ['caja-ethernet-dhcp@.service', 'caja-ethernet-revisar@.service',
                  'caja-ethernet-revisar@.timer']
    backup(files + [helper] + [Path('/etc/systemd/system') / name for name in unit_names])
    if addition:
        main = Path('/etc/network/interfaces')
        main.parent.mkdir(parents=True, exist_ok=True)
        with main.open('a') as out:
            out.write(addition)
    run('systemctl', 'enable', 'networking.service')
    run('ip', 'link', 'set', 'dev', interface, 'up')
    # A late router or a DHCP client that exited during boot must recover too.
    # The helper leaves an already assigned IPv4 untouched; it never tests Internet.
    here = Path(__file__).resolve().parent
    helper.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(here / 'ethernet_retry.py', helper)
    helper.chmod(0o755)
    for name in unit_names:
        shutil.copy2(here / name, Path('/etc/systemd/system') / name)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', f'caja-ethernet-revisar@{interface}.timer')
    run('systemctl', 'start', '--no-block', f'caja-ethernet-revisar@{interface}.service')
    return 'ifupdown'


def configure_networkd(interface):
    path = Path('/etc/systemd/network') / f'00-caja-ars-{interface}.network'
    backup([path])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'[Match]\nName={interface}\n\n[Link]\nRequiredForOnline=no\n\n'
                    '[Network]\nDHCP=ipv4\n\n[DHCPv4]\nRouteMetric=600\n')
    run('systemctl', 'enable', 'systemd-networkd.service')
    run('networkctl', 'reload')
    run('networkctl', 'reconfigure', interface)
    status = run('networkctl', 'status', '--no-pager', interface, check=False).stdout
    match = re.search(r'^\s*Network File:\s*(\S+)', status, flags=re.M)
    if match and match.group(1) != str(path):
        raise ValueError(f'networkd está aplicando {match.group(1)} antes que {path}. '
                         'Esa regla debe dejar de coincidir con esta interfaz o usar DHCP=ipv4')
    return 'systemd-networkd'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interfaz')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ValueError('Ejecutá este comando con sudo')
        interface = choose_interface(args.interfaz)
        if active('NetworkManager.service'):
            managed = run('nmcli', '-g', 'GENERAL.NM-MANAGED', 'device', 'show', interface,
                          check=False).stdout.strip().lower()
            if managed in ('yes', 'true'):
                manager = configure_nm(interface)
            elif shutil.which('ifup') and active('networking.service'):
                manager = configure_ifupdown(interface)
            elif active('systemd-networkd.service'):
                manager = configure_networkd(interface)
            else:
                raise ValueError(f'NetworkManager no gestiona {interface}; no se cambiará de gestor automáticamente')
        elif active('systemd-networkd.service'):
            manager = configure_networkd(interface)
        elif shutil.which('ifup'):
            manager = configure_ifupdown(interface)
        else:
            raise ValueError('No se detectó un gestor de red compatible: NetworkManager, ifupdown o networkd')
        print(f'{interface}: DHCP y arranque automático configurados con {manager}.')
        print('Conectá el cable a un puerto LAN del Technicolor y comprobá:')
        print(f'  ip -4 -br address show dev {interface}')
        print('  ping -c 3 192.168.0.1')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', '') or str(error)
        parser.exit(1, f'Configuración pendiente: {detail.strip()}\n')


if __name__ == '__main__':
    main()
