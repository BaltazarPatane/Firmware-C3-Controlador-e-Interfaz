'use client'

import { memo } from 'react'
import type { ConsoleEntry, MessageDirection } from '@/lib/printer-types'
import { cn } from '@/lib/utils'

const DIRECTION_STYLE: Record<MessageDirection, string> = {
  TX: 'text-info',
  RX: 'text-success',
  SYS: 'text-muted-foreground',
  ERR: 'text-danger',
}

const DIRECTION_BADGE: Record<MessageDirection, string> = {
  TX: 'bg-info/15 text-info',
  RX: 'bg-success/15 text-success',
  SYS: 'bg-muted text-muted-foreground',
  ERR: 'bg-danger/15 text-danger',
}

export const ConsoleEntryRow = memo(function ConsoleEntryRow({
  entry,
}: {
  entry: ConsoleEntry
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-1 font-mono text-xs leading-relaxed">
      <span className="shrink-0 select-none tabular-nums text-muted-foreground/70">
        {entry.timestamp}
      </span>
      <span
        className={cn(
          'w-9 shrink-0 select-none rounded px-1 py-0.5 text-center text-[10px] font-semibold',
          DIRECTION_BADGE[entry.direction],
        )}
      >
        {entry.direction}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 break-words whitespace-pre-wrap',
          DIRECTION_STYLE[entry.direction],
        )}
      >
        {entry.content}
      </span>
    </div>
  )
})
