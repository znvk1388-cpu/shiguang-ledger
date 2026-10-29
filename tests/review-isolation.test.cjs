const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

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
  review.add([3]); assert.equal(review.count(), 0)
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
