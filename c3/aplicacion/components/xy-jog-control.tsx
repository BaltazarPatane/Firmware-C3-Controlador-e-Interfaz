'use client'

import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Crosshair } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'
import type { Axis } from '@/lib/printer-types'
import { cn } from '@/lib/utils'

function JogButton({
  onClick,
  disabled,
  busy,
  label,
  ariaLabel,
  icon,
  iconPosition = 'top',
}: {
  onClick: () => void
  disabled: boolean
  busy: boolean
  label: string
  ariaLabel: string
  icon: React.ReactNode
  iconPosition?: 'top' | 'bottom' | 'left' | 'right'
}) {
  const isVertical = iconPosition === 'top' || iconPosition === 'bottom'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-border bg-muted/50 font-semibold text-foreground transition-colors',
        'hover:bg-muted hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'active:translate-y-px active:bg-primary/15 active:border-primary/60',
        'disabled:pointer-events-none disabled:opacity-40',
        busy && 'border-primary/60 bg-primary/15',
        isVertical ? 'flex-col' : 'flex-row',
      )}
    >
      {(iconPosition === 'top' || iconPosition === 'left') && icon}
      <span className="font-mono text-sm">{label}</span>
      {(iconPosition === 'bottom' || iconPosition === 'right') && icon}
    </button>
  )
}

export function XyJogControl({ className }: { className?: string }) {
  const { jog, canOperate, busyAction } = usePrinter()
  const disabled = !canOperate

  const move = (axis: Axis, dir: 1 | -1) => () => {
    void jog(axis, dir)
  }
  const isBusy = (axis: Axis, dir: 1 | -1) => busyAction === `jog:${axis}:${dir}`

  return (
    <section className={cn('flex h-full flex-col gap-2', className)} aria-labelledby="xy-title">
      <h2
        id="xy-title"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Movimiento XY
      </h2>
      <div className="grid flex-1 grid-cols-3 grid-rows-3 gap-2 rounded-2xl border border-border bg-panel p-2.5">
        <div aria-hidden="true" />
        <JogButton
          onClick={move('y', 1)}
          disabled={disabled}
          busy={isBusy('y', 1)}
          label="Y+"
          ariaLabel="Mover eje Y en sentido positivo"
          icon={<ArrowUp className="size-5" aria-hidden="true" />}
          iconPosition="top"
        />
        <div aria-hidden="true" />

        <JogButton
          onClick={move('x', -1)}
          disabled={disabled}
          busy={isBusy('x', -1)}
          label="X−"
          ariaLabel="Mover eje X en sentido negativo"
          icon={<ArrowLeft className="size-5" aria-hidden="true" />}
          iconPosition="left"
        />
        <div className="flex min-h-[44px] items-center justify-center rounded-xl border border-dashed border-border/70 text-muted-foreground">
          <Crosshair className="size-6" aria-hidden="true" />
          <span className="sr-only">Centro del plano XY</span>
        </div>
        <JogButton
          onClick={move('x', 1)}
          disabled={disabled}
          busy={isBusy('x', 1)}
          label="X+"
          ariaLabel="Mover eje X en sentido positivo"
          icon={<ArrowRight className="size-5" aria-hidden="true" />}
          iconPosition="right"
        />

        <div aria-hidden="true" />
        <JogButton
          onClick={move('y', -1)}
          disabled={disabled}
          busy={isBusy('y', -1)}
          label="Y−"
          ariaLabel="Mover eje Y en sentido negativo"
          icon={<ArrowDown className="size-5" aria-hidden="true" />}
          iconPosition="bottom"
        />
        <div aria-hidden="true" />
      </div>
    </section>
  )
}
