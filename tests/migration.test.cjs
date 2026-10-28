const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

function guestDump(overrides = {}) {
  return {
    sourceId: 'guest-library-1',
    books: [{ id: 1, name: '日常' }],
    accounts: [{ id: 1, name: '现金', currency: 'CNY', initial_balance: 0 }],
    categories: [{ id: 1, name: '其他', kind: 'expense' }],
    transactions: [{ id: 1, txn_type: 'expense', amount: 25, occurred_at: '2026-10-24T10:00:00Z', account_id: 1, category_id: 1, book_id: 1, note: '午饭' }],
    attachments: [], budgets: [], recurring: [], goals: [], templates: [], ...overrides,
  }
}

function harness(initialDump = guestDump()) {
  const saved = new Map(), users = new Map()
  let uid = '', dump = initialDump, wipeCalls = 0, nextId = 100
  const controls = { failReads: false, failTransactionResponse: false, failAttachmentResponse: false, failRules: false, uploads: 0 }
  const current = () => users.get(uid)
  function ensureUser(id) {
    if (!users.has(id)) users.set(id, {
      uid: id, categories: [{ id: 1, name: '其他', kind: 'expense' }],
      accounts: [{ id: 1, name: '现金', currency: 'CNY' }], books: [{ id: 1, name: '日常' }],
      goals: [], templates: [], transactions: [], recurring_rules: [], attachments: [], budgets: [], bookId: null,
    })
  }
  function insert(table, row) { const made = { ...structuredClone(row), id: nextId++ }; current()[table].push(made); return made }
  const Store = {
    get state() { return current() },
    seedPresets: async () => {}, ensureDefaultBook: async () => {},
    currentBookId: () => current().bookId || 1,
    allAccounts: () => current().accounts,
    addBook: async row => insert('books', row), addAccount: async row => insert('accounts', row), addCategory: async row => insert('categories', row),
    addTransaction: async row => {
      const made = insert('transactions', row)
      if (controls.failTransactionResponse) { controls.failTransactionResponse = false; throw new Error('response lost') }
      return made
    },
    updateTransaction: async (id, patch) => Object.assign(current().transactions.find(t => t.id === id), structuredClone(patch)),
    addRecurring: async row => { if (controls.failRules) throw new Error('rules unavailable'); return insert('recurring_rules', row) },
    updateRecurring: async (id, patch) => Object.assign(current().recurring_rules.find(t => t.id === id), structuredClone(patch)),
    setActiveBook: id => { current().bookId = id },
    setBudget: async (month, category, amount, book) => { current().budgets.push({ month_key: month, category_id: category, amount, book_id: book }) },
    listGoals: () => current().goals, addGoal: async row => insert('goals', row),
    listTemplates: async () => current().templates, addTemplate: async row => insert('templates', row),
    uploadImageBlob: async () => ({ path: 'uploads/' + (++controls.uploads) }),
    addAttachments: async (transactionId, uploaded) => {
      const rows = uploaded.map(f => insert('attachments', { transaction_id: transactionId, storage_path: f.path }))
      if (controls.failAttachmentResponse) { controls.failAttachmentResponse = false; throw new Error('attachment response lost') }
      return rows
    },
  }
  const window = {
    Store, crypto: webcrypto, TextEncoder,
    GuestStore: { dump: async () => structuredClone(dump), wipe: async () => { wipeCalls++ } },
    DB: { useCloud: async session => { uid = session.user.id; ensureUser(uid) } },
    Cloud: { cloud: { database: { from(table) {
      const filters = []
      return {
        select() { return this },
        contains(column, tags) { filters.push(row => tags.every(tag => (row[column] || []).includes(tag))); return this },
        eq(column, value) { filters.push(row => row[column] === value); return this },
        async limit(limit) {
          if (controls.failReads) return { data: null, error: new Error('read unavailable') }
          return { data: current()[table].filter(row => filters.every(f => f(row))).slice(0, limit).map(row => structuredClone(row)), error: null }
        },
      }
    } } } },
  }
  const context = vm.createContext({ window, TextEncoder, Uint8Array, Blob, fetch, localStorage: {
    getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k),
  } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/migrate.js'), 'utf8'), context)
  return {
    api: window.Migrate, saved, users, controls,
    get wipeCalls() { return wipeCalls },
    setDump(value) { dump = value },
    async migrate(id = 'A') { return window.Migrate.migrateGuestToCloud({ user: { id } }) },
    use(id) { uid = id; ensureUser(id) },
  }
}

test('migration progress is isolated by target account and source library', async () => {
  const h = harness()
  assert.equal((await h.migrate('A')).complete, true)
  assert.equal((await h.migrate('B')).complete, true)
  assert.equal(h.users.get('A').transactions.length, 1)
  assert.equal(h.users.get('B').transactions.length, 1)
  assert.equal((await h.migrate('A')).complete, true)
  assert.equal(h.users.get('A').transactions.length, 1)
  h.setDump(guestDump({ sourceId: 'another-library', transactions: [{ ...guestDump().transactions[0], note: '另一份数据' }] }))
  assert.equal((await h.migrate('A')).complete, true)
  assert.equal(h.users.get('A').transactions.length, 2)
  assert.notEqual(h.users.get('A').transactions[0].tags[0], h.users.get('A').transactions[1].tags[0])
  assert.equal(h.wipeCalls, 0)
})

test('new rows in the same source preserve existing identities across reload/retry', async () => {
  const h = harness()
  await h.migrate()
  h.setDump(guestDump({ transactions: [...guestDump().transactions, { ...guestDump().transactions[0], id: 2, note: '晚饭' }] }))
  assert.equal((await h.migrate()).txns, 2)
  assert.equal(h.users.get('A').transactions.length, 2)
  h.users.get('A').transactions.splice(0, 1)
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.users.get('A').transactions.length, 2, 'journal alone cannot hide a deleted cloud row')
})

test('legacy backups with equal count and IDs but different contents do not collide', async () => {
  const dump = guestDump(); delete dump.sourceId
  const h = harness(dump)
  await h.migrate()
  h.setDump({ ...dump, transactions: [{ ...dump.transactions[0], amount: 99 }] })
  await h.migrate()
  assert.equal(h.users.get('A').transactions.length, 2)
  await h.migrate()
  assert.equal(h.users.get('A').transactions.length, 2)
  h.setDump({ ...dump, sourceId: '', exportedAt: '2026-10-30T00:00:00Z', transactions: [{ ...dump.transactions[0], amount: 99 }] })
  await h.migrate()
  assert.equal(h.users.get('A').transactions.length, 2, 'export envelope metadata does not create a new legacy source')
})

test('lost write response retries by source operation ID, and failed reads never trigger blind inserts', async () => {
  const h = harness()
  h.controls.failTransactionResponse = true
  assert.equal((await h.migrate()).complete, false)
  assert.equal(h.users.get('A').transactions.length, 1)
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.users.get('A').transactions.length, 1)
  h.controls.failReads = true
  const result = await h.migrate()
  assert.equal(result.complete, false)
  assert.equal(result.txns, 0)
  assert.equal(h.users.get('A').transactions.length, 1)
  assert.equal(h.wipeCalls, 0)
})

test('attachment response loss reuses the uploaded path and verifies real cloud metadata', async () => {
  const h = harness(guestDump({ attachments: [{ id: 1, transaction_id: 1, blob: new Blob(['image']), file_name: 'image.png' }] }))
  h.controls.failAttachmentResponse = true
  assert.equal((await h.migrate()).complete, false)
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.controls.uploads, 1)
  assert.equal(h.users.get('A').attachments.length, 1)
  h.users.get('A').attachments.length = 0
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.users.get('A').attachments.length, 1)
  assert.equal(h.controls.uploads, 1)
})

test('incomplete recurring rules cannot be reported as a complete migration', async () => {
  const h = harness(guestDump({ recurring: [{ ...guestDump().transactions[0], freq: 'monthly', start_date: '2026-10-24', active: true }] }))
  h.controls.failRules = true
  assert.equal((await h.migrate()).complete, false)
  h.controls.failRules = false
  assert.equal((await h.migrate()).complete, true)
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.users.get('A').recurring_rules.length, 1)
})

test('accounts with the same name but different currencies remain separate', async () => {
  const h = harness(guestDump({ accounts: [{ id: 1, name: '现金', currency: 'USD' }] }))
  await h.migrate()
  const user = h.users.get('A')
  assert.equal(user.accounts.length, 2)
  assert.equal(user.accounts.find(a => a.id === user.transactions[0].account_id).currency, 'USD')
})

test('legacy unscoped journal is adopted only after current-account record verification', async () => {
  const dump = guestDump()
  const h = harness(dump)
  h.use('A')
  h.users.get('A').transactions.push({ ...dump.transactions[0], id: 80, tags: ['_op:mig-1'], reimbursable: false })
  const raw = '1:1:1'; let hash = 5381
  for (const char of raw) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0
  h.saved.set('ledger10_migrate_journal', JSON.stringify({ srcSig: String(hash >>> 0), txnMap: { 1: 80 } }))
  assert.equal((await h.migrate('A')).complete, true)
  assert.equal(h.users.get('A').transactions.length, 1)
  assert.ok(h.users.get('A').transactions[0].tags.includes('_op:mig-guest-library-1:1'))
  assert.equal((await h.migrate('B')).complete, true)
  assert.equal(h.users.get('B').transactions.length, 1)
})

test('same-name source accounts and books retain distinct IDs and opening balances', async () => {
  const dump = guestDump({
    books: [{ id: 11, name: '日常' }, { id: 12, name: '日常' }],
    accounts: [{ id: 11, name: '现金', currency: 'CNY', initial_balance: 100 }, { id: 12, name: '现金', currency: 'CNY', initial_balance: 200 }],
    transactions: [
      { ...guestDump().transactions[0], id: 11, account_id: 11, book_id: 11 },
      { ...guestDump().transactions[0], id: 12, account_id: 12, book_id: 12 },
    ],
  })
  const h = harness(dump)
  assert.equal((await h.migrate()).complete, true)
  const user = h.users.get('A')
  assert.equal(new Set(user.transactions.map(t => t.account_id)).size, 2)
  assert.equal(new Set(user.transactions.map(t => t.book_id)).size, 2)
  assert.equal(user.accounts.reduce((sum, a) => sum + Number(a.initial_balance || 0), 0), 300)
  const firstAccountId = user.transactions[0].account_id
  user.accounts.reverse(); user.books.reverse()
  user.accounts.find(a => a.id === firstAccountId).name = '改名后的现金'
  h.setDump({ ...dump, transactions: [...dump.transactions, { ...dump.transactions[0], id: 13, note: '后续新增' }] })
  assert.equal((await h.migrate()).complete, true)
  assert.equal(user.transactions[2].account_id, firstAccountId)
  assert.equal(user.accounts.length, 3, 'source maps survive reorder and destination rename')
})

test('same-name goals and templates in one source are not folded together', async () => {
  const h = harness(guestDump({
    goals: [{ id: 11, name: '旅行', book_id: 1, target_amount: 100, saved_amount: 10 }, { id: 12, name: '旅行', book_id: 1, target_amount: 100, saved_amount: 20 }],
    templates: [{ ...guestDump().transactions[0], id: 11, name: '午饭', amount: 10 }, { ...guestDump().transactions[0], id: 12, name: '午饭', amount: 20 }],
  }))
  assert.equal((await h.migrate()).complete, true)
  assert.equal((await h.migrate()).complete, true)
  assert.equal(h.users.get('A').goals.length, 2)
  assert.equal(h.users.get('A').templates.length, 2)
})

test('verified legacy attachment progress is reused without uploading duplicate files', async () => {
  const dump = guestDump({ attachments: [{ id: 1, transaction_id: 1, blob: new Blob(['image']) }] })
  const h = harness(dump)
  h.use('A')
  const user = h.users.get('A')
  user.transactions.push({ ...dump.transactions[0], id: 80, tags: ['_op:mig-1'], reimbursable: false })
  user.attachments.push({ id: 90, transaction_id: 80, storage_path: 'legacy/image' })
  let hash = 5381
  for (const char of '1:1:1') hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0
  h.saved.set('ledger10_migrate_journal', JSON.stringify({ srcSig: String(hash >>> 0), txnMap: { 1: 80 }, imgMap: { 1: 90 } }))
  assert.equal((await h.migrate()).complete, true)
  assert.equal(user.transactions.length, 1)
  assert.equal(user.attachments.length, 1)
  assert.equal(h.controls.uploads, 0)
})
