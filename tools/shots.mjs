/* 界面截图脚本（C8）
 * ------------------------------------------------------------------
 * 以前 docs 里写着「30 个 Chrome 模拟场景通过」，但仓库里没有任何脚本能复现。
 * 这个脚本把最常用的 7 个场景固化下来：起一个本地静态服务 → 用本机 Chrome
 * 的无头模式逐屏截图，产物落到 shots/。
 *
 * 前置：
 *   1) 另开一个终端跑静态服务：python -m http.server 4173（项目根目录）
 *   2) 装好 Chrome；macOS 需改用下面的 CHROME 路径
 * 用法：node tools/shots.mjs [url] [输出目录]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_BASE = process.argv[2] || 'http://127.0.0.1:4173/index.html'
const OUT = process.argv[3] || join(ROOT, 'shots')
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome')
const PORT = 9222
const PROFILE = join(OUT, '.profile')

if (!existsSync(CHROME)) {
  console.error('找不到 Chrome：' + CHROME + '\n可以用 CHROME_PATH 环境变量指定路径')
  process.exit(1)
}
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=390,844', '--force-device-scale-factor=1', URL_BASE], { stdio: ['ignore', 'pipe', 'pipe'] })

let seq = 1, ws
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = seq++
  pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})

async function main() {
  let info
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      info = list.find(t => t.type === 'page')
      if (info && info.webSocketDebuggerUrl) break
    } catch (e) { /* 还没起来 */ }
    await sleep(250)
  }
  if (!info) throw new Error('Chrome 调试端口未就绪')
  ws = new WebSocket(info.webSocketDebuggerUrl)
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  })
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await sleep(1400)

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) console.log('页面报错', JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200))
    return r.result && r.result.value
  }
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
    console.log('已保存 shots/' + name)
  }

  /* 统一用浅色主题截图：默认跟随系统，CI/服务器上可能是深色 */
  await ev(`(() => { try { localStorage.setItem('ledger10_theme','light'); localStorage.setItem('ledger10_privacy_ok','1') } catch(e){}; location.href='${URL_BASE}'; return 1 })()`)
  await sleep(2000)
  await shot('01-auth.png')
  await ev(`(() => { const c=document.querySelector('#consentChk'); if(c) c.checked=true; const b=document.querySelector('#guestBtn'); if(b) b.click(); return 1 })()`)
  await sleep(3400)
  await shot('02-home.png')
  await ev(`(() => { const b=document.querySelector('[data-tab="add"]'); if(b) b.click(); return 1 })()`)
  await sleep(1600)
  await shot('03-editor.png')
  await ev(`(() => { const b=document.querySelector('#edClose'); if(b) b.click(); return 1 })()`)
  for (const [tab, name] of [['stats', '04-stats.png'], ['assets', '05-assets.png'], ['me', '06-me.png']]) {
    await ev(`(() => { const b=document.querySelector('[data-tab="${tab}"]'); if(b) b.click(); return 1 })()`)
    await sleep(2000)
    await shot(name)
  }
  await ev(`(() => { try { localStorage.removeItem('ledger10_privacy_ok'); localStorage.removeItem('ledger10_mode') } catch(e){}; location.href='${URL_BASE}?auth=1'; return 1 })()`)
  await sleep(2000)
  await ev(`(() => { const t=document.querySelector('#authTitle'); if(t) t.click(); return 1 })()`)
  await sleep(900)
  await shot('07-auth-expanded.png')
  ws.close()
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => { try { chrome.kill() } catch (e) {} })
