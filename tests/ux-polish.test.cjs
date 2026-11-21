const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')
const turn = () => new Promise(resolve => setImmediate(resolve))

function setup() {
  const dom = new JSDOM(
    '<main id="mainView"><button id="opener">记一笔</button><div id="content">当前记录</div></main>' +
    '<div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>',
    { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, animations = []
  let reduceListener
  const media = { matches: false, addEventListener(n, fn) { reduceListener = fn }, addListener(fn) { reduceListener = fn } }
  w.matchMedia = () => media
  w.HTMLElement.prototype.animate = function (frames, options) {
    let resolve, reject
    const finished = new Promise((yes, no) => { resolve = yes; reject = no })
    const a = { frames, options, finished, cancels: 0, cancel() { this.cancels++; reject(Error('cancelled')) }, finish() { resolve() } }
    animations.push(a); return a
  }
  const account = { id: 1, name: '现金', currency: 'CNY' }, category = { id: 1, name: '餐饮', txn_type: 'expense' }
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async () => null }
  w.DB = { mode: 'guest', state: { sourceId: 'ux-test', categories: [category] }, accounts: () => [account], allAccounts: () => [account],
    category: () => category, rootCategories: () => [category], childCategories: () => [], categoryName: () => category.name, accountName: () => account.name, budgetOf: () => null,
    addTransaction: async () => ({ id: 1 }), uploadImage: async () => ({ id: 2 }), addAttachments: async () => {} }
  w.App = { state: { attachments: {} }, refresh: async () => {} }
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}
  w.confirm = () => true
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  return { w, animations, $: s => w.document.querySelector(s), close: () => w.close() }
}

test('quick-add entries open the editor with the numeric keypad already expanded', async () => {
  const h = setup()
  try {
    await h.w.UI.openEditor(null, 'expense', { categoryId: 1, keyboard: true })
    const wrap = h.$('#keypadWrap')
    assert.ok(wrap, '键盘容器存在')
    assert.equal(wrap.classList.contains('hidden'), false, '快捷记账直接展开键盘')
    const sheet = h.$('#sheet')
    assert.equal(sheet.classList.contains('kp-open'), true)
    /* 关闭后再用普通入口打开：键盘恢复默认收起，preset 不应跨面板泄漏 */
    h.w.UI.closeSheet(true)
    await h.w.UI.openEditor(null)
    assert.equal(h.$('#keypadWrap').classList.contains('hidden'), true, '普通入口键盘默认收起')
  } finally { h.close() }
})

test('a preset without the keyboard flag keeps the default collapsed behaviour', async () => {
  const h = setup()
  try {
    await h.w.UI.openEditor(null, 'expense', { categoryId: 1 })
    assert.equal(h.$('#keypadWrap').classList.contains('hidden'), true)
    assert.equal(h.$('#sheet').classList.contains('kp-open'), false)
  } finally { h.close() }
})
