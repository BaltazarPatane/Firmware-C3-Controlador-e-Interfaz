'use client'
import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { usePrinter } from '@/lib/printer-store'

export function DisconnectedNotice() {
  const { connection, emergencyStopActive, connectPrinter, mode } = usePrinter()
  const [address, setAddress] = useState('192.168.0.254')
  const [published, setPublished] = useState(false)
  useEffect(() => { setPublished(window.location.protocol === 'https:' && mode === 'wifi') }, [mode])
  if (connection === 'connected' || emergencyStopActive) return null
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <button type="button" className="flex items-center gap-2 text-left" onClick={() => { void connectPrinter() }} disabled={connection === 'connecting' || connection === 'waiting-marlin'}>
        <WifiOff className="size-4 shrink-0" aria-hidden="true" />
        <span>{connection === 'waiting-marlin' ? 'WiFi conectado. Esperando que Marlin confirme la comunicación; ver Consola.' : connection === 'connecting' ? 'Conectando…' : `Sin conexión ${mode === 'wifi' ? 'WiFi' : 'USB'} con la máquina. Tocar para conectar.`}</span>
      </button>
      {published && (
        <div className="flex flex-col gap-2">
          <p>Conectate a la red de la impresora y abrí su dirección local para controlarla.</p>
          <div className="flex items-center gap-2">
            <input aria-label="Dirección local de la ESP" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" value={address} onChange={(event) => setAddress(event.target.value)} />
            <a className="rounded border border-warning/40 px-2 py-1" href={`http://${/^[a-z0-9.-]+(?::\d+)?$/i.test(address) ? address : '192.168.0.254'}/`}>Abrir impresora</a>
          </div>
        </div>
      )}
    </div>
  )
}
