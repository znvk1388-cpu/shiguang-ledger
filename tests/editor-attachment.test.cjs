const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

async function setup({ failSave = false, failDelete = false } = {}) {
  const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, calls = []
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async () => null }
  const account = { id: 1, currency: 'CNY', name: '现金' }, category = { id: 2, name: '餐饮' }
  w.DB = { mode: 'guest', state: { sourceId: 'one', categories: [category] }, accounts: () => [account], allAccounts: () => [account],
    category: () => category, rootCategories: () => [category], childCategories: () => [], categoryName: () => '餐饮', accountName: () => '现金', budgetOf: () => null,
    imageUrl: async () => '', updateTransaction: async () => { calls.push('save'); if (failSave) throw Error('failed') },
    removeAttachment: async () => { calls.push('remove'); if (failDelete) throw Error('failed') } }
  w.App = { state: { attachments: { 7: [{ id: 9, storage_path: 'a' }] } }, refresh: async () => {} }
  w.confirm = () => true
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  await w.UI.openEditor({ id: 7, txn_type: 'expense', amount: 12, category_id: 2, account_id: 1, occurred_at: '2026-01-01T12:00:00Z', tags: [] })
  return { w, dom, calls }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test('删除原凭证仅修改草稿，放弃时不删除', async () => {
  const h = await setup()
  try { h.w.document.querySelector('[data-remove]').click(); await tick(); assert.deepEqual(h.calls, []); h.w.document.querySelector('#edClose').click(); assert.deepEqual(h.calls, []) } finally { h.dom.window.close() }
})
test('保存账目失败时不删除原凭证', async () => {
  const h = await setup({ failSave: true })
  try { h.w.document.querySelector('[data-remove]').click(); h.w.document.querySelector('#edSave').click(); await tick(); assert.deepEqual(h.calls, ['save']) } finally { h.dom.window.close() }
})
test('保存成功后才删除原凭证，删除失败提示核对', async () => {
  for (const failDelete of [false, true]) {
    const h = await setup({ failDelete })
    try { h.w.document.querySelector('[data-remove]').click(); h.w.document.querySelector('#edSave').click(); await tick(); assert.deepEqual(h.calls, ['save', 'remove']); if (failDelete) assert.match(h.w.document.body.textContent, /账目已保存.*凭证.*核对/) } finally { h.dom.window.close() }
  }
})
test('切换数据来源后不能删除另一来源的凭证', async () => {
  const h = await setup()
  try {
    h.w.document.querySelector('[data-remove]').click()
    h.w.DB.state.sourceId = 'other'
    h.w.document.querySelector('#edSave').click(); await tick()
    assert.deepEqual(h.calls, ['save'])
    assert.match(h.w.document.body.textContent, /凭证删除结果需要核对/)
  } finally { h.dom.window.close() }
})
test('冲突覆盖后提示删除凭证尚未执行', async () => {
  const h = await setup()
  try {
    h.w.DB.updateTransaction = async () => { const e = Error('conflict'); e.code = 'CONFLICT'; throw e }
    let options
    h.w.Lazy.need = async name => name === 'syncui' ? ({ showConflict: (err, id, payload, opt) => { options = opt } }) : null
    h.w.document.querySelector('[data-remove]').click()
    h.w.document.querySelector('#edSave').click(); await tick(); await tick()
    assert.match(options.pendingAttachmentNotice, /凭证.*未删除/)
  } finally { h.dom.window.close() }
})
test('冲突覆盖成功后持续展示待核对凭证提示', async () => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  try {
    const w = dom.window
    w.eval(fs.readFileSync('js/format.js', 'utf8'))
    w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, toast() {} }
    w.DB = { updateTransaction: async () => {} }
    w.App = { refresh() {} }
    w.eval(fs.readFileSync('js/sync-sheet.js', 'utf8'))
    w.SyncSheet.showConflict({}, 7, { txn_type: 'expense', amount: 12, occurred_at: '2026-01-01' }, { pendingAttachmentNotice: '所选凭证尚未删除，请重新打开账目核对' })
    w.document.querySelector('#cfKeep').click(); await tick()
    assert.match(w.document.querySelector('#sheet').textContent, /凭证尚未删除.*核对/)
  } finally { dom.window.close() }
})
