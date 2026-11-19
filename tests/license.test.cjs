const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')
const { generateKeyPairSync, sign, webcrypto } = require('node:crypto')
const turn = () => new Promise(r => setImmediate(r))

function setup({ withUi = false } = {}) {
  const dom = new JSDOM(
    '<main id="mainView"><div id="content"></div></main><div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>',
    { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, vibes = [], animations = []
  let reduceListener
  const reduceMedia = { matches: false, addEventListener(n, fn) { reduceListener = fn }, addListener(fn) { reduceListener = fn } }
  const coarseMedia = { matches: true, addEventListener() {}, addListener() {} }
  w.matchMedia = q => String(q).indexOf('prefers-reduced-motion') >= 0 ? reduceMedia : coarseMedia
  w.HTMLElement.prototype.animate = function (frames, options) {
    let resolve, reject
    const finished = new Promise((yes, no) => { resolve = yes; reject = no })
    const a = { frames, options, finished, cancels: 0, cancel() { this.cancels++; reject(Error('cancelled')) }, finish() { resolve() } }
    animations.push(a); return a
  }
  Object.defineProperty(w.navigator, 'vibrate', { configurable: true, value: p => { vibes.push(p); return true } })
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle })
  const keyPair = generateKeyPairSync('ed25519')
  w.PRO_LICENSE_PUB = keyPair.publicKey.export({ format: 'jwk' }).x
  const account = { id: 1, name: '现金', currency: 'CNY' }, category = { id: 1, name: '餐饮', txn_type: 'expense' }
  const smartCalls = []
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.eval(fs.readFileSync('js/license.js', 'utf8'))
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async mod => { smartCalls.push(mod); return withUi ? null : null } }
  const state = { tab: 'me', scope: 'month', year: 2026, month: 11, homeView: 'list', filters: {} }
  w.DB = { mode: 'guest', state: { sourceId: 'license-test', categories: [category] }, activeBookId: () => 1,
    storageUsage: async () => ({ count: 0, bytes: 0 }), listTransactions: async () => ({ rows: [], total: 0 }),
    budgetOf: () => null, setBudget: async () => {}, accounts: () => [account], allAccounts: () => [account],
    category: () => category, rootCategories: () => [category], childCategories: () => [], categoryName: () => category.name, accountName: () => account.name }
  w.App = { state, version: 'test', themeMode: () => 'light', lockConfig: () => ({ on: false }),
    uiSettings: () => ({ scale: 'normal', palette: 'bright' }), refresh: async () => {},
    renderTab: () => { w.__renderTabCalls = (w.__renderTabCalls || 0) + 1 } }
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}
  w.confirm = () => true
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  return { w, state, vibes, animations, smartCalls, keyPair, $: s => w.document.querySelector(s), close: () => w.close() }
}

function makeCode(keyPair, { plan = 1, serial = 1, corrupt } = {}) {
  const p = Buffer.alloc(10)
  p[0] = 0x53; p[1] = 0x4A; p[2] = 0x31; p[3] = plan
  p.writeUInt32BE(Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86400000), 4)
  p.writeUInt16BE(serial & 0xFFFF, 8)
  let sig = Buffer.from(sign(null, p, keyPair.privateKey))
  if (corrupt === 'sig') sig[10] ^= 0x40
  if (corrupt === 'plan') p[3] = plan
  return 'SJ1.' + p.toString('base64url') + '.' + Buffer.from(sig).toString('base64url')
}

test('a genuinely signed code activates and persists Pro status with its order details', async () => {
  const h = setup()
  try {
    assert.equal(h.w.License.isPro(), false)
    const res = await h.w.License.activate(makeCode(h.keyPair, { serial: 2026 }))
    assert.equal(res.ok, true)
    assert.equal(h.w.License.isPro(), true)
    const st = h.w.License.status()
    assert.equal(st.pro, true)
    assert.equal(st.serial, 2026)
    assert.match(st.issued, /^20\d\d-/)
    assert.ok(h.w.localStorage.getItem('ledger10_license').includes('SJ1.'))
  } finally { h.close() }
})

test('tampered, foreign-plan and malformed codes are all rejected and never unlock Pro', async () => {
  const h = setup()
  try {
    const good = makeCode(h.keyPair, { serial: 7 })
    const flipped = makeCode(h.keyPair, { serial: 7 }) ; /* 换一枚再篡改 */
    const bad = flipped.slice(0, flipped.length - 8) + (flipped.endsWith('A') ? 'B' : 'A')
    assert.equal((await h.w.License.activate(bad)).reason, 'signature')
    assert.equal((await h.w.License.activate(makeCode(h.keyPair, { plan: 2 }))).reason, 'plan')
    assert.equal((await h.w.License.activate('SJ1.abc')).reason, 'format')
    assert.equal((await h.w.License.activate('随便一串')).reason, 'format')
    assert.equal((await h.w.License.activate('PRO-1234-5678')).reason, 'format')
    const other = await h.w.License.activate(good.replace('SJ1.', 'SJ2.'))
    assert.equal(other.ok, false)
    assert.equal(h.w.License.isPro(), false)
  } finally { h.close() }
})

test('a saved activation is Pro without re-activating, and deactivation clears it', async () => {
  const h = setup()
  try {
    const code = makeCode(h.keyPair, { serial: 9 })
    h.w.localStorage.setItem('ledger10_license', JSON.stringify({ code, activatedAt: '2026-11-19T00:00:00.000Z' }))
    assert.equal(h.w.License.isPro(), true)
    h.w.License.deactivate()
    assert.equal(h.w.License.isPro(), false)
    assert.equal(h.w.License.status().pro, false)
  } finally { h.close() }
})

test('the AI entry is gated: without Pro it opens the Pro sheet, activation unlocks it', async () => {
  const h = setup()
  try {
    await h.w.UI.renderMe(h.state)
    const proRow = h.$('#proBtn')
    assert.ok(proRow, '我的页有拾光 Pro 入口')
    assert.match(proRow.textContent, /拾光 Pro/)
    assert.match(h.$('#proLabel').textContent, /未激活/)
    h.$('#aiBtn').click()
    assert.match(h.$('#sheet .sheet-title').textContent, /拾光 Pro/)
    assert.ok(!h.smartCalls.includes('smart'), '未激活不进入 AI 面板')
    await h.w.License.activate(makeCode(h.keyPair, { serial: 31 }))
    h.$('#proCodeInput').value = makeCode(h.keyPair, { serial: 32 })
    h.$('#proActivateBtn').click()
    await new Promise(r => setTimeout(r, 120))
    assert.equal(h.w.License.isPro(), true, '输入框里的码已激活')
    assert.ok(h.w.__renderTabCalls >= 1, '激活成功刷新我的页')
    assert.ok(h.vibes.includes(20), '激活成功有成功触感')
    /* 另一独立环境同样激活后，我的页标签显示已激活 */
    const gate2 = setup()
    try {
      await gate2.w.License.activate(makeCode(gate2.keyPair, { serial: 41 }))
      await gate2.w.UI.renderMe(gate2.state)
      assert.match(gate2.$('#proLabel').textContent, /已激活/)
    } finally { gate2.close() }
  } finally { h.close() }
})

test('with Pro active the AI sheet opens directly through the lazy module', async () => {
  const h = setup()
  try {
    await h.w.License.activate(makeCode(h.keyPair, { serial: 77 }))
    await h.w.UI.renderMe(h.state)
    h.$('#aiBtn').click()
    await turn()
    assert.deepEqual(h.smartCalls.filter(m => m === 'smart'), ['smart'], '已激活直接进入 AI 面板')
    const title = h.$('#sheet .sheet-title')
    assert.ok(!(title && /拾光 Pro/.test(title.textContent)), '已激活时不再弹 Pro 推介')
  } finally { h.close() }
})
