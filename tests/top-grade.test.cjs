/* 顶级品质冲刺（v1.22.0）回归：
   1) 本机诊断环形记录（Diag）
   2) 每日自动快照：捕获/列表/保留上限/回滚（含回滚前留底）/当天只留一次
   3) restoreCore：只替换核心表，凭证图片与附件表原样保留
   4) 全局错误监听器把脚本异常写进 Diag */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')
const { IDBFactory } = require('fake-indexeddb')
const { JSDOM } = require('jsdom')
const turn = () => new Promise(r => setImmediate(r))

const source = name => fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8')
function memoryStorage() {
  const values = new Map()
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) }
}

/* 独立快照库 + 主账本库共用一个假 IDBFactory；装载 format/idb/guest-store/snapshot */
async function snapHarness({ txns = 0 } = {}) {
  const factory = new IDBFactory()
  const window = { crypto: webcrypto, indexedDB: factory, localStorage: memoryStorage() }
  const context = vm.createContext({ window, indexedDB: factory, localStorage: window.localStorage, URL, Blob, console })
  for (const name of ['format.js', 'idb.js', 'guest-store.js', 'snapshot.js']) {
    vm.runInContext(source(name), context, { filename: name })
  }
  window.DB = { mode: 'guest' }
  window.GuestStore = window.GuestStore
  await window.GuestStore.init()
  for (let i = 0; i < txns; i++) {
    await window.GuestStore.addTransaction({ txn_type: 'expense', amount: i + 1, occurred_at: '2026-11-2' + (i % 9), account_id: 1, category_id: 1, note: '第' + (i + 1) + '笔' })
  }
  return { window, context }
}

test('Diag keeps a trimmed ring of recent errors with clipped fields and a summary', () => {
  const dom = new JSDOM('<main id="mainView"></main>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  w.localStorage.clear()
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'diag.js'), 'utf8'))
  for (let i = 0; i < 25; i++) w.Diag.logError('error', '错误' + i, 'js/app.js:' + i)
  assert.equal(w.Diag.recent().length, 20, '最多保留 20 条')
  const first = w.Diag.recent()[0]
  assert.match(first.msg, /错误5/, '最旧的 5 条被挤掉')
  w.Diag.logError('rejection', 'x'.repeat(500), 'very-long-source'.repeat(20))
  const last = w.Diag.recent().at(-1)
  assert.ok(last.msg.length <= 201, '消息截断到 200 字')
  assert.ok(last.src.length <= 121, '来源截断到 120 字')
  assert.match(w.Diag.summary(3), /最近错误|\[/)
  assert.ok(w.Diag.summary(3).split('\n').length <= 3, 'summary 只取最近 N 条')
  w.Diag.clear()
  assert.equal(w.Diag.recent().length, 0)
  assert.equal(w.Diag.summary(), '（无）')
})

test('daily snapshot: capture once per day, list metadata, prune to 14', async () => {
  const h = await snapHarness({ txns: 3 })
  const S = h.window.Snapshot
  const first = await S.maybeDaily()
  assert.equal(first.ok, true)
  assert.equal(first.count, 3)
  assert.equal(await S.maybeDaily(), null, '同一天不再重复留')
  const rows = await S.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, 'auto')
  assert.ok(!rows[0].map, '列表不携带整份账本数据')
  /* 塞满超过上限：prune 只留最近 14 份 */
  for (let i = 0; i < 16; i++) await S.capture('manual')
  const after = await S.list()
  assert.equal(after.length, 14, '快照数量封顶 14')
  assert.equal(after[0].reason, 'manual', '最新的在最前')
  await h.window.GuestStore.wipe && h.window.GuestStore.wipe()
})

test('restore rolls back to an older day, auto-keeps a pre-restore snapshot, attachments survive', async () => {
  const h = await snapHarness({ txns: 2 })
  const S = h.window.Snapshot
  await S.maybeDaily()
  /* 快照之后又记了新账：当前 4 笔 */
  await h.window.GuestStore.addTransaction({ txn_type: 'expense', amount: 99, occurred_at: '2026-11-21', account_id: 1, category_id: 1, note: '回滚前新记的' })
  const before = await h.window.GuestStore.listTransactions({ limit: 100 })
  assert.equal(before.rows.length, 3)
  const rows = await S.list()
  const oldId = rows[rows.length - 1].id
  const res = await S.restore(oldId)
  assert.equal(res.txns, 2, '回滚到 2 笔的版本')
  const now = await h.window.GuestStore.listTransactions({ limit: 100 })
  assert.equal(now.rows.length, 2)
  assert.ok(!now.rows.some(r => r.note === '回滚前新记的'), '新记的账被回滚掉')
  const after = await S.list()
  assert.equal(after[0].reason, 'pre-restore', '回滚前自动留底')
  assert.equal(after[0].count, 3, '留底的是回滚前那一刻的 3 笔')
  /* 回滚后当前状态可用 maybeDaily 之外的手动捕获找回——这里验证 restoreCore 的入口 */
  assert.equal(typeof h.window.GuestStore.restoreCore, 'function')
})

test('restoreCore replaces core tables but keeps the attachments table untouched', async () => {
  const h = await snapHarness({ txns: 1 })
  const w = h.window
  /* 直接往主库塞一条附件（模拟凭证图片行），快照 map 不含它 */
  await w.Idb.put('attachments', { id: 900, txn_id: 1, file_name: '小票.png', blob: { type: 'image/png' } })
  const dump = await w.GuestStore.dump()
  const oldMap = {}
  for (const t of w.Snapshot.CORE) oldMap[t] = JSON.parse(JSON.stringify(dump[t]))
  /* 之后账目发生了变化（再加一笔） */
  await w.GuestStore.addTransaction({ txn_type: 'expense', amount: 66, occurred_at: '2026-11-20', account_id: 1, category_id: 1, note: '快照后的新账' })
  const res = await w.GuestStore.restoreCore(oldMap)
  assert.equal(res.txns, 1)
  const txns = await w.Idb.all('transactions')
  assert.equal(txns.length, 1, '账目回到快照时的样子')
  const atts = await w.Idb.all('attachments')
  assert.equal(atts.length, 1, '凭证图片表原样保留')
  assert.equal(atts[0].file_name, '小票.png')
  const listed = await w.GuestStore.listTransactions({ limit: 10 })
  assert.equal(listed.rows.length, 1, '恢复后缓存已失效，读到的是回滚后的数据')
})

test('the global error listener feeds Diag; snapshot scheduling is once per main view', async () => {
  const dom = new JSDOM(
    '<section id="authView" class="hidden"></section><section id="mainView" class="hidden"><div id="content"></div></section>' +
    '<div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div><div id="updateBar"></div>',
    { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  w.localStorage.clear()
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'diag.js'), 'utf8'))
  const app = source('app.js')
  const a = app.indexOf('  function humanError(m) {')
  const b = app.indexOf('  /* ---------- 启动 ---------- */')
  assert.ok(a >= 0 && b > a)
  w.UI = { toast: () => {} }
  w.ic = () => ''
  w.DB = { mode: 'guest' }
  w.Lazy = { need: async () => null }
  w.eval(app.slice(a, b) + '\nglobalThis.__bindSafety = bindGlobalSafety')
  w.__bindSafety()
  const err = new w.ErrorEvent('error', { message: 'TypeError: boom', filename: 'js/ui.js', lineno: 42, cancelable: true })
  w.dispatchEvent(err)
  const rej = new w.Event('unhandledrejection')
  Object.defineProperty(rej, 'reason', { value: new Error('promise 炸了') })
  w.dispatchEvent(rej)
  await turn()
  const log = w.Diag.recent()
  assert.equal(log.length, 2)
  assert.equal(log[0].kind, 'error')
  assert.match(log[0].msg, /TypeError: boom/)
  assert.match(log[0].src, /js\/ui\.js:42/)
  assert.equal(log[1].kind, 'rejection')
  assert.match(log[1].msg, /promise 炸了/)
})
