const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

test('demo preview never reads or writes the real ledger', async t => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://test.local', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  w.confirm = () => true
  w.DB = new Proxy({}, { get() { throw new Error('示例不能访问真实账本') } })
  w.UI = {
    openSheet: html => { w.document.querySelector('#sheet').innerHTML = html },
    closeSheet: () => { w.document.querySelector('#sheet').innerHTML = '' },
    $: selector => w.document.querySelector(selector),
  }
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'js/demo.js'), 'utf8'))
  await w.Demo.openDemoData()
  assert.match(w.document.querySelector('#sheet').textContent, /示例/)
  assert.match(w.document.querySelector('#sheet').textContent, /不会写入/)
  w.document.querySelector('#dmClose').click()
  assert.equal(w.document.querySelector('#sheet').textContent, '')
})
