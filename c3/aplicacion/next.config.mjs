/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a fully static site to `out/` so it can be hosted anywhere and run as
  // an installable offline PWA. No Node.js server, API routes, or server
  // rendering at runtime — printer communication uses WiFi WebSocket or USB Web Serial from the page.
  output: 'export',
  // Trailing slashes make each route a directory with an index.html, which is
  // friendlier for simple static file hosts.
  trailingSlash: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    // Required for static export: no on-demand image optimization server.
    unoptimized: true,
  },
}

export default nextConfig
