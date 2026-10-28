const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const script = file => fs.readFileSync(path.join(root, file), 'utf8')
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

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
