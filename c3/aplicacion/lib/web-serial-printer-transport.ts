// Real transport that talks to an Arduino Mega 2560 / Marlin DIRECTLY over USB
// using the Web Serial API on /usb. WiFi uses WifiPrinterTransport.
//
//   UI → Printer Store → PrinterTransport → WebSerialPrinterTransport
//        → navigator.serial → Mega → Marlin
//
// This transport owns exactly ONE USB SerialPort,
// with exactly ONE reader and ONE writer (never in React components). It never
// fabricates data: the console only shows RX lines that actually arrive on the
// port, and the position only updates when Marlin reports it (e.g. from an
// M114 response). `port.open()` resolving does NOT mean "connected" — the app
// is connected only after the M115 handshake receives a real `ok`.
//
// For direct USB control, THIS transport implements the
// Pronterface-like command queue: it sends one normal command, waits for the
// real Marlin `ok`, then sends the next. Urgent commands (M112/M410/M108)
// bypass that FIFO but still share the single serialized writer.

import {
  formatTimestamp,
  uid,
  type JobEvent,
  type JobTag,
  type MessageDirection,
  type PauseMarker,
  type Position,
  type PrinterMessage,
  type PrinterTransport,
  type SendMeta,
} from './printer-types'
import { MARLIN_BAUD_RATE } from './printer-config'

/** Web Serial availability (feature detection — never assume it exists). */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/**
 * Whether a raw G-code line is a motion-producing command for the "Cola"
 * counter. Case-insensitive, whitespace-tolerant, matches whole G-words so
 * "G12"/"G100" do not false-positive. Deliberately EXCLUDES helpers such as
 * G90/G91/M114/M115 (they are still tracked as pending for FIFO alignment, but
 * do not count as movements). Set: G0/G00 G1/G01 G2/G02 G3/G03 G5 G28 G29 G30.
 */
export function isMovementCommand(command: string): boolean {
  return /^(G0?0|G0?1|G0?2|G0?3|G5|G28|G29|G30)\b/.test(
    command.trim().toUpperCase(),
  )
}

/**
 * Urgent commands that MUST bypass the ok-based FIFO and be written to the
 * serial stream immediately: M112 (emergency stop), M410 (quickstop) and M108
 * (break out of M0 to resume). Marlin's EMERGENCY_PARSER handles these out of
 * band.
 */
export function isUrgentCommand(upper: string): boolean {
  return /^M(112|410|108)\b/.test(upper.trim())
}

/** True for a real Marlin acknowledgement line (`ok`, `ok N5`, `ok P15 B3`). */
function isOkLine(line: string): boolean {
  return /^ok\b/i.test(line.trim())
}

/**
 * Detect a Marlin resend request and extract the requested line number.
 * Handles `Resend: 123`, `Resend: N123`, `rs N123`, `rs 123`, `Resend:123`.
 */
function parseResendRequest(line: string): number | null {
  const m = /^(?:resend|rs)\s*:?\s*N?\s*(\d+)/i.exec(line.trim())
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Marlin XOR checksum over the exact bytes of the command body (everything
 * BEFORE the `*`), i.e. `N<line> <command>`. The `*checksum` bytes themselves
 * are never included.
 */
function marlinChecksum(body: string): number {
  let checksum = 0
  for (const byte of new TextEncoder().encode(body)) checksum ^= byte
  return checksum
}

/** True for a Marlin startup/reset banner line (`start`). */
function isStartLine(line: string): boolean {
  return /^start\b/i.test(line.trim())
}

/** Extract a Position from a Marlin-style report such as "X:12.30 Y:0.00 Z:5.00". */
export function parsePositionReport(line: string): Position | null {
  line = line.split(/\bCount\b/i)[0] // Step counts are not millimetres.
  // Parse X/Y/Z independently so a single fragile exact-string format is not
  // required. Values may be integers, decimals, negative, with variable
  // whitespace. Only the coordinate triple matters (ignore E:, Count X:...).
  const grab = (axis: string): number | null => {
    const m = new RegExp(`${axis}:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(line)
    if (!m) return null
    const v = Number.parseFloat(m[1])
    return Number.isFinite(v) ? v : null
  }
  const x = grab('X')
  const y = grab('Y')
  const z = grab('Z')
  if (x === null && y === null && z === null) return null
  return { x, y, z }
}

/** A command tracked in the host FIFO (queued and/or awaiting its `ok`). */
interface PendingCommand {
  seq: number
  text: string
  isMovement: boolean
  pauseMarker: PauseMarker | null
  /** File-job role (undefined for ordinary manual/handshake commands). */
  jobTag?: JobTag
  /** Controller-assigned id echoed back in job events for correlation. */
  ackId?: number
  /** Numbered protocol line number assigned at write time (null if plain). */
  lineNumber: number | null
  /** Resolved on this command's real `ok`; rejected if the FIFO is reset. */
  ackResolve?: () => void
  ackReject?: (reason?: unknown) => void
}

/** How many recently transmitted numbered lines to keep for resend requests. */
const RESEND_HISTORY_CAP = 48

// Timing (ms).
const HANDSHAKE_OPEN_DELAY = 2000 // wait out a possible Arduino reset on open
const HANDSHAKE_TIMEOUT = 7000 // M115 → real `ok` window (6–8s)
const RESET_GRACE = 2000 // grace after a detected board reset before re-handshake

type ConnState = 'connected' | 'connecting' | 'disconnected' | 'error'

export class WebSerialPrinterTransport implements PrinterTransport {
  private listeners = new Set<(message: PrinterMessage) => void>()

  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private readLoopDone: Promise<void> = Promise.resolve()
  private readAbort = false
  private closing = false

  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private rxBuffer = '' // persistent RX accumulator across USB chunks

  // Single serialized write chain so no two Uint8Array writes overlap at the
  // Streams level (normal AND urgent writes go through this).
  private writeChain: Promise<void> = Promise.resolve()

  // Host-side Pronterface-like FIFO.
  private queue: PendingCommand[] = [] // waiting to be written
  private currentCommand: PendingCommand | null = null // written, awaiting `ok`
  private seqCounter = 0

  // Numbered-protocol state (ONLY active while a G-code file job is running).
  // Normal manual usage never sends line numbers/checksums.
  private numberedMode = false
  private nextLineNumber = 1
  private resendHistory = new Map<number, string>() // lineNumber → exact wire line
  private onJobEvent: ((event: JobEvent) => void) | null = null

  private connState: ConnState = 'disconnected'

  // Handshake tracking.
  private handshakePending = false
  private handshakeStartTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private resetGraceTimer: ReturnType<typeof setTimeout> | null = null

  // Optional hook fired once each time Marlin completes the handshake. The
  // store uses it to send a single M114 and read the real current position.
  private onReady: (() => void) | null = null

  private serialEventsBound = false
  private readonly onSerialConnect = () => {
    // A previously authorized device came back. Only auto-reopen when we are
    // idle and the choice is unambiguous (exactly one authorized port).
    if (this.port) return
    void this.tryAutoConnect()
  }
  private readonly onSerialDisconnect = (event: Event) => {
    // Only react to OUR device being physically removed.
    if (this.port && (event.target as unknown) === this.port) {
      void this.cleanup('disconnected', 'USB desconectado')
    }
  }

  // ---- public API ----------------------------------------------------------

  setOnReady(cb: (() => void) | null) {
    this.onReady = cb
  }

  /** Register the single job-event sink (the GCodeJobController). */
  setOnJobEvent(cb: ((event: JobEvent) => void) | null) {
    this.onJobEvent = cb
  }

  /** True when the FIFO has no queued and no in-flight command. */
  isIdle(): boolean {
    return this.currentCommand === null && this.queue.length === 0
  }

  isNumberedProtocol(): boolean {
    return this.numberedMode
  }

  /**
   * Enter numbered file mode. The caller MUST have already sent `M110 N0` and
   * received its real `ok`; this only flips local state so subsequent normal
   * commands are serialized as `N<n> <cmd>*<checksum>` starting at line 1.
   */
  enableNumberedProtocol(): void {
    this.numberedMode = true
    this.nextLineNumber = 1
    this.resendHistory.clear()
  }

  /** Leave numbered file mode; subsequent normal commands are sent plain. */
  disableNumberedProtocol(): void {
    this.numberedMode = false
    this.resendHistory.clear()
  }

  /**
   * Send a command and resolve ONLY when its real Marlin `ok` arrives (used by
   * the job controller for internal sync barriers: M110/M400/M114). Rejects if
   * the FIFO is reset (disconnect/emergency) before the `ok`.
   */
  sendTracked(command: string, meta?: SendMeta): Promise<void> {
    const cmd = command.trim()
    if (!cmd) return Promise.resolve()
    if (this.connState !== 'connected') {
      return Promise.reject(new Error('Sin conexión con la impresora'))
    }
    return new Promise<void>((resolve, reject) => {
      this.seqCounter += 1
      this.queue.push({
        seq: this.seqCounter,
        text: cmd,
        isMovement: isMovementCommand(cmd),
        pauseMarker: meta?.pauseMarker ?? null,
        jobTag: meta?.jobTag,
        ackId: meta?.ackId,
        lineNumber: null,
        ackResolve: resolve,
        ackReject: reject,
      })
      this.emitQueue()
      this.processQueue()
    })
  }

  /**
   * Discard commands that are queued but NOT yet written (controlled cancel).
   * The in-flight `currentCommand` is preserved so it can finish/ack normally.
   */
  discardQueuedCommands(): void {
    for (const c of this.queue) c.ackReject?.(new Error('discarded'))
    this.queue = []
    this.emitQueue()
  }

  subscribe(listener: (message: PrinterMessage) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Startup path. Does NOT call requestPort() (that needs a user gesture).
   * Attempts a silent auto-reconnect to an already-authorized Mega instead.
   */
  async connect(): Promise<void> {
    this.bindSerialEvents()
    if (!isWebSerialSupported()) {
      this.setConnection('disconnected')
      return
    }
    await this.tryAutoConnect()
  }

  /**
   * User-gesture entry point (invoked from the disconnected banner). Opens the
   * browser serial chooser WITHOUT a hard vendor filter so genuine and clone
   * Mega 2560 boards are both usable. Returns silently if the user dismisses
   * the chooser; throws only on a real open failure so the store can toast.
   */
  async requestAndConnect(): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error('web-serial-unsupported')
    }
    if (this.port) return // already connected/connecting — never open twice
    let port: SerialPort
    try {
      port = await navigator.serial.requestPort()
    } catch {
      // User dismissed the chooser (NotFoundError/AbortError) → stay
      // disconnected quietly, do not spam the console.
      return
    }
    await this.beginConnection(port)
  }

  async disconnect(): Promise<void> {
    // Manual teardown (e.g. unmount). Do not auto-reconnect afterwards.
    await this.cleanup('disconnected')
  }

  /**
   * Enqueue a command. Normal commands join the ok-based FIFO; urgent commands
   * (M112/M410/M108) bypass it and are written immediately. Resolves once the
   * command has been accepted (queued or written), NOT when Marlin acks it.
   */
  async sendCommand(command: string, meta?: SendMeta): Promise<void> {
    const cmd = command.trim()
    if (!cmd) return
    const upper = cmd.toUpperCase()

    if (isUrgentCommand(upper)) {
      await this.sendUrgent(cmd, upper)
      return
    }

    if (this.connState !== 'connected') {
      throw new Error('Sin conexión con la impresora')
    }

    this.seqCounter += 1
    this.queue.push({
      seq: this.seqCounter,
      text: cmd,
      isMovement: isMovementCommand(cmd),
      pauseMarker: meta?.pauseMarker ?? null,
      jobTag: meta?.jobTag,
      ackId: meta?.ackId,
      lineNumber: null,
    })
    this.emitQueue()
    this.processQueue()
  }

  // ---- connection lifecycle ------------------------------------------------

  private bindSerialEvents() {
    if (this.serialEventsBound || !isWebSerialSupported()) return
    this.serialEventsBound = true
    navigator.serial.addEventListener('connect', this.onSerialConnect)
    navigator.serial.addEventListener('disconnect', this.onSerialDisconnect)
  }

  private async tryAutoConnect(): Promise<void> {
    if (this.port) return
    try {
      const ports = await navigator.serial.getPorts()
      if (ports.length === 1) {
        // Exactly one previously authorized port → reopen it automatically.
        await this.beginConnection(ports[0])
      } else {
        // Zero ports, or ambiguous (>1) → require the user gesture.
        this.setConnection('disconnected')
      }
    } catch {
      this.setConnection('disconnected')
    }
  }

  /** Open a chosen/authorized port and start the handshake sequence. */
  private async beginConnection(port: SerialPort): Promise<void> {
    if (this.port) return
    this.closing = false
    this.readAbort = false
    this.rxBuffer = ''
    this.resetFifo()
    this.port = port
    this.setConnection('connecting')

    try {
      await port.open({
        baudRate: MARLIN_BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      })
    } catch (err) {
      // Another program may already own the port, or the device vanished.
      this.port = null
      this.log('ERR', 'No se pudo abrir el puerto USB (¿en uso por otra app?)')
      this.setConnection('disconnected')
      throw err
    }

    try {
      this.writer = port.writable ? port.writable.getWriter() : null
    } catch {
      this.writer = null
    }

    // Start the read loop IMMEDIATELY so early Marlin startup output is not lost.
    this.readAbort = false
    this.readLoopDone = this.readLoop()

    // Wait out a possible Arduino reset, then perform the Marlin handshake.
    this.clearTimer('handshakeStartTimer')
    this.handshakeStartTimer = setTimeout(() => {
      this.handshakeStartTimer = null
      this.startHandshake()
    }, HANDSHAKE_OPEN_DELAY)
  }

  private startHandshake() {
    if (!this.port || !this.writer) return
    this.handshakePending = true
    // M115 is an INTERNAL handshake command. Track it in the FIFO so its `ok`
    // is matched normally; it is not a movement.
    this.seqCounter += 1
    const cmd: PendingCommand = {
      seq: this.seqCounter,
      text: 'M115',
      isMovement: false,
      pauseMarker: null,
      lineNumber: null,
    }
    this.currentCommand = cmd
    this.emitQueue()
    void this.rawWrite(cmd.text + '\n')
      .then(() => this.log('TX', cmd.text))
      .catch(() => this.cleanup('error', 'Fallo al enviar el handshake'))

    this.clearTimer('handshakeTimeoutTimer')
    this.handshakeTimeoutTimer = setTimeout(() => {
      this.handshakeTimeoutTimer = null
      if (this.handshakePending) {
        this.log('ERR', 'Marlin no respondió al handshake (M115)')
        void this.cleanup('disconnected')
      }
    }, HANDSHAKE_TIMEOUT)
  }

  private completeHandshake() {
    this.handshakePending = false
    this.clearTimer('handshakeTimeoutTimer')
    this.setConnection('connected')
    // Ask for the real current position exactly once.
    this.onReady?.()
    this.processQueue()
  }

  // ---- read loop -----------------------------------------------------------

  private async readLoop(): Promise<void> {
    try {
      while (this.port?.readable && !this.readAbort) {
        const reader = this.port.readable.getReader()
        this.reader = reader
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (value && value.length) {
              this.rxBuffer += this.decoder.decode(value, { stream: true })
              this.flushLines()
            }
          }
        } finally {
          try {
            reader.releaseLock()
          } catch {
            /* already released */
          }
          this.reader = null
        }
      }
    } catch {
      // A read error means the device is gone / fatally errored.
    }
    if (!this.readAbort) {
      // Unexpected end of the read loop → treat as a physical disconnect.
      void this.cleanup('error', 'Conexión serie perdida')
    }
  }

  /** Split the RX buffer on CR/LF/CRLF, keeping the trailing partial line. */
  private flushLines() {
    const parts = this.rxBuffer.split(/\r\n|\n|\r/)
    this.rxBuffer = parts.pop() ?? '' // preserve incomplete tail for next read
    for (const raw of parts) {
      const line = raw.trim()
      if (line.length === 0) continue
      this.handleIncoming(line)
    }
  }

  private handleIncoming(line: string) {
    // Every complete Marlin line is shown verbatim as RX (including echo:,
    // busy:, Error:, warnings, firmware info). We never invent or suppress it.
    this.log('RX', line)

    // Board reset while already connected: stop trusting queue/pause state.
    if (isStartLine(line) && this.connState === 'connected') {
      this.handleBoardReset()
      return
    }

    // A real Marlin resend request (numbered file mode only). Retransmit the
    // EXACT stored wire line without advancing the parser/progress/line number,
    // or stop the job if the requested line is outside the retained history.
    if (this.numberedMode) {
      const resendLine = parseResendRequest(line)
      if (resendLine !== null) {
        const wire = this.resendHistory.get(resendLine)
        if (wire) {
          this.log('SYS', `Reenvío solicitado por Marlin: N${resendLine}`)
          void this.rawWrite(wire + '\n').catch(() => {
            void this.cleanup('error', 'Error al reenviar la línea')
          })
          this.onJobEvent?.({ type: 'resend', lineNumber: resendLine })
        } else {
          this.log(
            'ERR',
            `Reenvío imposible: N${resendLine} fuera del historial`,
          )
          this.onJobEvent?.({ type: 'resendFailed', lineNumber: resendLine })
        }
        return // never treat a resend line as an ack
      }
    }

    const position = parsePositionReport(line)
    if (position) this.emit({ kind: 'position', position })

    if (isOkLine(line)) {
      if (this.currentCommand) {
        const acked = this.currentCommand
        this.currentCommand = null
        if (
          this.handshakePending &&
          acked.text.toUpperCase().startsWith('M115')
        ) {
          this.completeHandshake()
        }
        this.emitQueue({
          wasMovement: acked.isMovement,
          pauseMarker: acked.pauseMarker,
        })
        // Notify the job controller (correlated) and resolve any tracked send.
        if (acked.jobTag) {
          this.onJobEvent?.({
            type: 'acked',
            tag: acked.jobTag,
            ackId: acked.ackId,
            lineNumber: acked.lineNumber,
            wasMovement: acked.isMovement,
          })
        }
        acked.ackResolve?.()
        this.processQueue()
      } else {
        // Stray / late `ok` with nothing outstanding: log only, never pop a
        // queued command (that would desync the FIFO after resume).
      }
    }
  }

  private handleBoardReset() {
    this.log('SYS', 'Reinicio de la placa detectado (start)')
    this.resetFifo()
    this.handshakePending = false
    this.clearTimer('handshakeTimeoutTimer')
    this.clearTimer('handshakeStartTimer')
    // Back to connecting so the store clears stale position/pause/queue safely.
    this.setConnection('connecting')
    this.clearTimer('resetGraceTimer')
    this.resetGraceTimer = setTimeout(() => {
      this.resetGraceTimer = null
      if (this.port && this.writer) this.startHandshake()
    }, RESET_GRACE)
  }

  // ---- FIFO / writing ------------------------------------------------------

  private processQueue() {
    if (this.currentCommand) return // waiting for the current `ok`
    if (this.connState !== 'connected') return // hold until Marlin is ready
    const next = this.queue.shift()
    if (!next) return
    this.currentCommand = next
    this.emitQueue()

    // In numbered file mode every normal command is serialized as
    // `N<n> <cmd>*<checksum>` and remembered for possible resend. Manual mode
    // (numberedMode === false) transmits the raw text exactly as before.
    let wire: string
    if (this.numberedMode) {
      const n = this.nextLineNumber
      this.nextLineNumber += 1
      const body = `N${n} ${next.text}`
      wire = `${body}*${marlinChecksum(body)}`
      next.lineNumber = n
      this.resendHistory.set(n, wire)
      this.pruneResendHistory()
    } else {
      wire = next.text
    }

    void this.rawWrite(wire + '\n')
      .then(() => {
        // Log TX only once the bytes have ACTUALLY been written to the Mega.
        this.log('TX', wire)
        if (next.jobTag) {
          this.onJobEvent?.({
            type: 'written',
            tag: next.jobTag,
            ackId: next.ackId,
            lineNumber: next.lineNumber,
          })
        }
      })
      .catch(() => {
        this.currentCommand = null
        void this.cleanup('error', 'Error al escribir en el puerto')
      })
  }

  private pruneResendHistory() {
    while (this.resendHistory.size > RESEND_HISTORY_CAP) {
      const oldest = this.resendHistory.keys().next().value
      if (oldest === undefined) break
      this.resendHistory.delete(oldest)
    }
  }

  /** Urgent write: bypass the FIFO but still serialize the actual bytes. */
  private async sendUrgent(cmd: string, upper: string): Promise<void> {
    if (!this.writer || this.connState === 'disconnected') {
      throw new Error('Sin conexión con la impresora')
    }
    // M112 / M410 discard commands that must NOT run afterwards. M108 (resume)
    // must PRESERVE the queue and the outstanding M0 (currentCommand).
    if (upper.startsWith('M112') || upper.startsWith('M410')) {
      for (const c of this.queue) c.ackReject?.(new Error('emergency'))
      this.currentCommand?.ackReject?.(new Error('emergency'))
      this.queue = []
      this.currentCommand = null
      // Emergency invalidates the numbered file sequence.
      this.numberedMode = false
      this.resendHistory.clear()
      this.emitQueue()
    }
    await this.rawWrite(cmd + '\n')
    this.log('TX', cmd)
  }

  /** The one and only place bytes are written; chained so writes never overlap. */
  private rawWrite(text: string): Promise<void> {
    const run = this.writeChain.then(async () => {
      if (!this.writer) throw new Error('no-writer')
      await this.writer.write(this.encoder.encode(text))
    })
    // Keep the chain alive even if this particular write rejects.
    this.writeChain = run.catch(() => {})
    return run
  }

  // ---- cleanup -------------------------------------------------------------

  private async cleanup(finalState: ConnState, logMsg?: string) {
    if (this.closing) return
    this.closing = true
    this.readAbort = true

    this.clearTimer('handshakeStartTimer')
    this.clearTimer('handshakeTimeoutTimer')
    this.clearTimer('resetGraceTimer')
    this.handshakePending = false

    if (logMsg) this.log('ERR', logMsg)

    // Stop the read loop and release its lock.
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      await this.readLoopDone
    } catch {
      /* ignore */
    }

    // Finish any in-flight write, then release the writer.
    try {
      await this.writeChain
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.writer = null

    // Close the port only after both streams are unlocked.
    const port = this.port
    this.port = null
    try {
      await port?.close()
    } catch {
      /* ignore */
    }

    this.rxBuffer = ''
    this.resetFifo()
    this.setConnection(finalState)
    this.closing = false
  }

  // ---- helpers -------------------------------------------------------------

  private resetFifo() {
    // Reject any tracked sends still awaiting an `ok` so the job controller can
    // abort cleanly instead of hanging on a promise that will never resolve.
    for (const c of this.queue) c.ackReject?.(new Error('fifo-reset'))
    this.currentCommand?.ackReject?.(new Error('fifo-reset'))
    this.queue = []
    this.currentCommand = null
    // A reset invalidates the numbered sequence entirely.
    this.numberedMode = false
    this.resendHistory.clear()
    this.emitQueue()
  }

  private pendingMovementCount(): number {
    let n = this.queue.reduce((acc, c) => (c.isMovement ? acc + 1 : acc), 0)
    if (this.currentCommand?.isMovement) n += 1
    return n
  }

  private emitQueue(ack?: {
    wasMovement: boolean
    pauseMarker: PauseMarker | null
  }) {
    this.emit({
      kind: 'queue',
      pendingMovementCount: this.pendingMovementCount(),
      ...(ack ? { ack } : {}),
    })
  }

  private setConnection(state: ConnState) {
    this.connState = state
    this.emit({ kind: 'connection', state })
  }

  private emit(message: PrinterMessage) {
    this.listeners.forEach((listener) => listener(message))
  }

  private log(direction: MessageDirection, content: string) {
    this.emit({
      kind: 'console',
      entry: { id: uid(), timestamp: formatTimestamp(), direction, content },
    })
  }

  private clearTimer(
    key: 'handshakeStartTimer' | 'handshakeTimeoutTimer' | 'resetGraceTimer',
  ) {
    const t = this[key]
    if (t !== null) {
      clearTimeout(t)
      this[key] = null
    }
  }
}
