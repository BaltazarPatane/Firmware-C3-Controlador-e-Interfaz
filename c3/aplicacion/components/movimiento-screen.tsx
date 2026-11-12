'use client'

import { PositionDisplay } from '@/components/position-display'
import { StepSelector } from '@/components/step-selector'
import { XyJogControl } from '@/components/xy-jog-control'
import { ZJogControl } from '@/components/z-jog-control'
import { EmergencyStop } from '@/components/emergency-stop'
import { DisconnectedNotice } from '@/components/disconnected-notice'

/**
 * Movimiento tab — exclusively manual axis movement. A fixed-height flex column
 * that fits the viewport without page scrolling: connection warning, current
 * position, step selector, the XY + Z jog pads (which flex to fill the free
 * space), and the emergency stop pinned at the bottom. Homing, pause, program
 * and console deliberately live on other tabs.
 */
export function MovimientoScreen() {
  return (
    <div className="flex h-full flex-col gap-3">
      <DisconnectedNotice />
      <PositionDisplay compact />
      <StepSelector />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_5.5rem] gap-3">
        <XyJogControl />
        <ZJogControl />
      </div>
      <EmergencyStop compact />
    </div>
  )
}
