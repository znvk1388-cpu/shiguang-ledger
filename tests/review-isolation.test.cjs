const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

function setup() {
  const map = new Map([['ledger10_pending', '[99]']])
  const localStorage = { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }
  const DB = { mode: 'guest', state: { sourceId: 'one' }, getTransaction: async id => ({ id, occurred_at: '2026-01-01' }) }
  const window = { DB, Fmt: { escapeHtml: String }, UI: {}, Lazy: {} }
  vm.runInNewContext(fs.readFileSync('js/review.js', 'utf8'), { window, localStorage })
  return { DB, review: window.Review, map }
}
test('pending review is scoped to data source and leaves unowned legacy data untouched', () => {
  const { DB, review, map } = setup()
  assert.equal(review.count(), 0)
  review.add([1])
  DB.state.sourceId = 'two'
  assert.equal(review.count(), 0)
  review.add([2])
  DB.state.sourceId = 'one'
  assert.equal(JSON.stringify(review.ids()), '[1]')
  assert.equal(map.get('ledger10_pending'), '[99]')
  DB.mode = 'cloud'; DB.state.uid = ''
  assert.throws(() => review.add([3]), /身份/); assert.equal(review.count(), 0)
})
test('read failure or identity change cannot erase pending entries', async () => {
  const { DB, review } = setup()
  review.add([1, 2])
  DB.getTransaction = async id => { if (id === 1) throw Error('network'); return null }
  await review.list()
  assert.equal(JSON.stringify(review.ids()), '[1]')
  DB.getTransaction = async () => { DB.state.sourceId = 'two'; return null }
  await review.list()
  DB.state.sourceId = 'one'
  assert.equal(JSON.stringify(review.ids()), '[1]')
})

test('review card masks amounts in privacy mode', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.DB = { mode: 'guest', state: { sourceId: 'one' }, getTransaction: async id => ({ id, amount: 128.35, txn_type: 'expense', occurred_at: '2026-10-28', note: '午餐' }), rootCategories: () => [], accountName: () => '' }
  w.Lazy = { need: async () => null }
  w.UI = { $: sel => w.document.querySelector(sel), $$: sel => Array.from(w.document.querySelectorAll(sel)), openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
  w.eval(fs.readFileSync('js/review.js', 'utf8'))
  w.Review.add([1])
  await w.Review.openReview()
  assert.match(w.document.querySelector('#rvCard').textContent, /128\.35/)
  w.localStorage.setItem('ledger10_privacy', '1')
  await w.Review.openReview()
  assert.doesNotMatch(w.document.querySelector('#rvCard').textContent, /128\.35/)
  assert.match(w.document.querySelector('#rvCard').textContent, /\*\*\*\*/)
})

test('storage failure is reported rather than pretending the pending list was changed', () => {
  const map = new Map()
  const localStorage = { getItem: k => map.get(k) || null, setItem: () => { throw Error('quota') }, removeItem: () => { throw Error('disabled') } }
  const DB = { mode: 'guest', state: { sourceId: 'one' } }
  const window = { DB, Fmt: { escapeHtml: String }, UI: {}, Lazy: {} }
  vm.runInNewContext(fs.readFileSync('js/review.js', 'utf8'), { window, localStorage })
  assert.throws(() => window.Review.add([1]), /保存|存储/)
  assert.throws(() => window.Review.remove(1), /保存|存储/)
  localStorage.getItem = () => { throw Error('disabled') }
  assert.throws(() => window.Review.ids(), /读取|存储/)
})
