'use client'

import { PositionDisplay } from '@/components/position-display'
import { PauseControl } from '@/components/pause-control'
import { HomingControls } from '@/components/homing-controls'
import { EmergencyStop } from '@/components/emergency-stop'
import { DisconnectedNotice } from '@/components/disconnected-notice'
import { usePrinter } from '@/lib/printer-store'

/**
 * Control tab — machine preparation / referencing (homing). Fits the viewport
 * without page scrolling: connection warning, current position, the shared
 * Pause/Resume + movement-queue control, the individual (X/Y/Z) and general
 * homing controls, and the emergency stop pinned at the bottom.
 *
 * The Pause/Resume + movement-queue control is the SAME <PauseControl>
 * component rendered on the Impresión tab — it reads and drives the single
 * authoritative pause/queue state from the store, so actions taken here affect
 * exactly the same underlying state (no duplicated logic or second source of
 * truth). The content scrolls independently of the pinned emergency button.
 */
export function ControlScreen() {
  const { sdPrint } = usePrinter()
  return (
    <div className="flex h-full flex-col gap-3">
      <DisconnectedNotice />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        <PositionDisplay compact />
        <PauseControl />
        {(sdPrint.active || sdPrint.paused) && (
          <p className="rounded-xl border border-border p-3 text-xs">
            Impresión SD · {sdPrint.done} / {sdPrint.total} bytes informados por Marlin
          </p>
        )}
        <HomingControls />
      </div>
      <div className="shrink-0">
        <EmergencyStop compact />
      </div>
    </div>
  )
}
