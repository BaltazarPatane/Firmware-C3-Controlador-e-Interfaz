'use client'

import { CameraView } from '@/components/camera-view'
import { EmergencyStop } from '@/components/emergency-stop'

/** Direct Debian camera receiver with independent printer controls. */
export function CameraScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* La ausencia de Mega/Marlin no debe bloquear la cámara. */}
      <CameraView />
      <div className="mt-auto">
        <EmergencyStop compact />
      </div>
    </div>
  )
}
