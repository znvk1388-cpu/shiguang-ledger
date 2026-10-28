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
  const ctx = { window: { DB: db, Fmt: { localInput: () => '' }, addEventListener() {} }, localStorage }
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
