'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  OctagonAlert,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { uid } from '@/lib/printer-types'

type ToastVariant = 'default' | 'success' | 'warning' | 'danger'

interface Toast {
  id: string
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const VARIANT_STYLES: Record<ToastVariant, string> = {
  default: 'border-border bg-popover text-popover-foreground',
  success: 'border-success/40 bg-popover text-foreground',
  warning: 'border-warning/40 bg-popover text-foreground',
  danger: 'border-danger/50 bg-popover text-foreground',
}

const VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
}

const VARIANT_ICON_COLOR: Record<ToastVariant, string> = {
  default: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, variant: ToastVariant = 'default') => {
      const id = uid()
      setToasts((prev) => [...prev.slice(-3), { id, message, variant }])
      window.setTimeout(() => dismiss(id), 3200)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-3 pt-3 safe-top"
        role="region"
        aria-label="Notificaciones"
      >
        {toasts.map((t) => {
          const Icon = VARIANT_ICON[t.variant]
          return (
            <div
              key={t.id}
              role="status"
              className={cn(
                'pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-200',
                VARIANT_STYLES[t.variant],
              )}
            >
              <Icon
                className={cn('size-5 shrink-0', VARIANT_ICON_COLOR[t.variant])}
                aria-hidden="true"
              />
              <p className="flex-1 text-sm leading-snug text-pretty">{t.message}</p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label="Cerrar notificación"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast debe usarse dentro de <ToastProvider>')
  }
  return ctx
}
