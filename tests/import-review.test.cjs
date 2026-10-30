const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

test('account mapping is required only for rows selected for import', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { sourceId: 'a', categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [{ id: 7, name: '现金' }], accountName: () => '现金',
    listTransactions: async () => ({ rows: [{ id: 1, book_id: 1, txn_type: 'expense', amount: 16, occurred_at: '2026-10-28T10:00:00', note: '重复', tags: ['_ord:ABC'] }], total: 1 }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,账户,备注,交易单号\n2026-10-28,支出,16,未知方式,重复,ABC\n2026-10-28,支出,20,现金,正常,XYZ')
  parsed.rows[0].accountNeedsConfirm = true
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  const button = w.document.querySelector('#impRun')
  const unknown = [...w.document.querySelectorAll('[data-account-map]')].find(x => x.parentElement.textContent.includes('未知方式'))
  assert.ok(unknown)
  assert.equal(button.disabled, false, '跳过的重复记录不应阻止导入其他记录')
  const checkbox = w.document.querySelector('[data-import-uncertain]')
  checkbox.checked = true
  checkbox.dispatchEvent(new w.Event('change', { bubbles: true }))
  assert.equal(button.disabled, true, '选择导入未知账户时必须先映射')
  unknown.value = '7'
  unknown.dispatchEvent(new w.Event('change', { bubbles: true }))
  assert.equal(button.disabled, false)
})

test('duplicate review shows matching existing records for comparison without exposing other books', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { sourceId: 'a', categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    bookName: () => '日常', rootCategories: () => [], allAccounts: () => [], accountName: () => '银行卡',
    listTransactions: async () => ({ rows: [
      { id: 1, book_id: 1, txn_type: 'expense', amount: 15, occurred_at: '2026-10-28T10:00:00', note: '<原记录>', tags: ['_ord:ABC'] },
      { id: 2, book_id: 2, txn_type: 'expense', amount: 15, occurred_at: '2026-10-28T10:00:00', note: '别的账本', tags: ['_ord:ABC'] },
      { id: 3, book_id: 1, txn_type: 'expense', amount: 15, occurred_at: '2026-10-28T10:00:00', note: '已删除账目', deleted_at: '2026-10-29', tags: ['_ord:ABC'] },
    ], total: 3 }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,账户,备注,交易单号\n2026-10-28 11:00,支出,16,微信,新记录,ABC')
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  const sheet = w.document.querySelector('#sheet')
  assert.match(sheet.textContent, /已有账目/)
  assert.match(sheet.textContent, /<原记录>/)
  assert.match(sheet.textContent, /银行卡/)
  assert.doesNotMatch(sheet.textContent, /别的账本/)
  assert.doesNotMatch(sheet.textContent, /已删除账目/)
  assert.equal(sheet.querySelector('原记录'), null)
  assert.equal(sheet.querySelector('[data-import-uncertain]').checked, false)
  w.Fmt.privacy = () => true
  await w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  assert.match(w.document.querySelector('details.small').textContent, /\*\*\*\*/)
  assert.doesNotMatch(w.document.querySelector('details.small').textContent, /15\.00/)
  assert.doesNotMatch(w.document.querySelector('#sheet').textContent, /16\.00/)
})

test('duplicate candidates are not shown after identity changes during lookup', async t => {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  let release
  w.ic = () => ''
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.DB = { mode: 'guest', state: { sourceId: 'a', categories: [] }, currentBookId: () => 1, defaultBookId: () => 1,
    listTransactions: () => new Promise(resolve => { release = resolve }) }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const parsed = w.LedgerCsv.parseCsvText('日期,类型,金额,备注,交易单号\n2026-10-28,支出,10,早餐,ABC')
  const work = w.LedgerCsv.openImportPreview(parsed, '测试.csv')
  w.DB.state.sourceId = 'b'
  release({ rows: [{ id: 1, book_id: 1, txn_type: 'expense', amount: 10, occurred_at: '2026-10-28', note: '隐私记录', tags: ['_ord:ABC'] }], total: 1 })
  await work
  assert.doesNotMatch(w.document.querySelector('#sheet').textContent, /隐私记录/)
})

test('import reports review registration failure without claiming the saved transaction failed', async t => {
  const dom = new JSDOM('', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.DB = { mode: 'guest', state: { sourceId: 'a' }, currentBookId: () => 1,
    allAccounts: () => [], rootCategories: () => [], addTransaction: async () => ({ id: 10 }) }
  w.Lazy = { need: async () => ({ add() { throw new Error('保存待确认名单失败') } }) }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const result = await w.LedgerCsv.commitRows([{ type: 'expense', amount: 10, occurred: '2026-10-28', note: 'test' }])
  assert.equal(result.ok, 1)
  assert.match(result.reviewWarning, /待确认/)
})

test('partial import failure registers the successful rows for review', async t => {
  const dom = new JSDOM('', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, added = []
  let count = 0
  w.DB = { mode: 'guest', state: { sourceId: 'a' }, currentBookId: () => 1,
    allAccounts: () => [], rootCategories: () => [], addTransaction: async () => { if (++count === 2) throw Error('写入失败'); return { id: 10 } } }
  w.Lazy = { need: async () => ({ add(ids) { added.push(...ids) } }) }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const rows = [1, 2].map(() => ({ type: 'expense', amount: 10, occurred: '2026-10-28', note: 'test' }))
  await assert.rejects(w.LedgerCsv.commitRows(rows), /写入失败/)
  assert.deepEqual(added, [10])
})

test('import does not add pending IDs to a new identity after lazy loading', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, added = []
  let release, started
  const loading = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  w.DB = { mode: 'guest', state: { sourceId: 'source-a' }, currentBookId: () => 1,
    allAccounts: () => [], rootCategories: () => [], addTransaction: async () => ({ id: 123 }) }
  w.Lazy = { need: () => { started(); return loading } }
  for (const file of ['js/format.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const work = w.LedgerCsv.commitRows([{ type: 'expense', amount: 10, occurred: '2026-10-28', note: 'test' }])
  await entered
  w.DB.state.sourceId = 'source-b'
  release({ add: ids => added.push(...ids) })
  await work
  assert.deepEqual(added, [])
})

test('all invalid rows retain visible diagnostics and allow selecting another file', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  let selectors = 0
  w.HTMLInputElement.prototype.click = function () { selectors++ }
  w.LedgerCsv.importCsv()
  const input = w.document.querySelector('input[type=file]')
  Object.defineProperty(input, 'files', { value: [{ name: '<坏账单>.csv', text: async () => '日期,类型,金额\n错误,支出,12\n2026-10-29,支出,无效' }] })
  input.dispatchEvent(new w.Event('change'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(w.document.querySelector('#sheet').textContent, /第 2 条.*日期无效/)
  assert.match(w.document.querySelector('#sheet').textContent, /第 3 条/)
  assert.equal(w.document.querySelector('#sheet img'), null)
  w.document.querySelector('#emptyImportAgain').click()
  assert.equal(selectors, 2)
})

test('column mapping shows failed row numbers without losing selected mapping', () => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  try {
    const w = dom.window
    w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
    for (const file of ['js/format.js', 'js/vendor/papaparse.min.js', 'js/csv.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    w.LedgerCsv.openColumnMap('日期列,金额列\n错误,12', '测试.csv')
    w.document.querySelector('[data-cm="date"]').value = '0'
    w.document.querySelector('[data-cm="amount"]').value = '1'
    w.document.querySelector('#cmGo').click()
    assert.match(w.document.querySelector('#sheet').textContent, /第 2 条.*日期无效/)
    assert.equal(w.document.querySelector('[data-cm="date"]').value, '0')
  } finally { dom.window.close() }
})

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
