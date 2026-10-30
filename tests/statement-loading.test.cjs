const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

test('对账单日期加载和失败时不允许对旧数据核对或导出，重试后恢复', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { sourceId: 'one' }, allAccounts: () => [{ id: 1, name: '现金', currency: 'CNY' }],
    listTransactions: async () => ({ rows: [{ id: 9, txn_type: 'expense', account_id: 1, amount: 12, occurred_at: '2026-10-01T00:00:00Z' }] }), accountName: () => '现金', categoryName: () => '' }
  w.eval(fs.readFileSync('js/format.js', 'utf8')); w.eval(fs.readFileSync('js/insight.js', 'utf8'))
  await w.Insight.openStatement(1)
  let reject
  w.DB.listTransactions = () => new Promise((_, r) => { reject = r })
  const from = w.document.querySelector('#stFrom')
  from.value = '2026-10-01'; from.dispatchEvent(new w.Event('change'))
  assert.equal(w.document.querySelector('#stCsv').disabled, true)
  assert.equal(w.document.querySelectorAll('[data-reconciled]').length, 0)
  reject(new Error('offline'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.document.querySelector('#stCsv').disabled, true)
  assert.match(w.document.querySelector('#stStatus').textContent, /失败/)
  w.DB.listTransactions = async () => ({ rows: [] })
  w.document.querySelector('#stRetry').click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.document.querySelector('#stCsv').disabled, false)
  assert.match(w.document.querySelector('#stBody').textContent, /没有流水/)
  let finish
  w.DB.listTransactions = () => new Promise(resolve => { finish = resolve })
  from.value = '2026-10-02'; from.dispatchEvent(new w.Event('change'))
  w.DB.state.sourceId = 'two'
  finish({ rows: [{ id: 99, txn_type: 'expense', account_id: 1, amount: 100, occurred_at: '2026-10-02T00:00:00Z' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.document.querySelector('#stCsv').disabled, true)
  assert.match(w.document.querySelector('#stStatus').textContent, /账本已变化/)
  assert.doesNotMatch(w.document.querySelector('#stBody').textContent, /100/)
})
