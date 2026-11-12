'use client'

import { OctagonAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { HoldToConfirm } from '@/lib/hold-to-confirm'
import { usePrinter } from '@/lib/printer-store'
import { cn } from '@/lib/utils'

/**
 * Every placement uses the same continuous one-second confirmation. M112 is
 * sent once at completion. A short tap or an interrupted hold sends nothing.
 *
 * `compact` renders a shorter button for secondary placements (Homing).
 */
export function EmergencyStop({
  className,
  compact,
}: {
  className?: string
  compact?: boolean
}) {
  const { emergencyStop, emergencyStopActive } = usePrinter()
  const titleId = useId()
  const [progress, setProgress] = useState(0)
  const action = useRef(emergencyStop)
  action.current = emergencyStop
  const hold = useRef<HoldToConfirm | null>(null)
  if (!hold.current) hold.current = new HoldToConfirm(() => action.current(), setProgress)
  const pointer = useRef<number | null>(null)
  const cancel = () => { pointer.current = null; hold.current?.cancel() }
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel() }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hide)
      hold.current?.cancel()
    }
  }, [])
  useEffect(() => { if (emergencyStopActive) cancel() }, [emergencyStopActive])

  return (
    <section className={cn('space-y-2', className)} aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        Parada de emergencia
      </h2>

      <button
        type="button"
        aria-label="Parada de emergencia. Mantener presionado un segundo"
        onClick={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || emergencyStopActive) return
          event.preventDefault()
          pointer.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
          hold.current?.begin()
        }}
        onPointerMove={(event) => {
          if (pointer.current !== event.pointerId) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancel()
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onPointerLeave={cancel}
        onBlur={cancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { cancel(); return }
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          if (!event.repeat && !emergencyStopActive) hold.current?.begin()
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); cancel() }
        }}
        className={cn(
          'relative flex w-full touch-none select-none items-center justify-center gap-2.5 overflow-hidden rounded-2xl border border-danger/60 bg-danger/10 font-semibold uppercase tracking-wide text-danger transition-colors hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger active:bg-danger/20',
          compact ? 'h-12 text-sm' : 'h-16 text-base',
        )}
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-danger/30" style={{ width: `${progress * 100}%` }} />
        <OctagonAlert
          className={cn('relative shrink-0', compact ? 'size-5' : 'size-6')}
          aria-hidden="true"
        />
        <span className="relative flex flex-col items-center">
          <span>Parada de emergencia</span>
          <span className="text-[10px] font-medium normal-case tracking-normal">
            {emergencyStopActive ? 'Reiniciar el Mega para recuperar' : progress > 0 ? `Mantener… ${(1 - progress).toFixed(1)} s` : 'Mantener presionado 1 segundo'}
          </span>
        </span>
      </button>

      {emergencyStopActive && !compact && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border-2 border-danger bg-danger/10 p-3.5"
        >
          <OctagonAlert
            className="mt-0.5 size-5 shrink-0 text-danger"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-danger">
              Parada de emergencia activada
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
              Reiniciá físicamente el Mega. Los controles se recuperan cuando
              Marlin vuelve a responder; no hace falta recargar la página.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
