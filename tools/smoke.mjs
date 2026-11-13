/* 真实浏览器冒烟：游客 → 空态入口 → UI 保存 → 多选改分类 → 重载持久化。
 * 前置：另起静态服务（项目根或 dist/）。
 * 用法：node tools/smoke.mjs [url] [CDP端口，默认 0 自动分配]
 * 每次只使用 shots/ 下独立测试 profile，退出时关闭浏览器并清理。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'shots')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function waitForProcessExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { child.removeListener('exit', done); child.removeListener('error', onError); resolve() }
    // 没有 pid 的启动失败才可视为无需等待；kill 失败仍须等待真实 exit。
    const onError = () => { if (child.pid == null) done() }
    child.once('exit', done); child.on('error', onError)
  })
}

export function evaluationValue(result) {
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails
    throw new Error('页面执行失败：' + (detail.exception?.description || detail.text))
  }
  return result.result?.value
}

export function safeProfilePath(profile) {
  const shots = realpathSync(SHOTS)
  const target = realpathSync(profile)
  assert.equal(shots, join(realpathSync(ROOT), 'shots'), '测试目录不能指向仓库外部')
  assert.ok(dirname(target) === shots && basename(target).startsWith('.smoke-profile-'), '拒绝清理测试目录以外的路径')
  return target
}

async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:4174/index.html').href
  const port = Number(process.argv[3] || 0)
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, 'CDP 端口必须为 0–65535')
  const chromePath = process.env.CHROME_PATH || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome')
  assert.ok(existsSync(chromePath), '找不到 Chrome；请用 CHROME_PATH 指定路径：' + chromePath)
  mkdirSync(SHOTS, { recursive: true })
  // 创建前也校验 shots，避免符号链接把测试数据写到仓库外。
  assert.equal(realpathSync(SHOTS), join(realpathSync(ROOT), 'shots'), '测试目录不能指向仓库外部')
  const profile = mkdtempSync(join(SHOTS, '.smoke-profile-'))
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', '--force-device-scale-factor=1', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
  chrome.stdout.resume(); chrome.stderr.resume()
  let launchError, announcedPort, exited = false, ws, seq = 1, failure, browserStderr = ''
  chrome.stderr.on('data', data => {
    browserStderr = (browserStderr + String(data)).slice(-4000)
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(String(data))
    if (match) announcedPort = Number(match[1])
  })
  const closed = waitForProcessExit(chrome).then(() => { exited = true })
  chrome.once('error', error => { launchError = error })
  const pending = new Map(), errors = [], exceptions = [], out = { url, profile }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = seq++
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 请求超时：' + method)) }, 10000)
    pending.set(id, { res, rej, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async expression => evaluationValue(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
  const waitFor = async (expression, label) => {
    const end = Date.now() + 12000
    do {
      assert.equal(errors.length + exceptions.length, 0, '页面报错：' + [...errors, ...exceptions].join('\n'))
      const value = await ev(expression)
      if (value) return value
      await sleep(100)
    } while (Date.now() < end)
    throw new Error('冒烟断言失败（等待超时）：' + label)
  }
  try {
    let activePort
    for (let i = 0; i < 80; i++) {
      if (launchError) throw launchError
      if (exited) throw new Error('Chrome 在调试端口就绪前退出')
      // 0 端口由 Chrome 自己分配，读取本次 profile 的端口，绝不连接其它实例。
      try { activePort = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch (e) { activePort = announcedPort }
      if (activePort) break
      await sleep(250)
    }
    if (!activePort) throw new Error('Chrome 调试端口未就绪')
    const list = await (await fetch(`http://127.0.0.1:${activePort}/json`)).json()
    const info = list.find(t => t.type === 'page' && t.url === 'about:blank')
    assert.ok(info?.webSocketDebuggerUrl, '找不到本次测试页面')
    ws = new WebSocket(info.webSocketDebuggerUrl)
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer)
        message.error ? request.rej(new Error(message.error.message)) : request.res(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value ?? a.description ?? '').join(' '))
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
    })
    ws.addEventListener('close', () => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.rej(new Error('Chrome 调试连接已关闭')) }
      pending.clear()
    })
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await ev('window.__sgSmokeLeaving = true')
    await send('Page.navigate', { url })
    await waitFor("!window.__sgSmokeLeaving && document.readyState === 'complete'", '页面加载')
    assert.ok(await ev("!!document.querySelector('#guestBtn')"), '冒烟断言失败：游客入口缺失')
    await waitFor("!!document.querySelector('#authView:not(.hidden)') && !document.querySelector('#guestBtn').disabled", '游客入口可用')
    out.boot = await ev("({ title: document.title, hasGuestBtn: !!document.querySelector('#guestBtn'), authVisible: !!document.querySelector('#authView:not(.hidden)') })")
    assert.ok(out.boot.hasGuestBtn && out.boot.authVisible, '冒烟断言失败：游客入口必须可见')
    await ev("(() => { document.querySelector('#consentChk').checked = true; document.querySelector('#guestBtn').click() })()")
    await waitFor("window.DB?.mode === 'guest' && !!document.querySelector('#mainView:not(.hidden)') && !!document.querySelector('#productHome [data-quick-category]')", '游客进入与空态快捷入口')
    out.emptyHome = await ev("(async () => ({ quickbar: !!document.querySelector('#productHome .sg-quickbar'), quickCats: document.querySelectorAll('#productHome [data-quick-category]').length, total: (await window.DB.listTransactions({ limit: 5 })).total }))()")
    assert.ok(out.emptyHome.quickbar && out.emptyHome.quickCats > 0, '冒烟断言失败：空账本快捷入口缺失')
    assert.equal(out.emptyHome.total, 0, '冒烟断言失败：独立测试账本应为空')
    out.initialCategory = await ev("(() => { const button = document.querySelector('#productHome [data-quick-category]'); button.click(); return button.dataset.quickCategory })()")
    await waitFor("!!document.querySelector('#amtInput') && !!document.querySelector('#edSave')", '打开记账表单')
    await ev("(() => { const amount = document.querySelector('#amtInput'); amount.value = '12.5'; amount.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#noteInput').value = 'smoke'; document.querySelector('#edSave').click() })()")
    await waitFor("document.querySelector('#sheet')?.getAttribute('aria-hidden') === 'true' && document.querySelectorAll('#content .txn').length === 1", '通过界面保存一笔账')
    const readRows = "(async () => { const result = await window.DB.listTransactions({ limit: 5 }); return { total: result.total, rows: result.rows.map(t => ({ id: t.id, amount: t.amount, categoryId: String(t.category_id), note: t.note, type: t.txn_type })), visibleRows: document.querySelectorAll('#content .txn').length } })()"
    out.write = await ev(readRows)
    assert.equal(out.write.total, 1, '冒烟断言失败：必须实际写入且只写入一笔')
    assert.equal(out.write.rows.length, 1)
    assert.equal(out.write.rows[0].amount, 12.5, '冒烟断言失败：保存金额错误')
    assert.equal(out.write.rows[0].note, 'smoke')
    assert.equal(out.write.rows[0].type, 'expense')
    assert.equal(out.write.rows[0].categoryId, out.initialCategory, '冒烟断言失败：快捷分类未带入保存')
    await ev("document.querySelector('[data-batch]').click()")
    out.barBeforePick = await ev("({ on: !!document.querySelector('#batchBar.on'), count: document.querySelector('#batchBar .batch-count b')?.textContent, selected: document.querySelectorAll('#content .txn.sel').length })")
    assert.ok(out.barBeforePick.on, '冒烟断言失败：未进入多选')
    assert.equal(out.barBeforePick.count, '0')
    assert.equal(out.barBeforePick.selected, 0)
    await ev("document.querySelector('#content .txn').click()")
    out.barAfterPick = await ev("({ count: document.querySelector('#batchBar .batch-count b')?.textContent, selected: document.querySelectorAll('#content .txn.sel').length, disabled: document.querySelector('#batchCat').disabled })")
    assert.equal(out.barAfterPick.count, '1', '冒烟断言失败：多选计数错误')
    assert.equal(out.barAfterPick.selected, 1, '冒烟断言失败：账目未选中')
    assert.equal(out.barAfterPick.disabled, false)
    await ev("document.querySelector('#batchCat').click()")
    await waitFor("document.querySelectorAll('#sheet [data-bcat]').length > 1", '批量分类选择器')
    out.targetCategory = await ev(`(() => { const button = Array.from(document.querySelectorAll('#sheet [data-bcat]')).find(b => b.dataset.bcat !== ${JSON.stringify(out.initialCategory)} && window.DB.category(Number(b.dataset.bcat))?.kind === 'expense'); if (!button) throw new Error('缺少不同的支出分类'); button.click(); return button.dataset.bcat })()`)
    await waitFor(`(async () => { const result = await window.DB.listTransactions({ limit: 5 }); return result.total === 1 && String(result.rows[0]?.category_id) === ${JSON.stringify(out.targetCategory)} && !document.querySelector('#batchBar.on') })()`, '分类真实改变')
    out.afterBatch = await ev(readRows)
    assert.notEqual(out.targetCategory, out.initialCategory)
    assert.equal(out.afterBatch.rows[0].id, out.write.rows[0].id, '冒烟断言失败：改分类不应新增账目')
    assert.equal(out.afterBatch.rows[0].amount, 12.5)
    assert.equal(await ev("document.querySelectorAll('#content .txn.sel').length"), 0)
    await ev('window.__sgSmokeLeaving = true')
    await send('Page.reload', { ignoreCache: true })
    await waitFor("!window.__sgSmokeLeaving && document.readyState === 'complete' && window.DB?.mode === 'guest' && !!document.querySelector('#mainView:not(.hidden)') && document.querySelectorAll('#content .txn').length === 1", '重载后恢复本机账目')
    out.persisted = await ev(readRows)
    assert.equal(out.persisted.total, 1, '冒烟断言失败：重载后账目数量变化')
    assert.deepEqual(out.persisted.rows, out.afterBatch.rows, '冒烟断言失败：重载后金额或分类未持久化')
    assert.equal(errors.length + exceptions.length, 0, '冒烟断言失败：页面存在错误')
    out.ok = true
  } catch (error) {
    failure = error
    throw error
  } finally {
    out.errors = errors; out.exceptions = exceptions
    if (!out.ok) out.browserStderr = browserStderr
    console.log(JSON.stringify(out, null, 2))
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        try { await send('Browser.close') } catch (e) { /* 浏览器可能先关闭连接 */ }
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close()
      await Promise.race([closed, sleep(2000)])
      if (!exited) { chrome.kill(); await Promise.race([closed, sleep(3000)]) }
      if (!exited) { chrome.kill('SIGKILL'); await Promise.race([closed, sleep(3000)]) }
      assert.ok(exited, 'Chrome 未退出，保留测试 profile 供检查')
      chrome.stdout.destroy(); chrome.stderr.destroy()
      rmSync(safeProfilePath(profile), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      assert.equal(errors.length + exceptions.length, 0, '冒烟断言失败：页面存在错误')
    } catch (cleanupError) {
      if (!failure) throw cleanupError
      console.error('浏览器清理失败：' + cleanupError.message)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
