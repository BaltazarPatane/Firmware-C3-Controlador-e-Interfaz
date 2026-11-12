'use client'

import { usePrinter } from '@/lib/printer-store'
import { formatMm, type Axis, type Position } from '@/lib/printer-types'
import { cn } from '@/lib/utils'

function AxisCard({
  axis,
  value,
  compact,
}: {
  axis: Axis
  value: number | null
  compact?: boolean
}) {
  const placeholder = value === null
  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-border bg-panel',
        compact ? 'px-3 py-2' : 'p-3',
      )}
    >
      <span className="text-xs font-semibold uppercase text-primary">{axis}</span>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            'font-mono font-semibold tabular-nums leading-none tracking-tight',
            compact ? 'text-lg' : 'text-2xl sm:text-3xl',
            placeholder && 'text-muted-foreground',
          )}
          aria-label={`Posición eje ${axis.toUpperCase()}`}
        >
          {formatMm(value)}
        </span>
        <span className="text-xs font-medium text-muted-foreground">mm</span>
      </div>
    </div>
  )
}

export function PositionDisplay({
  className,
  compact,
  position: positionProp,
}: {
  className?: string
  compact?: boolean
  position?: Position
}) {
  const store = usePrinter()
  const position = positionProp ?? store.position
  return (
    <section className={cn('space-y-2', className)} aria-labelledby="pos-title">
      <h2
        id="pos-title"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Posición actual
      </h2>
      <div className="grid grid-cols-3 gap-2.5">
        <AxisCard axis="x" value={position.x} compact={compact} />
        <AxisCard axis="y" value={position.y} compact={compact} />
        <AxisCard axis="z" value={position.z} compact={compact} />
      </div>
    </section>
  )
}
