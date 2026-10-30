'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

test('partial budget save prevents retry and identifies confirmed and uncertain writes', async () => {
  const nodes = new Map(), writes = []
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', disabled: false,
      addEventListener(type, fn) { this[type] = fn }, removeEventListener(type) { delete this[type] } })
    return nodes.get(selector)
  }
  const inputs = [1, 2, 3].map(id => ({ value: String(id * 10), getAttribute: () => String(id) }))
  const context = { window: {}, document: { querySelector: node, querySelectorAll: sel => sel === '#sheet [data-catbudget]' ? inputs : [] },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout() {} }
  context.window.DB = { mode: 'guest', state: { sourceId: 'test' }, currentBookId: () => 1,
    categorySummary: async () => [], rootCategories: () => inputs.map((_, i) => ({ id: i + 1, name: '分类' + (i + 1), icon: '' })),
    budgetOf: () => 0, setBudget: async (_, id) => { writes.push(id); if (id === 2) throw new Error('断网') } }
  context.window.UI = { openSheet() {}, closeSheet() {}, toast() {} }
  context.window.App = { refresh() {} }
  vm.createContext(context)
  for (const file of ['format.js', 'wealth.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context)
  await context.window.Wealth.openCategoryBudget()
  await node('#cbSave').click()
  await node('#cbSave').click()
  assert.deepEqual(writes, [1, 2])
  assert.equal(node('#cbSave').disabled, true)
  assert.match(node('#cbErr').textContent, /1.*分类2.*核对/)
})

test('budget save writes only changes and blocks panel controls during pending save', async () => {
  const nodes = new Map(), writes = [], rollNodes = [], maskListeners = new Map(), docListeners = new Map()
  let release
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', disabled: false,
      addEventListener(type, fn) { this[type] = fn } })
    return nodes.get(selector)
  }
  const mask = node('#mask')
  mask.addEventListener = (type, fn) => maskListeners.set(type, fn)
  mask.removeEventListener = type => maskListeners.delete(type)
  const inputs = [1, 2].map(id => ({ value: id === 1 ? '10' : '30', getAttribute: () => String(id) }))
  const context = { window: {}, document: { querySelector: node, querySelectorAll: sel => sel === '#sheet [data-catbudget]' ? inputs : rollNodes,
    addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: type => docListeners.delete(type) },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout() {} }
  let closed = 0, totalOpened = 0
  context.window.DB = { mode: 'guest', state: { sourceId: 'test' }, currentBookId: () => 1,
    categorySummary: async () => [], rootCategories: () => inputs.map((_, i) => ({ id: i + 1, name: '分类' + (i + 1), icon: '' })),
    budgetOf: (_, id) => id === 1 ? 10 : id === 2 ? 20 : 100,
    setBudget: async (_, id) => { writes.push(id); await new Promise(resolve => { release = resolve }) } }
  context.window.UI = { openSheet() {}, closeSheet() { closed++ }, toast() {}, openMonthBudget() { totalOpened++ } }
  context.window.App = { state: {}, refresh() {} }
  vm.createContext(context)
  for (const file of ['format.js', 'wealth.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context)
  await context.window.Wealth.openCategoryBudget()
  const pending = node('#cbSave').click()
  node('#cbClose').click(); node('#cbTotal').click()
  let prevented = false
  maskListeners.get('click')?.({ preventDefault() {}, stopImmediatePropagation() { prevented = true } })
  assert.deepEqual(writes, [2]); assert.equal(closed, 0); assert.equal(totalOpened, 0); assert.equal(prevented, true)
  let escapeBlocked = false
  docListeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() { escapeBlocked = true } })
  assert.equal(escapeBlocked, true)
  release(); await pending
  assert.equal(closed, 1); assert.equal(maskListeners.has('click'), false); assert.equal(docListeners.has('keydown'), false)
})
