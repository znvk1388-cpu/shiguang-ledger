const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

test('user can import a selected uncertain match while an order-number duplicate stays excluded', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  w.DB = {
    mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [],
    listTransactions: async () => ({ rows: [
      { book_id: 1, txn_type: 'expense', amount: 10, occurred_at: '2026-10-28T12:00:00', note: '咖啡' },
      { book_id: 1, txn_type: 'expense', amount: 20, occurred_at: '2026-10-28T12:00:00', note: '午餐', _ord: 'order-1' },
    ] }),
    addTransaction: async row => { writes.push(row); return { id: writes.length } },
  }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const rows = [
    { type: 'expense', amount: 10, occurred: '2026-10-28T12:00:00', note: '咖啡' },
    { type: 'expense', amount: 20, occurred: '2026-10-28T12:00:00', note: '午餐', orderNo: 'order-1' },
  ]
  await w.LedgerCsv.openImportPreview({ rows, report: {} }, '测试.csv')
  assert.match(w.document.querySelector('#sheet').textContent, /确定重复/)
  const choice = w.document.querySelector('[data-import-uncertain="0"]')
  assert.ok(choice)
  choice.checked = true
  choice.dispatchEvent(new w.Event('change'))
  assert.match(w.document.querySelector('#impRun').textContent, /1 笔/)
  w.document.querySelector('#impRun').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].note, '咖啡')
})

test('account mapping persists for the same identity and routes imported rows to an existing account', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  const accounts = [{ id: 7, name: '银行卡' }]
  w.DB = {
    mode: 'guest', state: { sourceId: 'library-a', categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => accounts,
    listTransactions: async () => ({ rows: [] }),
    addAccount: async () => { throw new Error('不应新建账户') },
    addTransaction: async row => { writes.push(row); return { id: writes.length } },
  }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const makeRows = () => [{ type: 'expense', amount: 10, occurred: '2026-10-28T12:00:00', note: '早餐', accountName: '零钱通' }]
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  const mapping = w.document.querySelector('[data-account-map]')
  assert.ok(mapping)
  mapping.value = '7'
  w.document.querySelector('#impRun').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(writes[0].account_id, 7)
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  assert.equal(w.document.querySelector('[data-account-map]').value, '7')
  w.DB.state.sourceId = 'library-b'
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  assert.equal(w.document.querySelector('[data-account-map]').value, '')
})
