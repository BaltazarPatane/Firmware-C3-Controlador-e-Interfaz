const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('playwright-core')
const { PNG } = require('pngjs')
const { WebSocketServer } = require('ws')
const root = process.env.WEB_ROOT
const mime = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.woff2':'font/woff2','.json':'application/json','.txt':'text/plain','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'}
let jpg, stream = true, frameNo = 0, peer, origin
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin)
  if (url.pathname === '/api/camera') {
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({available:true,baseUrl:origin})); return
  }
  if (url.pathname === '/frames' || url.pathname === '/stream') {
    if (!stream) { res.writeHead(415); res.end(); return }
    res.writeHead(200, {'content-type':'application/octet-stream','cache-control':'no-store'})
    const emit = () => { res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '+jpg.length+'\r\n\r\n'); res.write(jpg); res.write('\r\n') }
    emit(); const timer = setInterval(emit, 150); res.on('close', () => clearInterval(timer)); return
  }
  if (url.pathname === '/capture') {
    res.writeHead(200, {'content-type':'image/jpeg','content-length':jpg.length,'etag':'"cam-'+(++frameNo)+'"','cache-control':'no-store'}); res.end(jpg); return
  }
  const relative = url.pathname.replace(/^\/+/, '') + (url.pathname.endsWith('/') ? 'index.html' : '')
  const plain = path.join(root, relative)
  const compressed = fs.existsSync(plain+'.gz')
  const file = compressed ? plain+'.gz' : plain
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, {'content-type': mime[path.extname(plain)] || 'application/octet-stream', ...(compressed?{'content-encoding':'gzip'}:{})})
  fs.createReadStream(file).pipe(res)
})
new WebSocketServer({server,path:'/ws'}).on('connection', conn => {
  peer=conn
  conn.on('message', raw => {
    const msg=JSON.parse(raw.toString())
    if(msg.type==='hello') conn.send(JSON.stringify({type:'status',protocol:3,ready:true,bootId:1,generation:1,clientId:1,machineControls:true,reason:'Marlin conectado'}))
    if(msg.type==='ping') conn.send('{"type":"pong"}')
  })
})
async function verifyImage(page, alt, fit) {
  const box = page.getByRole('region', {name:'Cámara en vivo'})
  await box.getByText(/EN VIVO/).waitFor()
  const img = box.getByAltText(alt)
  await img.waitFor()
  const geometry = await img.evaluate(img=>{
    const bounds=img.getBoundingClientRect(), frame=img.closest('section').getBoundingClientRect()
    return [getComputedStyle(img).objectFit,img.naturalWidth,img.naturalHeight,Math.abs(bounds.width-frame.width),Math.abs(bounds.height-frame.height)]
  })
  assert.deepEqual(geometry.slice(0,3),[fit,320,180]);assert.ok(geometry[3]<3&&geometry[4]<3, JSON.stringify(geometry))
  const png=PNG.sync.read(await box.screenshot())
  const pixel = y => Array.from(png.data.subarray((Math.floor(png.height*y)*png.width+Math.floor(png.width/2))*4,(Math.floor(png.height*y)*png.width+Math.floor(png.width/2))*4+3))
  const top=pixel(.3),bottom=pixel(.7)
  assert.ok(top[0]>2*top[1]&&bottom[1]>2*bottom[0], JSON.stringify({top,bottom}))
}
async function testBrowser(name, engine, options) {
  const browser=await engine.launch(options)
  try {
    peer=null;stream=true
    const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,serviceWorkers:'block'})
    page.setDefaultTimeout(15000)
    jpg=Buffer.from(await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180
      const ctx=canvas.getContext('2d');ctx.fillStyle='#e0192c';ctx.fillRect(0,0,160,180);ctx.fillStyle='#14b850';ctx.fillRect(160,0,160,180)
      return canvas.toDataURL('image/jpeg').split(',')[1]
    }),'base64')
    await page.goto(origin)
    const button = text => page.getByRole('button',{name:text,exact:true})
    await button('Consola').click();const log=page.getByRole('log');await log.getByText('ESP y Marlin conectados por WiFi',{exact:true}).waitFor()
    for(const [type,text,consoleNormal] of [['tx','M27',false],['rx','Not SD printing',false],['tx','M119',true],['rx','x_min: open',true],['rx','Warning: final de carrera',false]]) peer.send(JSON.stringify({type,text,consoleNormal}))
    await log.getByText('Warning: final de carrera',{exact:true}).waitFor()
    assert.equal(await button('Normal').getAttribute('aria-pressed'),'true')
    assert.equal(await log.getByText('Not SD printing',{exact:true}).count(),0)
    assert.equal(await log.getByText('x_min: open',{exact:true}).count(),1)
    await button('Diagnóstico').click()
    await log.getByText('Not SD printing',{exact:true}).waitFor()
    await button('Cámara').click();await verifyImage(page,'Video de la cámara','cover')
    const frame=page.getByRole('region',{name:'Cámara en vivo'})
    await frame.getByRole('button',{name:'Ver imagen completa sin recortes'}).click()
    await verifyImage(page,'Video de la cámara','contain')
    await page.setViewportSize({width:760,height:440});await verifyImage(page,'Video de la cámara','contain')
    await page.setViewportSize({width:390,height:844});await button('Consola').click()
    assert.equal(await button('Diagnóstico').getAttribute('aria-pressed'),'true')
    await button('Limpiar').click();assert.equal(await log.getByText('M119',{exact:true}).count(),0)
    await button('Normal').click();assert.equal(await log.getByText('M119',{exact:true}).count(),0)
    stream=false;await button('Cámara').click()
    await verifyImage(page,'Imagen actual de la cámara','cover')
    await frame.getByRole('button',{name:'Ver imagen completa sin recortes'}).click();await verifyImage(page,'Imagen actual de la cámara','contain')
    console.log(name+': console modes, history, clear, MJPEG, JPEG fallback, cover, contain, portrait rotation and viewport resize OK')
  } finally {await browser.close()}
}
async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port
  try {
    await testBrowser('Chrome',chromium,{headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox']})
    await testBrowser('WebKit',webkit,{headless:true})
  } finally {server.close();server.closeAllConnections()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
