'use client'

import { useEffect, useRef, useState } from 'react'
import { VideoOff, RefreshCw } from 'lucide-react'
import { MjpegParser } from '@/lib/mjpeg-parser'
import { discoverCamera } from '@/lib/camera-discovery'
import { CameraReceiver } from '@/lib/camera-receiver'

// La cámara va directo al navegador. Nunca depende de la Mega ni de Marlin.
const STALE_MS = 3500
const START_TIMEOUT_MS = 5500
const STREAM_PROBE_INTERVAL_MS = 15000

type Mode = 'stream' | 'snapshots'
type Status = 'connecting' | 'live' | 'stale' | 'offline'

/** MJPEG real por Fetch streaming: funciona aunque Safari no informe naturalWidth
 * de un <img> cuyo HTTP multipart todavía no terminó. */
export function CameraView() {
  const [cameraHost, setCameraHost] = useState<string | null>(null)
  const [visible, setVisible] = useState(true)
  // Fill the tall camera viewport without distortion. This necessarily crops the sides.
  // User can switch to Contain to see the whole 4:3 frame.
  const [fillFrame, setFillFrame] = useState(true)
  const [mode, setMode] = useState<Mode>('stream')
  const [status, setStatus] = useState<Status>('connecting')
  const [attempt, setAttempt] = useState(0)
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null)
  const [measuredFps, setMeasuredFps] = useState(0)
  const receivedFrames = useRef(0)
  const streamImage = useRef<HTMLImageElement | null>(null)
  const lastDecodedImage = useRef(0)
  const failedStarts = useRef(0)
  const streamWorked = useRef(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: AbortController | undefined
    const poll = async () => {
      pending = new AbortController()
      const deadline = setTimeout(() => pending?.abort(), 1500)
      try {
        const host = await discoverCamera(pending.signal)
        if (active) setCameraHost(host)
      } catch {
        // A brief C3 outage must not interrupt a working direct Debian stream.
      } finally {
        clearTimeout(deadline)
        if (active) timer = setTimeout(poll, 2000)
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer); pending?.abort() }
  }, [])

  useEffect(() => {
    lastDecodedImage.current = 0
    failedStarts.current = 0
    streamWorked.current = false
    setSnapshotSrc(null)
    setStatus(cameraHost ? 'connecting' : 'offline')
    setMode('stream')
  }, [cameraHost])

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    update()
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    receivedFrames.current = 0
    setMeasuredFps(0)
    let previousAt = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const fps = receivedFrames.current * 1000 / Math.max(1, now - previousAt)
      setMeasuredFps(Math.round(fps * 10) / 10)
      receivedFrames.current = 0
      previousAt = now
    }, 2000)
    return () => clearInterval(timer)
  }, [visible, mode, attempt, cameraHost])

  useEffect(() => {
    if (!visible || !cameraHost || mode !== 'stream') return
    let active = true
    const abort = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let incompatible = false
    const parser = new MjpegParser()
    let inDecode = false
    let jpegCount = 0
    let lastSuccess = Date.now()
    let currentUrl: string | null = null
    let nextUrl: string | null = null
    const image = streamImage.current
    setStatus('connecting')

    const decoded = () => {
      if (!active) return
      jpegCount++
      receivedFrames.current++
      lastSuccess = Date.now()
      lastDecodedImage.current = lastSuccess
      setStatus('live')
      failedStarts.current = 0
      streamWorked.current = true
      // Revocar solo cuando el siguiente JPEG ya se decodificó.
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      currentUrl = nextUrl
      nextUrl = null
      inDecode = false
    }
    const decodeError = () => {
      if (nextUrl) URL.revokeObjectURL(nextUrl)
      nextUrl = null
      inDecode = false
    }
    image?.addEventListener('load', decoded)
    image?.addEventListener('error', decodeError)

    const showFrame = (frame: Uint8Array) => {
      if (!active || !image || inDecode) return
      // Se descartan fotogramas si el navegador no llega a decodificarlos.
      // Así nunca se acumula una cola de vídeo atrasado.
      inDecode = true
      nextUrl = URL.createObjectURL(new Blob([new Uint8Array(frame)], { type: 'image/jpeg' }))
      image.src = nextUrl
    }

    const watchdog = setInterval(() => {
      const elapsed = Date.now() - lastSuccess
      if (elapsed > START_TIMEOUT_MS || (jpegCount > 0 && elapsed > STALE_MS)) {
        abort.abort()
      }
    }, 350)

    const run = async () => {
      try {
        const options: RequestInit = {
          cache: 'no-store', mode: 'cors', credentials: 'omit', signal: abort.signal,
        }
        // WebKit rejects fetch() of multipart/x-mixed-replace. /frames carries
        // identical JPEG frames as opaque bytes; the parser handles boundaries.
        let response = await fetch(`${cameraHost}/frames?client=${attempt}`, options)
        if (response.status === 404) {
          // Older Debian installations still work through MJPEG or JPEG fallback.
          await response.body?.cancel().catch(() => {})
          response = await fetch(`${cameraHost}/stream?client=${attempt}`, options)
        }
        if (!response.ok) throw new Error('Cámara temporalmente no disponible')
        if (!/^(?:application\/octet-stream|multipart\/x-mixed-replace)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '') ||
            !response.body) { incompatible = true; throw new Error('Servidor sin MJPEG continuo') }
        const reader = response.body.getReader()
        try {
          while (active) {
            const { done, value } = await reader.read()
            if (done) break
            // El lector recibe un flujo binario ilimitado. El parser entrega
            // cada imagen JPEG completa según Content-Length.
            for (const jpeg of parser.push(value)) showFrame(jpeg)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } catch {
        // Recover in the background; the UI exposes only connection state.
      }
      if (active) {
        if (Date.now() - lastDecodedImage.current > STALE_MS)
          setStatus(lastDecodedImage.current ? 'stale' : 'offline')
        // Do not loop forever when a browser cannot consume a streaming body.
        // Once video has worked, ordinary network cuts keep retrying MJPEG.
        if (!streamWorked.current) failedStarts.current++
        if (incompatible || failedStarts.current >= 2) setMode('snapshots')
        else retryTimer = setTimeout(() => { if (active) setAttempt(n => n + 1) }, 1000)
      }
    }
    void run()
    return () => {
      active = false
      clearTimeout(retryTimer)
      clearInterval(watchdog)
      abort.abort()
      image?.removeEventListener('load', decoded)
      image?.removeEventListener('error', decodeError)
      if (nextUrl) URL.revokeObjectURL(nextUrl)
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [mode, attempt, visible, cameraHost])

  // Respaldo: una imagen JPEG por consulta HTTP, como v3.2.
  useEffect(() => {
    if (!visible || !cameraHost || mode !== 'snapshots') return
    let active = true
    let currentUrl: string | null = null
    const receiver = new CameraReceiver(`${cameraHost}/capture`, setStatus, blob => {
      if (!active) return
      const nextUrl = blob ? URL.createObjectURL(blob) : null
      setSnapshotSrc(nextUrl)
      if (blob) {
        lastDecodedImage.current = Date.now()
        // Count distinct decoded frames, not repeated HTTP reads of one JPEG.
        receivedFrames.current++
      }
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      currentUrl = nextUrl
    })
    receiver.start()
    return () => {
      active = false
      receiver.stop()
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [mode, attempt, visible, cameraHost])

  // While snapshots are working, check the efficient continuous transport in
  // the background. Switch only after receiving a complete valid frame; failed
  // probes never interrupt the image or show technical details to the user.
  useEffect(() => {
    if (!visible || !cameraHost || mode !== 'snapshots') return
    let active = true
    let pending: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = async () => {
      const abort = new AbortController()
      pending = abort
      const deadline = setTimeout(() => abort.abort(), 2500)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let ready = false
      try {
        const response = await fetch(`${cameraHost}/frames?probe=1`, {
          cache: 'no-store', mode: 'cors', credentials: 'omit', signal: abort.signal,
        })
        if (response.ok && /^application\/octet-stream(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '') && response.body) {
          reader = response.body.getReader()
          const parser = new MjpegParser()
          while (active && !ready) {
            const { done, value } = await reader.read()
            if (done) break
            ready = parser.push(value).length > 0
          }
        }
      } catch {
        // The snapshot receiver remains active throughout a failed probe.
      } finally {
        clearTimeout(deadline)
        abort.abort()
        if (reader) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        pending = null
      }
      if (!active) return
      if (ready) {
        failedStarts.current = 0
        streamWorked.current = false
        setAttempt(value => value + 1)
        setMode('stream')
      } else timer = setTimeout(probe, STREAM_PROBE_INTERVAL_MS)
    }
    timer = setTimeout(probe, STREAM_PROBE_INTERVAL_MS)
    return () => { active = false; clearTimeout(timer); pending?.abort() }
  }, [mode, visible, cameraHost])

  const restart = () => {
    lastDecodedImage.current = 0
    failedStarts.current = 0
    streamWorked.current = false
    setSnapshotSrc(null)
    setStatus('connecting')
    setMode('stream')
    setAttempt(n => n + 1)
  }

  const imageIsLive = status === 'live'
  return (
    <section aria-label="Cámara en vivo" className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-border bg-card">
      {visible && mode === 'stream' && (
        <img
          key={attempt}
          ref={streamImage}
          alt="Video de la cámara"
          className={`absolute inset-0 h-full w-full ${fillFrame ? 'object-cover' : 'object-contain'} ${imageIsLive ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {visible && mode === 'snapshots' && snapshotSrc && (
        <img
          src={snapshotSrc}
          alt="Imagen actual de la cámara"
          className={`absolute inset-0 h-full w-full ${fillFrame ? 'object-cover' : 'object-contain'} ${imageIsLive ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {!imageIsLive && (
        <div className="relative flex flex-col items-center gap-2 px-6 text-center">
          <VideoOff className="size-8 text-muted-foreground" aria-hidden="true" />
          <p role="status" className="text-sm font-medium">Sin conexión</p>
          <button type="button" onClick={restart}
            className="mt-2 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <RefreshCw className="size-4" aria-hidden="true" /> Reconectar cámara
          </button>
        </div>
      )}
      {imageIsLive && <span className="absolute left-3 top-3 rounded-full border border-border bg-background/80 px-2.5 py-1 text-[11px] font-medium">
        EN VIVO{measuredFps > 0 ? ` · ${measuredFps.toFixed(1)} FPS` : ''}
      </span>}
      {imageIsLive && <button type="button" onClick={() => setFillFrame(value => !value)}
        aria-label={fillFrame ? 'Ver imagen completa sin recortes' : 'Ampliar imagen para llenar la pantalla'}
        className="absolute bottom-3 right-3 rounded-lg border border-border bg-background/85 px-3 py-1.5 text-xs font-medium shadow-sm">
        {fillFrame ? 'Ver completa' : 'Ampliar imagen'}
      </button>}
    </section>
  )
}
