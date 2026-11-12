/**
 * Parser incremental para el MJPEG que emite Debian:
 * multipart/x-mixed-replace; boundary=frame
 * --frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n[JPEG]\r\n...
 *
 * No espera que el HTTP termine: entrega cada JPEG completo apenas llega.
 */
export class MjpegParser {
  private buffer = new Uint8Array(0)
  private expected = 0
  private readonly maxFrame: number
  private static readonly HEADER_END = new Uint8Array([13, 10, 13, 10])

  constructor(maxFrame = 512 * 1024) {
    this.maxFrame = maxFrame
  }

  push(chunk: Uint8Array): Uint8Array[] {
    // El límite corresponde a cada JPEG; un read puede traer varios completos.
    const frames: Uint8Array[] = []
    for (let offset = 0; offset < chunk.length; offset += 32768) {
      frames.push(...this.consume(chunk.subarray(offset, offset + 32768)))
    }
    return frames
  }

  private consume(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged
    if (merged.length > this.maxFrame + 32768 + 1024) {
      throw new Error('Trama MJPEG demasiado grande')
    }

    const frames: Uint8Array[] = []
    for (;;) {
      if (this.expected === 0) {
        const end = this.findSequence(this.buffer, MjpegParser.HEADER_END)
        if (end < 0) {
          if (this.buffer.length > 1024) throw new Error('Cabecera MJPEG incompleta')
          break
        }
        if (end > 1024) throw new Error('Cabecera MJPEG demasiado grande')
        const header = new TextDecoder().decode(this.buffer.subarray(0, end))
        if (!/\-\-frame(?:\r\n|$)/i.test(header)) {
          throw new Error('Boundary MJPEG inesperado')
        }
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) throw new Error('Falta Content-Length del frame')
        const length = Number(match[1])
        if (!Number.isInteger(length) || length < 4 || length > this.maxFrame) {
          throw new Error('Longitud MJPEG invalida')
        }
        this.expected = length
        this.buffer = this.buffer.slice(end + 4)
      }
      if (this.buffer.length < this.expected) break
      const jpeg = this.buffer.slice(0, this.expected)
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
          jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
        throw new Error('Imagen JPEG incompleta')
      }
      frames.push(jpeg)
      this.buffer = this.buffer.slice(this.expected)
      this.expected = 0
    }
    return frames
  }

  private findSequence(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }
}
