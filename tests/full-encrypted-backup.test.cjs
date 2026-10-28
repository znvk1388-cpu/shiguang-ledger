const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { webcrypto } = require('node:crypto')
const { IDBFactory } = require('fake-indexeddb')
const { JSDOM } = require('jsdom')

test('guest encrypted file restores attachments and recurring rules only after overwrite confirmation', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  Object.defineProperty(w, 'crypto', { value: webcrypto })
  Object.defineProperty(w, 'indexedDB', { value: new IDBFactory() })
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.fetch = fetch; w.Blob = Blob
  w.FileReader = class { readAsDataURL(blob) { blob.arrayBuffer().then(b => { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(b).toString('base64'); this.onload() }, e => { this.error = e; this.onerror() }) } }
  w.UI = { toast() {} }
  w.DB = { mode: 'guest', useGuest: async () => w.GuestStore.init() }
  w.Lazy = { need: async () => { throw new Error('游客完整备份不应调用共享快照') } }
  let exported
  w.URL.createObjectURL = blob => { exported = blob; return 'blob:test' }
  w.URL.revokeObjectURL = () => {}
  w.HTMLAnchorElement.prototype.click = function () {}
  for (const file of ['format.js', 'idb.js', 'guest-store.js', 'vault.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'))
  await w.GuestStore.init()
  const fixture = { app: 'ledger10', version: 2, data: {
    sourceId: 'test-source', books: [{ id: 1, name: '日常' }],
    accounts: [{ id: 2, name: '现金', initial_balance: 10 }], categories: [{ id: 3, name: '餐饮', kind: 'expense' }],
    transactions: [{ id: 4, book_id: 1, account_id: 2, category_id: 3, txn_type: 'expense', amount: 5, occurred_at: '2026-10-28T12:00:00Z' }],
    attachments: [{ id: 5, transaction_id: 4, dataUrl: 'data:text/plain;base64,aGVsbG8=' }],
    recurring: [{ id: 6, book_id: 1, account_id: 2, category_id: 3, txn_type: 'expense', amount: 5, freq: 'monthly', start_date: '2026-10-28' }],
    budgets: [], goals: [], templates: [],
  } }
  await w.GuestStore.restore(fixture)
  assert.equal((await w.Vault.exportLocal('password123')).ok, true)
  const file = { text: async () => exported.text() }
  await w.Idb.put('transactions', { id: 4, txn_type: 'expense', amount: 9, occurred_at: '2026-10-28T12:00:00Z' })
  w.confirm = () => false
  assert.ok((await w.Vault.restoreLocal(file, 'password123')).error)
  assert.equal((await w.Idb.get('transactions', 4)).amount, 9)
  w.confirm = () => { w.DB.mode = 'cloud'; return true }
  assert.ok((await w.Vault.restoreLocal(file, 'password123')).error)
  assert.equal((await w.Idb.get('transactions', 4)).amount, 9)
  w.DB.mode = 'guest'
  w.confirm = () => true
  assert.equal((await w.Vault.restoreLocal(file, 'password123')).ok, true)
  assert.equal((await w.Idb.get('transactions', 4)).amount, 5)
  assert.equal(await (await w.Idb.get('attachments', 5)).blob.text(), 'hello')
  assert.equal((await w.Idb.get('recurring', 6)).freq, 'monthly')
})

test('cloud backup never silently deletes earlier backups', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window, removed = []
  Object.defineProperty(w, 'crypto', { value: webcrypto })
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob
  w.UI = { toast() {} }
  w.Cloud = {
    getSession: async () => ({ user: { id: 'test' } }),
    cloud: { storage: {
      userPath: (uid, rel) => uid + '/' + rel,
      upload: async () => ({}),
      list: async () => ({ data: Array.from({ length: 22 }, (_, i) => ({ name: i + '.json' })) }),
      remove: async paths => { removed.push(...paths) },
    } },
  }
  w.Lazy = { need: async () => ({ buildSnapshot: async () => ({ accounts: [{}], transactions: [] }) }) }
  for (const file of ['format.js', 'vault.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'))
  assert.equal((await w.Vault.backup('password123')).ok, true)
  assert.deepEqual(removed, [])
})

test('export aborts if the active account changes while preparing the file', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  Object.defineProperty(w, 'crypto', { value: webcrypto })
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob
  w.UI = { toast() {} }
  w.DB = { mode: 'guest' }
  let release
  w.GuestStore = { state: { sourceId: 'a' }, backup: () => new Promise(resolve => { release = resolve }) }
  let downloads = 0
  w.URL.createObjectURL = () => { downloads++; return 'blob:test' }
  for (const file of ['format.js', 'vault.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'))
  const pending = w.Vault.exportLocal('password123')
  w.DB.mode = 'cloud'
  release({ data: { transactions: [], accounts: [{}] } })
  const result = await pending
  assert.match(result.error, /切换/)
  assert.equal(downloads, 0)
})
