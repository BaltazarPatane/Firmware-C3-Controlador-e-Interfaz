/** QA opcional. No se instala ni hace falta en la PC Debian de la caja. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const engine = process.env.BROWSER_ENGINE || 'chromium'
const { [engine]: playwright } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = spawn('python3', ['-u', 'tests/browser_fixture.py'], {cwd:root, stdio:['ignore','pipe','inherit']})
let browser
try {
  const lines=readline.createInterface({input:fixture.stdout})
  const [line]=await once(lines,'line'); lines.close()
  const {url}=JSON.parse(line)
  const options={headless:true}
  if(process.env.SPARTICUZ_MODULE && engine === 'chromium'){
    const module=require(process.env.SPARTICUZ_MODULE)
    const chromium=module.default||module
    options.executablePath=await chromium.executablePath()
    options.args=chromium.args.filter(a=>a!=='--single-process'&&a!=='--disable-web-security')
  }
  browser=await playwright.launch(options)
  const contexts=[]
  async function phone(){
    // The real C3 uses plain HTTP on a LAN address, where service workers are
    // unavailable. Disable localhost's secure-context exception in this fixture.
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1,serviceWorkers:'block'})
    contexts.push(context)
    const page=await context.newPage()
    if(process.env.QA_DEBUG){
      page.on('console',message=>console.log('BROWSER',message.type(),message.text()))
      page.on('requestfailed',request=>console.log('REQUEST FAILED',request.url(),request.failure()))
      page.on('response',response=>{if(/\/(frames|stream|capture)/.test(response.url()))console.log('RESPONSE',response.status(),response.url())})
    }
    await page.goto(url)
    await page.getByRole('button',{name:'Cámara',exact:true}).click()
    await page.getByText(/EN VIVO/).waitFor({timeout:20000})
    await page.waitForFunction(()=>{const i=document.querySelector('img[alt="Video de la cámara"]');return i?.naturalWidth===320&&i?.naturalHeight===240})
    return page
  }
  const page=await phone()
  const camera=page.getByRole('region',{name:'Cámara en vivo'})
  async function liveImage(alt){
    await page.getByText(/EN VIVO/).waitFor({timeout:25000})
    await page.waitForFunction(alt=>{const image=document.querySelector(`img[alt="${alt}"]`);return image?.naturalWidth===320&&image?.naturalHeight===240},alt,{timeout:25000})
  }
  async function cleanCamera(){
    const text=await camera.innerText()
    assert(!/MJPEG|JPEG|Debian|Marlin|compatible|directa/i.test(text),text)
    assert.equal(await camera.getByRole('button',{name:'Modo compatible',exact:true}).count(),0)
    assert.equal(await camera.getByRole('button',{name:'Probar MJPEG',exact:true}).count(),0)
    assert.equal(await camera.getByRole('link').count(),0)
  }
  await cleanCamera()
  assert(!/Video Debian|C3 v|Arduino Mega/.test(await page.locator('header').innerText()))
  console.log('PASS 1 ('+engine+'): video continuo real y cámara sin rótulos técnicos')
  await page.route(/\/frames\?/,route=>route.fulfill({status:404,headers:{'Access-Control-Allow-Origin':'*'},body:'old camera'}))
  await page.route(/\/stream\?/,route=>route.abort())
  await fetch(url+'/__qa?action=pause')
  await camera.getByText('Sin conexión',{exact:true}).waitFor({timeout:15000})
  await cleanCamera()
  assert.equal(await camera.getByRole('button').count(),1)
  assert.equal((await camera.innerText()).replace(/\s+/g,' ').trim(),'Sin conexión Reconectar cámara')
  if(process.env.E2E_SCREENSHOT) await page.screenshot({path:process.env.E2E_SCREENSHOT.replace('.png','-offline.png')})
  await fetch(url+'/__qa?action=resume')
  await camera.getByRole('button',{name:'Reconectar cámara',exact:true}).click()
  await liveImage('Imagen actual de la cámara')
  await cleanCamera()
  console.log('PASS 1b: sin conexión muestra sólo el aviso y reconexión; respaldo automático funciona')
  await page.waitForResponse(response=>response.url().endsWith('/frames?probe=1')&&response.status()===404,{timeout:20000})
  await liveImage('Imagen actual de la cámara')
  console.log('PASS 1c: una prueba fallida del flujo continuo conserva la imagen del respaldo')
  await page.unroute(/\/frames\?/)
  await page.unroute(/\/stream\?/)
  await liveImage('Video de la cámara')
  console.log('PASS 1d: vuelve automáticamente al flujo continuo sin botones de modo')
  await fetch(url+'/__qa?action=pause')
  await page.waitForFunction(()=>!document.body.textContent.includes('EN VIVO'),{},{timeout:15000})
  console.log('PASS 2: la pérdida de captura quita el indicador EN VIVO')
  await fetch(url+'/__qa?action=resume')
  await page.getByText(/EN VIVO/).waitFor({timeout:20000})
  console.log('PASS 3: vuelve automáticamente a MJPEG sin recargar ni tocar botones')
  async function pixel(page){
    return page.evaluate(()=>{const image=document.querySelector('img[alt="Video de la cámara"]');const c=document.createElement('canvas');c.width=1;c.height=1;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data)})
  }
  const blue=await pixel(page); assert(blue[2]>blue[1]+80)
  await fetch(url+'/__qa?action=switch')
  await page.waitForFunction(()=>{const image=document.querySelector('img[alt="Video de la cámara"]');if(!image?.naturalWidth)return false;const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return p[1]>p[2]+50},{},{timeout:20000})
  console.log('PASS 4: cambio de dirección/puerto detectado mediante anuncio UDP real')
  await page.getByRole('button',{name:'Impresión',exact:true}).click()
  await page.getByText('El tiempo restante y el porcentaje son estimativos y solo están disponibles para impresiones desde la SD',{exact:true}).waitFor()
  assert(!/M27|M31|Marlin|Pronterface/.test(await page.locator('main').innerText()))
  if(process.env.E2E_SCREENSHOT) await page.screenshot({path:process.env.E2E_SCREENSHOT.replace('.png','-impresion.png')})
  await page.getByRole('button',{name:'Cámara',exact:true}).click()
  await liveImage('Video de la cámara')
  console.log('PASS 4b: texto exacto de Impresión y regreso a Cámara')

  for (let device = 1; device < 5; device++) await phone()
  const stats=await(await fetch(url+'/__qa')).json()
  assert.equal(stats.second.streams,5)
  console.log('PASS 5: cinco navegadores simultáneos, una captura; '+JSON.stringify({fps:stats.second.published_fps,streams:stats.second.streams,mbps:stats.second.mbps_per_view}))
  if(process.env.E2E_SCREENSHOT) await page.screenshot({path:process.env.E2E_SCREENSHOT})
  await Promise.all(contexts.map(c=>c.close()))
} finally {
  if(browser) await browser.close()
  fixture.kill('SIGTERM')
  await Promise.race([once(fixture,'exit'),new Promise(resolve=>setTimeout(resolve,8000))])
  if(fixture.exitCode===null)fixture.kill('SIGKILL')
}
