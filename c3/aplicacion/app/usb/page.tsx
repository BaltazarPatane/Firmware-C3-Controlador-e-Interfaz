import { PrinterApp } from '@/components/printer-app'

// La interfaz de control por USB (Web Serial) se sirve en /usb. La interfaz
// WiFi es independiente y vive en su propia ruta; no se modifica aquí.
export default function UsbPage() {
  return <PrinterApp mode="usb" />
}
