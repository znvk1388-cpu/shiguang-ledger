const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

async function setup() {
  const dom = new JSDOM('<main id="mainView"><button id="opener">记一笔</button></main><div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>', { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  const accounts = [{ id: 1, name: '现金', icon: '钞', currency: 'CNY' }, { id: 2, name: '微信', icon: '微', currency: 'CNY' }]
  const categories = [{ id: 1, name: '餐饮', txn_type: 'expense' }, { id: 2, name: '购物', txn_type: 'expense' }]
  let saved = 0
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async () => null }
  w.DB = { mode: 'guest', state: { sourceId: 'one', categories }, accounts: () => accounts, allAccounts: () => accounts,
    category: id => categories.find(c => c.id === id), rootCategories: () => categories, childCategories: () => [],
    categoryName: () => '餐饮', accountName: id => accounts.find(a => a.id === id)?.name || '', budgetOf: () => null,
    addTransaction: async () => { saved++; return { id: 1 } } }
  w.App = { state: { attachments: {} }, refresh: async () => {} }
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  w.document.getElementById('opener').focus()
  await w.UI.openEditor(null)
  return { w, dom, saved: () => saved, $: sel => w.document.querySelector(sel), key: k => [...w.document.querySelectorAll('[data-k]')].find(b => b.dataset.k === k).click() }
}

test('数字键盘在光标处插入、替换选区并按当前位置退格', async () => {
  const h = await setup()
  try {
    const input = h.$('#amtInput')
    input.value = '128'
    input.setSelectionRange(1, 2)
    h.key('4')
    assert.equal(input.value, '148')
    assert.equal(input.selectionStart, 2)
    h.key('⌫')
    assert.equal(input.value, '18')
    input.setSelectionRange(0, 0)
    h.key('⌫')
    assert.equal(input.value, '18')
    input.select()
    h.key('7')
    assert.equal(input.value, '7')
  } finally { h.dom.window.close() }
})

test('小数点检查当前算式项，替换选区时不误拒绝小数点', async () => {
  const h = await setup()
  try {
    const input = h.$('#amtInput')
    input.value = '12+3.4'
    input.setSelectionRange(1, 1)
    h.key('.')
    assert.equal(input.value, '1.2+3.4')
    h.key('.')
    assert.equal(input.value, '1.2+3.4')
    input.setSelectionRange(1, 2)
    h.key('.')
    assert.equal(input.value, '1.2+3.4')
    input.setSelectionRange(0, 7)
    h.key('.')
    assert.equal(input.value, '0.')
  } finally { h.dom.window.close() }
})

test('打开和切换分类后保留键盘焦点，选中状态可被辅助技术读取', async () => {
  const h = await setup()
  try {
    await new Promise(resolve => h.w.requestAnimationFrame(resolve))
    assert.equal(h.w.document.activeElement.id, 'amtInput')
    const cat = h.$('[data-cid="2"]')
    cat.focus()
    cat.click()
    await new Promise(resolve => h.w.requestAnimationFrame(resolve))
    assert.equal(h.w.document.activeElement.dataset.cid, '2')
    assert.equal(h.$('[data-cid="2"]').getAttribute('aria-pressed'), 'true')
    assert.equal(h.$('[data-cid="1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(h.$('#typeSeg [data-etype="expense"]').getAttribute('aria-pressed'), 'true')
    h.w.confirm = () => true
    h.w.UI.closeSheet()
    assert.equal(h.w.document.activeElement.id, 'opener')
  } finally { h.dom.window.close() }
})

test('中文输入法确认期间的 Enter 和 Ctrl Enter 不提交账单', async () => {
  const h = await setup()
  try {
    const input = h.$('#amtInput')
    input.value = '12'
    input.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    h.$('#noteInput').dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.saved(), 0)
    input.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.saved(), 1)
  } finally { h.dom.window.close() }
})

test('规则修改账户后保留每个账户自己的名称和图标', async () => {
  const h = await setup()
  try {
    h.w.Smart = { applyRules: payload => { payload.account_id = 2; return ['rule'] } }
    h.$('#noteInput').dispatchEvent(new h.w.Event('blur'))
    assert.equal(h.$('#accChips [data-aid="1"]').textContent.trim(), '钞 现金')
    assert.equal(h.$('#accChips [data-aid="2"]').textContent.trim(), '✓ 微 微信')
    assert.equal(h.$('#accChips [data-aid="1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(h.$('#accChips [data-aid="2"]').getAttribute('aria-pressed'), 'true')
  } finally { h.dom.window.close() }
})

test('新开记账从表单顶部开始，切换账户重绘时保留滚动位置', async () => {
  const h = await setup()
  try {
    h.$('#editorBody').scrollTop = 120
    h.$('#accChips [data-aid="2"]').click()
    assert.equal(h.$('#editorBody').scrollTop, 120)
    h.w.UI.closeSheet(true)
    await h.w.UI.openEditor(null)
    assert.equal(h.$('#editorBody').scrollTop, 0)
  } finally { h.dom.window.close() }
})

test('打开更多操作时将菜单送到可见区域并聚焦第一项', async () => {
  const h = await setup()
  try {
    let revealed = false
    h.$('#edMenu').scrollIntoView = () => { revealed = true }
    h.$('#edMore').click()
    assert.equal(revealed, true)
    assert.equal(h.w.document.activeElement.id, 'edContinue')
    assert.equal(h.$('#edMore').getAttribute('aria-expanded'), 'true')
  } finally { h.dom.window.close() }
})
