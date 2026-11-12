// Shared domain types for the Cartesian printer control app.
//
// These types are transport-agnostic. The UI talks only to the printer store,
// which talks to a `PrinterTransport`. The concrete transport
// is either USB Web Serial to the Mega or WiFi through the ESP32-C3.
// There is no simulation layer: coordinates and responses only
// ever come from real hardware messages.

export type PrinterConnectionState =
  | 'connected'
  | 'connecting'
  | 'waiting-marlin'
  | 'disconnected'
  | 'error'

export type MachineState =
  | 'idle'
  | 'moving'
  | 'homing'
  | 'printing'
  | 'error'
  | 'emergency-stop'

export type Axis = 'x' | 'y' | 'z'

export type Step = 0.1 | 1 | 10 | 100

/**
 * Position in millimetres. `null` on any axis means "no real value received
 * from the printer yet" and must be rendered as `--.--`. The UI never
 * fabricates coordinates.
 */
export interface Position {
  x: number | null
  y: number | null
  z: number | null
}

export type MessageDirection = 'TX' | 'RX' | 'SYS' | 'ERR'

/**
 * Controlled-pause state machine (host-side, Pronterface-like). It is driven by
 * REAL Marlin acknowledgements, never by timers:
 *  - running                   → normal operation
 *  - pause-requested           → M400+M0 sent, movements still ahead of pause
 *  - waiting-for-motion-finish → all pre-pause movements acked, waiting M400 ok
 *  - paused                    → M400 acked (planner drained); M0 now blocks
 *  - resuming                  → M108 transmitted, returning to running
 */
export type PauseState =
  | 'running'
  | 'pause-requested'
  | 'waiting-for-motion-finish'
  | 'paused'
  | 'resuming'

export const PAUSE_STATE_LABELS: Record<PauseState, string> = {
  running: 'En ejecución',
  'pause-requested': 'Pausa pendiente',
  'waiting-for-motion-finish': 'Esperando fin de movimientos…',
  paused: 'Pausada',
  resuming: 'Reanudando…',
}

/**
 * Marker attached to the two commands of the controlled-pause sequence so the
 * transport can associate the real `ok` for M400 with the "paused" transition.
 */
export type PauseMarker = 'M400' | 'M0'

/**
 * Tag identifying the role of a command inside a G-code file job, used by the
 * transport to fire correlated job events back to the GCodeJobController.
 *  - file        → an executable line streamed from the loaded program
 *  - m110         → the M110 N0 line-number synchronization
 *  - pause-m400   → controlled-pause barrier
 *  - pause-m0     → controlled-pause hold (released by M108)
 *  - final-m400   → end-of-program planner-drain barrier
 *  - cancel-m400  → controlled-cancel synchronization barrier
 *  - m114          → internal position refresh during a job
 */
export type JobTag =
  | 'file'
  | 'm110'
  | 'pause-m400'
  | 'pause-m0'
  | 'final-m400'
  | 'cancel-m400'
  | 'm114'

/** Optional metadata passed alongside a transmitted command. */
export interface SendMeta {
  pauseMarker?: PauseMarker
  /** Marks the command as part of a numbered file job (for correlation). */
  jobTag?: JobTag
  /** Controller-assigned id to correlate the eventual `ok` with a file line. */
  ackId?: number
}

/**
 * Direct transport→controller notifications for numbered file execution. These
 * are delivered on a dedicated hook (NOT the public message bus) so job
 * correlation never pollutes generic store state.
 */
export type JobEvent =
  | { type: 'written'; tag: JobTag; ackId?: number; lineNumber: number | null }
  | {
      type: 'acked'
      tag: JobTag
      ackId?: number
      lineNumber: number | null
      wasMovement: boolean
    }
  // Marlin asked to resend a numbered line that WAS in history (already retransmitted).
  | { type: 'resend'; lineNumber: number }
  // Marlin asked for a line that cannot be safely reconstructed → fatal.
  | { type: 'resendFailed'; lineNumber: number }

/**
 * Centralized G-code program job state machine. Driven exclusively by real
 * Marlin acknowledgements and real file streaming — never by timers.
 */
export type GCodeJobState =
  | 'idle'
  | 'analyzing'
  | 'ready'
  | 'starting'
  | 'printing'
  | 'pause-requested'
  | 'waiting-for-motion-finish'
  | 'paused'
  | 'resuming'
  | 'cancelling'
  | 'cancelled'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'error'

export const GCODE_JOB_STATE_LABELS: Record<GCodeJobState, string> = {
  idle: 'Sin programa',
  analyzing: 'Analizando archivo…',
  ready: 'Listo',
  starting: 'Iniciando…',
  printing: 'Ejecutando',
  'pause-requested': 'Pausa pendiente',
  'waiting-for-motion-finish': 'Esperando fin de movimientos…',
  paused: 'Pausado',
  resuming: 'Reanudando…',
  cancelling: 'Cancelando…',
  cancelled: 'Cancelado',
  finalizing: 'Finalizando…',
  completed: 'Completado',
  interrupted: 'Interrumpido',
  error: 'Error',
}

/** Job phases during which ordinary manual commands must be locked out. */
export const JOB_ACTIVE_STATES: ReadonlySet<GCodeJobState> = new Set<GCodeJobState>(
  [
    'starting',
    'printing',
    'pause-requested',
    'waiting-for-motion-finish',
    'paused',
    'resuming',
    'cancelling',
    'finalizing',
  ],
)

/** Immutable snapshot of the current program job shown by the UI. */
export interface GCodeJob {
  fileName: string
  fileSize: number
  totalCommands: number
  acknowledgedCommands: number
  progress: number // 0..100
  state: GCodeJobState
  error?: string
}

export const EMPTY_JOB: GCodeJob = {
  fileName: '',
  fileSize: 0,
  totalCommands: 0,
  acknowledgedCommands: 0,
  progress: 0,
  state: 'idle',
}

/** Human-friendly byte size (e.g. "12.4 MB") for the program card. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export interface ConsoleEntry {
  id: string
  /** Wall-clock timestamp formatted as HH:MM:SS */
  timestamp: string
  direction: MessageDirection
  content: string
}

/**
 * Messages emitted by a transport back to the store. A single union keeps the
 * subscribe() contract simple.
 */
export type PrinterMessage =
  | { kind: 'bridge'; clients: number; phones: number; phoneLimit: number; cameraAssociated: boolean; cameraUrl: string; detail: string; emergency: boolean; pausePhase: PauseState; sdPrinting: boolean; sdPaused: boolean; sdDone: number; sdTotal: number }
  | { kind: 'remoteJob'; job: GCodeJob | null }
  | { kind: 'remoteJobAction'; action: 'pause' | 'resume' | 'cancel' }
  | { kind: 'pauseReport'; paused: boolean }
  | { kind: 'console'; entry: ConsoleEntry }
  | { kind: 'position'; position: Position }
  | { kind: 'machineState'; state: MachineState }
  | { kind: 'connection'; state: PrinterConnectionState }
  // Emitted whenever the pending-command FIFO changes: on each send and on each
  // real Marlin `ok`. `pendingMovementCount` is the authoritative number of
  // motion commands still awaiting acknowledgement. When the change was caused
  // by an `ok`, `ack` describes the command that was just acknowledged.
  | {
      kind: 'queue'
      pendingMovementCount: number
      ack?: { wasMovement: boolean; pauseMarker: PauseMarker | null }
    }

/**
 * Transport abstraction. The UI never opens sockets directly, only the store
 * (through this interface) does.
 */
export interface PrinterTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  sendCommand(command: string, meta?: SendMeta): Promise<void>
  subscribe(listener: (message: PrinterMessage) => void): () => void
}

/** Common contract for USB and the ESP32-C3 bridge. */
export interface JobPrinterTransport extends PrinterTransport {
  sendMachineControl?(action: 'pause' | 'resume'): Promise<void>
  sendBatch?(commands: string[]): Promise<void>
  publishJob?(job: GCodeJob): void
  requestRemoteJobAction?(action: 'pause' | 'resume' | 'cancel'): void
  requestAndConnect(): Promise<void>
  setOnReady(callback: (() => void) | null): void
  setOnJobEvent(callback: ((event: JobEvent) => void) | null): void
  isIdle(): boolean
  isNumberedProtocol(): boolean
  enableNumberedProtocol(): void
  disableNumberedProtocol(): void
  sendTracked(command: string, meta?: SendMeta): Promise<void>
  discardQueuedCommands(): void
}

export interface PrinterState {
  connection: PrinterConnectionState
  machineState: MachineState | null
  position: Position
  selectedStep: Step
}

export const STEPS: Step[] = [0.1, 1, 10, 100]

export const MACHINE_STATE_LABELS: Record<MachineState, string> = {
  idle: 'En espera',
  moving: 'Moviendo',
  homing: 'Ejecutando home',
  printing: 'Imprimiendo',
  error: 'Error',
  'emergency-stop': 'Parada de emergencia',
}

export const CONNECTION_LABELS: Record<PrinterConnectionState, string> = {
  connected: 'Conectada',
  connecting: 'Conectando',
  'waiting-marlin': 'ESP conectada · esperando Marlin',
  disconnected: 'Desconectada',
  error: 'Error de conexión',
}

export const EMPTY_POSITION: Position = { x: null, y: null, z: null }

/** Format a millimetre value; `null` renders as the placeholder `--.--`. */
export function formatMm(value: number | null): string {
  return value === null ? '--.--' : value.toFixed(2)
}

/** HH:MM:SS timestamp for console entries. */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toLocaleTimeString('es-ES', { hour12: false })
}

let __id = 0
export function uid(): string {
  __id += 1
  return `${Date.now().toString(36)}-${__id.toString(36)}`
}
