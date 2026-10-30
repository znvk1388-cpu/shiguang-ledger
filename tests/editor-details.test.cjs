const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

async function setup() {
  const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  const cat = { id: 2, name: '餐饮' }, acc = { id: 1, currency: 'CNY' }
  let saved = 0
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async () => null }
  w.DB = { mode: 'guest', state: { sourceId: 'one', categories: [cat] }, accounts: () => [acc], allAccounts: () => [acc], category: () => cat, rootCategories: () => [cat], childCategories: () => [], categoryName: () => '餐饮', accountName: () => '现金', budgetOf: () => null, addTransaction: async () => { saved++; return { id: 1 } } }
  w.App = { state: { attachments: {} }, refresh: async () => {} }
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  await w.UI.openEditor(null)
  return { w, dom, saved: () => saved }
}
test('清空记账时间后阻止保存并显示错误', async () => {
  const h = await setup()
  try {
    h.w.document.querySelector('#amtInput').value = '10'
    h.w.document.querySelector('#timeInput').value = ''
    h.w.document.querySelector('#edSave').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.saved(), 0)
    assert.match(h.w.document.querySelector('#edErr').textContent, /时间/)
    assert.equal(h.w.document.querySelector('#moreBox').classList.contains('hidden'), false)
  } finally { h.dom.window.close() }
})
test('备注接近上限时显示剩余数量，切换类型后仍保持提示', async () => {
  const h = await setup()
  try {
    const el = h.w.document.querySelector('#noteInput')
    assert.equal(el.getAttribute('aria-describedby'), 'noteLimit')
    el.value = '餐'.repeat(75)
    el.dispatchEvent(new h.w.Event('input', { bubbles: true }))
    assert.match(h.w.document.querySelector('#noteLimit').textContent, /5/)
    h.w.document.querySelector('#typeSeg button[data-etype="income"]').click()
    assert.match(h.w.document.querySelector('#noteLimit').textContent, /5/)
  } finally { h.dom.window.close() }
})

test('AI 币种不一致时明显提示并定位到可调整账户', async () => {
  const h = await setup()
  try {
    await h.w.UI.openEditor(null, 'expense', { amount: 10, categoryId: 2, accountId: 1, aiReview: true, aiCurrency: 'USD' })
    h.w.document.querySelector('#edSave').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.saved(), 0)
    assert.match(h.w.document.querySelector('#edErr').textContent, /币种/)
    assert.match(h.w.document.querySelector('#toast').textContent, /币种/)
    assert.equal(h.w.document.querySelector('#accChips').classList.contains('invalid'), true)
  } finally { h.dom.window.close() }
})
