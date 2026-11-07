const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

test('游客初始化期间保留入口加载反馈，失败后可重试且不能进入空账本', async () => {
  const dom = new JSDOM('<section id="authView"><button id="guestBtn">先试用一下</button></section><section id="mainView" class="hidden"><div id="content"></div></section>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  let rejectInit, calls = 0
  const messages = []
  w.UI = { $: s => w.document.querySelector(s), $$: s => [...w.document.querySelectorAll(s)], toast: m => messages.push(m) }
  w.DB = { useGuest: () => { calls++; return new Promise((_, reject) => { rejectInit = reject }) } }
  w.Fmt = { escapeHtml: s => s }
  w.eval(fs.readFileSync('js/app.js', 'utf8'))
  try {
    const pending = w.App.enterGuest()
    assert.equal(w.document.getElementById('mainView').classList.contains('hidden'), true)
    assert.equal(w.document.getElementById('guestBtn').disabled, true)
    assert.match(w.document.getElementById('guestBtn').textContent, /正在/)
    await w.App.enterGuest()
    assert.equal(calls, 1, '不能重复初始化同一本地账本')
    rejectInit(new Error('storage unavailable'))
    await pending
    assert.equal(w.document.getElementById('authView').classList.contains('hidden'), false)
    assert.equal(w.document.getElementById('mainView').classList.contains('hidden'), true)
    assert.equal(w.document.getElementById('guestBtn').disabled, false)
    assert.equal(w.document.getElementById('guestBtn').textContent, '先试用一下')
    assert.equal(w.document.getElementById('guestBtn').hasAttribute('aria-busy'), false)
    assert.match(messages.join(' '), /重试/)
  } finally { dom.window.close() }
})
