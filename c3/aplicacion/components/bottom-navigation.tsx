'use client'

import { Crosshair, Move, Video, TerminalSquare, ChartNoAxesCombined } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TabId = 'movimiento' | 'control' | 'camara' | 'impresion' | 'consola'

const TABS: { id: TabId; label: string; icon: typeof Move }[] = [
  { id: 'movimiento', label: 'Movimiento', icon: Move },
  { id: 'control', label: 'Control', icon: Crosshair },
  { id: 'camara', label: 'Cámara', icon: Video },
  { id: 'impresion', label: 'Impresión', icon: ChartNoAxesCombined },
  { id: 'consola', label: 'Consola', icon: TerminalSquare },
]

export function BottomNavigation({
  active,
  onChange,
}: {
  active: TabId
  onChange: (tab: TabId) => void
}) {
  return (
    <nav
      aria-label="Navegación principal"
      className="shrink-0 border-t border-border bg-background/95 backdrop-blur-md safe-bottom"
    >
      <div className="mx-auto flex w-full max-w-3xl items-stretch">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = active === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] sm:text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'absolute top-0 h-0.5 w-8 rounded-full transition-colors',
                  isActive ? 'bg-primary' : 'bg-transparent',
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg transition-colors',
                  isActive && 'bg-primary/10',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="max-w-full truncate leading-none">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
