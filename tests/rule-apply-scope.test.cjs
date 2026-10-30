const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

function setup() {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window, writes = [], messages = []
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.ic = () => ''
  w.TXN_TYPE_LABEL = { expense: '支出' }
  const sheet = w.document.querySelector('#sheet')
  w.UI = { openSheet: html => { sheet.innerHTML = html; sheet.setAttribute('aria-hidden', 'false') }, closeSheet: () => sheet.setAttribute('aria-hidden', 'true'), toast: s => messages.push(s) }
  w.DB = { mode: 'cloud', state: { uid: 'a' }, currentBookId: () => 1, categoryName: () => '', accountName: () => '',
    listTransactions: async () => ({ rows: [1, 2].map(id => ({ id, txn_type: 'expense', note: '咖啡', amount: 10, occurred_at: '2026-01-01', category_id: 1, tags: [] })) }),
    updateTransaction: async id => { writes.push(id) } }
  w.eval(fs.readFileSync('js/smart.js', 'utf8'))
  return { dom, w, writes, messages, rule: { field: 'note', op: 'contains', value: '咖啡', setCategoryId: 2 } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test('预览期间切换账号后不得写入', async () => {
  const h = setup()
  try { await h.w.Smart.openRuleApply(h.rule); h.w.DB.state.uid = 'b'; h.w.document.querySelector('#raRun').click(); await tick(); assert.deepEqual(h.writes, []); assert.match(h.messages.join(' '), /切换/) } finally { h.dom.window.close() }
})
test('预览读取期间关闭面板不会覆盖随后打开的面板', async () => {
  const h = setup(); let release
  h.w.DB.listTransactions = () => new Promise(resolve => { release = resolve })
  try {
    const pending = h.w.Smart.openRuleApply(h.rule)
    h.w.UI.openSheet('<div id="new-panel">其他面板</div>')
    release({ rows: [] }); await pending
    assert.equal(h.w.document.querySelector('#new-panel').textContent, '其他面板')
    assert.deepEqual(h.writes, [])
  } finally { h.dom.window.close() }
})
test('写入期间切换账本只处理已发出的请求', async () => {
  const h = setup(); let release, book = 1
  h.w.DB.currentBookId = () => book
  h.w.DB.updateTransaction = async id => { h.writes.push(id); await new Promise(resolve => { release = resolve }) }
  try { await h.w.Smart.openRuleApply(h.rule); h.w.document.querySelector('#raRun').click(); book = 2; release(); await tick(); assert.deepEqual(h.writes, [1]); assert.match(h.messages.join(' '), /核对/) } finally { h.dom.window.close() }
})
test('写入结果不明时停止后续更新并提醒核对', async () => {
  const h = setup()
  h.w.DB.updateTransaction = async id => { h.writes.push(id); throw Error('NetworkError') }
  try { await h.w.Smart.openRuleApply(h.rule); h.w.document.querySelector('#raRun').click(); await tick(); assert.deepEqual(h.writes, [1]); assert.match(h.messages.join(' '), /核对/) } finally { h.dom.window.close() }
})
