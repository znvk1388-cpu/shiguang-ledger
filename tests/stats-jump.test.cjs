'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('统计分类跳转保持账本与时间并移除统计未使用的旧筛选', () => {
  for (const range of ['month', 'year']) {
    const handlers = {}
    const category = { addEventListener: (type, fn) => { handlers[type] = fn }, getAttribute: () => '12' }
    const fakeNode = { classList: { toggle() {} } }
    const UI = { $: s => ['#periodTitle', '#scopeBtn', '#content'].includes(s) ? fakeNode : null,
      $$: s => s === '#content [data-cat]' ? [category] : [], periodTitle: () => '',
      renderHome: async () => {}, renderOverview: async () => {}, toast() {} }
    const DB = { mode: 'cloud', activeBookId: () => 42, categoryName: () => '餐饮' }
    const ctx = { window: { UI, DB, Fmt: {} }, document: { body: fakeNode,
      addEventListener() {}, querySelector: () => null, getElementById: () => null }, localStorage: { getItem: () => null }, setTimeout() {}, clearTimeout() {} }
    vm.createContext(ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'), ctx)
    const app = ctx.window.App
    Object.assign(app.state, { statRange: range, scope: 'all', year: 2025, month: 2, homeView: 'cal', calDay: '2025-02-01' })
    Object.assign(app.state.filters, { type: 'income', accountId: 9, categoryId: 5, keyword: '旧搜索', tag: '标签', minAmount: '10', maxAmount: '50', reimbursable: true })
    app.bindContentEvents()
    handlers.click()
    assert.equal(app.state.scope, range)
    assert.equal(app.state.year, 2025)
    assert.equal(app.state.month, 2)
    assert.equal(DB.activeBookId(), 42)
    assert.equal(app.state.homeView, 'list')
    assert.equal(app.state.calDay, null)
    assert.equal(JSON.stringify(app.state.filters), JSON.stringify({ type: 'expense', accountId: null, categoryId: 12, keyword: '', tag: '', minAmount: '', maxAmount: '', reimbursable: false }))
  }
})
