# Firmware C3 · Controlador e interfaz

Control por Wi-Fi de la impresora cartesiana del Astillero Río Santiago. La **ESP32-C3** sirve la interfaz de celular y comunica los comandos con **Marlin en la Arduino Mega 2560**. Una PC con **Debian 13** captura la webcam USB y entrega el video directamente a los navegadores.

**Versión de referencia: C3 4.1.3, con la corrección de IPv4 mapeado a IPv6 integrada.**

| Parte | Ubicación |
| --- | --- |
| Interfaz de celular en la red de la máquina | [http://192.168.0.254/](http://192.168.0.254/) |
| Interfaz de PC por USB | [controlador.impresora-ars.workers.dev](https://controlador.impresora-ars.workers.dev/) |
| Código del controlador de PC | [Controlador-Impresora-PC](https://github.com/BaltazarPatane/Controlador-Impresora-PC) |
| Firmware de la Mega | [Impresora-Cartesiana](https://github.com/BaltazarPatane/Impresora-Cartesiana) |

La dirección de la C3 es local: el dispositivo debe estar conectado a la red de la impresora. Este repositorio contiene fuentes completas, pruebas y **la web ya compilada para SPIFFS**. No es un volcado de la memoria de una placa; la procedencia y el alcance de la verificación se detallan en [docs/PROCEDENCIA.md](docs/PROCEDENCIA.md).

## Arquitectura actual

El router genera el Wi-Fi de 2,4 GHz. La C3 se conecta como estación y usa `192.168.0.254`; Debian se conecta al router por Ethernet. El celular descarga la interfaz de la C3, intercambia control por WebSocket `/ws` y recibe el video HTTP directamente desde Debian. La ESP32-S3 ya no participa en esta versión.

| Componente | Función |
| --- | --- |
| ESP32-C3 | Servidor web, sesiones de control, cola y puente UART hacia Marlin |
| Arduino Mega 2560 | Ejecución del G-code y control de la impresora cartesiana |
| Debian + webcam USB | Captura MJPEG, servidor HTTP y anuncio de su dirección a la C3 |
| Router | Red local y DHCP de Debian; no se necesita salida a Internet durante el uso |

Debian anuncia su IP y puerto a la C3. La interfaz puede recuperar el video cuando cambia la dirección de Debian o se reinicia la cámara. Una pérdida de video no invalida el enlace de control con Marlin.

## Interfaz y control

- **Movimiento:** posición XYZ, pasos y desplazamientos manuales.
- **Control:** homing, pausa y reanudación compartidas.
- **Cámara:** transmisión automática, estado «Sin conexión» y botón «Reconectar cámara».
- **Impresión:** seguimiento de trabajos de SD. El tiempo restante y el porcentaje son estimativos y solo están disponibles para impresiones desde la SD.
- **Consola:** envío manual de G-code y respuestas del controlador.

La versión admite **cinco dispositivos de control**, con hasta **dos pestañas por dirección IPv4**. La cámara Debian no consume uno de esos cinco lugares. El servidor de video tiene su propio límite de seis transmisiones simultáneas.

Los clientes pueden entrar y salir durante el funcionamiento. Las sesiones comparten estado y cola; los lotes de movimiento no se intercalan entre celulares. La pausa/reanudación y la emergencia se coordinan en la C3. La emergencia requiere mantener presionado el botón durante un segundo. El paro físico de la máquina sigue siendo el recurso de emergencia independiente de la comunicación.

La interfaz móvil no ofrece carga de programas G-code completos. Para transmitir archivos desde una computadora se utiliza el controlador de PC por USB. El seguimiento de SD se puede iniciar aunque el trabajo ya esté en marcha.

## Cableado conservado

| Señal C3 | Arduino Mega |
| --- | --- |
| TX GPIO5 | RX3, pin 15 |
| RX GPIO4 | TX3, pin 14, mediante la adaptación existente de 5 V a 3,3 V |
| GND | GND común |

UART1 en la C3, a **115200 baudios**. Marlin debe tener habilitado el puerto serie 3 correspondiente. El firmware actual de la impresora es cartesiano y utiliza motores en Z; este proyecto no implementa la antigua corrección hidráulica/encoders.

## Descargar y configurar

Cloná el repositorio en la computadora desde la que vas a grabar la C3:

```bash
git clone https://github.com/BaltazarPatane/Firmware-C3-Controlador-e-Interfaz.git caja_debian_directo
cd caja_debian_directo
python configurar_red.py --ssid "NOMBRE_DE_TU_WIFI"
python configurar_red.py --comprobar
```

La contraseña se pide dos veces sin mostrarla. El grupo predeterminado es `ARS_CAJA1`; para cambiarlo, agregá `--grupo NOMBRE` y llevá también el archivo `debian/red_camara.json` actualizado a Debian.

La plantilla pública es `c3/firmware/sdkconfig.defaults.example`. El configurador crea `sdkconfig.defaults` localmente y conserva los parámetros de compilación de la plantilla. Tanto ese archivo, que puede contener la contraseña, como `sdkconfig` están excluidos de Git. No hace falta ingresar la clave del Wi-Fi en Debian, porque se conecta por Ethernet.

## Compilar y grabar la C3

Se requiere **ESP-IDF 6.1** y Python 3.10 o posterior. La web compilada está incluida; **Node.js no es necesario para grabar esta versión**.

### Windows

Abrí la terminal de **ESP-IDF 6.1** del entorno instalado con EIM y entrá en la carpeta `caja_debian_directo`. Verificá primero que el entorno está activo:

```powershell
idf.py --version
python configurar_red.py --comprobar
python compilar.py c3
python compilar.py c3 --grabar COM4
idf.py -C c3/firmware -p COM4 monitor
```

Usá el puerto COM real de la placa. Si `idf.py` no se reconoce, todavía falta activar o abrir la terminal de ESP-IDF; no es un error del código. Se sale del monitor con `Ctrl+]`.

### Linux

Activá el SDK desde su ruta instalada; por ejemplo:

```bash
source "$HOME/esp/esp-idf/export.sh"
idf.py --version
cd "$HOME/caja_debian_directo"
python3 configurar_red.py --comprobar
python3 compilar.py c3 --grabar /dev/ttyACM0
idf.py -C c3/firmware -p /dev/ttyACM0 monitor
```

La ruta del SDK y el puerto pueden variar. El script exige ESP-IDF 6.1 y compila tanto el firmware como la partición web antes de grabar.

## Modificar la interfaz

Las fuentes están en `c3/aplicacion/`; el contenido servido por la placa está en `c3/firmware/web/`. Después de editar la interfaz, reconstruí también la web para que ambos coincidan:

```bash
python compilar.py c3 --reconstruir-web --grabar COM4
```

Este paso requiere Node.js 22 y npm, además del entorno ESP-IDF activo. Para revisar solo la aplicación:

```bash
cd c3/aplicacion
npm ci
npm test
npm run build
npm run typecheck
```

Desde la raíz, `python c3/firmware/tools/prepare_web.py c3/aplicacion/out` actualiza los archivos de SPIFFS. Si publicás cambios de interfaz, incluí las fuentes y la web preparada en el mismo commit.

## Cámara Debian

El programa permanente, los instaladores y los servicios están incluidos en `debian/`. La guía [docs/INSTALACION_DEBIAN.md](docs/INSTALACION_DEBIAN.md) explica cómo instalarlo y verificar la captura, la red y el arranque automático.

| Consulta | Resultado esperado |
| --- | --- |
| `http://192.168.0.254/api/camera` | `build: c3-direct-v4.1.3`, `phoneLimit: 5`, origen Debian |
| `http://IP_DEBIAN:8080/health` | `build: debian-direct-v1.0.1`, `active: true` y FPS mayores que cero |
| `http://192.168.0.254/` → Cámara | Imagen o estado de desconexión con reconexión |

## Corrección WebSocket incluida

ESP-IDF/lwIP puede informar una conexión IPv4 mediante una estructura IPv6 con dirección `::ffff:a.b.c.d`. El firmware anterior rechazaba ese caso con «No se pudo validar la IP del cliente». `peer_address()` ahora recupera la IPv4 en ese caso y aplica las mismas comprobaciones de subred y dirección de origen. No habilita IPv6 nativo ni elimina los límites de sesiones u origen.

La corrección ya está integrada: no hay que ejecutar el parche externo. `PROJECT_VER` se alinea con `4.1.3`; el paquete recuperado todavía declaraba `4.1.0` aunque el endpoint reportaba `c3-direct-v4.1.3`.

## Pruebas y estructura

```bash
python3 verificar.py
```

Las pruebas portables requieren `g++`, un compilador C y Python. No conectan placas ni cambian la red del equipo. Cubren cola, clientes, pausa, emergencia, recepción de cámara, instalación y política de dirección del WebSocket. GitHub Actions ejecuta esas pruebas, las de interfaz y una compilación ESP-IDF 6.1 sin credenciales.

| Ruta | Contenido |
| --- | --- |
| `c3/aplicacion/` | Aplicación Next.js, componentes, transporte Wi-Fi y pruebas |
| `c3/firmware/main/` | Servidor C++, núcleo del puente, sesiones y cámara |
| `c3/firmware/web/` | HTML, JavaScript, CSS y recursos ya preparados para la placa |
| `debian/` | Captura, servidor HTTP, configuración Ethernet y servicio systemd |
| `configurar_red.py` | Configuración local de Wi-Fi y grupo de cámara |
| `compilar.py` | Compilación, reconstrucción opcional de interfaz y grabación |
| `verificar.py`, `tests/` | Pruebas portables e integración |
| `VALIDACION.md` | Comprobaciones realizadas y límites de validación |

Desarrollo de **Baltazar Patané**, Astillero Río Santiago.
