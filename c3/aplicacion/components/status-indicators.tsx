'use client'

import { cn } from '@/lib/utils'
import {
  CONNECTION_LABELS,
  MACHINE_STATE_LABELS,
  type MachineState,
  type PrinterConnectionState,
} from '@/lib/printer-types'

const CONNECTION_DOT: Record<PrinterConnectionState, string> = {
  connected: 'bg-success shadow-[0_0_0_3px] shadow-success/20',
  connecting: 'bg-warning shadow-[0_0_0_3px] shadow-warning/20 animate-pulse',
  'waiting-marlin': 'bg-warning shadow-[0_0_0_3px] shadow-warning/20 animate-pulse',
  disconnected: 'bg-danger shadow-[0_0_0_3px] shadow-danger/20',
  error: 'bg-danger shadow-[0_0_0_3px] shadow-danger/20 animate-pulse',
}

export function ConnectionStatus({
  connection,
  className,
  onConnect,
}: {
  connection: PrinterConnectionState
  className?: string
  /**
   * Optional connect handler. When provided and the machine is not connected,
   * the status becomes a tap target using the provider-selected transport.
   */
  onConnect?: () => void
}) {
  const dot = (
    <span
      className={cn('size-2.5 shrink-0 rounded-full', CONNECTION_DOT[connection])}
      aria-hidden="true"
    />
  )
  const label = (
    <span className="text-sm font-medium">{CONNECTION_LABELS[connection]}</span>
  )

  // Interactive only when a handler is given and we are not already connected.
  if (onConnect && connection !== 'connected') {
    return (
      <button
        type="button"
        onClick={onConnect}
        disabled={connection === 'connecting' || connection === 'waiting-marlin'}
        aria-label="Conectar la máquina"
        className={cn(
          'flex items-center gap-2 rounded-md text-left transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70',
          className,
        )}
      >
        {dot}
        {label}
      </button>
    )
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {dot}
      {label}
    </div>
  )
}

const MACHINE_STATE_STYLE: Record<MachineState, string> = {
  idle: 'border-border bg-muted text-muted-foreground',
  moving: 'border-info/40 bg-info/10 text-info',
  homing: 'border-info/40 bg-info/10 text-info',
  printing: 'border-info/40 bg-info/10 text-info',
  error: 'border-danger/50 bg-danger/10 text-danger',
  'emergency-stop': 'border-danger/60 bg-danger/15 text-danger',
}

export function MachineStateBadge({
  machineState,
  className,
}: {
  machineState: MachineState | null
  className?: string
}) {
  // No real machine state yet → neutral em dash placeholder.
  if (machineState === null) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground',
          className,
        )}
      >
        —
      </span>
    )
  }

  const isActive =
    machineState === 'moving' ||
    machineState === 'homing' ||
    machineState === 'printing'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
        MACHINE_STATE_STYLE[machineState],
        className,
      )}
    >
      {isActive && (
        <span className="size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
      )}
      {MACHINE_STATE_LABELS[machineState]}
    </span>
  )
}
