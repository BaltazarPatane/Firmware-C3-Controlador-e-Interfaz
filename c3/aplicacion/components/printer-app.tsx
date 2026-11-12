'use client'

import { useState } from 'react'
import { ToastProvider } from '@/components/toaster'
import { PrinterProvider } from '@/lib/printer-store'
import { AppHeader } from '@/components/app-header'
import { MovimientoScreen } from '@/components/movimiento-screen'
import { ControlScreen } from '@/components/control-screen'
import { CameraScreen } from '@/components/camera-screen'
import { ImpresionScreen } from '@/components/impresion-screen'
import { ConsolaScreen } from '@/components/consola-screen'
import { BottomNavigation, type TabId } from '@/components/bottom-navigation'
import { ServiceWorkerRegister } from '@/components/service-worker-register'

/**
 * Single-page shell: a fixed-height (100dvh) column of
 *   header → active screen → bottom navigation.
 * The whole app never scrolls; only the console history scrolls internally.
 * Tab switching is UI-only — the PrinterProvider (transport, position, queue,
 * pause) lives above this and is never remounted when switching tabs.
 */
function AppShell() {
  const [tab, setTab] = useState<TabId>('movimiento')

  // The compact machine header is shared by the three control screens. Consola
  // provides its own top status bar, so it hides the shared header.
  const showHeader = tab !== 'consola'

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      {showHeader && <AppHeader />}

      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-3">
          {tab === 'movimiento' && <MovimientoScreen />}
          {tab === 'control' && <ControlScreen />}
          {tab === 'camara' && <CameraScreen />}
          {tab === 'impresion' && <ImpresionScreen />}
          {tab === 'consola' && <ConsolaScreen />}
        </div>
      </main>

      <BottomNavigation active={tab} onChange={setTab} />
    </div>
  )
}

export function PrinterApp({ mode = 'wifi' }: { mode?: 'wifi' | 'usb' }) {
  return (
    <ToastProvider>
      <PrinterProvider mode={mode}>
        <AppShell />
        <ServiceWorkerRegister />
      </PrinterProvider>
    </ToastProvider>
  )
}
