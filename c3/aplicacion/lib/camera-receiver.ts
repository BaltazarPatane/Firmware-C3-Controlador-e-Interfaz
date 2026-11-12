export type CameraStatus = 'connecting' | 'live' | 'offline' | 'stale'
// Respaldo JPEG: una consulta a la vez. El modo principal usa MJPEG continuo.
// La velocidad depende de la red y el navegador. No se retransmite por la C3.
export const CAMERA_LIMITS = { bytes: 512 * 1024, width: 1920, height: 1080, timeout: 1800, stale: 3000, interval: 80, retry: 1000 }

async function decodeJpeg(blob: Blob): Promise<{ width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(Error('JPEG no decodificable'))
      image.src = url
    })
    return { width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (error) { URL.revokeObjectURL(url); throw error }
}

// Standard HTTP JPEG snapshots, requested directly from Debian. No C3 proxy.
// Exactly one request at a time; stale and request deadlines are independent.
export class CameraReceiver {
  private active = false
  private epoch = 0
  private controller: AbortController | null = null
  private next: ReturnType<typeof setTimeout> | null = null
  private stale: ReturnType<typeof setTimeout> | null = null
  private lastTag = ''
  private lastGoodAt = 0
  constructor(
    private url: string,
    private state: (status: CameraStatus) => void,
    private frame: (blob: Blob | null) => void,
    private fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private decoder: (blob: Blob) => Promise<{ width: number; height: number; close: () => void }> = decodeJpeg,
  ) {}
  start() {
    if (this.active) return
    this.active = true; this.lastTag = ''; this.lastGoodAt = 0; this.state('connecting')
    const epoch = ++this.epoch
    void this.request(epoch)
  }
  stop() {
    this.active = false; ++this.epoch; this.controller?.abort()
    if (this.next) clearTimeout(this.next)
    if (this.stale) clearTimeout(this.stale)
    this.next = this.stale = null; this.frame(null)
  }
  private async read(signal: AbortSignal): Promise<{ blob: Blob; tag: string }> {
    const response = await this.fetcher(this.url, { signal, mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error' })
    const tag = response.headers.get('ETag') || ''
    if (response.status !== 200 || !/^image\/jpeg(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '') ||
        !/^"[\x21\x23-\x7e]{1,96}"$/.test(tag)) throw Error('Respuesta de cámara inválida')
    const length = Number(response.headers.get('Content-Length'))
    if (length > CAMERA_LIMITS.bytes) throw Error('Imagen demasiado grande')
    if (!response.body) throw Error('Respuesta sin imagen')
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (signal.aborted) throw Error('Cancelada')
        if (done) break
        bytes += value.length
        if (bytes > CAMERA_LIMITS.bytes) throw Error('Imagen demasiado grande')
        chunks.push(new Uint8Array(value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (!bytes) throw Error('Imagen vacía')
    const blob = new Blob(chunks, { type: 'image/jpeg' })
    const bitmap = await this.decoder(blob)
    const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= CAMERA_LIMITS.width && bitmap.height <= CAMERA_LIMITS.height
    bitmap.close()
    if (!valid || signal.aborted) throw Error('Imagen fuera de límite o cancelada')
    return { blob, tag }
  }
  private async request(epoch: number) {
    if (!this.active || epoch !== this.epoch) return
    const controller = new AbortController(); this.controller = controller
    const timeout = setTimeout(() => controller.abort(), CAMERA_LIMITS.timeout)
    let retry = CAMERA_LIMITS.interval
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('Tiempo de cámara agotado')), { once: true }))
    try {
      const { blob, tag } = await Promise.race([this.read(controller.signal), aborted])
      if (!this.active || epoch !== this.epoch) return
      if (tag !== this.lastTag) {
        this.lastTag = tag; this.lastGoodAt = Date.now(); this.frame(blob); this.state('live')
        if (this.stale) clearTimeout(this.stale)
        this.stale = setTimeout(() => {
          if (this.active && epoch === this.epoch) { this.frame(null); this.state('stale') }
        }, CAMERA_LIMITS.stale)
      }
    } catch {
      if (!this.active || epoch !== this.epoch) return
      // Un unico corte TCP no implica que la camara haya dejado de generar
      // cuadros. Conservar el ultimo JPEG hasta agotar su plazo de frescura.
      if (!this.lastGoodAt || Date.now() - this.lastGoodAt >= CAMERA_LIMITS.stale) {
        if (this.stale) clearTimeout(this.stale)
        this.stale = null; this.frame(null); this.state('offline')
      }
      retry = CAMERA_LIMITS.retry
    } finally { clearTimeout(timeout); controller.abort(); if (this.controller === controller) this.controller = null }
    if (this.active && epoch === this.epoch) this.next = setTimeout(() => { void this.request(epoch) }, retry)
  }
}
