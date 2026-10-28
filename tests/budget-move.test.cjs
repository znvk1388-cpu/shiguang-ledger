'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

async function harness(setBudget) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', disabled: false,
      addEventListener(type, handler) { this[type] = handler } })
    return nodes.get(selector)
  }
  const context = { window: {}, document: { querySelector: node, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout() {} }
  context.window.DB = { categorySummary: async () => [], rootCategories: () => [{ id: 1, name: '餐饮', icon: '' }, { id: 2, name: '交通', icon: '' }],
    budgetOf: (_, id) => id == null ? 1000 : id === 1 ? 500 : 100, setBudget }
  context.window.UI = { openSheet() {}, closeSheet() {}, toast() {} }
  context.window.App = { refresh() {} }
  vm.createContext(context)
  for (const file of ['format.js', 'wealth.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context)
  await context.window.Wealth.openCategoryBudget()
  node('#cbMove').click()
  node('#bmTo').value = '2'
  node('#bmAmt').value = '20'
  return node
}

test('分类之间的预算挪动在缺少原子操作时不进行任何写入', async () => {
  const writes = []
  const node = await harness(async (...args) => writes.push(args))
  node('#bmFrom').value = '1'
  await node('#bmSave').click()
  assert.equal(writes.length, 0)
  assert.match(node('#bmErr').textContent, /分类.*调整/)
})

test('预算单次写入结果不明时禁止本面板重复提交', async () => {
  let writes = 0
  const node = await harness(async () => { writes++; throw new Error('断网') })
  node('#bmFrom').value = '0'
  await node('#bmSave').click()
  await node('#bmSave').click()
  assert.equal(writes, 1)
  assert.equal(node('#bmSave').disabled, true)
  assert.match(node('#bmErr').textContent, /核对/)
})
