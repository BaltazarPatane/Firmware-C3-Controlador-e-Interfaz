// Same-origin WebSocket client. The ESP owns UART, numbering, resends and ACKs.
// No command is replayed after reconnecting; the C3 owns shared state.
import {
  formatTimestamp, uid,
  type PauseState, type JobEvent, type JobPrinterTransport, type SendMeta,
  type PrinterMessage, type PrinterConnectionState,
} from './printer-types'
import { isMovementCommand, parsePositionReport } from './web-serial-printer-transport'
import { WIFI_MAX_COMMAND_BYTES } from './printer-config'

interface Pending {
  text: string
  meta: SendMeta
  written: boolean
  line: number | null
  accepted: () => void
  rejected: (error: Error) => void
  acked?: () => void
  ackRejected?: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class WifiPrinterTransport implements JobPrinterTransport {
  private socket: WebSocket | null = null
  private listeners = new Set<(message: PrinterMessage) => void>()
  private pending = new Map<number, Pending>()
  private id = 0
  private state: PrinterConnectionState = 'disconnected'
  private onReady: (() => void) | null = null
  private onJobEvent: ((event: JobEvent) => void) | null = null
  private numbered = false
  private stopped = true
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private lastRx = 0
  private lastReason = ''
  private reportedPaused = false
  private clientId = 0
  private globalMovements = 0
  private generation = ''
  private stopGeneration: string | null = null
  private machineControls = false
  private droppedConsoleLines = 0
  private controls = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  setOnReady(callback: (() => void) | null) { this.onReady = callback }
  setOnJobEvent(callback: ((event: JobEvent) => void) | null) { this.onJobEvent = callback }
  isIdle() { return this.pending.size === 0 && this.controls.size === 0 }
  isNumberedProtocol() { return this.numbered }
  enableNumberedProtocol() { this.numbered = true }
  disableNumberedProtocol() { this.numbered = false }
  subscribe(listener: (message: PrinterMessage) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(message: PrinterMessage) { this.listeners.forEach((fn) => fn(message)) }
  private log(direction: 'TX' | 'RX' | 'SYS' | 'ERR', content: string) {
    this.emit({ kind: 'console', entry: { id: uid(), timestamp: formatTimestamp(), direction, content } })
  }
  private setState(state: PrinterConnectionState) {
    if (this.state === state) return
    this.state = state
    this.emit({ kind: 'connection', state })
  }
  private queue(ack?: { wasMovement: boolean; pauseMarker: 'M400' | 'M0' | null }) {
    const pendingMovementCount = this.globalMovements
    this.emit({ kind: 'queue', pendingMovementCount, ...(ack ? { ack } : {}) })
  }
  private reset(reason: string) {
    const error = new Error(reason)
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.rejected(error); p.ackRejected?.(error)
    }
    for (const control of this.controls.values()) { clearTimeout(control.timer); control.reject(error) }
    this.controls.clear(); this.machineControls = false
    this.pending.clear(); this.numbered = false; this.queue()
    this.reportedPaused = false
  }
  async connect(): Promise<void> {
    if (typeof window === 'undefined' || this.socket) return
    this.stopped = false
    if (window.location.protocol === 'https:') {
      this.log('ERR', 'Abrí la dirección HTTP de la ESP para conectar por WiFi local.')
      this.setState('disconnected')
      return
    }
    this.setState('connecting')
    const socket = new WebSocket(`ws://${window.location.host}/ws`)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.lastRx = Date.now()
      socket.send(JSON.stringify({ type: 'hello', protocol: 3 }))
      this.setState('waiting-marlin')
      this.heartbeat = setInterval(() => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
        if (Date.now() - this.lastRx > 10000) { socket.close(); return }
        socket.send(JSON.stringify({ type: 'ping' }))
      }, 2000)
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastRx = Date.now()
      try { this.receive(JSON.parse(String(event.data))) }
      catch { this.log('ERR', 'Mensaje WiFi inválido'); socket.close() }
    }
    socket.onerror = () => { if (this.socket === socket) this.log('ERR', 'No se pudo abrir WiFi. Revisá la red o el límite de conexiones.') }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = null
      this.reset('Conexión WiFi perdida; comandos pendientes descartados')
      this.setState('disconnected')
      if (!this.stopped) this.retry = setTimeout(() => { this.retry = null; void this.connect() }, 3000)
    }
  }
  async requestAndConnect() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    await this.connect()
  }
  async disconnect() {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.retry = null; this.heartbeat = null
    const socket = this.socket; this.socket = null
    socket?.close()
    this.reset('Interfaz desconectada'); this.setState('disconnected')
  }
  sendCommand(text: string, meta: SendMeta = {}): Promise<void> {
    return this.submit(text, meta, false)
  }
  sendTracked(text: string, meta: SendMeta = {}): Promise<void> {
    return this.submit(text, meta, true)
  }
  private submit(raw: string, meta: SendMeta, tracked: boolean): Promise<void> {
    if (meta.jobTag) return Promise.reject(new Error("La versión 3 no carga archivos G-code"))
    const text = raw.trim()
    if (!text) return Promise.resolve()
    const urgent = /^M(?:108|112|410)\b/i.test(text)
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || (!urgent && this.state !== 'connected'))
      return Promise.reject(new Error('Sin conexión con Marlin'))
    if (!/^[GMT]\d/i.test(text) || /[^\x20-\x7e]|[;*()]/.test(text) || new TextEncoder().encode(text).length > WIFI_MAX_COMMAND_BYTES)
      return Promise.reject(new Error('Una línea G/M/T sin comentarios, hasta 78 bytes ASCII'))
    if (this.pending.size >= 32 && !urgent) return Promise.reject(new Error('Cola WiFi llena'))
    if (/^M(?:112|410)\b/i.test(text)) { this.stopGeneration = this.generation; this.reset('Parada solicitada') }
    const id = ++this.id
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = {
        text, meta, written: false, line: null,
        accepted: tracked ? () => {} : resolve,
        rejected: reject,
        ...(tracked ? { acked: resolve, ackRejected: reject } : {}),
        timer: null,
      }
      pending.timer = setTimeout(() => {
        this.log('ERR', 'La ESP no confirmó la recepción; se interrumpe el enlace sin repetir comandos.')
        this.socket?.close()
      }, 7000)
      this.pending.set(id, pending); this.queue()
      try { this.socket!.send(JSON.stringify({ type: 'command', id, text, job: false })) }
      catch { this.socket?.close(); this.reset('Fallo al enviar por WiFi') }
    })
  }
  sendMachineControl(action: 'pause' | 'resume'): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Sin conexión con la ESP'))
    if (!this.machineControls) return Promise.reject(new Error('Actualizar el firmware a 3.0 para usar el control compartido'))
    if (action === 'pause' && this.state !== 'connected') return Promise.reject(new Error('Marlin todavía no está listo'))
    const id = ++this.id
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.log('ERR', 'La ESP no confirmó la solicitud de control'); this.socket?.close() }, 7000)
      this.controls.set(id, { resolve, reject, timer })
      try { this.socket!.send(JSON.stringify({ type: 'control', id, action })) }
      catch { this.reset('Fallo al solicitar el control compartido'); this.socket?.close() }
    })
  }
  async sendBatch(commands: string[]): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.state !== 'connected') throw new Error('Sin conexión con Marlin')
    if (!commands.length || commands.length > 8 || this.pending.size + commands.length > 32) throw new Error('Lote o cola fuera de límite')
    const texts = commands.map((raw) => raw.trim())
    if (texts.some((text) => !/^[GMT]\d/i.test(text) || /[^\x20-\x7e]|[;*()]/.test(text) || text.length > WIFI_MAX_COMMAND_BYTES || /^M(?:108|112|410)\b/i.test(text)))
      throw new Error('Lote inválido; los comandos urgentes se envían individualmente')
    const first = this.id + 1
    const receipts = texts.map((text) => new Promise<void>((resolve, reject) => {
      const id = ++this.id
      const pending: Pending = { text, meta: {}, written: false, line: null, accepted: resolve, rejected: reject, timer: null }
      pending.timer = setTimeout(() => this.socket?.close(), 7000)
      this.pending.set(id, pending)
    }))
    const completion = Promise.all(receipts)
    try { this.socket.send(JSON.stringify({ type: 'batch', id: first, texts })) }
    catch { this.reset('Fallo al enviar lote'); this.socket?.close() }
    await completion
  }
  discardQueuedCommands() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'discard' }))
  }
  private receive(message: Record<string, unknown>) {
    const type = message.type
    if (type === 'pong') return
    if (type === 'status') {
      if (message.protocol !== 3) { this.log('ERR', 'Actualizá el firmware y la aplicación juntos (protocolo 3)'); this.socket?.close(); return }
      const reason = typeof message.reason === 'string' ? message.reason : ''
      const generation = `${message.bootId}:${message.generation}`
      if (this.generation && this.generation !== generation) this.reset('Mega o ESP reiniciados; comandos pendientes descartados')
      this.generation = generation
      const clientId = Number(message.clientId) || this.clientId
      if (clientId !== this.clientId) this.droppedConsoleLines = 0
      this.clientId = clientId
      const dropped = Number(message.droppedConsoleLines) || 0
      if (dropped > this.droppedConsoleLines)
        this.log('SYS', `Red ocupada: ${dropped - this.droppedConsoleLines} líneas de consola omitidas; las confirmaciones de comandos tienen prioridad.`)
      this.droppedConsoleLines = dropped
      this.globalMovements = Number(message.movements) || 0
      let emergency = message.emergency === true
      // An old ready packet in flight cannot clear a stop just requested locally.
      if (this.stopGeneration !== null) {
        if (this.stopGeneration === '') this.stopGeneration = generation
        if (emergency || generation !== this.stopGeneration) this.stopGeneration = null
        else emergency = true
      }
      if (message.ready === true) {
        const wasConnected = this.state === 'connected'
        this.setState('connected')
        if (!wasConnected) { this.log('SYS', 'ESP y Marlin conectados por WiFi'); this.onReady?.() }
      } else {
        if (this.state === 'connected') this.reset(reason || 'Marlin no está listo')
        this.setState(message.stage === 'fault' ? 'error' : 'waiting-marlin')
      }
      this.machineControls = message.machineControls === true
      if (reason && reason !== this.lastReason) this.log('SYS', reason)
      this.lastReason = reason
      const position = typeof message.position === 'string' ? parsePositionReport(message.position) : null
      if (position) this.emit({ kind: 'position', position })
      this.emit({ kind: 'bridge', clients: Number(message.clients) || 1,
        phones: Number(message.phones) || 0, phoneLimit: Number(message.phoneLimit) || 0,
        cameraAssociated: message.cameraAssociated === true,
        cameraUrl: typeof message.cameraUrl === 'string' ? message.cameraUrl : '',
        detail: reason || 'Marlin responde', emergency,
        pausePhase: ['running', 'pause-requested', 'waiting-for-motion-finish', 'paused', 'resuming'].includes(String(message.pausePhase))
          ? message.pausePhase as PauseState : message.paused === true ? 'paused' : 'running',
        sdPrinting: message.sdPrinting === true, sdPaused: message.sdPaused === true,
        sdDone: Number(message.sdDone) || 0, sdTotal: Number(message.sdTotal) || 0 })
      this.queue()
      if (typeof message.paused === 'boolean' && message.paused !== this.reportedPaused) {
        this.reportedPaused = message.paused
        this.emit({ kind: 'pauseReport', paused: message.paused })
      }
      return
    }
    const text = typeof message.text === 'string' ? message.text : ''
    if (type === 'tx' || type === 'historyTx' || type === 'historyRx' || type === 'notice') {
      this.log(type === 'tx' || type === 'historyTx' ? 'TX' : type === 'notice' ? 'SYS' : 'RX',
        (type.startsWith('history') ? '[Anterior] ' : '') + text)
      return
    }
    if (type === 'rx') {
      this.log('RX', text)
      const position = parsePositionReport(text)
      if (position) this.emit({ kind: 'position', position })
      if (/^Error:/i.test(text)) this.emit({ kind: 'machineState', state: 'error' })
      return
    }
    const id = typeof message.id === 'number' ? message.id : -1
    if (type === 'controlAccepted' || type === 'controlRejected') {
      const control = this.controls.get(id)
      if (control) {
        clearTimeout(control.timer); this.controls.delete(id)
        if (type === 'controlAccepted') control.resolve()
        else { this.log('ERR', text); control.reject(new Error(text || 'Control rechazado')) }
      }
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    if (type === 'accepted') {
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = null; pending.accepted()
    } else if (type === 'written') {
      pending.written = true
      pending.line = typeof message.line === 'number' ? message.line : null
      if (pending.meta.jobTag) this.onJobEvent?.({ type: 'written', tag: pending.meta.jobTag, ackId: pending.meta.ackId, lineNumber: pending.line })
    } else if (type === 'ack') {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      this.queue({ wasMovement: isMovementCommand(pending.text), pauseMarker: pending.meta.pauseMarker ?? null })
      if (pending.meta.jobTag) this.onJobEvent?.({ type: 'acked', tag: pending.meta.jobTag, ackId: pending.meta.ackId, lineNumber: pending.line, wasMovement: isMovementCommand(pending.text) })
      pending.acked?.()
    } else if (type === 'resend') {
      this.log('SYS', `Marlin pidió reenviar N${message.line}`)
      if (typeof message.line === 'number') this.onJobEvent?.({ type: 'resend', lineNumber: message.line })
    } else if (type === 'rejected' || type === 'discarded') {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      const error = new Error(text || 'Comando descartado')
      pending.rejected(error); pending.ackRejected?.(error); this.queue()
      if (type === 'rejected') {
        this.log('ERR', error.message)
        if (pending.meta.jobTag) { this.socket?.send(JSON.stringify({ type: 'discard' })); this.socket?.close() }
      }
    }
  }
}
