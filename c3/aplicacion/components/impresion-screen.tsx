'use client'

import { useEffect } from 'react'
import { Clock3, FileText, Info, RotateCw } from 'lucide-react'
import { EmergencyStop } from '@/components/emergency-stop'
import { usePrinter } from '@/lib/printer-store'
import { formatSdElapsed, sdFraction } from '@/lib/sd-print-report'

/** SD progress is actual M27 byte count, elapsed is actual M31 when received.
 * Time remaining is intentionally NOT estimated: this Marlin has M73 disabled.
 */
export function ImpresionScreen() {
  const { mode, connection, sdPrint, sdDetails, refreshSdDetails } = usePrinter()
  const connected = connection === 'connected'
  const isSd = mode === 'wifi' && connected && (sdPrint.active || sdPrint.paused)
  const percent = isSd ? sdFraction(sdPrint.done, sdPrint.total) : null
  useEffect(() => {
    if (!isSd) return
    void refreshSdDetails()
    const timer = window.setInterval(() => { void refreshSdDetails() }, 30000)
    return () => window.clearInterval(timer)
  }, [isSd, refreshSdDetails])

  const state = !connected ? 'Sin conexión' : sdPrint.paused ? 'Impresión SD pausada' : isSd ? 'Imprimiendo desde SD' : 'No hay impresión SD activa'
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Impresión</h2>
            <p className="text-xs text-muted-foreground">{state}</p>
          </div>
          <button type="button" disabled={!isSd} onClick={() => { void refreshSdDetails() }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs disabled:opacity-40"
            aria-label="Actualizar información de la impresión SD">
            <RotateCw className="size-4" /> Actualizar
          </button>
        </div>

        <div className="rounded-xl border border-border bg-background/60 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">Avance del archivo SD</span>
            <span className="text-3xl font-semibold tabular-nums">{percent === null ? '—' : `${percent.toFixed(1)} %`}</span>
          </div>
          <div role="progressbar" aria-label="Avance de la impresión SD"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
            className="mt-3 h-3 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent ?? 0}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-background/60 p-3">
            <Clock3 className="mb-2 size-4 text-primary" aria-hidden="true" />
            <div className="text-xs text-muted-foreground">Tiempo transcurrido</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{isSd ? formatSdElapsed(sdDetails.elapsedSeconds) : '—'}</div>
          </div>
          <div className="rounded-xl border border-border bg-background/60 p-3">
            <Clock3 className="mb-2 size-4 text-muted-foreground" aria-hidden="true" />
            <div className="text-xs text-muted-foreground">Tiempo restante</div>
            <div className="mt-1 text-sm font-medium">No disponible</div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-background/60 p-3">
          <div className="flex items-center gap-2 text-sm font-medium"><FileText className="size-4 text-primary" /> Archivo actual</div>
          <p className="mt-2 break-all text-sm">{isSd ? sdDetails.filename || '—' : '—'}</p>
        </div>
        <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>El tiempo restante y el porcentaje son estimativos y solo están disponibles para impresiones desde la SD</span>
        </p>
      </section>
      <div className="shrink-0"><EmergencyStop compact /></div>
    </div>
  )
}
