const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

test('same order number within the file is presented for manual review and is not imported by default', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [],
    listTransactions: async () => ({ rows: [] }),
    addTransaction: async row => { writes.push(row); return { id: writes.length } } }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,备注,交易单号\n2026-10-28,支出,10,咖啡,abc\n2026-10-28,支出,10,咖啡,abc\n2026-10-28,支出,10,咖啡,\n2026-10-28,支出,10,咖啡,')
  assert.equal(parsed.rows.length, 4)
  await assert.rejects(w.LedgerCsv.importCsvText('日期,类型,金额,备注,交易单号\n2026-10-28,支出,10,咖啡,abc\n2026-10-28,支出,10,咖啡,abc'), /逐笔核对/)
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  assert.match(w.document.querySelector('#sheet').textContent, /文件内单号重复/)
  assert.match(w.document.querySelector('#impRun').textContent, /3 笔/)
  w.document.querySelector('#impRun').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(writes.length, 3)
})

test('custom column mapping supports explicit transfer and destination account', () => {
  const dom = new JSDOM('', { url: 'https://test.local', runScripts: 'outside-only' })
  try {
    const w = dom.window
    for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    const result = w.LedgerCsv.parseCsvText('日期列,类型列,金额列,转出,转入\n2026-10-28,转账,20,微信,银行卡', { hi: 0, date: 0, type: 1, amount: 2, account: 3, toAccount: 4 })
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].type, 'transfer')
    assert.equal(result.rows[0].toAccountName, '银行卡')
  } finally { dom.window.close() }
})

test('preview identifies invalid source rows and gives enough context to review repeated order numbers', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [],
    listTransactions: async () => ({ rows: [] }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,账户,备注,交易单号\n无效日期,支出,8,微信,早餐,one\n2026-10-28 10:11,支出,10,微信,咖啡,编号123\n2026-10-28 11:12,支出,10,微信,咖啡,编号123')
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  const sheet = w.document.querySelector('#sheet').textContent
  assert.match(sheet, /第 2 条.*日期无效/)
  const label = w.document.querySelector('[data-import-uncertain]').closest('label').textContent
  assert.match(label, /编号123/)
  assert.match(label, /微信/)
  assert.match(label, /11:12/)
})

test('custom column selector exposes destination account and mapped transfer saves both account IDs', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  const accounts = [{ id: 1, name: '微信' }, { id: 2, name: '银行卡' }]
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => accounts,
    listTransactions: async () => ({ rows: [] }),
    addTransaction: async row => { writes.push(row); return { id: writes.length } } }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  w.LedgerCsv.openColumnMap('日期列,类型列,金额列,转出,转入\n2026-10-28,转账,20,微信,银行卡', '测试.csv')
  for (const [name, value] of Object.entries({ date: 0, type: 1, amount: 2, account: 3, toAccount: 4 })) w.document.querySelector('[data-cm="' + name + '"]').value = String(value)
  w.document.querySelector('#cmGo').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(w.document.querySelector('#sheet').textContent, /转账 1/)
  w.document.querySelector('#impRun').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].account_id, 1)
  assert.equal(writes[0].to_account_id, 2)
  assert.equal(writes[0].txn_type, 'transfer')
})

test('user can import a selected uncertain match while another duplicate stays excluded', async t => {
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
  assert.match(w.document.querySelector('#sheet').textContent, /疑似重复/)
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
  assert.match(w.document.querySelector('#sheet').textContent, /零钱通\s*→\s*银行卡/)
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  assert.equal(w.document.querySelector('[data-account-map]').value, '7')
  w.DB.state.sourceId = 'library-b'
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  assert.equal(w.document.querySelector('[data-account-map]').value, '')
  w.DB.state.sourceId = 'library-a'
  accounts.length = 0
  await w.LedgerCsv.openImportPreview({ rows: makeRows(), report: {} }, '测试.csv')
  assert.match(w.document.querySelector('#sheet').textContent, /原映射账户已不存在/)
  assert.equal(w.document.querySelector('#impRun').disabled, true)
  assert.equal(writes.length, 1)
})

test('unknown or absent payment method requires choosing an existing account', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [{ id: 7, name: '银行卡' }],
    listTransactions: async () => ({ rows: [] }), addTransaction: async r => { writes.push(r); return { id: 1 } } }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const csv = '交易时间,收/支,金额,支付方式,商品\n2026-10-28,支出,10,神秘支付,午餐\n2026-10-28,支出,20,,晚餐'
  const parsed = w.LedgerCsv.parseCsvText(csv)
  assert.equal(parsed.rows[0].accountName, '神秘支付')
  assert.equal(parsed.rows[0].accountSourceRaw, '神秘支付')
  await assert.rejects(w.LedgerCsv.importCsvText(csv), /确认.*账户/)
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  assert.equal(w.document.querySelector('#impRun').disabled, true)
  const selectors = [...w.document.querySelectorAll('[data-account-map]')]
  assert.equal(selectors.length, 2)
  selectors.forEach(s => { s.value = '7'; s.dispatchEvent(new w.Event('change')) })
  assert.equal(w.document.querySelector('#impRun').disabled, false)
  w.document.querySelector('#impRun').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(writes.map(r => r.account_id), [7, 7])
})

test('existing merchant order number is reviewable instead of silently skipped', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [],
    listTransactions: async () => ({ rows: [{ book_id: 1, txn_type: 'expense', amount: 10, occurred_at: '2026-10-28T12:00:00', note: '旧记录', _ord: 'M1' }] }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,商户单号\n2026-10-28,支出,20,M1')
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  assert.ok(w.document.querySelector('[data-import-uncertain="0"]'))
})

test('matching transaction number with a different amount is reviewable', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [],
    listTransactions: async () => ({ rows: [{ book_id: 1, txn_type: 'expense', amount: 10, occurred_at: '2026-10-28T12:00:00', note: '旧记录', _ord: 'T1' }] }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,交易单号\n2026-10-28,支出,20,T1')
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  assert.ok(w.document.querySelector('[data-import-uncertain="0"]'))
})

test('direct import stops when account or book changes during duplicate lookup', async t => {
  const dom = new JSDOM('', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, writes = []
  let resolveLookup, book = 1
  w.DB = { mode: 'guest', state: { sourceId: 'a', categories: [] }, currentBookId: () => book, defaultBookId: () => 1,
    listTransactions: () => new Promise(resolve => { resolveLookup = resolve }), addTransaction: async row => { writes.push(row) } }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const task = w.LedgerCsv.importCsvText('日期,类型,金额,备注\n2026-10-28,支出,10,咖啡')
  book = 2
  resolveLookup({ rows: [] })
  await assert.rejects(task, /账本|账号/)
  assert.equal(writes.length, 0)
})

test('account and category mapping cannot change while an import is running or being retried', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.App = { refresh: async () => {} }
  let rejectSave
  const save = new Promise((_, reject) => { rejectSave = reject })
  w.DB = { mode: 'guest', state: { sourceId: 'test', categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [{ id: 2, name: '餐饮' }],
    allAccounts: () => [{ id: 1, name: '微信' }],
    category: () => null, listTransactions: async () => ({ rows: [] }),
    addCategory: async () => ({ id: 2 }), addTransaction: async () => save }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const rows = [{ type: 'expense', amount: 10, occurred: '2026-10-28T12:00:00', note: '午餐', accountName: '微信', categoryName: '餐费' }]
  await w.LedgerCsv.openImportPreview({ rows, report: {} }, '测试.csv')
  const account = w.document.querySelector('[data-account-map]'), category = w.document.querySelector('[data-map]')
  w.document.querySelector('#impRun').click()
  assert.equal(account.disabled, true)
  assert.equal(category.disabled, true)
  rejectSave(new Error('网络故障'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(account.disabled, true)
  assert.equal(category.disabled, true)
  assert.match(w.document.querySelector('#impErr').textContent, /重试/)
})
