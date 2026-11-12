/** Camera discovery is independent of the Marlin WebSocket and UART state. */
export function cameraBaseUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') throw new Error('Respuesta de cámara inválida')
  const info = value as Record<string, unknown>
  if (info.available === false) return null
  if (info.available !== true || typeof info.baseUrl !== 'string')
    throw new Error('Respuesta de cámara inválida')
  const url = new URL(info.baseUrl)
  const parts = url.hostname.split('.')
  if (url.protocol !== 'http:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || parts.length !== 4 ||
      !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255))
    throw new Error('Dirección de cámara inválida')
  return url.origin
}

export async function discoverCamera(signal: AbortSignal): Promise<string | null> {
  const response = await fetch('/api/camera', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('C3 sin respuesta de descubrimiento')
  return cameraBaseUrl(await response.json())
}
