'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function env(initial = {}, storage = new Map()) {
  let next = 100
  const state = Object.assign({ uid: 'target', sourceId: 'target-library', bookId: null, books: [], accounts: [], categories: [], goals: [], budgets: [], transactions: [] }, structuredClone(initial))
  const DB = {
    mode: initial.mode || 'guest', state,
    books: () => state.books,
    defaultBookId: () => (state.books[0] || {}).id || null,
    activeBookId: () => state.bookId,
    setActiveBook: id => { state.bookId = id },
    bookName: id => (state.books.find(x => x.id === id) || {}).name || '',
    allAccounts: () => state.accounts, accounts: () => state.accounts,
    accountName: id => (state.accounts.find(x => x.id === id) || {}).name || '',
    category: id => state.categories.find(x => x.id === id),
    categoryName: id => (state.categories.find(x => x.id === id) || {}).name || '',
    listGoals: () => state.goals.filter(g => state.bookId == null || g.book_id === state.bookId),
    listTransactions: async () => ({ rows: structuredClone(state.transactions) }),
    getTransaction: async id => state.transactions.find(t => t.id === id) || null,
    addBook: async row => { const made = { ...row, id: ++next }; state.books.push(made); return made },
    addAccount: async row => { const made = { ...row, id: ++next }; state.accounts.push(made); return made },
    addCategory: async row => { const made = { ...row, id: ++next }; state.categories.push(made); return made },
    addTransaction: async row => { const made = { ...row, id: ++next }; state.transactions.push(made); return made },
    addGoal: async row => { const made = { ...row, id: ++next }; state.goals.push(made); return made },
    budgetOf: (month, cat) => { const found = state.budgets.find(x => x.month_key === month && (x.category_id || null) === cat && x.book_id === state.bookId); return found ? found.amount : null },
    setBudget: async (month, cat, amount, bookId) => { state.budgets.push({ month_key: month, category_id: cat, amount, book_id: bookId || state.bookId }) },
    hasOp: async (_table, op) => state.transactions.some(t => (t.tags || []).includes('_op:' + op)),
    opTag: op => '_op:' + op,
  }
  const window = { DB, crypto: webcrypto }
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
  const context = vm.createContext({ window, localStorage, crypto: webcrypto, TextEncoder, TextDecoder, Date, console, setTimeout, clearTimeout, btoa, atob, Blob })
  for (const name of ['format.js', 'share.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8'), context, { filename: name })
  return { DB, state, Share: window.Share, storage, window }
}

test('new shares use a secret separate from the object path and preserve it on update', async () => {
  const source = env(sourceData())
  const objects = new Map()
  source.window.UI = { toast: () => {} }
  source.window.Cloud = {
    getSession: async () => ({ user: { id: 'owner-123' } }),
    cloud: { storage: {
      sharedPath: (uid, rel) => uid + '/' + rel,
      upload: async (path, blob) => { objects.set(path, await blob.text()); return {} },
      download: async path => objects.has(path) ? { data: new Blob([objects.get(path)]) } : { error: {} },
    } },
  }
  const first = await source.Share.publish({ label: '家庭' })
  assert.equal(first.ok, true)
  assert.match(first.code, /^SG2-/)
  const parsed = source.Share.parseCode(first.code)
  assert.ok(parsed.secret)
  const objectPath = [...objects.keys()][0]
  assert.ok(!objectPath.includes(parsed.secret))
  assert.equal((await source.Share.fetchSnapshot(first.code)).ok, true)
  const target = env()
  const snap = (await source.Share.fetchSnapshot(first.code)).snap
  await target.Share.mergeSnapshot(snap, '家庭', parsed.sid, parsed.uid, { shareCode: first.code })
  assert.equal(target.Share.joinedShares()[0].code, first.code, 'refresh must retain the complete secret')
  await target.Share.mergeSnapshot(snap, '家庭', parsed.sid, parsed.uid, { onlyFp: [] })
  assert.equal(target.Share.joinedShares()[0].code, first.code, 'retry must not replace SG2 with an SG1 code')
  const altered = first.code.slice(0, -1) + (first.code.endsWith('0') ? '1' : '0')
  assert.ok((await source.Share.fetchSnapshot(altered)).error)
  const updated = await source.Share.publish({ sid: first.sid, label: '家庭' })
  assert.equal(updated.code, first.code)
  assert.equal((await source.Share.fetchSnapshot(first.code)).ok, true)
})

test('failure to persist the new secret prevents upload', async () => {
  const broken = new Map()
  broken.set = () => { throw new Error('storage full') }
  const source = env(sourceData(), broken)
  let uploads = 0
  source.window.UI = { toast: () => {} }
  source.window.Cloud = { getSession: async () => ({ user: { id: 'owner' } }), cloud: { storage: {
    sharedPath: (_uid, rel) => rel, upload: async () => { uploads++; return {} },
  } } }
  const result = await source.Share.publish({})
  assert.match(result.error, /无法保存共享码/)
  assert.equal(uploads, 0)
})

test('legacy SG1 shares remain readable with the original key', async () => {
  const source = env(sourceData())
  const sid = 'abcdefgh2345'
  const text = await source.Share.encryptJson({ label: '旧共享' }, sid)
  assert.equal((await source.Share.decryptJson(text, sid)).label, '旧共享')
  assert.equal(source.Share.parseCode('SG1-owner-123-' + sid).sid, sid)
})

function sourceData() {
  return {
    mode: 'cloud', uid: 'source-account', bookId: 2,
    books: [{ id: 1, name: '日常' }, { id: 2, name: '旅行' }],
    accounts: [{ id: 10, name: '现金', currency: 'CNY', initial_balance: 100 }, { id: 11, name: '现金', currency: 'USD', initial_balance: 20 }],
    categories: [
      { id: 20, kind: 'expense', name: '餐饮' }, { id: 21, kind: 'expense', name: '其他', parent_id: 20 },
      { id: 22, kind: 'expense', name: '交通' }, { id: 23, kind: 'expense', name: '其他', parent_id: 22 },
      { id: 24, kind: 'income', name: '其他' },
    ],
    transactions: [
      { id: 30, book_id: 1, account_id: 10, category_id: 21, txn_type: 'expense', amount: 100, occurred_at: '2026-10-28T12:00:00+08:00', note: '午饭' },
      { id: 31, book_id: 2, account_id: 10, category_id: 23, txn_type: 'expense', amount: 20, occurred_at: '2026-10-28T12:00:00+08:00', note: '车费' },
      { id: 32, book_id: 1, account_id: 10, category_id: 24, txn_type: 'income', amount: 30, occurred_at: '2026-10-28T12:00:00+08:00', note: '收入' },
      { id: 33, book_id: 2, account_id: 11, category_id: 21, txn_type: 'expense', amount: 10, occurred_at: '2026-10-28T12:00:00+08:00', note: '美元支出' },
    ],
    goals: [{ id: 40, name: '攒钱', book_id: 1, target_amount: 100 }, { id: 41, name: '攒钱', book_id: 2, target_amount: 200 }],
    budgets: [{ book_id: 1, month_key: '2026-10', category_id: 21, amount: 500 }, { book_id: 2, month_key: '2026-10', category_id: 23, amount: 600 }],
  }
}

function categoryPath(state, id) {
  const c = state.categories.find(x => x.id === id)
  const parent = c.parent_id && state.categories.find(x => x.id === c.parent_id)
  return { kind: c.kind, path: parent ? parent.name + '/' + c.name : c.name }
}

test('v2 backup round-trip preserves book, typed category, account currency, goals and budgets', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  assert.equal(snap.v, 2)
  assert.equal(snap.sourceId, 'cloud:source-account')
  assert.equal(snap.goals.length, 2, 'all scope must include goals outside selected book')
  const target = env({ bookId: 999, accounts: [{ id: 90, name: '现金', currency: 'EUR' }] })
  const stats = await target.Share.mergeSnapshot(snap, '本机文件恢复', 'vault-local', '')
  assert.equal(stats.added, 4)
  assert.equal(stats.invalid, 0)
  assert.deepEqual(target.state.books.map(b => b.name), ['日常', '旅行'])
  assert.equal(target.state.bookId, 999)
  const restored = target.state.transactions.map(t => ({
    note: t.note,
    book: target.DB.bookName(t.book_id),
    currency: target.state.accounts.find(a => a.id === t.account_id).currency,
    ...categoryPath(target.state, t.category_id),
  }))
  assert.deepEqual(restored, [
    { note: '午饭', book: '日常', currency: 'CNY', kind: 'expense', path: '餐饮/其他' },
    { note: '车费', book: '旅行', currency: 'CNY', kind: 'expense', path: '交通/其他' },
    { note: '收入', book: '日常', currency: 'CNY', kind: 'income', path: '其他' },
    { note: '美元支出', book: '旅行', currency: 'USD', kind: 'expense', path: '餐饮/其他' },
  ])
  assert.deepEqual(target.state.goals.map(g => [g.name, target.DB.bookName(g.book_id), g.target_amount]), [['攒钱', '日常', 100], ['攒钱', '旅行', 200]])
  assert.deepEqual(target.state.budgets.map(b => [target.DB.bookName(b.book_id), categoryPath(target.state, b.category_id).path, b.amount]), [['日常', '餐饮/其他', 500], ['旅行', '交通/其他', 600]])
})

test('legacy snapshot preserves book and full category paths, including identical legitimate rows', async () => {
  const snap = {
    v: 1, at: '2026-10-28T12:00:00Z', books: [{ name: '日常' }, { name: '旅行' }],
    accounts: [{ name: '现金', currency: 'CNY' }],
    categories: [{ kind: 'expense', name: '餐饮' }, { kind: 'expense', name: '交通' }, { kind: 'expense', name: '其他', parent: '餐饮' }, { kind: 'expense', name: '其他', parent: '交通' }, { kind: 'income', name: '其他' }],
    transactions: [
      { book: '日常', date: '2026-10-28 12:00', type: 'expense', amount: 10, account: '现金', category: '餐饮/其他', note: '同一时刻的两笔' },
      { book: '日常', date: '2026-10-28 12:00', type: 'expense', amount: 10, account: '现金', category: '餐饮/其他', note: '同一时刻的两笔' },
      { book: '旅行', date: '2026-10-28 12:00', type: 'expense', amount: 20, account: '现金', category: '交通/其他' },
      { book: '旅行', date: '2026-10-28 12:00', type: 'income', amount: 30, account: '现金', category: '其他' },
    ],
  }
  const target = env()
  const first = await target.Share.mergeSnapshot(snap, '旧备份恢复', 'vault-local', '')
  assert.equal(first.added, 4)
  assert.deepEqual(target.state.transactions.map(t => categoryPath(target.state, t.category_id)), [
    { kind: 'expense', path: '餐饮/其他' }, { kind: 'expense', path: '餐饮/其他' },
    { kind: 'expense', path: '交通/其他' }, { kind: 'income', path: '其他' },
  ])
  const second = await target.Share.mergeSnapshot(snap, '旧备份恢复', 'vault', '')
  assert.equal(second.added, 0)
  assert.equal(second.dup, 4)
})

test('cloud target account switch never trusts another account local seen set', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const storage = new Map()
  const a = env({ mode: 'cloud', uid: 'account-A' }, storage)
  const b = env({ mode: 'cloud', uid: 'account-B' }, storage)
  assert.equal((await a.Share.mergeSnapshot(snap, '恢复', 'vault', '')).added, 4)
  assert.equal((await b.Share.mergeSnapshot(snap, '恢复', 'vault', '')).added, 4)
  assert.equal((await b.Share.mergeSnapshot(snap, '恢复', 'vault', '')).dup, 4)
  b.state.transactions.length = 0
  assert.equal((await b.Share.mergeSnapshot(snap, '恢复', 'vault', '')).added, 4, 'purged target rows must not be skipped due to stale browser cache')
})

test('failed writes remain retryable and old foreign operation tags are not carried over', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  snap.transactions[0].tags = ['_op:foreign-operation', '午餐']
  const target = env({ mode: 'cloud' })
  const add = target.DB.addTransaction
  let failing = true
  target.DB.addTransaction = async row => { if (failing && row.note === '午饭') throw new Error('network'); return add(row) }
  const first = await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')
  assert.equal(first.failed, 1)
  assert.equal(first.added, 3)
  failing = false
  const retry = await target.Share.mergeSnapshot(snap, '恢复', 'vault', '', { onlyFp: first.failedItems.map(x => x.fp) })
  assert.equal(retry.added, 1)
  assert.equal(target.state.transactions.length, 4)
  const row = target.state.transactions.find(t => t.note === '午饭')
  assert.equal(row.tags.includes('_op:foreign-operation'), false)
  assert.equal(row.tags.includes('午餐'), true)
})

test('single-book preview and export never include another books budgets', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('旅行', 'book', { includeBudgets: true })
  const preview = await source.Share.previewCounts('book', { includeBudgets: true })
  assert.equal(snap.books.length, 1)
  assert.equal(snap.budgets.length, 1)
  assert.equal(snap.budgets[0].book_id, 2)
  assert.equal(preview.budgets, 1)
})

test('existing cloud v1 operation markers prevent duplicate imports after upgrade', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const raw = 'vault|' + snap.at + '|' + snap.transactions.length
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) & 0x7fffffff
  const target = env({ mode: 'cloud' })
  for (const t of snap.transactions) {
    const oldFp = [t.date, t.type, t.amount, t.account, t.toAccount, t.category, t.note].join('|')
    target.state.transactions.push({ id: t.id, tags: ['_op:sh' + h.toString(36) + ':' + oldFp] })
  }
  const stats = await target.Share.mergeSnapshot(snap, '恢复', 'vault-local', '')
  assert.equal(stats.added, 0)
  assert.equal(stats.dup, 4)
  assert.equal(target.state.transactions.length, 4)
})

test('null-account legacy and v2 transactions remain valid; unknown references have explicit details', async () => {
  const source = env(sourceData())
  source.state.transactions = [
    { id: 70, book_id: 1, account_id: null, category_id: 21, txn_type: 'expense', amount: 15, occurred_at: '2026-10-28T12:00:00+08:00', note: '未指定账户' },
  ]
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const target = env()
  const stats = await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')
  assert.equal(stats.added, 1)
  assert.equal(target.state.transactions[0].account_id, null)
  const bad = structuredClone(snap)
  bad.transactions[0].id = 71
  bad.transactions[0].account_id = 9999
  const invalid = await target.Share.mergeSnapshot(bad, '恢复', 'vault', '')
  assert.equal(invalid.invalid, 1)
  assert.equal(invalid.invalidItems.length, 1)
  assert.match(invalid.invalidItems[0].err, /账户/)
  const legacy = structuredClone(snap)
  delete legacy.sourceId
  legacy.v = 1
  legacy.transactions[0] = { date: '2026-10-28 12:00', type: 'expense', amount: 15, book: '日常', account: '', category: '餐饮/其他', note: '旧版未指定账户' }
  assert.equal((await target.Share.mergeSnapshot(legacy, '旧恢复', 'vault', '')).added, 1)
})

test('a switch during an awaited entity write stops all subsequent transaction writes', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  for (const switched of ['account', 'mode', 'library']) {
    const target = env()
    const addBook = target.DB.addBook
    target.DB.addBook = async row => {
      const result = await addBook(row)
      if (switched === 'account') target.state.uid = 'other-account'
      if (switched === 'mode') target.DB.mode = 'cloud'
      if (switched === 'library') target.state.sourceId = 'other-library'
      return result
    }
    await assert.rejects(target.Share.mergeSnapshot(snap, '恢复', 'vault', ''), e => e.code === 'TARGET_CHANGED')
    assert.equal(target.state.accounts.length, 0)
    assert.equal(target.state.transactions.length, 0)
  }
})

test('a target switch during operation lookup does not insert into the new cloud account', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const target = env({ mode: 'cloud' })
  target.DB.hasOp = async () => { target.state.uid = 'new-account'; return false }
  await assert.rejects(target.Share.mergeSnapshot(snap, '恢复', 'vault', ''), e => e.code === 'TARGET_CHANGED')
  assert.equal(target.state.transactions.length, 0)
})

test('initial-balance and kind differences do not swallow source opening balances; retries keep mapped account IDs', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const target = env({ accounts: [
    { id: 90, name: '现金', currency: 'CNY', initial_balance: 0, kind: 'cash' },
    { id: 91, name: '现金', currency: 'CNY', initial_balance: 100, kind: 'credit' },
  ] })
  const first = await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')
  assert.equal(first.added, 4)
  const cny = target.state.accounts.find(a => a.id === target.state.transactions.find(t => t.note === '午饭').account_id)
  assert.notEqual(cny.id, 90)
  assert.notEqual(cny.id, 91)
  assert.equal(cny.initial_balance, 100)
  const accountCount = target.state.accounts.length
  cny.name = '我改过的名字'
  cny.initial_balance = 150
  source.state.transactions.push({ ...source.state.transactions[0], id: 75, note: '新增账目' })
  const updated = await source.Share.buildSnapshot('备份', 'all')
  assert.equal((await target.Share.mergeSnapshot(updated, '恢复', 'vault', '')).added, 1)
  assert.equal(target.state.accounts.length, accountCount)
  assert.equal(target.state.transactions.find(t => t.note === '新增账目').account_id, cny.id)
})


test('guest reimport checks stored transaction existence instead of stale seen cache', async () => {
  const source = env(sourceData())
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const target = env()
  assert.equal((await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')).added, 4)
  assert.equal((await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')).dup, 4)
  target.state.transactions[0].deleted_at = '2026-10-29T12:00:00Z'
  assert.equal((await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')).dup, 4, 'soft-deleted row remains recoverable in recycle bin, without duplicating it')
  const deleted = target.state.transactions.shift()
  const retry = await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')
  assert.equal(retry.added, 1)
  assert.equal(retry.dup, 3)
  assert.equal(target.state.transactions.length, 4)
  assert.equal(target.state.transactions.some(t => t.id === deleted.id), false)
})

test('same-name goals in one book preserve distinct amounts and mappings across retries', async () => {
  const source = env(sourceData())
  source.state.goals = [
    { id: 80, name: '攒钱', book_id: 1, target_amount: 100, saved_amount: 10 },
    { id: 81, name: '攒钱', book_id: 1, target_amount: 200, saved_amount: 20 },
  ]
  const snap = await source.Share.buildSnapshot('备份', 'all')
  const target = env()
  assert.equal((await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')).goals, 2)
  assert.deepEqual(target.state.goals.map(g => [g.target_amount, g.saved_amount]), [[100, 10], [200, 20]])
  target.state.goals[0].name = '改名目标'
  target.state.goals[0].saved_amount = 30
  assert.equal((await target.Share.mergeSnapshot(snap, '恢复', 'vault', '')).goals, 0)
  assert.equal(target.state.goals.length, 2)
  assert.equal(target.state.goals[0].saved_amount, 30)
})

