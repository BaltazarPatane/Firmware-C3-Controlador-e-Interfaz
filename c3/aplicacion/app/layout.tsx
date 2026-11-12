import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

const geistSans = localFont({
  src: '../public/fonts/geist-sans.woff2',
  weight: '100 900',
  variable: '--font-geist-sans',
})

const geistMono = localFont({
  src: '../public/fonts/geist-mono.woff2',
  weight: '100 900',
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'Impresora Cartesiana · Control',
  description:
    'Panel de control industrial para impresora cartesiana por WiFi (Marlin). Control de ejes, homing, pausa y reanudación, cámara, parada de emergencia y consola.',
  generator: 'ESP32-C3 Marlin WiFi 4.0.0 Router',
  applicationName: 'Impresora Cartesiana',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Impresora',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#111318',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="es"
      className={`dark bg-background ${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="antialiased font-sans">
        {children}
        
      </body>
    </html>
  )
}
