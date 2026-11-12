'use client'

import { Home, Loader2, Target } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'
import type { Axis } from '@/lib/printer-types'
import { cn } from '@/lib/utils'

type HomeTarget = Axis | 'all'

export function HomingControls({ className }: { className?: string }) {
  const { home, canOperate, busyAction, machineState } = usePrinter()

  const homing = machineState === 'homing'
  const disabled = !canOperate || busyAction !== null || homing

  const run = (target: HomeTarget) => () => {
    void home(target)
  }
  const busy = (target: HomeTarget) => busyAction === `home:${target}`

  const axes: { key: Axis; label: string }[] = [
    { key: 'x', label: 'Home X' },
    { key: 'y', label: 'Home Y' },
    { key: 'z', label: 'Home Z' },
  ]

  return (
    <section className={cn('space-y-3', className)} aria-labelledby="home-title">
      <h2
        id="home-title"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Homing individual
      </h2>

      {/* Home X / Home Y on one row, Home Z spanning the row below. */}
      <div className="grid grid-cols-2 gap-2.5">
        {axes.slice(0, 2).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={run(key)}
            disabled={disabled}
            aria-label={`Referenciar ${label}`}
            className="flex h-14 items-center justify-center gap-2 rounded-xl border border-border bg-panel text-sm font-semibold transition-colors hover:bg-muted hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
          >
            {busy(key) ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Target className="size-4 text-primary" aria-hidden="true" />
            )}
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={run('z')}
          disabled={disabled}
          aria-label="Referenciar Home Z"
          className="col-span-2 flex h-14 items-center justify-center gap-2 rounded-xl border border-border bg-panel text-sm font-semibold transition-colors hover:bg-muted hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
        >
          {busy('z') ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Target className="size-4 text-primary" aria-hidden="true" />
          )}
          Home Z
        </button>
      </div>

      {/* Home general — visually dominant but NOT red (red is reserved for E-stop). */}
      <button
        type="button"
        onClick={run('all')}
        disabled={disabled}
        aria-label="Referenciar todos los ejes (Home general)"
        className="flex h-16 w-full items-center justify-center gap-2.5 rounded-2xl border-2 border-primary bg-primary text-base font-bold uppercase tracking-wide text-primary-foreground shadow-lg transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40"
      >
        {busy('all') ? (
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        ) : (
          <Home className="size-5" aria-hidden="true" />
        )}
        Home general
      </button>

      {homing && (
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-sm font-medium text-info"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Ejecutando home…
        </p>
      )}
    </section>
  )
}
