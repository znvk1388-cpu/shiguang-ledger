const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

// Exercise the shipped Store, DB facade and Sync functions against an in-memory
// database. Faults can happen before a write or after it commits but before its
// response arrives, which are different failure modes for a replay queue.
async function fixture(initial = {}) {
  const tables = structuredClone({
    books: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
    accounts: [{ id: 1, name: '现金' }, { id: 2, name: '美元', currency: 'USD' }, { id: 3, name: '银行卡', currency: 'CNY' }],
    categories: [], budgets: [], savings_goals: [], transactions: [], recurring_rules: [],
    ...initial,
  })
  const calls = []
  const saved = new Map()
  let serial = 100
  let fault = () => {}

  function from(table) {
    const query = { table, op: 'select', payload: null, conditions: [] }
    const filters = []
    const orders = []
    let range = null
    let limit = null
    const q = {
      select() { return q },
      order(key, options = {}) { orders.push({ key, ascending: options.ascending !== false }); return q },
      eq(key, value) { filters.push(row => row[key] === value); query.conditions.push(['eq', key, value]); return q },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); query.conditions.push(['is', key, value]); return q },
      in(key, values) { filters.push(row => values.includes(row[key])); return q },
      contains(key, values) { filters.push(row => values.every(value => (row[key] || []).includes(value))); query.conditions.push(['contains', key, values]); return q },
      range(first, last) { range = [first, last]; return q },
      limit(value) { limit = value; return q },
      insert(payload) { query.op = 'insert'; query.payload = payload; return q },
      update(payload) { query.op = 'update'; query.payload = payload; return q },
      maybeSingle() { return q.then(result => ({ ...result, data: result.data[0] || null })) },
      then(resolve, reject) {
        return Promise.resolve().then(async () => {
          const event = structuredClone(query)
          calls.push(event)
          await fault('before', event)
          tables[table] ||= []
          let rows = tables[table].filter(row => filters.every(filter => filter(row)))
          if (query.op === 'insert') {
            rows = (Array.isArray(query.payload) ? query.payload : [query.payload]).map(row => ({ id: ++serial, ...structuredClone(row) }))
            tables[table].push(...rows)
          } else if (query.op === 'update') {
            rows.forEach(row => Object.assign(row, structuredClone(query.payload)))
          }
          rows = rows.slice()
          for (const order of orders.slice().reverse()) {
            rows.sort((a, b) => (a[order.key] < b[order.key] ? -1 : a[order.key] > b[order.key] ? 1 : 0) * (order.ascending ? 1 : -1))
          }
          const count = rows.length
          if (range) rows = rows.slice(range[0], range[1] + 1)
          if (limit != null) rows = rows.slice(0, limit)
          await fault('after', event)
          return { data: structuredClone(rows), count }
        }).then(resolve, reject)
      },
    }
    return q
  }

  const context = vm.createContext({
    console, Date, Math, Promise, Map, crypto: webcrypto,
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { onLine: true },
    document: { readyState: 'loading', addEventListener() {}, body: { classList: { contains: () => false } } },
    setTimeout() {}, setInterval() {}, clearInterval() {},
    window: { Cloud: { cloud: { database: { from } } } },
  })
  for (const file of ['format.js', 'store.js', 'db.js', 'sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file })
  }
  const { DB, Store, Sync, Fmt } = context.window
  await DB.useCloud({ user: { id: 'test-user' } })
  Sync.install()
  calls.length = 0
  return { DB, Store, Sync, Fmt, tables, calls, setFault: callback => { fault = callback }, setOnline: online => { context.navigator.onLine = online } }
}

function networkError() { return new Error('NetworkError: simulated connection loss') }

test('budget replay keeps its original book after the active book changes', async () => {
  const f = await fixture()
  f.DB.setActiveBook(1)
  f.setFault((phase, event) => {
    if (phase === 'before' && event.table === 'budgets' && event.op === 'insert') throw networkError()
  })
  await assert.rejects(f.DB.setBudget('2026-10', null, 500), error => error.__queued === true)
  const item = f.Sync.outbox()[0]
  assert.equal(item.args[3], 1)
  f.DB.setActiveBook(2)
  f.setFault(() => {})
  assert.equal((await f.Sync.retryOne(item.id)).ok, true)
  assert.equal(f.tables.budgets.length, 1)
  assert.equal(f.tables.budgets[0].book_id, 1)
  assert.equal(f.tables.budgets[0].amount, 500)
  assert.equal(f.Sync.outboxCount(), 0)
})

test('legacy budget queue entries without a book stay available for review', async () => {
  const f = await fixture()
  const item = f.Sync.enqueue('setBudget', ['2026-10', null, 500], networkError())
  f.DB.setActiveBook(2)
  const result = await f.Sync.retryOne(item.id)
  assert.match(result.error, /原账本/)
  assert.equal(f.tables.budgets.length, 0)
  assert.equal(f.Sync.outbox()[0].state, 'review')
  assert.equal(f.calls.length, 0)
})

test('new operation tags do not mutate the caller payload reused for a rule', async () => {
  const f = await fixture()
  const payload = { txn_type: 'expense', amount: 10, tags: ['日常'] }
  await f.DB.addTransaction(payload)
  await f.DB.addRecurring({ txn_type: payload.txn_type, amount: payload.amount, tags: payload.tags })
  assert.deepEqual(payload.tags, ['日常'])
  const transactionOp = f.tables.transactions[0].tags.find(tag => tag.startsWith('_op:'))
  const ruleOp = f.tables.recurring_rules[0].tags.find(tag => tag.startsWith('_op:'))
  assert.ok(transactionOp)
  assert.ok(ruleOp)
  assert.notEqual(transactionOp, ruleOp)
})

test('an existing operation tag remains identifiable when an insert response is lost', async () => {
  const f = await fixture()
  let lost = false
  f.setFault((phase, event) => {
    if (!lost && phase === 'after' && event.table === 'transactions' && event.op === 'insert') {
      lost = true
      throw networkError()
    }
  })
  await assert.rejects(f.DB.addTransaction({ txn_type: 'expense', amount: 10, tags: ['_op:stable-id'] }), error => error.__queued === true)
  const item = f.Sync.outbox()[0]
  assert.equal(item.opId, 'stable-id')
  f.setFault(() => {})
  assert.equal((await f.Sync.retryOne(item.id)).skipped, true)
  assert.equal(f.tables.transactions.length, 1)
})

for (const interruption of ['lost insert response', 'failed rule watermark update']) {
  test(`recurring replay avoids a duplicate after ${interruption}`, async () => {
    const f = await fixture({ recurring_rules: [{
      id: 10, active: true, txn_type: 'expense', amount: 10,
      start_date: '2026-10-27', last_run_date: '2026-10-27', freq: 'daily',
      tags: ['房租', '_op:original-create', '_ord:original-order'], book_id: 1,
    }] })
    let interrupted = false
    f.setFault((phase, event) => {
      const insertResponse = interruption === 'lost insert response' && phase === 'after' && event.table === 'transactions' && event.op === 'insert'
      const watermark = interruption === 'failed rule watermark update' && phase === 'before' && event.table === 'recurring_rules' && event.op === 'update'
      if (!interrupted && (insertResponse || watermark)) { interrupted = true; throw networkError() }
    })
    const today = new Date(2026, 9, 28, 12)
    await assert.rejects(f.DB.applyRecurring(today), /NetworkError/)
    assert.equal(f.tables.transactions.length, 1)
    assert.deepEqual(f.tables.transactions[0].tags, ['房租', 'auto', '_op:rec:10:2026-10-28'])
    assert.equal(f.tables.recurring_rules[0].last_run_date, '2026-10-27')
    f.setFault(() => {})
    assert.equal(await f.DB.applyRecurring(today), 0)
    assert.equal(f.tables.transactions.length, 1)
    assert.equal(f.tables.recurring_rules[0].last_run_date, '2026-10-28')
  })
}

test('a failed recurring duplicate check does not proceed with an uncertain insert', async () => {
  const f = await fixture({ recurring_rules: [{
    id: 10, active: true, txn_type: 'expense', amount: 10,
    start_date: '2026-10-27', last_run_date: '2026-10-27', freq: 'daily', tags: [],
  }] })
  f.setFault((phase, event) => {
    if (phase === 'before' && event.table === 'transactions' && event.op === 'select') throw networkError()
  })
  await assert.rejects(f.DB.applyRecurring(new Date(2026, 9, 28, 12)), /NetworkError/)
  assert.equal(f.tables.transactions.length, 0)
  assert.equal(f.tables.recurring_rules[0].last_run_date, '2026-10-27')
})

test('independent same-amount goal deposits cannot both report success from one balance snapshot', async () => {
  const f = await fixture({ savings_goals: [{ id: 1, saved_amount: 100, target_amount: 1000 }] })
  assert.equal(await f.DB.goalDeposit(1, 50, 100), 150)
  await assert.rejects(f.DB.goalDeposit(1, 50, 100), error => error.code === 'CONFLICT' && /可能已经生效/.test(error.message))
  assert.equal(f.tables.savings_goals[0].saved_amount, 150)
  assert.equal(f.Sync.outboxCount(), 0)
})

test('goal replay preserves its original balance and requests review if its response was lost', async () => {
  const f = await fixture({ savings_goals: [{ id: 1, saved_amount: 100, target_amount: 1000 }] })
  let lost = false
  f.setFault((phase, event) => {
    if (!lost && phase === 'after' && event.table === 'savings_goals' && event.op === 'update') { lost = true; throw networkError() }
  })
  await assert.rejects(f.DB.goalDeposit(1, 50), error => error.__queued === true)
  const item = f.Sync.outbox()[0]
  assert.equal(item.args[2], 100)
  f.setFault(() => {})
  await f.DB.init('test-user')
  const result = await f.Sync.retryOne(item.id)
  assert.equal(result.conflict, true)
  assert.match(result.error, /先刷新核对余额/)
  assert.equal(f.tables.savings_goals[0].saved_amount, 150)
  assert.equal(f.Sync.outbox()[0].state, 'conflict')
})

test('net worth and current balances both exclude the recycle bin', async () => {
  const now = new Date()
  const occurred_at = new Date(now.getFullYear(), now.getMonth(), 1, 12).toISOString()
  const f = await fixture({ transactions: [
    { id: 1, account_id: 1, txn_type: 'income', amount: 100, occurred_at, deleted_at: occurred_at },
    { id: 2, account_id: 1, txn_type: 'expense', amount: 10, occurred_at, deleted_at: occurred_at },
    { id: 3, account_id: 1, txn_type: 'income', amount: 50, occurred_at, deleted_at: null },
    { id: 4, account_id: 1, txn_type: 'expense', amount: 20, occurred_at },
  ] })
  assert.equal((await f.DB.accountBalances()).find(item => item.account.id === 1).balance, 3000)
  assert.equal((await f.DB.netWorthSeries(1))[0].value, 3000)
})

test('cloud transaction and recurring write entry points reject cross-currency transfers', async () => {
  const f = await fixture({ transactions: [{ id: 10, txn_type: 'transfer', account_id: 1, to_account_id: 3, amount: 10 }] })
  const cross = { txn_type: 'transfer', account_id: 1, to_account_id: 2, amount: 10 }
  const rejectsCurrency = error => error.code === 'CROSS_CURRENCY_TRANSFER'
  await assert.rejects(f.DB.addTransaction(cross), rejectsCurrency)
  await assert.rejects(f.DB.addRecurring(cross), rejectsCurrency)
  await assert.rejects(f.DB.updateTransaction(10, cross), rejectsCurrency)
  await assert.rejects(f.DB.updateTransaction(10, { to_account_id: 2 }), rejectsCurrency)
  assert.equal(f.tables.transactions.length, 1)
  assert.equal(f.tables.transactions[0].to_account_id, 3)
  assert.equal(f.tables.recurring_rules.length, 0)
  assert.equal(f.calls.filter(call => call.op !== 'select').length, 0)
})

test('same-currency transfers and partial amount edits remain available', async () => {
  const f = await fixture()
  const same = { txn_type: 'transfer', account_id: 1, to_account_id: 3, amount: 10 }
  const created = await f.DB.addTransaction(same)
  await f.DB.updateTransaction(created.id, { amount: 20 })
  await f.DB.addRecurring(same)
  assert.equal(f.tables.transactions[0].amount, 20)
  assert.equal(f.tables.recurring_rules.length, 1)
})

test('legacy cross-currency recurring rules cannot generate new incorrect transfers', async () => {
  const f = await fixture({ recurring_rules: [{
    id: 10, active: true, txn_type: 'transfer', amount: 10, account_id: 1, to_account_id: 2,
    start_date: '2026-10-27', last_run_date: '2026-10-27', freq: 'daily', tags: [], book_id: 1,
  }] })
  await assert.rejects(f.DB.applyRecurring(new Date(2026, 9, 28, 12)), error => error.code === 'CROSS_CURRENCY_TRANSFER')
  assert.equal(f.tables.transactions.length, 0)
  assert.equal(f.tables.recurring_rules[0].last_run_date, '2026-10-27')
})

test('string account ids and currency case do not reject a same-currency transfer', async () => {
  const f = await fixture({ accounts: [{ id: 1, name: '现金', currency: 'cny' }, { id: 2, name: '银行卡', currency: 'CNY' }] })
  const same = { txn_type: 'transfer', account_id: '1', to_account_id: '2', amount: 10 }
  const created = await f.DB.addTransaction(same)
  await f.DB.updateTransaction(created.id, { amount: 20 })
  await f.DB.addRecurring(same)
  assert.equal(f.tables.transactions[0].amount, 20)
  assert.equal(f.tables.recurring_rules.length, 1)
})

test('offline local transfer validation failures are not queued as network failures', async () => {
  const f = await fixture()
  f.setOnline(false)
  const cross = { txn_type: 'transfer', account_id: 1, to_account_id: 2, amount: 10 }
  await assert.rejects(f.DB.addTransaction(cross), error => error.code === 'CROSS_CURRENCY_TRANSFER' && !error.__queued)
  await assert.rejects(f.DB.addRecurring(cross), error => error.code === 'CROSS_CURRENCY_TRANSFER' && !error.__queued)
  await assert.rejects(f.DB.addTransaction({ ...cross, to_account_id: 99 }), error => error.code === 'TRANSFER_ACCOUNT_REQUIRED' && !error.__queued)
  assert.equal(f.Sync.outboxCount(), 0)
  assert.equal(f.calls.length, 0)
})
