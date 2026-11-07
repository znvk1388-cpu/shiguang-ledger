const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

function setup(listTransactions) {
  const dom = new JSDOM('<main id="mainView"><div id="content"></div></main>', {
    url: 'https://ledger.test', runScripts: 'outside-only'
  })
  const w = dom.window
  const accounts = [{ id: 1, currency: 'CNY' }, { id: 2, currency: 'USD' }]
  let book = 1
  w.localStorage.setItem('ledger10_home_budget', 'off')
  w.DB = {
    mode: 'guest', activeBookId: () => book, listTransactions,
    listRecurring: async () => [], listAttachments: async () => ({}),
    accounts: () => accounts, allAccounts: () => accounts, category: () => null, accountName: () => ''
  }
  const state = {
    tab: 'home', homeView: 'list', scope: 'month', year: 2026, month: 11, loaded: 100,
    filters: { keyword: '', tag: '', minAmount: '', maxAmount: '' }
  }
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  w.App = { state, refresh: () => w.UI.renderHome(state) }
  return { dom, w, state, setBook: value => { book = value }, $: sel => w.document.querySelector(sel) }
}

const row = (id, note, account_id = 1) => ({
  id, note, account_id, amount: 10, txn_type: 'expense', occurred_at: '2026-11-06T10:00:00+08:00'
})
const turn = () => new Promise(resolve => setImmediate(resolve))

test('late results and errors cannot replace a newer search', async () => {
  const pending = new Map()
  const h = setup(query => new Promise((resolve, reject) => pending.set(query.keyword, { resolve, reject })))
  try {
    h.state.filters.keyword = '旧'
    const old = h.w.UI.renderHome(h.state)
    await turn()
    h.state.filters.keyword = '错误'
    const failed = h.w.UI.renderHome(h.state)
    await turn()
    h.state.filters.keyword = '新'
    const fresh = h.w.UI.renderHome(h.state)
    await turn()
    pending.get('新').resolve({ rows: [row(2, '新账单')], total: 1 })
    await fresh
    pending.get('旧').resolve({ rows: [row(1, '旧账单')], total: 1 })
    pending.get('错误').reject(new Error('late'))
    await Promise.all([old, failed])
    assert.equal(h.state.txns[0].id, 2)
    assert.equal(h.$('.txn').dataset.id, '2')
    assert.equal(h.$('#kwInput').value, '新')
    assert.equal(h.$('#homeRetry'), null)
  } finally { h.dom.window.close() }
})

test('results do not commit after leaving the ledger or switching books', async () => {
  let resolve
  const h = setup(() => new Promise(done => { resolve = done }))
  try {
    for (const leave of [() => { h.state.tab = 'stats' }, () => { h.setBook(2) }]) {
      h.state.tab = 'home'
      h.$('#content').textContent = '当前页面'
      const pending = h.w.UI.renderHome(h.state)
      await turn()
      leave()
      resolve({ rows: [row(1, '旧结果')], total: 1 })
      await pending
      assert.equal(h.$('#content').textContent, '当前页面')
      assert.equal(h.state.txns, undefined)
    }
  } finally { h.dom.window.close() }
})

test('search redraw keeps the active input and its composition or selection intact', async () => {
  const h = setup(async () => ({ rows: [row(1, '中午买菜')], total: 1 }))
  try {
    await h.w.UI.renderHome(h.state)
    const input = h.$('#kwInput')
    input.focus()
    input.value = '买菜'
    input.setSelectionRange(1, 1)
    h.state.filters.keyword = '买菜'
    await h.w.UI.renderHome(h.state)
    assert.equal(h.$('#kwInput'), input)
    assert.equal(h.w.document.activeElement, input)
    assert.equal(input.selectionStart, 1)
    input.dataset.composing = '1'
    input.value = '买菜 zhong'
    await h.w.UI.renderHome(h.state)
    assert.equal(h.$('#kwInput'), input)
    assert.equal(input.value, '买菜 zhong')
  } finally { h.dom.window.close() }
})

test('filtered totals keep currencies separate and label partial results and privacy', async () => {
  const h = setup(async () => ({ rows: [row(1, '购物'), row(2, '购物', 2)], total: 3 }))
  try {
    h.state.filters.keyword = '购物'
    h.state.filters.tag = '<img src=x>'
    h.state.filters.minAmount = '10'
    await h.w.UI.renderHome(h.state)
    assert.match(h.$('#content').textContent, /找到 3 笔 · 已显示 2 笔/)
    assert.match(h.$('#content').textContent, /已显示记录小计 · 支出 ¥10.00 · 支出 \$10.00/)
    assert.equal(h.$('.applied-filters img'), null)
    assert.match(h.$('[data-fremove="tag"]').textContent, /<img src=x>/)
    h.w.localStorage.setItem('ledger10_privacy', '1')
    await h.w.UI.renderHome(h.state)
    assert.doesNotMatch(h.$('#content').textContent, /10\.00/)
    assert.match(h.$('[data-fremove="minAmount"]').textContent, /\*\*\*\*/)
  } finally { h.dom.window.close() }
})
