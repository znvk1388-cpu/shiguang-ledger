/* 报销台账（懒加载模块）
 *
 * 背景（v3 评审 P0-3）：报销原来只是一个布尔标记 `transactions.reimbursable`，
 * 于是「垫付 100」记支出、「报销到账 100」记收入 —— 同一笔钱在月报里被算成
 * 支出 +100、收入 +100，用户最想问的「公司还欠我多少」也答不了。
 *
 * 数据边界（项目硬约束：不能改表结构）：
 *   - 账目表只保留原有的 reimbursable 布尔位（「这笔要报销」）
 *   - 三态（待报销 / 部分报销 / 已报销）、预计金额、已收金额、核销时间
 *     全部写本机 localStorage 的 `ledger10_reimb` 覆盖层
 *   - 覆盖层丢失（换设备 / 清缓存）时自动退回「待报销」，不会凭空多钱
 *
 * 口径：核销只改状态，不写任何新账目 —— 这样月支出 / 收入 / 净资产都不变，
 * 不会出现「报销一笔就多一笔收入」的虚增。真正到账的钱请用「转账」记录。
 */
;(function () {
  'use strict'
  const F = window.Fmt
  const S = window.DB
  const KEY = 'ledger10_reimb'

  const STATUS_LABEL = { pending: '待报销', partial: '部分报销', done: '已报销' }

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch (e) { return {} }
  }
  function saveAll(m) {
    try { localStorage.setItem(KEY, JSON.stringify(m)) } catch (e) { /* 隐私模式忽略 */ }
  }
  function get(id) { return all()[String(id)] || null }

  /* 写覆盖层。cents 一律「分」整数 */
  function set(id, patch) {
    const m = all()
    const cur = m[String(id)] || {}
    m[String(id)] = Object.assign({}, cur, patch, { at: new Date().toISOString() })
    saveAll(m)
  }
  function clear(id) {
    const m = all()
    delete m[String(id)]
    saveAll(m)
  }

  /* 状态推导：覆盖层优先，其次看账目自带的 reimbursable */
  function statusOf(t) {
    const r = get(t.id)
    if (r && r.status) return r.status
    return t.reimbursable ? 'pending' : ''
  }
  /* 未收金额（分）：垫付总额 − 已收 */
  function outstandingCents(t) {
    const r = get(t.id) || {}
    const total = F.toCents(t.amount)
    const got = Number(r.received || 0)
    if (statusOf(t) === 'done') return 0
    return Math.max(0, total - got)
  }
  function ageDays(t) {
    const d = F.parseIso(t.occurred_at)
    if (!d || isNaN(d.getTime())) return 0
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
  }

  /* 拉取所有「需要报销」的账目（跨账本），按时间倒序 */
  async function list() {
    const res = await S.listTransactions({ reimbursable: true, limit: 2000, ignoreBook: true })
    const rows = (res.rows || []).slice()
    rows.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    return rows.map(t => ({
      t,
      status: statusOf(t),
      outstanding: outstandingCents(t),
      age: ageDays(t),
    }))
  }

  /* 汇总：待收合计、笔数、本月代垫（不计入收支，仅用于说明） */
  async function summary() {
    const items = await list()
    let outstanding = 0
    let pendingCount = 0
    let doneCount = 0
    items.forEach(x => {
      if (x.status === 'done') doneCount++
      else { pendingCount++; outstanding += x.outstanding }
    })
    return { items, outstanding, pendingCount, doneCount }
  }

  /* ---------- 面板 ---------- */
  function rowHtml(x) {
    const t = x.t
    const cat = S.category(t.category_id)
    const acc = S.accountName(t.account_id)
    const done = x.status === 'done'
    return '<div class="reimb-row' + (done ? ' done' : '') + '" data-rid="' + t.id + '">' +
      '<div class="reimb-main">' +
      '<div class="reimb-line1"><b class="num">¥' + F.yuan(F.toCents(t.amount)) + '</b>' +
      '<span class="reimb-tag ' + x.status + '">' + (STATUS_LABEL[x.status] || '待报销') + '</span></div>' +
      '<div class="reimb-line2 small muted">' + F.humanDay(t.occurred_at) + ' · ' +
      F.escapeHtml((cat && cat.name) || '未分类') + (acc ? ' · ' + F.escapeHtml(acc) : '') +
      (t.note ? ' · ' + F.escapeHtml(t.note) : '') + '</div>' +
      '<div class="reimb-line3 tiny muted">' +
      (done ? '已收 ¥' + F.yuan(F.toCents(t.amount)) : '已垫付 ' + x.age + ' 天 · 待收 ¥' + F.yuan(x.outstanding)) +
      '</div></div>' +
      '<div class="reimb-acts">' +
      (done
        ? '<button class="btn sm line" data-reimb-undo="' + t.id + '">撤销</button>'
        : '<button class="btn sm" data-reimb-done="' + t.id + '">标记已收</button>' +
          '<button class="btn sm line" data-reimb-part="' + t.id + '">部分</button>') +
      '</div></div>'
  }

  async function openPanel() {
    const box = await summary()
    const body = box.items.length
      ? box.items.map(rowHtml).join('')
      : '<div class="empty" style="padding:26px 0"><div class="big">' + ic('receipt') + '</div>没有待报销的账目' +
        '<div class="small" style="margin-top:6px">记一笔时勾选「需要报销」，就会出现在这里</div></div>'
    window.UI.openSheet(
      '<div class="sheet-head"><span class="sheet-title">报销台账</span>' +
      '<button id="rbClose" class="btn sm line">关闭</button></div>' +
      '<div class="card reimb-sum">' +
      '<div class="between"><span class="small muted">待收合计</span>' +
      '<span class="small muted">' + box.pendingCount + ' 笔待收 · ' + box.doneCount + ' 笔已收</span></div>' +
      '<div class="num" style="font-size:28px;font-weight:800;margin-top:2px">¥' + F.yuan(box.outstanding) + '</div>' +
      '<div class="tiny muted" style="margin-top:6px">代垫本身已计入当月支出；核销只改状态、不写新账目，' +
      '所以月支出 / 收入 / 净资产都不会变。真正到账的钱请用「转账」记录，不要记成收入。</div>' +
      '</div>' + body
    )
    document.getElementById('rbClose').onclick = () => window.UI.closeSheet()
    document.querySelectorAll('[data-reimb-done]').forEach(b => {
      b.onclick = () => { set(Number(b.getAttribute('data-reimb-done')), { status: 'done', received: null }); reopen() }
    })
    document.querySelectorAll('[data-reimb-undo]').forEach(b => {
      b.onclick = () => { set(Number(b.getAttribute('data-reimb-undo')), { status: 'pending', received: 0 }); reopen() }
    })
    document.querySelectorAll('[data-reimb-part]').forEach(b => {
      b.onclick = () => {
        const id = Number(b.getAttribute('data-reimb-part'))
        const item = box.items.find(x => x.t.id === id)
        const max = item ? F.yuan(F.toCents(item.t.amount)) : ''
        const v = prompt('这次收到多少（元）？剩余部分仍显示为待报销。\n本笔金额：¥' + max, '')
        if (v == null) return
        const yuan = Number(String(v).trim())
        const cents = F.toCents(yuan)
        if (!Number.isSafeInteger(cents) || cents <= 0) { window.UI.toast('请输入有效且大于 0 的金额'); return }
        const total = item ? F.toCents(item.t.amount) : 0
        if (!(total > 0)) return
        /* 输入的是本次到账金额，覆盖层保存累计已收；再次打开面板也不能丢掉前次回款。 */
        const previous = Math.max(0, Number((get(id) || {}).received) || 0)
        const received = Math.min(total, previous + cents)
        set(id, { status: received >= total ? 'done' : 'partial', received })
        reopen()
      }
    })
  }

  function reopen() {
    window.UI.closeSheet()
    setTimeout(() => { openPanel() }, 180)
  }

  /* 记账弹层里的三态 chip：由 ui.js 直接调用，返回 HTML 片段 */
  function chipsHtml(status, expectYuan) {
    const cur = status || ''
    const one = (v, label) => '<button class="chip' + (cur === v ? ' on' : '') + '" data-reim="' + v + '">' + label + '</button>'
    return one('', '不用报销') + one('pending', '' + ic('receipt') + ' 待报销') + one('partial', '部分已收') + one('done', '已报销') +
      (cur && cur !== 'done'
        ? '<div class="row" style="gap:8px;margin-top:8px;width:100%"><input id="reimExpect" class="input grow" style="height:34px" type="number" inputmode="decimal" placeholder="预计报销金额（可留空）" value="' + (expectYuan || '') + '"></div>'
        : '')
  }

  window.Reimb = {
    get, set, clear, statusOf, outstandingCents, ageDays, list, summary, openPanel, chipsHtml, STATUS_LABEL,
  }
})()

