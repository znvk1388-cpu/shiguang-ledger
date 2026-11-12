/* 端到端冒烟（C8）
 * ------------------------------------------------------------------
 * 覆盖最容易在重构中坏掉、而单元测试（jsdom）看不到真实布局的路径：
 *   游客进入 → 空账本快捷入口 → 记一笔 → 多选 → 批量改分类 → 无报错
 * 同时也当 dist 构建产物的健康检查用（对压缩后的代码跑一遍）。
 *
 * 前置：静态服务（项目根或 dist/），例如 python -m http.server 4174（在 dist 里跑）
 * 用法：node tools/smoke.mjs [url]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_BASE = process.argv[2] || 'http://127.0.0.1:4174/index.html'
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome')
const PORT = 9229
const TMP = join(ROOT, 'shots', '.smoke-profile')

if (!existsSync(CHROME)) {
  console.error('找不到 Chrome：' + CHROME + '\n可以用 CHROME_PATH 环境变量指定路径')
  process.exit(1)
}
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=390,844', '--force-device-scale-factor=1', URL_BASE], { stdio: ['ignore', 'pipe', 'pipe'] })

let seq = 1, ws
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = seq++
  pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
const FLAT = "replace(/\\s+/g,' ').trim()"

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
  const errors = [], exceptions = []
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160))
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 160))
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(String(m.params.entry.text).slice(0, 160))
  })
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await sleep(1400)
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { err: String((r.exceptionDetails.exception || {}).description).slice(0, 240) }
    return r.result && r.result.value
  }

  const out = {}
  out.boot = await ev(`(() => ({ title: document.title, hasGuestBtn: !!document.querySelector('#guestBtn') }))()`)
  await ev(`(() => { try { localStorage.setItem('ledger10_privacy_ok','1'); localStorage.setItem('ledger10_theme','light') } catch(e){}; const c=document.querySelector('#consentChk'); if(c) c.checked=true; const b=document.querySelector('#guestBtn'); if(b) b.click(); return 1 })()`)
  await sleep(3600)
  /* 空账本：C5 的快捷入口必须出现 */
  out.emptyHome = await ev(`(() => ({ quickbar: !!document.querySelector('.sg-quickbar'), quickCats: document.querySelectorAll('#productHome [data-quick-category]').length }))()`)

  out.write = await ev(`(async () => { try {
    await window.DB.addTransaction({ txn_type:'expense', amount: 12.5, occurred_at: new Date().toISOString(),
      account_id: (window.DB.allAccounts()[0]||{}).id, category_id: (window.DB.rootCategories('expense')[0]||{}).id,
      note:'smoke', book_id: (window.DB.activeBookId ? window.DB.activeBookId() : 1) })
    window.App.refresh(); return 'ok' } catch(e) { return String(e && e.message) } })()`)
  await sleep(2800)
  out.list = await ev(`(() => ({ rows: document.querySelectorAll('#content .txn').length, hasBatchBtn: !!document.querySelector('[data-batch]') }))()`)

  await ev(`(() => { const b=document.querySelector('[data-batch]'); if(b) b.click(); return 1 })()`)
  await sleep(600)
  out.barBeforePick = await ev(`(() => { const bar=document.querySelector('#batchBar'); return { on: !!bar && bar.classList.contains('on'), text: bar ? (bar.innerText||'').${FLAT} : '' } })()`)
  await ev(`(() => { const row=document.querySelector('#content .txn'); if(row) row.click(); return 1 })()`)
  await sleep(500)
  out.barAfterPick = await ev(`(() => { const bar=document.querySelector('#batchBar'); return { sel: document.querySelectorAll('#content .txn.sel').length, text: bar ? (bar.innerText||'').${FLAT} : '' } })()`)

  await ev(`(() => { const b=document.querySelector('#batchCat'); if(b) b.click(); return 1 })()`)
  await sleep(700)
  out.catSheet = await ev(`(() => ({ chips: document.querySelectorAll('#sheet [data-bcat]').length }))()`)
  out.pickCat = await ev(`(() => { const c=document.querySelectorAll('#sheet [data-bcat]')[1]; if(!c) return {found:false}; c.click(); return {found:true} })()`)
  await sleep(2600)
  out.afterBatch = await ev(`(async () => { const res = await window.DB.listTransactions({ limit: 5 }); return { first: res.rows[0] ? { id: res.rows[0].id, categoryId: res.rows[0].category_id } : null, sel: document.querySelectorAll('#content .txn.sel').length } })()`)

  out.errors = errors
  out.exceptions = exceptions
  console.log(JSON.stringify(out, null, 2))
  ws.close()

  const bad = errors.length || exceptions.length
  if (bad) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => { try { chrome.kill() } catch (e) {} })
