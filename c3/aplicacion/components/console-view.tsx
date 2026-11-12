'use client'

import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import type { ConsoleEntry } from '@/lib/printer-types'
import { ConsoleEntryRow } from '@/components/console-entry'

export function ConsoleView({
  entries,
  autoScroll,
  onUserScroll,
}: {
  entries: ConsoleEntry[]
  autoScroll: boolean
  onUserScroll?: (atBottom: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the newest entry when enabled.
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, autoScroll])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || !onUserScroll) return
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24
    onUserScroll(atBottom)
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto overflow-x-hidden py-2"
      role="log"
      aria-live="polite"
      aria-label="Salida de la consola"
    >
      {entries.length === 0 ? (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <Terminal className="size-8 opacity-50" aria-hidden="true" />
          <p className="text-sm">La consola está vacía.</p>
          <p className="text-xs opacity-70 text-pretty">
            Enviá un comando G-code para ver la comunicación con la impresora.
          </p>
        </div>
      ) : (
        entries.map((entry) => <ConsoleEntryRow key={entry.id} entry={entry} />)
      )}
    </div>
  )
}
