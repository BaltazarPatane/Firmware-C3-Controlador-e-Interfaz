# Validación de la sincronización 4.1.3

Fecha: 12 de noviembre de 2026. Firmware C3 4.1.3 con corrección IPv4/IPv6; cámara Debian `debian-direct-v1.0.1`.

## Comprobaciones locales ejecutadas

| Comprobación | Resultado |
| --- | --- |
| Integridad del paquete recuperado y sus 166 archivos | SHA-256 verificados |
| Python: servidor Debian, instalación y política de dirección WebSocket | 32 pruebas: 31 aprobadas, una omitida por permisos del entorno para AF_UNIX/SOCK_DGRAM |
| C++ portable e integración de paquetes Debian → C3 | 69 escenarios aprobados |
| Aplicación: `npm test` | 48 pruebas aprobadas |
| Aplicación: `npm run build` | Exportación estática Next.js 16.3.0 completada |
| Aplicación: `npm run typecheck` | Sin errores |

La prueba de IPv4 mapeado falló frente a `peer_address()` original y pasó tras aplicar el corrector existente. Compila y ejecuta el cuerpo real de esa función con entradas controladas del socket: IPv4 local, IPv4 mapeado, red ajena, dirección propia, IPv6 nativo, direcciones truncadas y errores del descriptor/getpeername.

La prueba de configuración desde una copia nueva falló antes de la adaptación y pasó después: conserva los parámetros públicos de compilación y escribe la contraseña solamente en la configuración local.

## Web incluida

Se mantienen los recursos compilados entregados con la versión 4.1.3. Una compilación nueva de sus fuentes produjo los mismos ocho archivos JavaScript de chunks; el manifiesto utiliza un identificador de build generado de nuevo. No se sustituyeron los recursos entregados por una reconstrucción innecesaria.

Los recursos incluidos contienen el estado «Sin conexión», «Reconectar cámara» y la nota actualizada de impresión desde SD. No contienen los controles retirados «Modo compatible», «Probar MJPEG» ni el rótulo «Video Debian».

## Compilación ESP-IDF y límites

Este entorno local no tiene instalada la cadena ESP-IDF. El workflow `.github/workflows/validar.yml` incluye una compilación para ESP32-C3 con la imagen oficial `espressif/idf:v6.1`; el resultado de cada ejecución se consulta en GitHub Actions. Esa compilación usa la plantilla sin credenciales y no graba dispositivos.

Las pruebas portables no sustituyen una prueba de carga en la C3 ni una prueba física con Marlin, celulares y webcam. No se accionó la impresora, no se regrabó hardware y no se verificó el alcance Wi-Fi. El arranque real, la recepción de UART, el video y la corrección WebSocket deben comprobarse en el equipo después de compilar y grabar la configuración local.
