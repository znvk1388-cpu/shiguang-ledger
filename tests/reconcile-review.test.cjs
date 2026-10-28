const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

test('reconciliation stops when the balance changes while the form is open', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  let balance = 10000
  const account = { id: 1, name: '美元', currency: 'USD', initial_balance: 100 }
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { accountBalances: async () => [{ account, balance }], updateAccount: async (...args) => writes.push(args) }
  w.App = { refresh: async () => {} }
  w.ic = () => ''
  w.confirm = () => true
  for (const file of ['js/format.js', 'js/wealth.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  await w.Wealth.openReconcile(1)
  assert.match(w.document.querySelector('#sheet').textContent, /USD/)
  w.document.querySelector('#rcReal').value = '120'
  balance = 11000
  w.document.querySelector('#rcSave').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(writes.length, 0)
  assert.match(w.document.querySelector('#rcErr').textContent, /变化/)
})

test('reconciliation asks before changing opening balance and preserves account currency', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  const account = { id: 1, name: '美元', currency: 'USD', initial_balance: 100 }
  let approved = false
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { accountBalances: async () => [{ account, balance: 10000 }], updateAccount: async (...args) => writes.push(args) }
  w.App = { refresh: async () => {} }
  w.ic = () => ''
  w.confirm = () => approved
  for (const file of ['js/format.js', 'js/wealth.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  await w.Wealth.openReconcile(1)
  w.document.querySelector('#rcReal').value = '120'
  w.document.querySelector('#rcSave').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(writes.length, 0)
  approved = true
  w.document.querySelector('#rcSave').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1].initial_balance, 120)
})
