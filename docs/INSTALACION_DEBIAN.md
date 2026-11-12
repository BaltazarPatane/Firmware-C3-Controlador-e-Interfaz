# Cámara permanente en Debian 13

La webcam USB se conecta a Debian y la PC se conecta al router por Ethernet. La ESP32-S3 ya no se usa. La C3 sirve los controles; Debian entrega el video directamente al navegador.

## 1. Llevar el proyecto a Debian

Con Internet durante la preparación, podés clonar este repositorio como `~/caja_debian_directo`. También podés copiar esa carpeta mediante una SD. No hace falta llevar `node_modules`, ESP-IDF ni los directorios de compilación. Para instalar la cámara bastan `debian/` y su archivo `red_camara.json`.

Si cambiaste el grupo de la C3 con `configurar_red.py`, copiá el `debian/red_camara.json` generado en la computadora de preparación. El grupo debe coincidir. No copies contraseñas Wi-Fi a Debian.

## 2. Preparar dependencias y Ethernet

```bash
sudo apt update
sudo apt install -y python3 ffmpeg v4l-utils
ip -br link
v4l2-ctl --list-devices
cd "$HOME/caja_debian_directo"
sudo python3 debian/configurar_ethernet.py
```

El configurador utiliza el gestor de red que ya está instalado, conserva respaldos y habilita DHCP con reconexión. Si pide seleccionar interfaz, usá el nombre real observado en `ip -br link`; por ejemplo:

```bash
sudo python3 debian/configurar_ethernet.py --interfaz enp1s0
ip -4 -br address
```

Debe aparecer una dirección `192.168.0.xxx` en Ethernet. `127.0.0.1` corresponde al equipo mismo y no alcanza para comunicarse con la C3.

## 3. Instalar el servicio

```bash
sudo python3 debian/instalar.py --usuario trixie --capture-fps 25 --send-fps 25
```

Usá el usuario real de Debian si difiere de `trixie`. El instalador elige la webcam, prefiere una ruta persistente y configura el arranque automático. Si hay más de una cámara, indicá la correcta con `--camara /dev/v4l/by-id/...-video-index0`.

| Archivo instalado | Función |
| --- | --- |
| `/opt/caja-camara/camara_http.py` | Programa de captura y servidor |
| `/etc/caja-ars/camara-http.json` | Perfil persistente de cámara/red |
| `/etc/systemd/system/camara-caja.service` | Arranque y reinicio del servicio |
| `/var/backups/caja-ars/` | Respaldos de configuraciones anteriores |

Si estaba instalado `camera-usb-s3.service`, el instalador lo deshabilita para evitar que ambos servicios abran la webcam. Conserva resolución y parámetros del perfil anterior, salvo los indicados explícitamente.

## 4. Verificar captura y descubrimiento

```bash
systemctl is-enabled camara-caja.service
systemctl is-active camara-caja.service
journalctl -u camara-caja.service -n 30 --no-pager
python3 debian/diagnosticar.py
```

El servicio debe estar `enabled` y `active`. Además, el diagnóstico debe indicar captura reciente: `active: true`, `jpeg_bytes` y `published_fps` mayores que cero. Un servicio en marcha no basta para demostrar que hay imagen.

Desde un navegador en la misma red:

- `http://IP_DEBIAN:8080/health`: estado de captura; versión `debian-direct-v1.0.1`.
- `http://192.168.0.254/api/camera`: `available: true` y `baseUrl` con la IP actual de Debian.
- `http://192.168.0.254/`: pestaña Cámara de la interfaz de la impresora.

La dirección de Debian puede cambiar por DHCP; el anuncio a la C3 permite descubrirla nuevamente. El video funciona aunque Marlin esté desconectado. Si el celular indica que el Wi-Fi no tiene Internet, mantené la conexión a esa red local.

## 5. Arranque y mantenimiento

El servicio systemd inicia la cámara al arrancar Debian y la reinicia ante fallos. Si se necesita encendido automático al volver la alimentación, la opción correspondiente de la BIOS debe estar configurada en la PC.

```bash
sudo systemctl restart camara-caja.service
journalctl -u camara-caja.service -f
```

Para cambiar resolución o FPS, ejecutá nuevamente el instalador con los valores deseados. Para cambiar puerto, por ejemplo:

```bash
sudo python3 debian/instalar.py --usuario trixie --http-port 8081
```

El nuevo puerto se anuncia automáticamente; no requiere recompilar la C3. Para desactivar el servicio:

```bash
sudo systemctl disable --now camara-caja.service
```

La operación habitual no necesita Internet, una cuenta externa ni una terminal abierta.
