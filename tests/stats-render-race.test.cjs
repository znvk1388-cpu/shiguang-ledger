const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const charts = text => ({ trend: () => '<p>' + text + '</p>', heatmap: () => '' })
function setup(needCharts) {
  const dom = new JSDOM('<main id="mainView"><div id="content"></div></main>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  let book = 1, bindings = 0
  w.DB = { mode: 'guest', state: { sourceId: 'guest-one' }, activeBookId: () => book,
    monthlySummary: async () => [], listTransactions: async () => ({ rows: [] }) }
  w.Lazy = { need: needCharts || (async () => charts('当前图')) }
  const state = { tab: 'stats', statRange: 'decade', scope: 'all', year: 2026, month: 11 }
  w.App = { state, bindContentEvents: () => { bindings++ } }
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  return { w, state, $: s => w.document.querySelector(s), setBook: value => { book = value }, bindings: () => bindings, close: () => dom.window.close() }
}

test('late statistics results and failures never replace a different tab', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const gate = deferred(), h = setup(() => gate.promise)
    try {
      const pending = h.w.UI.renderStats(h.state)
      h.state.tab = 'home'
      h.$('#content').innerHTML = '<p id="latest">最新明细</p>'
      if (outcome === 'resolve') gate.resolve(charts('旧图'))
      else gate.reject(new Error('旧请求失败'))
      await pending
      assert.ok(h.$('#latest'), outcome + ' preserved latest tab')
      assert.equal(h.$('#statSeg'), null)
      assert.equal(h.bindings(), 0)
    } finally { h.close() }
  }
})

test('statistics cannot commit after book, identity, period, container or visibility changes', async () => {
  const changes = [h => h.setBook(2), h => { h.w.DB.state.sourceId = 'guest-two' },
    h => { h.w.DB.mode = 'cloud'; h.w.DB.state = { uid: 'cloud-one' } },
    h => { h.state.statRange = 'year' }, h => { h.state.year = 2025 },
    h => { h.state.month = 10 }, h => { h.state.scope = 'year' },
    h => h.$('#mainView').classList.add('hidden'),
    h => { h.$('#content').outerHTML = '<div id="content">新容器</div>' }]
  for (const mutate of changes) for (const outcome of ['resolve', 'reject']) {
    const gate = deferred(), h = setup(() => gate.promise)
    try {
      const pending = h.w.UI.renderStats(h.state)
      h.$('#content').textContent = '新容器'
      mutate(h)
      if (outcome === 'resolve') gate.resolve(charts('旧图'))
      else gate.reject(new Error('过期失败'))
      await pending
      assert.equal(h.$('#content').textContent, '新容器')
      assert.equal(h.bindings(), 0)
    } finally { h.close() }
  }
})

test('latest statistics request wins over earlier success and error for the same range', async () => {
  const gates = [deferred(), deferred(), deferred()]
  let next = 0
  const h = setup(() => gates[next++].promise)
  try {
    const old = h.w.UI.renderStats(h.state)
    const failed = h.w.UI.renderStats(h.state)
    const latest = h.w.UI.renderStats(h.state)
    gates[2].resolve(charts('新图'))
    await latest
    gates[0].resolve(charts('旧图'))
    gates[1].reject(new Error('更早的失败'))
    await Promise.all([old, failed])
    assert.ok(h.$('#content').textContent.includes('新图'))
    assert.ok(!h.$('#content').textContent.includes('旧图'))
    assert.ok(!h.$('#content').textContent.includes('更早的失败'))
    assert.equal(h.bindings(), 1)
  } finally { h.close() }
})

test('current statistics failure stays visible and keeps the selected range accessible', async () => {
  const h = setup(async () => { throw new Error('暂时无法读取统计') })
  try {
    await h.w.UI.renderStats(h.state)
    assert.ok(h.$('#content').textContent.includes('暂时无法读取统计'))
    assert.equal(h.$('[data-sr="decade"]').getAttribute('aria-pressed'), 'true')
    assert.equal(h.$('[data-sr="month"]').getAttribute('aria-pressed'), 'false')
  } finally { h.close() }
})

test('range redraw retains keyboard focus only while its original control still has focus', async () => {
  const h = setup()
  try {
    await h.w.UI.renderStats(h.state)
    const range = h.$('[data-sr="decade"]')
    range.focus(); range.click()
    await turn()
    assert.equal(h.w.document.activeElement, h.$('[data-sr="decade"]'))
    assert.equal(h.$('[data-sr="decade"]').getAttribute('aria-pressed'), 'true')
  } finally { h.close() }
})

test('statistics redraw does not steal focus moved elsewhere during the request', async () => {
  const gate = deferred()
  let calls = 0
  const h = setup(() => ++calls === 1 ? Promise.resolve(charts('初始图')) : gate.promise)
  try {
    await h.w.UI.renderStats(h.state)
    const range = h.$('[data-sr="decade"]')
    range.focus(); range.click()
    const outside = h.w.document.createElement('button')
    outside.textContent = '其他操作'
    h.$('#mainView').appendChild(outside)
    outside.focus()
    gate.resolve(charts('新图'))
    await turn()
    assert.ok(h.$('#content').textContent.includes('新图'))
    assert.equal(h.w.document.activeElement, outside)
  } finally { h.close() }
})
