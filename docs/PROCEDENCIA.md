# Procedencia de las fuentes

Revisión del 12 de noviembre de 2026.

## Base recuperada

La base es **Caja_C3_Windows_Diagnostico.py**, entregado el 10 de noviembre de 2026. Se extrajeron sus **166 archivos** verificando el SHA-256 del contenido empaquetado y el de cada archivo. El generador incluye el proyecto C3 completo, las fuentes de interfaz, la web compilada y el servidor Debian.

Versión declarada por el paquete: `4.1.3-five-devices-Windows-WS-diagnostic`.

| Archivo original | SHA-256 |
| --- | --- |
| `Caja_C3_Windows_Diagnostico.py` | `93325cb4413873b4d3201cb451da71789338302f2bd4c88dd86cf6ff5a33f670` |
| `Caja_ARS_Router.py` | `d009c8e5a80cc2f3d4429b9ead483187ba0e5bae2adbc019834580aff5338b2d` |
| `Corregir_IPv4_Mapeado_C3_Windows.py` | `61bfd7777a97857741279d30f4fe523db09534ab62c687b08e216902f02801b5` |

El paquete Windows difiere de Caja_ARS_Router.py 4.1.3 solamente en `c3/firmware/main/main.cpp` y `configurar_red.py`: diagnóstico del rechazo WebSocket y compatibilidad de permisos en Windows. La aplicación y los recursos preparados son idénticos entre ambos paquetes.

## Integración en GitHub

- Se aplicó exactamente el reemplazo de `peer_address()` contenido en el corrector del 10 de noviembre. El resto del puente se conserva.
- Se alineó `PROJECT_VER` de `4.1.0` a `4.1.3`, sin cambiar el protocolo ni las cadenas que ya informaban 4.1.3.
- Se conservan sin cambios las fuentes de la interfaz y los archivos preparados de `c3/firmware/web/`.
- La plantilla sin credenciales pasó a `sdkconfig.defaults.example`. `configurar_red.py` la copia al crear una configuración nueva; los archivos con la contraseña quedan locales y excluidos de Git.
- Se agregaron pruebas del problema IPv4/IPv6 y de configuración desde una copia nueva, documentación actual y validación automática.

El repositorio anterior `impresora-app`, en el commit `d1430fb6a9f1cd9f2ac087697aea968dd16d19de` del 16 de octubre de 2026, no contenía estas actualizaciones. La carpeta de aplicación recuperada tiene 22 archivos modificados y 18 agregados respecto de sus rutas equivalentes. Este repositorio conserva la versión completa de noviembre y no depende del repositorio antiguo para compilar.

## Qué se conoce de los equipos

El último diagnóstico aportado por el usuario reportó `c3-direct-v4.1.3`. Durante esta revisión no se pudo abrir la dirección local de la C3 ni leer su memoria flash. Por eso **este código no se presenta como una copia verificada byte a byte del firmware actualmente grabado**. La corrección IPv4/IPv6 está integrada aquí; su grabación efectiva en la placa no está confirmada.

La web pública de PC se abrió en `https://controlador.impresora-ars.workers.dev/` y se inspeccionaron sus cinco pantallas. Su código se mantiene en el repositorio independiente Controlador-Impresora-PC. La PC Debian de cámara, la aplicación de PC por USB y el firmware de la Mega son componentes distintos.
