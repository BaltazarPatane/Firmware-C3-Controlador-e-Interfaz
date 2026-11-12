'use client'

import { usePrinter } from '@/lib/printer-store'
import { STEPS } from '@/lib/printer-types'
import { cn } from '@/lib/utils'

export function StepSelector({ className }: { className?: string }) {
  const { selectedStep, setStep } = usePrinter()

  return (
    <section className={cn('space-y-1.5', className)} aria-labelledby="step-title">
      <div className="flex items-baseline justify-between">
        <h2
          id="step-title"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Paso
        </h2>
        <span className="text-xs font-medium text-muted-foreground">mm</span>
      </div>
      <div
        role="radiogroup"
        aria-label="Paso de movimiento en milímetros"
        className="grid grid-cols-4 gap-1.5 rounded-xl border border-border bg-panel p-1.5"
      >
        {STEPS.map((step) => {
          const active = selectedStep === step
          return (
            <button
              key={step}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setStep(step)}
              className={cn(
                'flex h-11 items-center justify-center rounded-lg border font-mono text-sm font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {step}
            </button>
          )
        })}
      </div>
    </section>
  )
}
