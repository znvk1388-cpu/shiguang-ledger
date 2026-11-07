const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

test('search and tablet rotation keep a single budget card and return it to the list', async () => {
  const dom = new JSDOM('<div class="shell"><div class="period-bar"><div id="periodTitle"></div><div id="scopeBtn"></div></div>' +
    '<div id="overview"><span>概览</span></div><div id="content"></div></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  let wide = true, revision = 0
  w.matchMedia = () => ({ matches: wide })
  w.UI = {
    $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)],
    periodTitle: () => '期间', renderHome: async () => {
      w.document.querySelector('#content').innerHTML = '<div class="budget-card" data-version="' + (++revision) + '">预算</div>'
    }
  }
  w.Fmt = {}
  w.DB = {}
  w.eval(fs.readFileSync('js/app.js', 'utf8'))
  try {
    await w.App.renderTab()
    await w.App.renderTab()
    assert.equal(w.document.querySelectorAll('.budget-card').length, 1)
    assert.equal(w.document.querySelector('#overview .budget-card').dataset.version, '2')
    wide = false
    await w.App.renderTab()
    assert.equal(w.document.querySelectorAll('.budget-card').length, 1)
    assert.equal(w.document.querySelector('#content .budget-card').dataset.version, '3')
    assert.equal(w.document.querySelector('#overview .budget-card'), null)
    assert.equal(w.document.querySelector('.shell').classList.contains('home-layout'), true)
    wide = true
    await w.App.renderTab()
    assert.equal(w.document.querySelectorAll('.budget-card').length, 1)
    assert.equal(w.document.querySelector('#overview .budget-card').dataset.version, '4')
  } finally { dom.window.close() }
})

test('late overview refresh cannot erase the budget card while arranging tablet columns', async () => {
  const dom = new JSDOM('<div class="shell"><div class="period-bar"><div id="periodTitle"></div><div id="scopeBtn"></div></div>' +
    '<div id="overview"></div><div id="content"></div></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  let finishOverview
  const gate = new Promise(resolve => { finishOverview = resolve })
  w.matchMedia = () => ({ matches: true })
  w.UI = {
    $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)],
    periodTitle: () => '期间',
    renderOverview: async () => { await gate; w.document.querySelector('#overview').innerHTML = '<span>新概览</span>' },
    renderHome: async () => { w.document.querySelector('#content').innerHTML = '<div class="budget-card">本月预算</div>' }
  }
  w.Fmt = {}
  w.DB = {}
  w.eval(fs.readFileSync('js/app.js', 'utf8'))
  try {
    const refreshing = w.App.refresh()
    await new Promise(resolve => setImmediate(resolve))
    finishOverview()
    await refreshing
    assert.equal(w.document.querySelectorAll('.budget-card').length, 1)
    assert.equal(w.document.querySelector('#overview .budget-card').textContent, '本月预算')
  } finally { dom.window.close() }
})
