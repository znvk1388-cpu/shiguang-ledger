'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const fixedNow = new Date(2026, 9, 28, 12).getTime()
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])) }
  static now() { return fixedNow }
}

function harness({ accounts = [], balances = [], rules = [], transactions = [], base = 'CNY' } = {}) {
  const storage = new Map([['ledger10_base', base]])
  const nodes = new Map()
  const buttons = new Map()
  let html = ''
  let promptValue = ''
  let promptHook = () => {}
  let writes = 0
  let storageFail = false
  let message = ''
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener() {} })
    return nodes.get(id)
  }
  const context = {
    window: {}, Date: FixedDate,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => { if (storageFail && key.startsWith('ledger10_reimb_v2:')) throw Error('quota'); storage.set(key, value) },
      removeItem: key => storage.delete(key),
    },
    ic: () => '', prompt: text => { promptHook(text); return promptValue }, setTimeout: () => {},
    document: {
      getElementById: node,
      querySelector: node,
      querySelectorAll: selector => {
        const match = /^\[data-reimb-(part|done|undo)\]$/.exec(selector)
        if (!match) return []
        return transactions.map(t => {
          const key = match[1] + ':' + t.id
          if (!buttons.has(key)) buttons.set(key, { getAttribute: () => String(t.id) })
          return buttons.get(key)
        })
      },
    },
  }
  context.window.DB = {
    mode: 'guest', state: { sourceId: 'library-a' },
    allAccounts: () => accounts,
    accountBalances: async () => balances,
    listRecurring: async () => rules,
    listTransactions: async () => ({ rows: transactions }),
    category: () => null, categoryName: () => '', accountName: () => '',
    budgetOf: () => 1000, monthlySummary: async () => [],
    addTransaction: async () => { writes++; throw new Error('Unexpected transaction write') },
  }
  context.window.UI = {
    openSheet: value => { html = value }, closeSheet() {}, toast(value) { message = value },
  }
  context.window.App = { state: {} }
  context.window.TXN_TYPE_LABEL = { income: '收入', expense: '支出', transfer: '转账' }
  vm.createContext(context)
  for (const file of ['format.js', 'reimb.js', 'wealth.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context, { filename: file })
  }
  return {
    window: context.window,
    html: () => html,
    writes: () => writes,
    message: () => message,
    failStorage: () => { storageFail = true },
    onPrompt: fn => { promptHook = fn },
    storage,
    click: (kind, id) => buttons.get(kind + ':' + id).onclick(),
    receive: async (id, amount) => {
      await context.window.Reimb.openPanel()
      promptValue = String(amount)
      buttons.get('part:' + id).onclick()
    },
  }
}

const claim = () => ({ id: 1, amount: 100, reimbursable: true, occurred_at: '2026-10-28T00:00:00Z' })
const recurring = (fields = {}) => Object.assign({
  active: true, amount: 10, txn_type: 'expense', account_id: 1,
  start_date: '2026-10-28', freq: 'monthly', note: '周期账目',
}, fields)

test('privacy hides reimbursement amounts in summary, details and legacy entries', async () => {
  const t = claim(), h = harness({ transactions: [t] })
  h.storage.set('ledger10_privacy', '1')
  h.storage.set('ledger10_reimb', JSON.stringify({ 10: { status: 'partial', received: 3000, expect: 2000 } }))
  h.window.Reimb.set(t.id, { status: 'partial', received: 4000 })
  await h.window.Reimb.openPanel()
  assert.doesNotMatch(h.html(), /100\.00|60\.00|40\.00|30\.00|20\.00/)
  assert.match(h.html(), /\*\*\*\*/)
  let promptText = ''
  h.onPrompt(text => { promptText = text })
  await h.receive(t.id, 80)
  assert.doesNotMatch(promptText, /100\.00/)
  assert.match(promptText, /\*\*\*\*/)
  assert.doesNotMatch(h.message(), /60\.00/)
})

test('reimbursement displays yuan and accumulates successive receipts of 30 + 20', async () => {
  const t = claim()
  const h = harness({ transactions: [t] })
  await h.window.Reimb.openPanel()
  assert.match(h.html(), /reimb-line1"><b class="num">¥100\.00<\/b>/)
  await h.receive(t.id, 30)
  assert.equal(h.window.Reimb.outstandingCents(t), 7000)
  await h.receive(t.id, 20)
  assert.equal(h.window.Reimb.get(t.id).received, 5000)
  assert.equal(h.window.Reimb.statusOf(t), 'partial')
  assert.equal(h.window.Reimb.outstandingCents(t), 5000)
  assert.equal(h.writes(), 0)
})

test('reimbursement receipts of 40 + 60 settle the claim without creating transactions', async () => {
  const t = claim()
  const h = harness({ transactions: [t] })
  await h.receive(t.id, 40)
  await h.receive(t.id, 60)
  assert.equal(h.window.Reimb.get(t.id).received, 10000)
  assert.equal(h.window.Reimb.statusOf(t), 'done')
  assert.equal(h.window.Reimb.outstandingCents(t), 0)
  const summary = await h.window.Reimb.summary()
  assert.equal(summary.doneCount, 1)
  assert.equal(summary.outstanding, 0)
  assert.equal(h.writes(), 0)
})

test('negative and non-finite reimbursement inputs cannot replace prior receipts', async () => {
  const t = claim()
  const h = harness({ transactions: [t] })
  await h.receive(t.id, 30)
  await h.receive(t.id, '-20')
  await h.receive(t.id, 'Infinity')
  assert.equal(h.window.Reimb.get(t.id).received, 3000)
  assert.equal(h.window.Reimb.outstandingCents(t), 7000)
})

test('reimbursement rejects a receipt exceeding remaining amount without altering prior state', async () => {
  const t = claim(), h = harness({ transactions: [t] })
  await h.receive(t.id, 30)
  await h.receive(t.id, 80)
  assert.equal(h.window.Reimb.get(t.id).received, 3000)
  assert.equal(h.window.Reimb.statusOf(t), 'partial')
  assert.match(h.message(), /超过|最多/)
})

test('reimbursement reports storage failure without showing successful update', async () => {
  const t = claim(), h = harness({ transactions: [t] })
  await h.receive(t.id, 30)
  h.failStorage()
  await h.receive(t.id, 20)
  assert.equal(h.window.Reimb.get(t.id).received, 3000)
  assert.match(h.message(), /保存失败/)
})

test('reimbursement overlays are isolated by source and never adopt unowned legacy records', () => {
  const t = claim(), h = harness({ transactions: [t] }), db = h.window.DB
  h.storage.set('ledger10_reimb', JSON.stringify({ '1': { status: 'done' } }))
  assert.equal(h.window.Reimb.statusOf(t), 'pending')
  h.window.Reimb.set(1, { status: 'partial', received: 3000 })
  db.state.sourceId = 'library-b'
  assert.equal(h.window.Reimb.statusOf(t), 'pending')
  db.mode = 'cloud'; db.state.uid = 'library-a'
  assert.equal(h.window.Reimb.statusOf(t), 'pending')
  db.state.uid = ''
  assert.throws(() => h.window.Reimb.set(1, { status: 'done' }), /身份/)
  assert.ok(h.storage.has('ledger10_reimb'))
})

test('corrupt reimbursement storage cannot be silently overwritten', () => {
  const h = harness(), key = 'ledger10_reimb_v2:' + encodeURIComponent(JSON.stringify(['guest', 'library-a']))
  h.storage.set(key, '{broken')
  assert.throws(() => h.window.Reimb.set(1, { status: 'done' }), /读取报销进度失败/)
  assert.equal(h.storage.get(key), '{broken')
})

test('legacy reimbursement entries are shown read-only and escaped without adopting them', async () => {
  const h = harness({ transactions: [claim()] })
  const raw = JSON.stringify({ '<img>': { status: 'partial', received: 3000, expect: 8000 }, '1': { status: 'done' } })
  h.storage.set('ledger10_reimb', raw)
  await h.window.Reimb.openPanel()
  assert.match(h.html(), /旧版.*报销/)
  assert.match(h.html(), /&lt;img&gt;/)
  assert.match(h.html(), /30\.00/)
  assert.match(h.html(), /80\.00/)
  assert.equal(h.window.Reimb.statusOf(claim()), 'pending')
  assert.equal(h.storage.get('ledger10_reimb'), raw)
})

test('old reimbursement panel cannot write to a newly selected account', async () => {
  const h = harness({ transactions: [claim()] })
  await h.window.Reimb.openPanel()
  h.window.DB.state.sourceId = 'library-b'
  h.click('done', 1)
  assert.equal(h.window.Reimb.statusOf(claim()), 'pending')
  assert.match(h.message(), /切换/)
})

test('switching identity while entering reimbursement amount prevents writing to new source', async () => {
  const h = harness({ transactions: [claim()] })
  h.onPrompt(() => { h.window.DB.state.sourceId = 'library-b' })
  await h.receive(1, 30)
  assert.equal(h.window.Reimb.statusOf(claim()), 'pending')
  assert.match(h.message(), /切换/)
})

test('switching identity while loading reimbursement list prevents opening stale panel', async () => {
  const h = harness({ transactions: [claim()] })
  let resolve
  h.window.DB.listTransactions = () => new Promise(r => { resolve = r })
  const pending = h.window.Reimb.openPanel()
  h.window.DB.state.sourceId = 'library-b'
  resolve({ rows: [claim()] })
  await pending
  assert.equal(h.html(), '')
  assert.match(h.message(), /切换/)
})

test('forecast converts foreign cash and recurring amounts to CNY and excludes debt balances', async () => {
  const accounts = [
    { id: 1, kind: 'cash', currency: 'CNY' },
    { id: 2, kind: 'cash', currency: 'USD' },
    { id: 3, kind: 'credit', currency: 'USD' },
    { id: 4, kind: 'loan_out', currency: 'CNY' },
  ]
  const h = harness({
    accounts,
    balances: accounts.map((account, i) => ({ account, balance: [10000, 10000, -5000, 999900][i] })),
    rules: [recurring({ account_id: 2, txn_type: 'income', amount: 10 }), recurring({ account_id: 2, amount: 5 })],
  })
  const forecast = await h.window.Wealth.forecastData(30)
  assert.equal(forecast.cash, 82000)
  assert.equal(forecast.inflow, 7200)
  assert.equal(forecast.outflow, 3600)
  assert.equal(forecast.cash + forecast.inflow - forecast.outflow, 85600)
  assert.equal(h.writes(), 0)
})

test('forecast uses non-CNY base currency for cash, schedules, and every displayed amount', async () => {
  const accounts = [{ id: 1, kind: 'cash', currency: 'CNY' }, { id: 2, kind: 'cash', currency: 'USD' }]
  const h = harness({
    accounts, base: 'USD',
    balances: [{ account: accounts[0], balance: 72000 }, { account: accounts[1], balance: 10000 }],
    rules: [recurring({ txn_type: 'income', amount: 72 }), recurring({ account_id: 2, amount: 5 })],
  })
  const forecast = await h.window.Wealth.forecastData(30)
  assert.equal(forecast.cash, 20000)
  assert.equal(forecast.inflow, 1000)
  assert.equal(forecast.outflow, 500)
  await h.window.Wealth.openForecast()
  assert.doesNotMatch(h.html(), /¥/)
  assert.match(h.html(), /30 天后余额<\/span><span class="num">\$205\.00/)
  assert.match(h.html(), /当前可用现金 \$200\.00/)
  assert.match(h.html(), /\+\$10\.00/)
  assert.match(h.html(), /−\$5\.00/)
})

test('recurring transfers affect cash only when crossing the cash-account boundary', async () => {
  const accounts = [
    { id: 1, kind: 'cash', currency: 'CNY' }, { id: 2, kind: 'bank', currency: 'CNY' },
    { id: 3, kind: 'credit', currency: 'CNY' }, { id: 4, kind: 'loan_in', currency: 'CNY' },
    { id: 5, kind: 'cash', currency: 'USD' }, { id: 6, kind: 'loan_in', currency: 'USD' },
    { id: 7, kind: 'loan_out', currency: 'USD' }, { id: 8, kind: 'credit', currency: 'USD' },
  ]
  const transfer = (from, to, amount) => recurring({ txn_type: 'transfer', account_id: from, to_account_id: to, amount })
  const h = harness({
    accounts, balances: accounts.map(account => ({ account, balance: 10000 })),
    rules: [
      transfer(1, 2, 25), transfer(1, 3, 30), transfer(4, 1, 40),
      transfer(5, 6, 10), transfer(7, 5, 20), transfer(8, 7, 15),
      recurring({ account_id: 3, txn_type: 'expense', amount: 50 }),
      recurring({ account_id: 4, txn_type: 'income', amount: 50 }),
    ],
  })
  const forecast = await h.window.Wealth.forecastData(30)
  assert.equal(forecast.cash, 92000)
  assert.equal(forecast.inflow, 18400)
  assert.equal(forecast.outflow, 10200)
  assert.equal(forecast.items[0].dir, 'neutral')
  assert.equal(forecast.items.filter(item => item.dir === 'neutral').length, 4)
  await h.window.Wealth.openForecast()
  assert.match(h.html(), /现金总额不变/)
  assert.match(h.html(), /转入现金/)
  assert.match(h.html(), /转出现金/)
  assert.equal(h.writes(), 0)
})

