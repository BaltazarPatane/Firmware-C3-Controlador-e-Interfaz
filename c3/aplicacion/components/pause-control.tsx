'use client'

import { Loader2, Pause, Play } from 'lucide-react'
import { useRef, type MouseEvent } from 'react'
import { usePrinter } from '@/lib/printer-store'
import {
  PAUSE_STATE_LABELS,
} from '@/lib/printer-types'
import { cn } from '@/lib/utils'

// Status text colour per pause state, using existing semantic tokens only.
// Red stays reserved for the emergency stop / real errors — pause never uses it.
const STATUS_CLASS: Record<string, string> = {
  running: 'text-muted-foreground',
  'pause-requested': 'text-warning',
  'waiting-for-motion-finish': 'text-warning',
  paused: 'text-info',
  resuming: 'text-info',
}

/** Shared pause state comes from Marlin acknowledgements, never UI timers. */
export function PauseControl() {
  const pressIntent = useRef<{ action: 'pause' | 'resume'; kind: 'pointer' | 'key' } | null>(null)
  const {
    mode,
    connection,
    emergencyStopActive,
    pauseState,
    pendingMovementCount,
    movementsAheadOfPause,
    requestPause,
    resumePrinter,
  } = usePrinter()

  const connected = connection === 'connected'

  const isPaused = pauseState === 'paused'
  const transitioning = pauseState === 'pause-requested' || pauseState === 'waiting-for-motion-finish' || pauseState === 'resuming'
  const canResumeBeforeReady = mode === 'wifi' && connection === 'waiting-marlin' && isPaused
  const disabled =
    (!connected && !canResumeBeforeReady) || emergencyStopActive || transitioning

  // While a pause is pending/finishing, "Cola" reflects the motion still ahead
  // of the pause; otherwise it is the live pending movement count. Unknown when
  // disconnected → em dash (never fabricate a number).
  const showAhead =
    (pauseState === 'pause-requested' ||
      pauseState === 'waiting-for-motion-finish')
  const colaValue = !connected
    ? '—'
    : String(showAhead ? movementsAheadOfPause : pendingMovementCount)

  const statusText = canResumeBeforeReady ? 'Marlin en pausa' : !connected
    ? 'Sin conexión'
    : PAUSE_STATE_LABELS[pauseState]
  const statusClass = !connected ? 'text-muted-foreground' : STATUS_CLASS[pauseState]

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A peer can change Pausar into Reanudar between pointer-down and click.
    // Preserve the action the user actually pressed, not the replacement label.
    if (event.detail > 0 && pressIntent.current?.kind !== 'pointer') return
    const kind = event.detail > 0 ? 'pointer' : 'key'
    const action = pressIntent.current?.kind === kind ? pressIntent.current.action : (isPaused ? 'resume' : 'pause')
    pressIntent.current = null
    if (action === 'resume') void resumePrinter()
    else void requestPause()
  }

  return (
    <section
      aria-labelledby="pause-title"
      className="rounded-xl border border-border bg-panel p-3"
    >
      <h2 id="pause-title" className="sr-only">
        Control de pausa y cola de movimientos
      </h2>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClick}
          onPointerDown={() => { pressIntent.current = { action: isPaused ? 'resume' : 'pause', kind: 'pointer' } }}
          onPointerCancel={() => { pressIntent.current = null }}
          onBlur={() => { if (pressIntent.current?.kind === 'key') pressIntent.current = null }}
          onKeyDown={(event) => {
            if (!event.repeat && (event.key === ' ' || event.key === 'Enter'))
              pressIntent.current = { action: isPaused ? 'resume' : 'pause', kind: 'key' }
          }}
          disabled={disabled}
          aria-label={isPaused ? 'Reanudar' : 'Pausar'}
          className={cn(
            'flex h-14 flex-1 items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
            isPaused
              ? 'border-info/50 bg-info/10 text-info hover:bg-info/15'
              : 'border-border bg-muted text-foreground hover:bg-muted/70 hover:border-primary/40',
          )}
        >
          {transitioning ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : isPaused ? (
            <Play className="size-4" aria-hidden="true" />
          ) : (
            <Pause className="size-4" aria-hidden="true" />
          )}
          {isPaused ? 'Reanudar' : 'Pausar'}
        </button>

        <div className="flex min-w-[7rem] shrink-0 flex-col items-end gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Cola {mode === 'wifi' ? 'WiFi' : 'USB'}
            </span>
            <span className="text-2xl font-bold leading-none tabular-nums">
              {colaValue}
            </span>
          </div>
          <span
            role="status"
            className={cn(
              'text-[11px] font-medium text-pretty text-right leading-tight',
              statusClass,
            )}
          >
            {statusText}
          </span>
        </div>
      </div>
    </section>
  )
}
