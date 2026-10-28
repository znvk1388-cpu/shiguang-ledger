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
  let writes = 0
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener() {} })
    return nodes.get(id)
  }
  const context = {
    window: {}, Date: FixedDate,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    ic: () => '', prompt: () => promptValue, setTimeout: () => {},
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
    allAccounts: () => accounts,
    accountBalances: async () => balances,
    listRecurring: async () => rules,
    listTransactions: async () => ({ rows: transactions }),
    category: () => null, categoryName: () => '', accountName: () => '',
    budgetOf: () => 1000, monthlySummary: async () => [],
    addTransaction: async () => { writes++; throw new Error('Unexpected transaction write') },
  }
  context.window.UI = {
    openSheet: value => { html = value }, closeSheet() {}, toast() {},
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
