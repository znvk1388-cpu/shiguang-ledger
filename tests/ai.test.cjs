'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
function setup(t, options = {}) {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://ledger.test/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  const NativeDate = w.Date
  w.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-28T12:00:00Z'])) }
    static now() { return new NativeDate('2026-10-28T12:00:00Z').getTime() }
  }
  const accounts = [
    { id: 1, name: '微信', currency: 'CNY' },
    { id: 2, name: '美元账户', currency: 'USD' },
  ]
  const categories = [
    { id: 10, name: '餐饮', kind: 'expense' },
    { id: 11, name: '交通', kind: 'expense' },
    { id: 20, name: '工资', kind: 'income' },
  ]
  const rows = options.rows || []
  const writes = [], toasts = [], queries = []
  const charts = { line: points => { charts.points = points; return '<div>trend</div>' }, barList: items => { charts.items = items; return '<div>bars</div>' } }
  w.ic = () => ''
  w.Lazy = { need: async () => charts }
  w.App = { state: { year: 2026, month: 10 }, refresh() {} }
  w.APP_INFO = { appName: '拾光记账', operator: '测试', contact: 'test@example.com' }
  w.UI = {
    $: selector => w.document.querySelector(selector),
    openSheet: html => { const s = w.document.getElementById('sheet'); s.innerHTML = html; s.setAttribute('aria-hidden', 'false') },
    closeSheet: () => w.document.getElementById('sheet').setAttribute('aria-hidden', 'true'),
    toast: message => toasts.push(message),
  }
  w.DB = {
    mode: 'guest', state: { categories },
    accounts: () => accounts, allAccounts: () => accounts,
    category: id => categories.find(c => c.id === id),
    categoryName: id => (categories.find(c => c.id === id) || {}).name || '未分类',
    accountName: id => (accounts.find(a => a.id === id) || {}).name || '',
    rootCategories: () => categories.filter(c => c.kind === 'expense'),
    childCategories: () => [],
    listTransactions: async q => {
      queries.push(q)
      return { rows: rows.filter(r => (!q.from || new Date(r.occurred_at) >= new Date(q.from)) &&
        (!q.to || new Date(r.occurred_at) < new Date(q.to)) &&
        (!q.type || r.txn_type === q.type) &&
        (!q.accountId || r.account_id === q.accountId || r.to_account_id === q.accountId)) }
    },
    addTransaction: async row => { writes.push(row); return { ...row, id: writes.length } },
    budgetOf: () => 100000,
    accountBalances: async () => accounts.map(account => ({ account, balance: 10000 })),
    listRecurring: async () => [],
  }
  const load = name => w.eval(fs.readFileSync(path.join(root, 'js', name), 'utf8'))
  load('format.js'); load('ai.js'); load('ask.js'); load('insight.js')
  return { w, accounts, categories, rows, writes, toasts, queries, charts, load }
}
const plain = value => JSON.parse(JSON.stringify(value))
const item = patch => ({
  type: 'expense', amount: 10, currency: 'CNY', date: '2026-10-28', time: '12:00',
  category: '餐饮', account: '微信', note: '午餐', tags: [], ...patch,
})
const multiple = items => ({
  status: 'multiple', type: null, amount: null, currency: null, date: null, time: null,
  category: null, account: null, to_account: null, note: '多笔支出', tags: [], confidence: 0.99,
  reason: '原文有明确金额', is_refund: false, review: [], items,
})
const transaction = patch => ({
  id: 1, txn_type: 'expense', amount: 100, account_id: 1, category_id: 10,
  occurred_at: '2026-10-15T12:00:00Z', note: '午餐', tags: [], ...patch,
})
async function settle(predicate = () => true) {
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setImmediate(resolve))
    if (predicate()) return
  }
  assert.fail('UI did not settle')
}
async function recognise(ctx, data) {
  const { w } = ctx
  w.Cloud = { chat: async () => JSON.stringify(data) }
  w.AI.openAiSheet()
  w.document.getElementById('aiText').value = '微信支出两笔'
  w.document.getElementById('aiRun').click()
  await settle(() => !!w.document.getElementById('aiBatch'))
}

test('AI actual review and batch click show mismatched currency and only write valid rows', async t => {
  const ctx = setup(t)
  await recognise(ctx, multiple([item({ currency: 'USD', note: '美元午餐' }), item({ amount: 20 })]))
  const { w, writes } = ctx
  assert.match(w.document.querySelector('#aiReview .err').textContent, /币种与账户不符/)
  assert.match(w.document.getElementById('aiReview').textContent, /USD 10/)
  assert.equal(w.document.getElementById('aiBatch').textContent, '确认记入 1 笔')
  w.document.getElementById('aiBatch').click()
  await settle(() => writes.length === 1 && w.document.getElementById('sheet').getAttribute('aria-hidden') === 'true')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].amount, 20)
  assert.equal(writes[0].account_id, 1)
})

test('AI batch mapper rejects invalid currency, stale account/category, fractional cents and invalid dates', t => {
  const { w, accounts, categories } = setup(t)
  const valid = w.AI.validateResult(multiple([item()])).data.items[0]
  const variants = [
    { currency: 'USD' }, { currency: 'XYZ' }, { currency: {} }, { accountId: 999 },
    { categoryId: 20 }, { amount: 1.001 }, { amount: -1 }, { date: '2026-02-30' },
    { time: '24:00' }, { type: 'transfer' },
  ]
  for (const patch of variants) {
    const result = w.AI.mapItemsToRows([{ ...valid, ...patch }])
    assert.equal(result.rows.length, 0, JSON.stringify(patch))
    assert.equal(result.blocked.length, 1)
  }
  assert.equal(w.AI.mapItemsToRows([valid]).rows.length, 1)
  const normalized = w.AI.mapItemsToRows([{ ...valid, date: '2026/1/2', time: '9:30' }]).rows[0]
  assert.match(normalized.occurred_at, /^2026-01-02T09:30:00/)
  accounts.splice(0, 1)
  assert.equal(w.AI.mapItemsToRows([valid]).rows.length, 0)
  accounts.unshift({ id: 1, name: '微信', currency: 'CNY' })
  categories.splice(0, 1)
  assert.equal(w.AI.mapItemsToRows([valid]).rows.length, 0)
})

test('AI batch click revalidates after account currency changes and refreshes the review', async t => {
  const ctx = setup(t)
  await recognise(ctx, multiple([item()]))
  ctx.accounts[0].currency = 'USD'
  ctx.w.document.getElementById('aiBatch').click()
  await settle()
  assert.equal(ctx.writes.length, 0)
  assert.match(ctx.w.document.getElementById('aiErr').textContent, /已变化/)
  assert.equal(ctx.w.document.getElementById('aiBatch').disabled, true)
  assert.match(ctx.w.document.querySelector('#aiReview .err').textContent, /币种与账户不符/)
})

test('AI single draft cannot bypass mismatched currency or cross-currency transfer checks', t => {
  const { w } = setup(t)
  const draft = w.AI.mapAiToDraft(item({ currency: 'USD' }))
  assert.equal(draft.accountId, null)
  assert.equal(draft.amount, '')
  assert.match(draft.aiReviewIssues.join(' '), /币种与账户不同/)
  const transfer = w.AI.mapAiToDraft(item({ type: 'transfer', to_account: '美元账户' }))
  assert.equal(transfer.toAccountId, null)
  assert.equal(transfer.amount, '')
})

test('AI missing currency remains an explicit review warning and invalid dates cannot batch-save', async t => {
  const ctx = setup(t)
  await recognise(ctx, multiple([item({ currency: null }), item({ date: '2026-02-30' })]))
  assert.match(ctx.w.document.getElementById('aiReview').textContent, /币种未明确/)
  assert.match(ctx.w.document.querySelector('#aiReview .err').textContent, /日期无效/)
  assert.equal(ctx.w.document.getElementById('aiBatch').textContent, '确认记入 1 笔')
})

test('AI question snapshot converts aggregate money and preserves original units without expanding detail upload', async t => {
  const rows = Array.from({ length: 10 }, (_, i) => transaction({
    id: i + 1, amount: 100, account_id: i % 2 ? 2 : 1,
    occurred_at: '2026-10-' + String(i + 1).padStart(2, '0') + 'T12:00:00Z',
    note: '这是一条用于验证只发送前二十字的很长很长很长的备注',
  }))
  const { w, queries } = setup(t, { rows })
  const snapshot = await w.Ask.buildSnapshot(new w.Date())
  assert.equal(snapshot.base_currency, 'CNY')
  assert.equal(snapshot.monthly.length, 12)
  assert.match(queries[0].from, /^2025-11-01/)
  assert.equal(snapshot.monthly.find(m => m.month === '2026-10').expense, 4100)
  assert.equal(snapshot.top_expense_categories['2026-10'][0].amount, 4100)
  assert.equal(snapshot.budget.spent, 4100)
  assert.equal(snapshot.recent.length, 8)
  assert.ok(snapshot.recent.every(r => r.note.length <= 20))
  assert.equal(snapshot.recent[0].currency, 'USD')
  assert.equal(snapshot.recent[0].amount, 100)
  assert.equal(snapshot.recent[0].base_amount, 720)
  assert.deepEqual(plain(snapshot.accounts[1]), { name: '美元账户', balance: 100, currency: 'USD', base_balance: 720 })
  assert.match(w.Ask.SYSTEM, /禁止把不同原币金额直接相加/)
  w.Fmt.setBaseCurrency('USD')
  const usd = await w.Ask.buildSnapshot(new w.Date())
  assert.equal(usd.base_currency, 'USD')
  assert.equal(usd.monthly.find(m => m.month === '2026-10').expense, 569.45)
})

test('AI ask sends the corrected snapshot and at most the previous three question turns', async t => {
  const { w } = setup(t, { rows: [transaction({ account_id: 2, amount: 100 })] })
  let request
  w.Cloud = { chat: async messages => { request = messages; return '本月支出 CNY 720.00。' } }
  const history = Array.from({ length: 5 }, (_, i) => ({ q: 'q' + i, a: 'a' + i }))
  const answer = await w.Ask.ask('这个月花了多少', null, history)
  assert.equal(answer.error, undefined)
  const payload = request[1].content
  const snapshot = JSON.parse(payload.match(/<ledger_data>\n([\s\S]+?)\n<\/ledger_data>/)[1])
  assert.equal(snapshot.monthly.find(m => m.month === '2026-10').expense, 720)
  assert.equal(snapshot.recent[0].currency, 'USD')
  assert.match(payload, /q2/)
  assert.doesNotMatch(payload, /q0|q1/)
})

test('consumption insights convert totals, recurring expenses, thresholds and ranking to base currency', async t => {
  const rows = [
    transaction({ id: 1, account_id: 2, amount: 100, note: '美元大额' }),
    transaction({ id: 2, account_id: 1, amount: 500, category_id: 11, note: '人民币交通' }),
    ...Array.from({ length: 5 }, (_, i) => transaction({ id: i + 3, account_id: 2, amount: 10, note: '美元小额' })),
  ]
  const { w } = setup(t, { rows })
  w.DB.listRecurring = async () => [
    { txn_type: 'expense', account_id: 2, amount: 5, freq: 'monthly', note: '美元订阅' },
    { txn_type: 'transfer', account_id: 2, amount: 1000, freq: 'monthly', note: '本人转账' },
  ]
  await w.Insight.openAudit()
  const body = w.document.getElementById('auBody')
  assert.match(body.textContent, /总支出¥1,580.00/)
  assert.match(body.textContent, /美元订阅¥36.00\/月/)
  assert.doesNotMatch(body.textContent, /本人转账|高频小额聚集区/)
  const ranking = Array.from(body.querySelectorAll('.card')).find(c => c.textContent.includes('大额支出 Top'))
  assert.match(ranking.querySelector('.kv').textContent, /美元大额.*¥720.00/)
  w.Fmt.setBaseCurrency('USD')
  await w.Insight.openAudit()
  assert.match(w.document.getElementById('auBody').textContent, /总支出\$219.44/)
})

test('category trend and tag report use converted values', async t => {
  const { w, charts } = setup(t, { rows: [
    transaction({ amount: 100, account_id: 1, tags: ['日常'] }),
    transaction({ id: 2, amount: 100, account_id: 2, tags: ['日常'] }),
  ] })
  await w.Insight.openCatTrend()
  assert.equal(charts.points.reduce((sum, p) => sum + p.value, 0), 82000)
  await w.Insight.openTagReport()
  assert.equal(charts.items[0].value, 82000)
})

test('statement date changes update totals and rows together in account currency and export the currency', async t => {
  const { w } = setup(t, { rows: [
    transaction({ id: 1, txn_type: 'income', account_id: 2, amount: 40, occurred_at: '2026-10-05T12:00:00Z' }),
    transaction({ id: 2, account_id: 2, amount: 10, occurred_at: '2026-10-20T12:00:00Z' }),
  ] })
  let exported
  w.Blob = Blob
  w.URL.createObjectURL = blob => { exported = blob; return 'blob:test' }
  w.URL.revokeObjectURL = () => {}
  w.HTMLAnchorElement.prototype.click = function () {}
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  await w.Insight.openStatement(2)
  assert.equal(w.document.getElementById('stInflow').textContent, '$40.00')
  assert.equal(w.document.getElementById('stOutflow').textContent, '$10.00')
  assert.equal(w.document.getElementById('stCount').textContent, '2')
  assert.equal(w.document.getElementById('stTo').value, '2026-10-31')
  assert.match(w.document.querySelector('.sheet-title').textContent, /USD/)
  w.document.getElementById('stFrom').value = '2026-10-10'
  w.document.getElementById('stFrom').dispatchEvent(new w.Event('change'))
  await settle(() => w.document.getElementById('stCount').textContent === '1')
  assert.equal(w.document.getElementById('stInflow').textContent, '$0.00')
  assert.equal(w.document.getElementById('stOutflow').textContent, '$10.00')
  assert.equal(w.document.getElementById('stBody').querySelectorAll('.kv').length, 1)
  w.document.getElementById('stCsv').click()
  const csv = await exported.text()
  assert.match(csv, /金额,币种/)
  assert.match(csv, /"10","USD"/)
  assert.doesNotMatch(csv, /"40"/)
})

test('statement ignores an older date request that completes after the latest one', async t => {
  const { w } = setup(t)
  await w.Insight.openStatement(2)
  const pending = []
  w.DB.listTransactions = () => new Promise(resolve => pending.push(resolve))
  const from = w.document.getElementById('stFrom')
  from.value = '2026-10-02'; from.dispatchEvent(new w.Event('change'))
  from.value = '2026-10-03'; from.dispatchEvent(new w.Event('change'))
  pending[1]({ rows: [transaction({ account_id: 2, amount: 8 })] })
  await settle(() => w.document.getElementById('stOutflow').textContent === '$8.00')
  pending[0]({ rows: [transaction({ account_id: 2, amount: 99 })] })
  await settle()
  assert.equal(w.document.getElementById('stOutflow').textContent, '$8.00')
  assert.equal(w.document.getElementById('stCount').textContent, '1')
})

test('privacy policy and AI ask UI disclose the actual aggregates and detail limits in guest mode', t => {
  const ctx = setup(t)
  ctx.load('legal.js')
  const html = ctx.w.Legal.privacyHtml()
  assert.match(html, /AI 问账/)
  assert.match(html, /近 12 个月/)
  assert.match(html, /最近 8 笔/)
  assert.match(html, /备注前 20 字/)
  assert.match(html, /最近 3 轮问答/)
  assert.doesNotMatch(html, /我们未获取任何数据|我们不会收到任何数据/)
  ctx.w.Ask.openAskSheet()
  assert.match(ctx.w.document.getElementById('sheet').textContent, /最近 8 笔/)
})

