'use client'

// Centralised, transport-agnostic state for the printer UI.
//
// UI  →  Printer Store  →  PrinterTransport  →  WebSerialPrinterTransport
//        →  navigator.serial  →  Mega  →  Marlin
//
// Components never open serial ports or fabricate data. They read state and
// call actions here; this store owns the single PrinterTransport instance and
// reflects only what the transport reports.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useToast } from '@/components/toaster'
import { parseSdDetail, type SdPrintDetails } from '@/lib/sd-print-report'
import {
  WebSerialPrinterTransport,
  isWebSerialSupported,
} from './web-serial-printer-transport'
import { WifiPrinterTransport } from './wifi-printer-transport'
import {
  EMPTY_POSITION,
  formatMm,
  formatTimestamp,
  uid,
  type Axis,
  type ConsoleEntry,
  type MachineState,
  type MessageDirection,
  type PauseState,
  type Position,
  type PrinterConnectionState,
  type Step,
  type JobPrinterTransport,
} from './printer-types'

// Preserve at least the latest 200 entries (spec). We keep a bit more headroom.
const MAX_ENTRIES = 300

type HomeTarget = Axis | 'all'

/**
 * Whether a manually-typed command is likely to change machine coordinates and
 * therefore warrants an automatic follow-up M114. Recognizes motion/home/offset
 * families (G0/G00, G1/G01, G2/G02, G3/G03, G5, G28, G29, G30, G92). Receives an
 * already-uppercased, trimmed command and matches on whole G-word boundaries so
 * e.g. "G12" or "G100" do not false-positive.
 */
function commandMayChangePosition(upper: string): boolean {
  return /^(G0?0|G0?1|G0?2|G0?3|G5|G28|G29|G30|G92)\b/.test(upper)
}

interface PrinterStoreValue {
  mode: 'wifi' | 'usb'
  linkDetail: string
  camera: { associated: boolean; url: string }
  sdPrint: { active: boolean; paused: boolean; done: number; total: number }
  sdDetails: SdPrintDetails
  refreshSdDetails: () => Promise<void>
  connection: PrinterConnectionState
  machineState: MachineState | null
  position: Position
  selectedStep: Step
  emergencyStopActive: boolean
  canOperate: boolean
  busyAction: string | null
  console: ConsoleEntry[]
  commandHistory: string[]
  // Controlled-pause state, driven only by real Marlin acknowledgements.
  pauseState: PauseState
  /** Motion commands currently awaiting `ok` (the running "Cola" value). */
  pendingMovementCount: number
  /** Movements that were already ahead of the pause when it was requested. */
  movementsAheadOfPause: number
  /** Whether this browser exposes the Web Serial API (USB). */
  webSerialSupported: boolean
  // actions
  /** Open the browser USB chooser (must be called from a user gesture). */
  connectUsb: () => Promise<void>
  connectPrinter: () => Promise<void>
  setStep: (step: Step) => void
  jog: (axis: Axis, direction: 1 | -1) => Promise<void>
  home: (target: HomeTarget) => Promise<void>
  emergencyStop: () => void
  sendCommand: (raw: string) => Promise<void>
  requestPause: () => Promise<void>
  resumePrinter: () => Promise<void>
  clearConsole: () => void

}

const PrinterContext = createContext<PrinterStoreValue | null>(null)

export function PrinterProvider({ children, mode = 'wifi' }: { children: React.ReactNode; mode?: 'wifi' | 'usb' }) {
  const { toast } = useToast()

  // Single real transport instance for the app lifetime. Exactly ONE
  // SerialPort reader/writer for the whole application.
  const transportRef = useRef<JobPrinterTransport | null>(null)
  if (transportRef.current === null) {
    transportRef.current = mode === 'usb' ? new WebSerialPrinterTransport() : new WifiPrinterTransport()
  }
  const transport = transportRef.current

  const [connection, setConnection] =
    useState<PrinterConnectionState>('disconnected')
  const [machineState, setMachineState] = useState<MachineState | null>(null)
  const [position, setPosition] = useState<Position>(EMPTY_POSITION)
  const [selectedStep, setSelectedStep] = useState<Step>(10)
  const [emergencyStopActive, setEmergencyStopActive] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [pauseState, setPauseState] = useState<PauseState>('running')
  const [pendingMovementCount, setPendingMovementCount] = useState(0)
  const [movementsAheadOfPause, setMovementsAheadOfPause] = useState(0)
  const [camera, setCamera] = useState({ associated: false, url: "" })
  const [linkDetail, setLinkDetail] = useState('')
  const [sdPrint, setSdPrint] = useState({ active: false, paused: false, done: 0, total: 0 })
  const [sdDetails, setSdDetails] = useState<SdPrintDetails>({ filename: null, elapsedSeconds: null })
  const lastSdDetailsRequest = useRef(0)
  const resetSeen = useRef(false)

  // Client-only feature detection. Starts false so SSR and first client render
  // match (avoids hydration mismatch); the effect below flips it on capable
  // browsers. Consumers use it to explain when USB is unavailable.
  const [webSerialSupported, setWebSerialSupported] = useState(false)
  useEffect(() => {
    setWebSerialSupported(isWebSerialSupported())
  }, [])

  // Refs mirror latest state for use inside callbacks without stale closures.
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const emergencyRef = useRef(emergencyStopActive)
  emergencyRef.current = emergencyStopActive
  const stepRef = useRef(selectedStep)
  stepRef.current = selectedStep
  const pauseStateRef = useRef(pauseState)
  pauseStateRef.current = pauseState
  const pendingMovementCountRef = useRef(pendingMovementCount)
  pendingMovementCountRef.current = pendingMovementCount
  const sdPrintRef = useRef(sdPrint)
  sdPrintRef.current = sdPrint
  const canOperate = connection === 'connected' && !emergencyStopActive && pauseState === 'running' && !sdPrint.active && !sdPrint.paused

  const appendEntry = useCallback(
    (direction: MessageDirection, content: string) => {
      setConsoleEntries((prev) => {
        const next = [
          ...prev,
          { id: uid(), timestamp: formatTimestamp(), direction, content },
        ]
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
      })
    },
    [],
  )

  // Subscribe to transport messages once. Only real messages mutate state.
  useEffect(() => {
    const unsubscribe = transport.subscribe((message) => {
      switch (message.kind) {
        case 'bridge':
          setLinkDetail(`${message.detail} · ${message.phones}${message.phoneLimit ? `/${message.phoneLimit}` : ''} dispositivos · ${message.clients} sesiones`)
          setCamera({ associated: message.cameraAssociated, url: message.cameraUrl })
          setPauseState(message.pausePhase)
          setSdPrint({ active: message.sdPrinting, paused: message.sdPaused, done: message.sdDone, total: message.sdTotal })
          // A completed job must not display the previous filename/elapsed time.
          if (!message.sdPrinting && !message.sdPaused) setSdDetails(current =>
            current.filename === null && current.elapsedSeconds === null ? current : { filename: null, elapsedSeconds: null })
          if (message.emergency) { emergencyRef.current = true; setEmergencyStopActive(true); setMachineState('emergency-stop') }
          else if (connectionRef.current === 'connected') {
            emergencyRef.current = false; setEmergencyStopActive(false)
            setMachineState(message.sdPrinting ? 'printing' : null)
          }
          break
        case 'console':
          if (message.entry.direction === 'RX') {
            const parsed = parseSdDetail(message.entry.content)
            if (parsed) setSdDetails(current => ({ ...current, ...parsed }))
          }
          if (message.entry.direction === 'RX' && message.entry.content.trim() === 'start') resetSeen.current = true
          setConsoleEntries((prev) => {
            const next = [...prev, message.entry]
            return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
          })
          break
        case 'position':
          setPosition(message.position)
          break
        case 'pauseReport':
          if (mode === 'usb') setPauseState(message.paused ? 'paused' : 'running')
          break
        case 'machineState':
          setMachineState(message.state)
          break
        case 'queue': {
          // Authoritative movement count from the transport's FIFO.
          setPendingMovementCount(message.pendingMovementCount)
          const ack = message.ack
          if (ack) {
            // A real movement `ok` reduces how much motion is still ahead of a
            // requested pause (floored at 0; irrelevant while running).
            if (ack.wasMovement) {
              setMovementsAheadOfPause((n) => (n > 0 ? n - 1 : 0))
            }
            // The `ok` for M400 means the planner has physically drained: only
            // now is the machine truly paused. We do NOT wait for M0's `ok`
            // (M0 blocks until resume).
            if (mode === 'usb' && ack.pauseMarker === 'M400') {
              setPauseState((s) =>
                s === 'pause-requested' || s === 'waiting-for-motion-finish'
                  ? 'paused'
                  : s,
              )
            }
          }
          break
        }
        case 'connection':
          connectionRef.current = message.state
          setConnection(message.state)
          if (message.state === 'connected') {
            if (mode === 'usb') {
              setMachineState(null)
              if (resetSeen.current) { emergencyRef.current = false; setEmergencyStopActive(false) }
            }
          } else {
            // Any non-connected state (connecting/disconnected/error, including
            // a detected board reset) means Marlin is not ready: clear stale
            // position and invalidate pause/queue tracking. Never fabricate a
            // persisted pause or a coordinate. Real values return via M114 once
            // the handshake completes.
            setMachineState(null)
            setPosition(EMPTY_POSITION)
            setPauseState('running')
            setMovementsAheadOfPause(0)
            setPendingMovementCount(0)
            if (mode === 'wifi') {
              setCamera(c => ({ ...c, associated: false }))
              setSdPrint({ active: false, paused: false, done: 0, total: 0 })
              setSdDetails({ filename: null, elapsedSeconds: null })
            }
          }
          break
      }
    })
    return unsubscribe
  }, [transport, mode])

  // Once every pre-pause movement has been acknowledged but M400 has not yet
  // returned its `ok`, we are physically finishing motion — not paused yet.
  useEffect(() => {
    if (mode === 'usb' && pauseState === 'pause-requested' && movementsAheadOfPause === 0) {
      setPauseState('waiting-for-motion-finish')
    }
  }, [pauseState, movementsAheadOfPause, mode])

  // On mount: seed a single real application event and attempt a SILENT
  // auto-reconnect. The transport calls navigator.serial.getPorts() (never
  // requestPort(), which needs a user gesture): if exactly one Mega was already
  // authorized it reopens automatically; otherwise it stays disconnected and
  // waits for the user to tap the existing disconnected banner.
  //
  // After each successful Marlin handshake we ask for the real current position
  // once (M114). We never invent a zero position — placeholders stay until the
  // real report arrives. Sent directly through the transport so it only depends
  // on the port being ready.
  const started = useRef(false)
  useEffect(() => {
    transport.setOnReady(() => {
      if (mode === 'usb') void transport.sendCommand('M114').catch(() => {
        // If the socket dropped between open and send, reconnect handles it.
      })
    })

    if (!started.current) {
      started.current = true
      appendEntry('SYS', 'Aplicación iniciada')
    }

    void transport.connect().catch(() => {
      // Initial failures are logged/emitted by the transport; it will retry.
    })

    return () => {
      // Unmount is a manual teardown: stop reconnecting and close the socket.
      transport.setOnReady(null)
      void transport.disconnect()
    }
  }, [transport, appendEntry, mode])

  const setStep = useCallback((step: Step) => setSelectedStep(step), [])

  // --- USB connect (user gesture) ------------------------------------------
  // Invoked from the existing disconnected banner/status. Opens the browser
  // serial chooser. Dismissing it leaves us disconnected silently; a real open
  // failure (e.g. the port is owned by another program) surfaces a toast.
  const connectUsb = useCallback(async () => {
    if (
      connectionRef.current === 'connected' ||
      connectionRef.current === 'connecting'
    ) {
      return
    }
    if (mode === 'usb' && !isWebSerialSupported()) {
      toast(
        'Este navegador no admite USB (Web Serial). Usá Chrome o Edge.',
        'danger',
      )
      return
    }
    try {
      await transport.requestAndConnect()
    } catch {
      toast('No se pudo conectar la impresora', 'danger')
    }
  }, [transport, toast, mode])

  const pushHistory = useCallback((cmd: string) => {
    setCommandHistory((prev) => {
      if (prev[prev.length - 1] === cmd) return prev
      return [...prev, cmd]
    })
  }, [])

  // --- Movement -------------------------------------------------------------
  const jog = useCallback(
    async (axis: Axis, direction: 1 | -1) => {
      if (connectionRef.current !== 'connected') {
        toast('No hay conexión con la impresora', 'danger')
        return
      }
      if (emergencyRef.current) {
        toast('Parada de emergencia activa', 'danger')
        return
      }
      if (pauseStateRef.current !== 'running' || sdPrintRef.current.active || sdPrintRef.current.paused) {
        toast('Control manual bloqueado durante pausa o impresión SD', 'danger')
        return
      }
      const delta = stepRef.current * direction
      const label = axis.toUpperCase()
      const key = `jog:${axis}:${direction}`
      setBusyAction(key)
      try {
        // Relative move, then restore absolute and request the REAL position.
        // The Marlin serial queue guarantees ordering, so M114 executes only
        // after the move reaches Marlin. Position updates from its response —
        // never locally from `delta`.
        if (transport.sendBatch) await transport.sendBatch(['G91', `G0 ${label}${delta}`, 'G90', 'M114'])
        else {
          await transport.sendCommand('G91')
          await transport.sendCommand(`G0 ${label}${delta}`)
          await transport.sendCommand('G90')
          await transport.sendCommand('M114')
        }
      } catch {
        appendEntry('ERR', 'No se pudo enviar el movimiento')
        toast('No se pudo enviar el comando', 'danger')
      } finally {
        setBusyAction(null)
      }
    },
    [transport, appendEntry, toast],
  )

  // --- Homing ---------------------------------------------------------------
  const home = useCallback(
    async (target: HomeTarget) => {
      if (connectionRef.current !== 'connected') {
        toast('No hay conexión con la impresora', 'danger')
        return
      }
      if (emergencyRef.current) {
        toast('Parada de emergencia activa', 'danger')
        return
      }
      if (pauseStateRef.current !== 'running' || sdPrintRef.current.active || sdPrintRef.current.paused) {
        toast('Control manual bloqueado durante pausa o impresión SD', 'danger')
        return
      }
      const cmd = target === 'all' ? 'G28' : `G28 ${target.toUpperCase()}`
      const key = `home:${target}`
      setBusyAction(key)
      try {
        // Home, then read the real homed position. Home coordinates are never
        // assumed locally — they come from the M114 response.
        if (transport.sendBatch) await transport.sendBatch([cmd, 'M114'])
        else { await transport.sendCommand(cmd); await transport.sendCommand('M114') }
      } catch {
        appendEntry('ERR', 'No se pudo enviar el homing')
        toast('No se pudo enviar el comando', 'danger')
      } finally {
        setBusyAction(null)
      }
    },
    [transport, appendEntry, toast],
  )

  // --- Emergency ------------------------------------------------------------
  // Immediate local lockout + transmit M112. This is a safety action, not
  // fabricated telemetry: it locks the UI right away and tries to send the
  // stop. It cannot be cleared locally — the printer must report recovery.
  const emergencyStop = useCallback(() => {
    emergencyRef.current = true
    resetSeen.current = false
    setEmergencyStopActive(true)
    setMachineState('emergency-stop')
    appendEntry('SYS', 'PARADA DE EMERGENCIA — enviando M112')
    void transport.sendCommand('M112').catch(() => {
      appendEntry('ERR', 'M112 no se pudo transmitir (sin conexión)')
    })
    toast('Parada de emergencia activada', 'danger')
  }, [transport, appendEntry, toast, mode])

  // --- Controlled pause / resume -------------------------------------------
  // Pronterface-like host pause: M400 (wait for planned motion to finish) then
  // M0 (pause and wait for continue). Resume uses M108 to break out of M0.
  // Everything goes through the SAME transport; there is no second queue and
  // no simulated timer — state advances only on real Marlin acknowledgements.
  const requestPause = useCallback(async () => {
    if (connectionRef.current !== 'connected') {
      toast('No hay conexión con la impresora', 'danger')
      return
    }
    if (emergencyRef.current) {
      toast('Parada de emergencia activa', 'danger')
      return
    }
    if (mode === 'wifi' && transport.sendMachineControl) {
      try { await transport.sendMachineControl('pause') }
      catch { toast('No se pudo solicitar la pausa; revisar Consola', 'danger') }
      return
    }
    // Ignore repeated presses: only a running machine can be paused. This
    // prevents duplicate M400/M0 sequences from double-clicks.
    if (pauseStateRef.current !== 'running') return

    // Snapshot how much motion is ahead of the pause BEFORE sending anything.
    setMovementsAheadOfPause(pendingMovementCountRef.current)
    setPauseState('pause-requested')
    appendEntry('SYS', 'Pausa solicitada (M400 → M0)')
    try {
      await transport.sendCommand('M400', { pauseMarker: 'M400' })
      await transport.sendCommand('M0', { pauseMarker: 'M0' })
    } catch {
      appendEntry('ERR', 'No se pudo enviar la secuencia de pausa')
      toast('No se pudo enviar la pausa', 'danger')
      setPauseState('running')
      setMovementsAheadOfPause(0)
    }
  }, [transport, appendEntry, toast, mode])

  const resumePrinter = useCallback(async () => {
    const resumeWhileIdentifying = mode === 'wifi' && connectionRef.current === 'waiting-marlin' && pauseStateRef.current === 'paused'
    if (connectionRef.current !== 'connected' && !resumeWhileIdentifying) {
      toast('No hay conexión con la impresora', 'danger')
      return
    }
    if (emergencyRef.current) return
    if (mode === 'wifi' && transport.sendMachineControl) {
      try { await transport.sendMachineControl('resume') }
      catch { toast('No se pudo solicitar la reanudación; revisar Consola', 'danger') }
      return
    }
    // Only a truly paused machine can resume; blocks duplicate M108.
    if (pauseStateRef.current !== 'paused') return

    setPauseState('resuming')
    appendEntry('SYS', 'Reanudando (M108)')
    try {
      // M108 breaks Marlin out of M0 (requires EMERGENCY_PARSER in firmware).
      await transport.sendCommand('M108')
      setPauseState('running')
      setMovementsAheadOfPause(0)
    } catch {
      appendEntry('ERR', 'No se pudo enviar la reanudación')
      toast('No se pudo reanudar', 'danger')
      setPauseState('paused')
    }
  }, [transport, appendEntry, toast, mode])

  // --- Console command ------------------------------------------------------
  const sendCommand = useCallback(
    async (raw: string) => {
      // Preserve EXACTLY what the user typed (only trimmed). Commands like
      // "M117 Hola" or filenames are case-sensitive/human-readable, so we must
      // transmit the original text. A separate uppercase copy is used ONLY for
      // recognition (M112, M114, position-changing families).
      const command = raw.trim()
      if (!command) return
      const upper = command.toUpperCase()
      pushHistory(command)

      if (upper === 'M112') {
        emergencyStop()
        return
      }
      if (connectionRef.current !== 'connected') {
        appendEntry('ERR', 'Sin conexión: comando no enviado')
        toast('No hay conexión con la impresora', 'danger')
        return
      }
      if (emergencyRef.current) {
        appendEntry('ERR', 'Parada de emergencia activa: comando bloqueado')
        toast('Parada de emergencia activa', 'danger')
        return
      }
      try {
        // Send the original-cased text.
        await transport.sendCommand(command)
        // If it likely moved/homed the machine, request the real position.
        // Skip when the user already sent M114 (avoid a duplicate query).
        if (upper !== 'M114' && commandMayChangePosition(upper)) {
          await transport.sendCommand('M114')
        }
      } catch {
        appendEntry('ERR', 'No se pudo enviar el comando')
      }
    },
    [transport, appendEntry, pushHistory, emergencyStop, toast, mode],
  )

  const refreshSdDetails = useCallback(async () => {
    if (mode !== 'wifi' || connectionRef.current !== 'connected' || emergencyRef.current ||
        (!sdPrintRef.current.active && !sdPrintRef.current.paused)) return
    // Avoid command bursts when users quickly switch tabs.
    const now = Date.now()
    if (now - lastSdDetailsRequest.current < 12000) return
    lastSdDetailsRequest.current = now
    try {
      // M27 C reports the current SD filename; M31 reports the actual elapsed timer.
      // No G-code files are transferred to the C3 from the application.
      await transport.sendCommand('M27 C')
      await transport.sendCommand('M31')
    } catch {
      // A lost connection is handled by the shared transport; never fabricate values.
    }
  }, [mode, transport])

  const clearConsole = useCallback(() => setConsoleEntries([]), [])

  const value = useMemo<PrinterStoreValue>(
    () => ({
      mode,
      linkDetail,
      camera,
      sdPrint,
      sdDetails,
      refreshSdDetails,
      connectPrinter: connectUsb,
      connection,
      machineState,
      position,
      selectedStep,
      emergencyStopActive,
      canOperate,
      busyAction,
      console: consoleEntries,
      commandHistory,
      pauseState,
      pendingMovementCount,
      movementsAheadOfPause,
      webSerialSupported,
      connectUsb,
      setStep,
      jog,
      home,
      emergencyStop,
      sendCommand,
      requestPause,
      resumePrinter,
      clearConsole,
    }),
    [
      linkDetail, sdPrint, sdDetails, refreshSdDetails, camera,
      mode,
      connection,
      machineState,
      position,
      selectedStep,
      emergencyStopActive,
      canOperate,
      busyAction,
      consoleEntries,
      commandHistory,
      pauseState,
      pendingMovementCount,
      movementsAheadOfPause,
      webSerialSupported,
      connectUsb,
      setStep,
      jog,
      home,
      emergencyStop,
      sendCommand,
      requestPause,
      resumePrinter,
      clearConsole,
    ],
  )

  return (
    <PrinterContext.Provider value={value}>{children}</PrinterContext.Provider>
  )
}

export function usePrinter(): PrinterStoreValue {
  const ctx = useContext(PrinterContext)
  if (!ctx) {
    throw new Error('usePrinter debe usarse dentro de <PrinterProvider>')
  }
  return ctx
}

export { formatMm }
