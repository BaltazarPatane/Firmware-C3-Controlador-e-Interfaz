#!/usr/bin/env python3
"""Copy the Next static export to SPIFFS, gzip text assets deterministically."""
import gzip
import shutil
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'aplicacion/out'
destination = Path(__file__).resolve().parents[1] / 'web'
if not (source / 'index.html').is_file():
    raise SystemExit(f'Falta {source}/index.html. Ejecutar npm run build en c3/aplicacion.')
if destination.exists():
    shutil.rmtree(destination)
destination.mkdir(parents=True)
total = 0
for src in sorted(source.rglob('*')):
    if not src.is_file():
        continue
    relative = src.relative_to(source)
    content = src.read_bytes()
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    use_gzip = len(compressed) + 32 < len(content)
    name = str(relative) + ('.gz' if use_gzip else '')
    if len(('/' + name).encode()) >= 128:
        raise SystemExit(f'Nombre supera SPIFFS_OBJ_NAME_LEN=128: {name}')
    dst = destination / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(compressed if use_gzip else content)
    total += dst.stat().st_size
print(f'Web preparada: {total} bytes; destino {destination}')
