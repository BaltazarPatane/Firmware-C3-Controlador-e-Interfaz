#!/usr/bin/env python3
"""Instala video HTTP permanente y migra el servicio anterior sin la S3."""
import argparse
import datetime
import grp
import json
import os
import pwd
import re
import shlex
import shutil
import socket
import subprocess
from pathlib import Path
from camara_http import DEFAULTS, validate_config

HERE = Path(__file__).resolve().parent
PROFILE = Path('/etc/caja-ars/camara-http.json')
LEGACY_PROFILE = Path('/etc/caja-ars/camera.json')
SERVICE = Path('/etc/systemd/system/camara-caja.service')
DESTINATION = Path('/opt/caja-camara')
LEGACY_SERVICE = 'camera-usb-s3.service'
MIGRATED_KEYS = ('camera', 'width', 'height', 'capture_fps', 'send_fps', 'stall_timeout')


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True)


def legacy_profile(service_text, old_json=None):
    profile = dict(DEFAULTS)
    if old_json is not None:
        profile.update({key: old_json[key] for key in MIGRATED_KEYS if key in old_json})
    else:
        for line in service_text.replace('\\\n', ' ').splitlines():
            if not line.startswith('ExecStart='):
                continue
            argv = shlex.split(line.split('=', 1)[1])
            if not any(Path(arg).name == 'camera_sender.py' for arg in argv):
                continue
            for key in MIGRATED_KEYS:
                flag = '--' + key.replace('_', '-')
                if flag in argv:
                    i = argv.index(flag) + 1
                    if i >= len(argv):
                        raise ValueError(f'Falta el valor de {flag} en el servicio anterior')
                    profile[key] = type(DEFAULTS[key])(argv[i])
    return profile


def stable_device(requested, links):
    candidates = sorted(path for path in links if path.exists())
    if requested:
        path = Path(requested)
        if not path.is_absolute() or not str(path).startswith('/dev/'):
            raise ValueError('Webcam: usá una ruta absoluta /dev/...')
        if '/by-id/' in str(path) or '/by-path/' in str(path):
            return str(path)
        equivalent = [link for link in candidates if link.resolve() == path.resolve()]
        if equivalent:
            return str(sorted(equivalent, key=lambda p: ('/by-id/' not in str(p), str(p)))[0])
        if not path.exists():
            raise ValueError(f'Webcam: {path} no está conectada. Conectala y repetí la instalación')
        print(f'Webcam: usando {path}; sin identificador USB persistente disponible')
        return str(path)
    choices = [link for link in candidates if '/by-id/' in str(link)] or candidates
    unique = {}
    for link in choices:
        unique.setdefault(str(link.resolve()), link)
    if len(unique) == 1:
        return str(next(iter(unique.values())))
    names = ', '.join(str(link) for link in unique.values()) or 'ninguna conectada'
    raise ValueError(f'Webcam: no se puede elegir automáticamente ({names}). Indicá --camara /dev/...')


def choose_camera(explicit, previous, links):
    if explicit:
        return stable_device(explicit, links)
    if previous and ('/by-id/' in previous or '/by-path/' in previous):
        return stable_device(previous, links)
    if any(path.exists() for path in links):
        return stable_device(None, links)
    return stable_device(previous, links)


def choose_user(argument, service_text):
    found = re.findall(r'^User=([A-Za-z0-9_.-]+)$', service_text, flags=re.M)
    user = argument or (found[-1] if found else os.environ.get('SUDO_USER', 'trixie'))
    record = pwd.getpwnam(user)
    if record.pw_uid == 0:
        raise ValueError('Elegí un usuario normal: --usuario trixie')
    grp.getgrnam('video')
    return user


def backup(paths):
    stamp = datetime.datetime.now().strftime('video-directo-%Y%m%d-%H%M%S-%f')
    destination = Path('/var/backups/caja-ars') / stamp
    destination.mkdir(parents=True, mode=0o700)
    for path in paths:
        if path.is_file():
            target = destination / str(path).lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    return destination


def atomic_write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.caja-tmp')
    with temporary.open('wb') as out:
        out.write(data)
    temporary.chmod(mode)
    os.replace(temporary, path)


def install(args):
    if os.geteuid() != 0:
        raise ValueError('Ejecutá el instalador con sudo')
    if not shutil.which('ffmpeg'):
        raise ValueError('Falta FFmpeg. Con Internet temporal: sudo apt install ffmpeg v4l-utils')
    # No reemplazar silenciosamente ajustes externos que alterarían el servicio nuevo.
    overrides = run('systemctl', 'show', '-p', 'DropInPaths', '--value', SERVICE.name, check=False).stdout.strip()
    if overrides:
        raise ValueError(f'El servicio tiene ajustes externos: {overrides}. Revisalos antes de reinstalar')
    previous = run('systemctl', 'cat', LEGACY_SERVICE, check=False).stdout
    current = run('systemctl', 'cat', SERVICE.name, check=False).stdout
    user = choose_user(args.usuario, current or previous)
    if PROFILE.is_file():
        profile = validate_config(json.loads(PROFILE.read_text()))
    else:
        old_json = json.loads(LEGACY_PROFILE.read_text()) if LEGACY_PROFILE.is_file() else None
        profile = legacy_profile(previous, old_json)
    network = json.loads((HERE / 'red_camara.json').read_text())
    if set(network) != {'c3_address', 'pair_group'}:
        raise ValueError('red_camara.json debe contener sólo c3_address y pair_group')
    profile.update(network)
    for name in ('width', 'height', 'capture_fps', 'send_fps', 'stall_timeout', 'http_port'):
        if getattr(args, name) is not None:
            profile[name] = getattr(args, name)
    links = list(Path('/dev/v4l/by-id').glob('*video-index0'))
    links += list(Path('/dev/v4l/by-path').glob('*video-index0'))
    old_camera = profile['camera'] if previous or PROFILE.exists() or LEGACY_PROFILE.exists() else None
    profile['camera'] = choose_camera(args.camara, old_camera, links)
    profile = validate_config(profile)
    saved = backup([SERVICE, PROFILE, LEGACY_PROFILE, DESTINATION / 'camara_http.py'])
    was_active = run('systemctl', 'is-active', '--quiet', SERVICE.name, check=False).returncode == 0
    run('systemctl', 'stop', SERVICE.name, check=False)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((profile['bind'], profile['http_port']))
    except OSError as error:
        if was_active:
            run('systemctl', 'start', SERVICE.name, check=False)
        raise ValueError(f'El puerto {profile["http_port"]} está ocupado: {error}. '
                         'Cerrá ese servidor o elegí --http-port 8081') from error
    # Desactivar sólo el emisor antiguo que competía por la misma webcam.
    if previous:
        run('systemctl', 'disable', '--now', LEGACY_SERVICE)
    atomic_write(DESTINATION / 'camara_http.py', (HERE / 'camara_http.py').read_bytes(), 0o755)
    atomic_write(PROFILE, (json.dumps(profile, indent=2) + '\n').encode())
    service = (HERE / SERVICE.name).read_text()
    service = re.sub(r'^User=.+$', 'User=' + user, service, flags=re.M)
    atomic_write(SERVICE, service.encode())
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', SERVICE.name)
    run('systemctl', 'is-active', '--quiet', SERVICE.name)
    print(f'Servicio instalado para {user}: {SERVICE.name}')
    print(f'Copia de seguridad: {saved}')
    print(json.dumps(profile, indent=2))
    print('Revisar: journalctl -u camara-caja.service -n 30 --no-pager')
    print('Servicio activo significa programa en marcha. /health active=true confirma captura reciente.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--usuario')
    parser.add_argument('--camara', help='preferir /dev/v4l/by-id/...-video-index0')
    for flag in ('width', 'height', 'capture-fps', 'send-fps', 'http-port'):
        parser.add_argument('--' + flag, type=int)
    parser.add_argument('--stall-timeout', type=float)
    args = parser.parse_args()
    try:
        install(args)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', '') or str(error)
        parser.exit(1, f'Instalación pendiente: {detail.strip()}\n')


if __name__ == '__main__':
    main()
