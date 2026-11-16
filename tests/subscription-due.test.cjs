'use strict'
/* v1.19.5 回归：订阅/固定支出视图的扣款日推算与排序高亮（Wallos 式续费日视角）。
   只读聚合 + 展示增强，不改账目数据结构；纯函数挂在 window.Manage 上测试。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')

/* 固定“今天”：2026-11-16（本地时区下同一天）。 */
function fixedDate(w) {
  const NativeDate = w.Date
  w.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-16T12:00:00Z'])) }
    static now() { return new NativeDate('2026-11-16T12:00:00Z').getTime() }
  }
}

function loadManage(t, options = {}) {
  const dom = new JSDOM('<div id="sheet" aria-hidden="false"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  fixedDate(w)
  let sheetHtml = null
  w.UI = {
    $: () => ({ addEventListener() {} }),
    $$: () => [],
    openSheet: html => { sheetHtml = html },
    closeSheet: () => {},
    toast: () => {},
  }
  /* manage.js 在 eval 时就捕获 window.DB，必须在 eval 前注入 */
  w.DB = { listRecurring: async () => options.rules || [], categoryName: () => '' }
  w.ic = () => ''
  w.eval(fs.readFileSync(path.join(root, 'js/format.js'), 'utf8'))
  w.eval(fs.readFileSync(path.join(root, 'js/manage.js'), 'utf8'))
  return { w, sheet: () => sheetHtml }
}

test('subMonthlyCost keeps the v1.16 monthly-average semantics', t => {
  const h = loadManage(t)
  const M = h.w.Manage
  assert.equal(M.subMonthlyCost({ amount: '10.00', freq: 'monthly' }), 1000)
  assert.equal(M.subMonthlyCost({ amount: '365.00', freq: 'yearly' }), Math.round(36500 / 12))
  assert.equal(M.subMonthlyCost({ amount: '7.00', freq: 'weekly' }), Math.round(700 * 4.33))
  assert.equal(M.subMonthlyCost({ amount: '1.00', freq: 'daily' }), 3000)
})

test('subNextDue advances from last_run_date, or uses start_date as first due', t => {
  const h = loadManage(t)
  const M = h.w.Manage
  /* 上次已扣的月度规则：从 last_run_date 顺延一个月 */
  assert.deepEqual(
    { ...M.subNextDue({ freq: 'monthly', last_run_date: '2026-10-20', start_date: '2025-01-20' }, '2026-11-16') },
    { date: '2026-11-20', days: 4 })
  /* 从未扣过：start_date 本身就是首次扣款日 */
  assert.deepEqual(
    { ...M.subNextDue({ freq: 'monthly', start_date: '2026-12-01' }, '2026-11-16') },
    { date: '2026-12-01', days: 15 })
  /* 日规则从 last_run_date + 1 天 */
  assert.deepEqual(
    { ...M.subNextDue({ freq: 'daily', last_run_date: '2026-11-15', start_date: '2026-11-01' }, '2026-11-16') },
    { date: '2026-11-16', days: 0 })
  /* 无有效日期返回 null，界面沉底且不标注 */
  assert.equal(M.subNextDue({ freq: 'monthly', start_date: '' }), null)
  /* today 缺省用真实今天（固定为 2026-11-16） */
  assert.deepEqual(
    { ...M.subNextDue({ freq: 'monthly', start_date: '2026-11-16' }) },
    { date: '2026-11-16', days: 0 })
})

test('subscription sheet sorts by due date and highlights overdue / today / due-soon', async t => {
  const rules = [
    { id: 1, active: true, txn_type: 'expense', freq: 'monthly', amount: '30.00', note: '视频会员', last_run_date: '2026-11-09', start_date: '2026-01-09' },   /* → 12-09，23 天后 */
    { id: 2, active: true, txn_type: 'expense', freq: 'monthly', amount: '15.00', note: '云存储', last_run_date: '2026-10-20', start_date: '2025-10-20' },   /* → 11-20，4 天后 */
    { id: 3, active: true, txn_type: 'expense', freq: 'monthly', amount: '25.00', note: '健身房', last_run_date: '2026-10-15', start_date: '2025-10-15' },   /* → 11-15，昨天：已逾期 1 天 */
    { id: 4, active: true, txn_type: 'expense', freq: 'monthly', amount: '9.00', note: '音乐', last_run_date: '2026-11-16', start_date: '2025-11-16' },      /* → 12-16，30 天后 */
    { id: 5, active: false, txn_type: 'expense', freq: 'monthly', amount: '5.00', note: '已停用不应出现', last_run_date: '2026-11-17', start_date: '2025-11-17' },
    { id: 6, active: true, txn_type: 'income', freq: 'monthly', amount: '3000.00', note: '收入规则不应出现', last_run_date: '2026-11-01', start_date: '2025-11-01' },
  ]
  const h = loadManage(t, { rules })
  await h.w.Manage.openSubscriptionSheet()
  const html = h.sheet()
  assert.ok(html, 'sheet rendered')
  assert.ok(!html.includes('已停用不应出现'), 'inactive rule filtered')
  assert.ok(!html.includes('收入规则不应出现'), 'income rule filtered')
  /* 高亮：逾期 / 今天 / 7 天内 */
  assert.ok(html.includes('已逾期 1 天'), 'overdue highlighted')
  /* 排序：逾期(健身房) → 4 天(云存储) → 23 天(视频会员) → 30 天(音乐) */
  const iFit = html.indexOf('健身房')
  const iCloud = html.indexOf('云存储')
  const iMusic = html.indexOf('音乐')
  const iVideo = html.indexOf('视频会员')
  assert.ok(iFit < iCloud, 'overdue first')
  assert.ok(iCloud < iVideo, 'due-soon before far')
  assert.ok(iVideo < iMusic, '23 天 before 30 天')
  /* 非到期项只显示日期，不冒充「N 天后扣款」 */
  assert.ok(html.includes('下次 2026-12-16'), 'far due shows date only')
})
