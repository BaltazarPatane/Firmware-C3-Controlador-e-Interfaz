'use client'

import { useState } from 'react'
import { ArrowDownToLine, Pause, Trash2 } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'
import { ConsoleView } from '@/components/console-view'
import { CommandInput } from '@/components/command-input'
import { ConnectionStatus } from '@/components/status-indicators'
import { DisconnectedNotice } from '@/components/disconnected-notice'
import { EmergencyStop } from '@/components/emergency-stop'
import { cn } from '@/lib/utils'

export function ConsolaScreen() {
  const { console: entries, clearConsole, connection, connectPrinter, mode, linkDetail } = usePrinter()
  const [autoScroll, setAutoScroll] = useState(true)

  return (
    <div className="flex h-full flex-col gap-3">
      <DisconnectedNotice />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-panel">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <h2 className="mr-auto text-sm font-semibold">Consola</h2>
        <ConnectionStatus connection={connection} onConnect={() => { void connectPrinter() }} className="text-muted-foreground" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAutoScroll((v) => !v)}
            aria-pressed={!autoScroll}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              autoScroll
                ? 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
                : 'border-warning/40 bg-warning/10 text-warning',
            )}
          >
            {autoScroll ? (
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            ) : (
              <Pause className="size-3.5" aria-hidden="true" />
            )}
            {autoScroll ? 'Auto' : 'Pausado'}
          </button>
          <button
            type="button"
            onClick={clearConsole}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Limpiar
          </button>
        </div>
      </div>

      {mode === 'wifi' && linkDetail && <p className="border-b border-border px-3 py-1 text-[10px] text-muted-foreground">C3 v2.1 · {linkDetail}</p>}
      {/* Output */}
      <div className="min-h-0 flex-1">
        <ConsoleView
          entries={entries}
          autoScroll={autoScroll}
          onUserScroll={(atBottom) => {
            // Pause when the user scrolls up; resume when back at the bottom.
            if (!atBottom && autoScroll) setAutoScroll(false)
            if (atBottom && !autoScroll) setAutoScroll(true)
          }}
        />
      </div>

        {/* Sticky command entry */}
        <CommandInput />
      </div>

      {/* Shared emergency stop — same centralized M112 action as every tab. */}
      <EmergencyStop compact />
    </div>
  )
}
