'use strict'
/* v1.19.4 回归：无支出日统计（NoBuy/Kept 式无消费挑战口径）
   与财年报告（Ocular 式自定义财年起始月）。两者都是只读聚合，
   不改账目数据结构。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const turn = () => new Promise(resolve => setImmediate(resolve))

/* 固定“今天”：2026-11-16（本地时区下同一天）。 */
function fixedDate(w) {
  const NativeDate = w.Date
  w.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-16T12:00:00Z'])) }
    static now() { return new NativeDate('2026-11-16T12:00:00Z').getTime() }
  }
}

function loadUi(t, options = {}) {
  const dom = new JSDOM('<main id="mainView"><div id="content"></div></main>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  fixedDate(w)
  const rows = options.rows || []
  const monthRows = options.monthRows || [{ month_key: '2026-11', expense: 500, income: 0, txn_count: rows.length }]
  const cats = options.cats || [{ category_id: 10, total: 500 }]
  w.DB = {
    mode: 'guest', state: {}, activeBookId: () => 1,
    monthlySummary: async () => monthRows,
    categorySummary: async () => cats,
    budgetOf: () => null,
    rootCategories: () => [],
    category: () => null,
    listTransactions: async () => ({ rows }),
  }
  w.Lazy = { need: async () => ({
    trend: () => '<div>trend</div>', heatmap: () => '', donut: () => '<div>donut</div>',
    barList: () => '<div>bars</div>', sankey: () => '<div>sankey</div>',
  }) }
  w.App = { state: { tab: 'stats', statRange: 'month', scope: 'month', year: 2026, month: 11 }, bindContentEvents: () => {}, refresh() {} }
  w.ic = () => ''
  w.eval(fs.readFileSync(path.join(root, 'js/format.js'), 'utf8'))
  w.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'))
  return { w, $: s => w.document.querySelector(s), content: () => w.document.getElementById('content').innerHTML }
}

test('noSpendStats counts zero-expense days, current and longest streaks', () => {
  const dom = new JSDOM('', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  fixedDate(w)
  w.DB = { mode: 'guest', state: {} }
  w.eval(fs.readFileSync(path.join(root, 'js/format.js'), 'utf8'))
  w.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'))
  const ns = w.UI.noSpendStats
  const y = 2026, m = 11

  /* 11/1、11/3、11/5、11/16（今天）有支出：已过 16 天 */
  /* 11/1、11/3、11/5、11/16（今天）有支出：已过 16 天；6–15 日连续 10 天无支出 */
  const days = ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-16']
  /* 跨 realm（jsdom）对象先展开到 Node 侧再比较 */
  assert.deepEqual({ ...ns(days, y, m, '2026-11-16') }, { noSpend: 12, longest: 10, current: 10, passed: 16, daysInMonth: 30 })

  /* 今天还没花：今天也算无支出日，当前连续从今天往回数 */
  const early = ['2026-11-01', '2026-11-03', '2026-11-05']
  assert.deepEqual({ ...ns(early, y, m, '2026-11-16') }, { noSpend: 13, longest: 11, current: 11, passed: 16, daysInMonth: 30 })
  /* 历史整月（非当前月）：全部天数都参与，无「当前连续」 */
  const oct = ['2026-10-31']
  assert.deepEqual({ ...ns(oct, y, 10, '2026-11-16') }, { noSpend: 30, longest: 30, current: 0, passed: 31, daysInMonth: 31 })

  /* 未来月份：返回 null，界面不显示卡片 */
  assert.equal(ns([], y, 12, '2026-11-16'), null)

  /* 整月一笔支出都没有：全部已过天数都算 */
  assert.deepEqual({ ...ns([], y, 10, '2026-11-16') }, { noSpend: 31, longest: 31, current: 0, passed: 31, daysInMonth: 31 })

  /* 跨月连击不应串进别的月份：键按年月日生成，12 月的支出日不影响 11 月 */
  assert.equal(ns(['2026-12-01'], y, m, '2026-11-16').longest, 16)
})

test('stats month view shows the no-spend card only when the month has expenses', async t => {
  /* 有支出：卡片出现且数字正确 */
  const rows = [
    { id: 1, txn_type: 'expense', amount: '12.50', account_id: 1, category_id: 10, occurred_at: '2026-11-01T09:00:00' },
    { id: 2, txn_type: 'expense', amount: '8.90', account_id: 1, category_id: 10, occurred_at: '2026-11-03T09:00:00' },
    { id: 3, txn_type: 'expense', amount: '28.00', account_id: 1, category_id: 10, occurred_at: '2026-11-05T09:00:00' },
    { id: 4, txn_type: 'expense', amount: '6.00', account_id: 1, category_id: 10, occurred_at: '2026-11-16T09:00:00' },
    { id: 5, txn_type: 'transfer', amount: '100.00', account_id: 1, occurred_at: '2026-11-07T09:00:00' },
    { id: 6, txn_type: 'income', amount: '3000.00', account_id: 1, category_id: 20, occurred_at: '2026-11-10T09:00:00' },
  ]
  const h = loadUi(t, { rows })
  await h.w.UI.renderStats(h.w.App.state)
  const html = h.content()
  assert.ok(html.includes('无支出日'), 'card rendered')
  assert.ok(html.includes('12 / 16 天'), 'no-spend count')
  assert.ok(html.includes('本月最长连续'), 'longest streak row')
  /* 转账（11/7）与收入（11/10）不计为支出日 */
  assert.ok(html.includes('转账不计'), 'transfer note')

  /* 整月没有支出：不显示卡片，避免空账本误读 */
  const h2 = loadUi(t, { rows: [], monthRows: [{ month_key: '2026-11', expense: 0, income: 0, txn_count: 0 }] })
  await h2.w.UI.renderStats(h2.w.App.state)
  assert.ok(!h2.content().includes('无支出日'), 'hidden without expenses')
})

function loadInsight(t) {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  fixedDate(w)
  const monthly = {
    '2025-04': { month_key: '2025-04', expense: 200, income: 0 },
    '2026-04': { month_key: '2026-04', expense: 100, income: 40 },
    '2026-11': { month_key: '2026-11', expense: 300, income: 50 },
  }
  const cats = [
    { category_id: 10, total: 260 },
    { category_id: 11, total: 140 },
    { category_id: null, total: 9 },
  ]
  const queries = []
  w.DB = {
    mode: 'guest', state: {},
    monthlySummary: async (from, to) => { queries.push(['m', from, to]); return Object.values(monthly) },
    categorySummary: async () => cats,
    category: id => ({ 10: { id: 10, name: '餐饮' }, 11: { id: 11, name: '交通' } }[id] || null),
  }
  const sheets = []
  w.UI = {
    openSheet: html => { sheets.push(html); w.document.getElementById('sheet').innerHTML = html },
    closeSheet: () => {},
    toast: () => {},
  }
  w.App = { state: { year: 2026, month: 11 } }
  w.eval(fs.readFileSync(path.join(root, 'js/format.js'), 'utf8'))
  w.eval(fs.readFileSync(path.join(root, 'js/insight.js'), 'utf8'))
  return { w, sheets, queries, $: s => w.document.querySelector(s) }
}

test('fyMonths builds a custom financial year and clamps the start month', () => {
  const dom = new JSDOM('', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  fixedDate(w)
  w.Fmt = { privacy: () => false }
  w.DB = {}
  w.UI = { openSheet() {}, closeSheet() {}, toast() {} }
  w.eval(fs.readFileSync(path.join(root, 'js/insight.js'), 'utf8'))
  const fy = w.Insight.fyMonths

  /* 2026 年 11 月、4 月制：2026-04 → 2027-03 */
  let r = fy(2026, 11, 4)
  assert.equal(r.startY, 2026)
  assert.deepEqual({ ...r.months[0] }, { y: 2026, m: 4 })
  assert.deepEqual({ ...r.months[11] }, { y: 2027, m: 3 })
  assert.equal(r.label, '2026年4月 – 2027年3月')

  /* 当前月份还没到起始月：财年从去年开始 */
  r = fy(2026, 2, 4)
  assert.deepEqual({ ...r.months[0] }, { y: 2025, m: 4 })
  assert.deepEqual({ ...r.months[11] }, { y: 2026, m: 3 })

  /* 1 月制：结束于同年 12 月；12 月制且当月已到：跨到次年 11 月 */
  assert.equal(fy(2026, 5, 1).label, '2026年1月 – 2026年12月')
  assert.deepEqual({ ...fy(2026, 12, 12).months[11] }, { y: 2027, m: 11 })

  /* 非法输入收敛到 1–12 */
  assert.equal(fy(2026, 5, 0).startMonth, 1)
  assert.equal(fy(2026, 5, 13).startMonth, 12)
  assert.equal(fy(2026, 5, 'x').startMonth, 1)
})

test('fyAggregate sums the financial year and previous-year comparison', async t => {
  const h = loadInsight(t)
  const a = await h.w.Insight.fyAggregate(4)
  /* 当前财年 2026-04..2027-03：区间开右端（F.iso 带时区，取日期部分比对） */
  const day = s => String(s).slice(0, 10)
  assert.deepEqual(h.queries[0].map(day), ['m'.slice(0, 10), '2026-04-01', '2027-04-01'])
  assert.deepEqual(h.queries[1].map(day), ['m'.slice(0, 10), '2025-04-01', '2026-04-01'])
  assert.equal(a.months.length, 12)
  assert.equal(a.expense, 40000) /* 100 + 300 元（单位：分） */
  assert.equal(a.income, 9000) /* 40 + 50 元 */
  assert.equal(a.prevExpense, 20000) /* 2025-04 的 200 元 */
  assert.deepEqual(a.catsList.map(c => c.name), ['餐饮', '交通']) /* 按 value 排序，null 分类剔除 */
  const dec = a.months.find(x => x.y === 2026 && x.m === 12)
  assert.ok(dec, '2026-12 exists in the fy window')
  assert.deepEqual({ ...dec }, { y: 2026, m: 12, expense: 0, income: 0 })
})

test('financial year report renders in the report sheet and remembers the start month', async t => {
  const h = loadInsight(t)
  await h.w.Insight.openFyReport()
  const html = () => h.w.document.getElementById('sheet').innerHTML
  assert.ok(html().includes('财年报告'), 'sheet title')
  await turn()
  assert.ok(html().includes('财年总支出'), 'aggregate rendered')
  assert.ok(html().includes('2026年1月 – 2026年12月'), 'default fy label (January, same-year December)')
  assert.equal(h.w.document.getElementById('fyMonth').value, '1', 'default start month')
  assert.ok(html().includes('上一财年对比'), 'prev fy row')
  assert.ok(html().includes('逐月支出'), 'monthly rows')
  const select = h.$('#fyMonth')
  assert.equal(select.options.length, 12, '12 start-month options')
  /* 改起始月：只重绘正文，不重开弹层；选择写回本机 */
  const openCount = h.sheets.length
  select.value = '7'
  select.dispatchEvent(new h.w.Event('change'))
  await turn()
  assert.equal(h.sheets.length, openCount, 'sheet not reopened')
  assert.ok(html().includes('2026年7月 – 2027年6月'), 'relabeled to new fy')
  assert.equal(h.w.localStorage.getItem('ledger10_fy_month'), '7', 'persisted locally')
  /* 再次打开时沿用上次选择 */
  await h.w.Insight.openFyReport()
  await turn()
  assert.equal(h.w.document.getElementById('fyMonth').value, '7', 'remembers last choice')
})
