'use client'

import { Cpu } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'
import {
  ConnectionStatus,
  MachineStateBadge,
} from '@/components/status-indicators'

/**
 * Compact header shared by the Movimiento, Control and Impresión screens. Kept
 * vertically small on purpose — screen height is the scarce resource. It shows
 * the machine name, the WiFi connection status and the live machine-state
 * badge. Tapping a disconnected status uses the selected WiFi or USB mode.
 */
export function AppHeader() {
  const { connection, machineState, connectPrinter, mode } = usePrinter()

  return (
    <header className="shrink-0 border-b border-border bg-background/85 backdrop-blur-md safe-top">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-4 py-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-primary">
          <Cpu className="size-4.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight">
            Impresora Cartesiana
          </h1>
          <ConnectionStatus
            connection={connection}
            onConnect={() => { void connectPrinter() }}
            className="mt-0.5 text-muted-foreground [&>span:last-child]:text-xs"
          />
          <span className="text-[10px] text-muted-foreground">{mode === 'wifi' ? 'WiFi' : 'USB'}</span>
        </div>
        <MachineStateBadge machineState={machineState} />
      </div>
    </header>
  )
}
