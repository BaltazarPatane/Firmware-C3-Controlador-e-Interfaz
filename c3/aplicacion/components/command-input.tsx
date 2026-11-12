'use client'

import { useEffect, useRef, useState } from 'react'
import { History, SendHorizontal, X } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'
import { cn } from '@/lib/utils'

// Tapping a quick command places it into the input (it is NOT sent
// automatically) so the user can review it before transmitting.
const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: 'M114', command: 'M114' },
  { label: 'G28', command: 'G28' },
  { label: 'G29', command: 'G29' },
  { label: 'G30', command: 'G30' },
  { label: 'Home X', command: 'G28 X' },
  { label: 'Home Y', command: 'G28 Y' },
  { label: 'Home Z', command: 'G28 Z' },
  { label: 'M115', command: 'M115' },
]

export function CommandInput() {
  const { sendCommand, commandHistory, connection } = usePrinter()
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  const disabled = connection !== 'connected'

  // Close the history popover on outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [historyOpen])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    void sendCommand(trimmed)
    setValue('')
    setHistoryIndex(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Respect IME composition (CJK keyboards / Safari 229).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return

    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (commandHistory.length === 0) return

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next =
        historyIndex === null
          ? commandHistory.length - 1
          : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setValue(commandHistory[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === null) return
      const next = historyIndex + 1
      if (next >= commandHistory.length) {
        setHistoryIndex(null)
        setValue('')
      } else {
        setHistoryIndex(next)
        setValue(commandHistory[next])
      }
    }
  }

  const pickQuick = (command: string) => {
    setValue(command)
    setHistoryIndex(null)
    inputRef.current?.focus()
  }

  const pickHistory = (command: string) => {
    setValue(command)
    setHistoryOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur-md">
      {/* Quick commands */}
      <div className="flex gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {QUICK_COMMANDS.map((qc) => (
          <button
            key={qc.label}
            type="button"
            onClick={() => pickQuick(qc.command)}
            className="shrink-0 rounded-full border border-border bg-panel px-3 py-1 font-mono text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px"
          >
            {qc.label}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        <div className="relative" ref={historyRef}>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            disabled={commandHistory.length === 0}
            aria-label="Historial de comandos"
            aria-expanded={historyOpen}
            className="flex size-11 items-center justify-center rounded-xl border border-border bg-panel text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
          >
            <History className="size-5" aria-hidden="true" />
          </button>
          {historyOpen && commandHistory.length > 0 && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-52 overflow-hidden rounded-xl border border-border bg-popover shadow-xl animate-in fade-in slide-in-from-bottom-1 duration-150">
              <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Historial
              </p>
              <ul className="max-h-56 overflow-y-auto py-1">
                {[...commandHistory]
                  .slice()
                  .reverse()
                  .map((cmd, i) => (
                    <li key={`${cmd}-${i}`}>
                      <button
                        type="button"
                        onClick={() => pickHistory(cmd)}
                        className="w-full px-3 py-2 text-left font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      >
                        {cmd}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Escribí un comando G-code…"
            aria-label="Comando G-code"
            className="h-11 w-full rounded-xl border border-border bg-panel pl-3.5 pr-9 font-mono text-sm text-foreground placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          {value && (
            <button
              type="button"
              onClick={() => {
                setValue('')
                setHistoryIndex(null)
                inputRef.current?.focus()
              }}
              aria-label="Borrar comando"
              className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          aria-label="Enviar comando"
          className={cn(
            'flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px',
            'bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          <SendHorizontal className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Enviar</span>
        </button>
      </div>
    </div>
  )
}
