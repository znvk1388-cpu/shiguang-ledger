const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const script = file => fs.readFileSync(path.join(root, file), 'utf8')
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('editor protects changed input on close, mask and Escape while retaining input on cancel', async () => {
  const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', {
    url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true,
  })
  try {
    const w = dom.window
    w.eval(script('js/format.js'))
    w.TXN_TYPE_LABEL = { income: '收入', expense: '支出', transfer: '转账' }
    w.Lazy = { need: async () => null }
    w.DB = { mode: 'guest', state: { categories: [] }, accounts: () => [], allAccounts: () => [],
      category: () => null, rootCategories: () => [], childCategories: () => [], categoryName: () => '', accountName: () => '', budgetOf: () => null, listTemplates: async () => [] }
    w.App = { state: { attachments: {} }, refresh: async () => {} }
    w.eval(script('js/ui.js'))
    let calls = 0
    w.confirm = () => { calls++; return false }
    await w.UI.openEditor(null)
    w.document.querySelector('#edClose').click()
    assert.equal(calls, 0)
    assert.equal(w.document.querySelector('#sheet').getAttribute('aria-hidden'), 'true')
    await w.UI.openEditor(null)
    w.document.querySelector('#amtInput').value = '12'
    const leaving = new w.Event('beforeunload', { cancelable: true })
    w.dispatchEvent(leaving)
    assert.equal(leaving.defaultPrevented, true)
    w.document.querySelector('#edClose').click()
    assert.equal(calls, 1)
    assert.equal(w.document.querySelector('#amtInput').value, '12')
    w.document.querySelector('#tplPickBtn').click()
    await nextTurn()
    assert.equal(calls, 2)
    assert.ok(w.document.querySelector('#edSave'))
    w.document.querySelector('#typeSeg button[data-etype="income"]').click()
    assert.equal(w.document.querySelector('#amtInput').value, '12')
    w.URL.createObjectURL = () => 'blob:test'
    const fileInput = w.document.querySelector('#fileInput')
    Object.defineProperty(fileInput, 'files', { value: [new w.File(['receipt'], 'receipt.png', { type: 'image/png' })] })
    fileInput.dispatchEvent(new w.Event('change', { bubbles: true }))
    assert.equal(w.document.querySelector('#amtInput').value, '12')
    assert.equal(w.document.querySelectorAll('[data-removenew]').length, 1)
    w.UI.closeSheet()
    assert.equal(calls, 3)
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(calls, 4)
    w.confirm = () => { calls++; return true }
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(calls, 5)
    assert.equal(w.document.querySelector('#sheet').getAttribute('aria-hidden'), 'true')
  } finally { dom.window.close() }
})

test('report center exposes keyboard-operable buttons and describes statement export accurately', async () => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  try {
    const w = dom.window
    w.eval(script('js/format.js'))
    w.DB = {}
    w.ic = () => ''
    w.App = { state: {} }
    w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html }, closeSheet() {}, ic: () => '' }
    w.eval(script('js/insight.js'))
    await w.Insight.openReportCenter()
    for (const id of ['rpAsk', 'rpH', 'rpAudit', 'rpY', 'rpT', 'rpA', 'rpG', 'rpTag']) {
      assert.equal(w.document.getElementById(id).tagName, 'BUTTON')
    }
    assert.match(w.document.querySelector('#rpA').textContent, /查看期间收支汇总，导出流水/)
  } finally { dom.window.close() }
})

test('amount field opens the keypad on keyboard focus and editor inputs have clear accessible names', async () => {
  const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', {
    url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true,
  })
  try {
    const w = dom.window
    Object.defineProperty(w, 'innerWidth', { value: 390, configurable: true })
    w.eval(script('js/format.js'))
    w.TXN_TYPE_LABEL = { income: '收入', expense: '支出', transfer: '转账' }
    w.Lazy = { need: async () => null }
    w.DB = { mode: 'guest', state: { categories: [] }, accounts: () => [], allAccounts: () => [],
      category: () => null, rootCategories: () => [], childCategories: () => [], categoryName: () => '', accountName: () => '', budgetOf: () => null }
    w.App = { state: { attachments: {} }, refresh: async () => {} }
    w.eval(script('js/ui.js'))
    await w.UI.openEditor(null)
    const amount = w.document.querySelector('#amtInput')
    assert.equal(w.document.querySelector('#keypadWrap').classList.contains('hidden'), true)
    amount.focus()
    assert.equal(w.document.querySelector('#keypadWrap').classList.contains('hidden'), false)
    assert.equal(w.document.querySelector('label[for="noteInput"]').textContent, '备注')
    assert.equal(w.document.querySelector('label[for="timeInput"]').textContent, '时间')
    assert.equal(w.document.querySelector('label[for="tagInput"]').textContent, '标签（逗号分隔，可留空）')
  } finally { dom.window.close() }
})

test('image viewer has a named close control', () => {
  const dom = new JSDOM('<div id="lightboxRoot"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  try {
    const w = dom.window
    w.eval(script('js/format.js'))
    w.DB = {}
    w.eval(script('js/ui.js'))
    w.UI.lightbox('https://ledger.test/example.png')
    assert.equal(w.document.querySelector('.lightbox button').getAttribute('aria-label'), '关闭凭证图片')
    w.document.querySelector('.lightbox button').click()
    assert.equal(w.document.querySelector('.lightbox'), null)
  } finally { dom.window.close() }
})
test('manual transfer blocks different currencies before writing and accepts matching currencies', async () => {
  for (const [fromCurrency, targetCurrency, fromId, toId, accepted] of [
    ['CNY', 'USD', 1, 2, false],
    ['CNY', 'CNY', 1, 2, true],
    ['USD', 'USD', '1', '2', true],
    ['USD', 'usd', 1, 2, true],
  ]) {
    const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', {
      url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true,
    })
    try {
      const w = dom.window, saved = []
      const accounts = [{ id: 1, name: '现金', currency: fromCurrency }, { id: 2, name: '另一账户', currency: targetCurrency }]
      w.eval(script('js/format.js'))
      w.TXN_TYPE_LABEL = { income: '收入', expense: '支出', transfer: '转账' }
      w.Lazy = { need: async () => null }
      w.DB = {
        mode: 'guest', state: { categories: [] }, accounts: () => accounts, allAccounts: () => accounts,
        category: () => null, rootCategories: () => [], childCategories: () => [],
        categoryName: () => '', accountName: id => accounts.find(a => a.id === id)?.name || '',
        addTransaction: async row => { saved.push(row); return { id: 1 } },
        budgetOf: () => null,
      }
      w.App = { state: { attachments: {} }, refresh: async () => {} }
      w.confirm = () => { throw new Error('saving must not ask to discard') }
      w.eval(script('js/ui.js'))
      await w.UI.openEditor(null, 'transfer', { amount: 100, accountId: fromId, toAccountId: toId })
      w.document.querySelector('#edSave').click()
      await nextTurn()
      if (!accepted) {
        assert.equal(saved.length, 0)
        assert.match(w.document.querySelector('#edErr').textContent, /同币种账户/)
      } else {
        assert.equal(saved.length, 1)
        assert.equal(saved[0].amount, 100)
        assert.equal(String(saved[0].to_account_id), '2')
      }
    } finally { dom.window.close() }
  }
})

test('today card counts only expenses and uses the selected base-currency symbol', async () => {
  const dom = new JSDOM('<div class="topbar"></div><div id="productHome"></div><nav id="tabbar"></nav>', {
    url: 'https://ledger.test', runScripts: 'outside-only',
  })
  try {
    const w = dom.window, requests = []
    w.eval(script('js/format.js'))
    w.Fmt.setBaseCurrency('USD')
    w.UI = { renderOverview: async () => {}, ledgerEmpty: async () => false, openEditor() {} }
    w.App = { version: 'test' }
    w.DB = {
      monthlySummary: async () => [{ expense: 10, txn_count: 3 }],
      listTransactions: async opt => {
        requests.push(opt)
        return { rows: [], total: opt.from && opt.to ? 1 : 20 }
      },
      category: () => null, rootCategories: () => [],
    }
    w.eval(script('js/product.js'))
    await w.UI.renderOverview({ tab: 'home' })
    assert.equal(w.document.querySelector('.qb-n').textContent, '支出 · 1 笔')
    assert.equal(w.document.querySelector('.qb-v').textContent, '$10.00')
    const countRequest = requests.find(r => r.from && r.to)
    assert.equal(countRequest.type, 'expense')
    assert.equal(countRequest.limit, 1)
    assert.equal(new Date(countRequest.to) - new Date(countRequest.from), 86400000)
  } finally { dom.window.close() }
})

