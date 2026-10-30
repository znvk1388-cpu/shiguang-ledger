'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function harness() {
  const values = new Map()
  let fail = false
  const localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => { if (fail) throw Error('quota'); values.set(key, value) } }
  const db = { mode: 'guest', state: { sourceId: 'guest-a' }, accounts: () => [{ id: 1 }], category: id => id === 2 ? { id } : null }
  const ctx = { window: { DB: db, Fmt: { localInput: () => '', toCents: n => Math.round(n * 100), escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }, addEventListener() {} }, localStorage }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8'), ctx)
  return { ui: ctx.window.UI, db, values, fail: () => { fail = true } }
}

test('保存的筛选按用户和游客来源隔离，且仅使用当前账本与时间', () => {
  const h = harness()
  const filters = { type: 'expense', accountId: 1, categoryId: 2, keyword: '午餐', tag: '', minAmount: '', maxAmount: '', reimbursable: false }
  h.ui.savedFilterSave('午餐', filters)
  assert.equal(h.ui.savedFilterList().length, 1)
  assert.equal(h.ui.savedFilterApply('午餐').keyword, '午餐')
  h.db.state.sourceId = 'guest-b'
  assert.equal(h.ui.savedFilterList().length, 0)
  h.db.mode = 'cloud'; h.db.state.uid = 'guest-a'
  assert.equal(h.ui.savedFilterList().length, 0)
  h.db.state.uid = ''
  assert.throws(() => h.ui.savedFilterSave('x', filters), /身份/)
})

test('失效账户或分类不得静默应用，保存失败要告知用户', () => {
  const h = harness()
  h.ui.savedFilterSave('常用', { accountId: 1, categoryId: 2 })
  h.db.accounts = () => []
  assert.throws(() => h.ui.savedFilterApply('常用'), /账户/)
  h.db.accounts = () => [{ id: 1 }]
  h.db.category = () => null
  assert.throws(() => h.ui.savedFilterApply('常用'), /分类/)
  h.fail()
  assert.throws(() => h.ui.savedFilterSave('失败', {}), /保存/)
})

test('首页待确认提示只读取当前身份，旧名单被保留且不会错误计入', () => {
  const h = harness()
  h.ui.ic = () => ''
  h.values.set('ledger10_pending', '[99]')
  const key = 'ledger10_pending_v2:' + encodeURIComponent(JSON.stringify(['guest', 'guest-a']))
  h.values.set(key, '[1,2]')
  assert.match(h.ui.pendingBanner(), /2 笔/)
  assert.match(h.ui.pendingBanner(), /旧版.*保留.*未自动/)
  assert.match(h.ui.pendingBanner(), /查看旧记录编号.*99/)
  h.db.state.sourceId = 'guest-b'
  assert.doesNotMatch(h.ui.pendingBanner(), /2 笔/)
  assert.match(h.ui.pendingBanner(), /旧版.*保留.*未自动/)
  h.db.state.sourceId = ''
  assert.doesNotMatch(h.ui.pendingBanner(), /2 笔/)
  assert.equal(h.values.get('ledger10_pending'), '[99]')
})

test('待确认数据损坏时首页提示用户核对', () => {
  const h = harness()
  const key = 'ledger10_pending_v2:' + encodeURIComponent(JSON.stringify(['guest', 'guest-a']))
  h.values.set(key, '{bad json')
  assert.match(h.ui.pendingBanner(), /待确认.*读取失败/)
  assert.equal(h.values.get(key), '{bad json')
})

test('报销覆盖层和异步缓存均按当前数据来源隔离', async () => {
  const h = harness()
  h.ui.writeReimb(1, 'done', '', 'ledger10_reimb_v2:' + encodeURIComponent(JSON.stringify(['guest', 'guest-a'])))
  assert.equal(h.ui.reimbStatusOf({ id: 1, reimbursable: true }), 'done')
  h.db.state.sourceId = 'guest-b'
  assert.equal(h.ui.reimbStatusOf({ id: 1, reimbursable: true }), 'pending')
  assert.throws(() => h.ui.writeReimb(1, 'done', '', 'ledger10_reimb_v2:' + encodeURIComponent(JSON.stringify(['guest', 'guest-a']))), /切换/)
  let release
  h.db.listTransactions = () => new Promise(resolve => { release = resolve })
  const pending = h.ui.reimbPending()
  h.db.state.sourceId = 'guest-c'
  release({ rows: [{ id: 1, amount: 5 }] })
  assert.equal((await pending).count, 0)
})

test('旧版报销进度存在时汇总提示需核对并保留原数据', () => {
  const h = harness()
  assert.equal(h.ui.legacyReimbNotice(), '')
  h.values.set('ledger10_reimb', '{"1":{"status":"done"}}')
  assert.match(h.ui.legacyReimbNotice(), /旧版报销进度未计入.*可能偏高.*核对/)
  assert.equal(h.values.get('ledger10_reimb'), '{"1":{"status":"done"}}')
})
