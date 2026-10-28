/* 资产与债务模块
   1) 借入借出（债权债务）：用负债/债权账户 + 转账实现，天然并入净资产与账户余额
   2) 账户对账：把账面余额校准到真实余额（改期初，不污染收支统计）
   3) 预算增强：月 / 周 / 年三种周期 + 自动预算（基础 / 累积 / 纠偏）
   全部基于现有表结构，不新增字段。到期日等附加信息存 localStorage。 */
window.Wealth = (function () {
  const F = window.Fmt
  const S = window.DB
  const U = () => window.UI

  const DEBT_META = 'ledger10_debt_meta'      /* { [accountId]: { due, note, created } } */
  const RECON_LOG = 'ledger10_recon_log'      /* [{ accountId, at, from, to }] */
  const AUTOBUDGET = 'ledger10_autobudget'    /* { month|week|year: { on, mode, amount } } */

  const LOAN_IN = 'loan_in'    /* 我欠别人（负债） */
  const LOAN_OUT = 'loan_out'  /* 别人欠我（债权） */

  function readJson(k, d) {
    try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v } catch (e) { return d }
  }
  function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch (e) { return false } }

  /* ================= 一、借入借出 ================= */
  function debtMeta() { return readJson(DEBT_META, {}) }
  function setDebtMeta(id, patch) {
    const m = debtMeta()
    m[id] = Object.assign({}, m[id] || {}, patch)
    writeJson(DEBT_META, m)
  }
  function clearDebtMeta(id) {
    const m = debtMeta()
    delete m[id]
    writeJson(DEBT_META, m)
  }

  function isDebtAccount(a) { return a && (a.kind === LOAN_IN || a.kind === LOAN_OUT) }

  /* 返回 [{ account, kind, principal, outstanding, repaid, pct, due, meta }] */
  async function listDebts() {
    const balances = await S.accountBalances()
    const balMap = {}
    balances.forEach(b => { balMap[b.account.id] = b.balance })
    const meta = debtMeta()
    return S.allAccounts().filter(isDebtAccount).map(a => {
      const bal = balMap[a.id] || 0
      const outstanding = a.kind === LOAN_IN ? Math.max(0, -bal) : Math.max(0, bal)
      /* 「再借 / 再借出」会让欠款超过最初本金，本金取两者较大值，进度才不会是负数 */
      const principal = Math.max(Math.abs(F.toCents(a.initial_balance)), outstanding)
      const repaid = Math.max(0, principal - outstanding)
      return {
        account: a,
        kind: a.kind,
        principal,
        outstanding,
        repaid,
        pct: principal > 0 ? Math.min(100, repaid / principal * 100) : 0,
        due: (meta[a.id] && meta[a.id].due) || null,
        meta: meta[a.id] || {},
      }
    }).sort((x, y) => y.outstanding - x.outstanding)
  }

  async function openDebtSheet() {
    const list = await listDebts()
    const totalIn = list.filter(d => d.kind === LOAN_IN).reduce((s, d) => s + d.outstanding, 0)
    const totalOut = list.filter(d => d.kind === LOAN_OUT).reduce((s, d) => s + d.outstanding, 0)
    const today = F.dstr(new Date())

    const rows = list.map(d => {
      const overdue = d.due && d.due < today && d.outstanding > 0
      return '<div class="goal-card">' +
        '<div class="top"><span style="font-size:20px">' + (d.kind === LOAN_IN ? '' + ic('download') + '' : '' + ic('upload') + '') + '</span>' +
        '<div class="grow"><div class="name">' + F.escapeHtml(d.account.name) +
        (d.outstanding <= 0 ? ' <span class="goal-done">已结清</span>' : '') + '</div>' +
        '<div class="deadline">' + (d.kind === LOAN_IN ? '我欠对方' : '对方欠我') +
        (d.due ? ' · 到期 ' + F.escapeHtml(d.due) : '') +
        (overdue ? ' <span style="color:var(--expense)">已逾期</span>' : '') + '</div></div>' +
        '<div class="num" style="font-weight:700;text-align:right">¥' + F.yuan(d.outstanding) +
        '<div class="tiny muted" style="font-weight:400">本金 ¥' + F.yuan(d.principal) + '</div></div></div>' +
        '<div class="progress' + (d.outstanding <= 0 ? '' : overdue ? ' over' : '') + '"><i style="width:' + d.pct.toFixed(1) + '%;' +
        (d.outstanding <= 0 ? 'background:var(--income)' : '') + '"></i></div>' +
        '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="btn sm ghost grow" data-drepay="' + d.account.id + '">' + (d.kind === LOAN_IN ? '还一笔' : '收一笔') + '</button>' +
        '<button class="btn sm line grow" data-dadd="' + d.account.id + '">' + (d.kind === LOAN_IN ? '再借' : '再借出') + '</button>' +
        '<button class="btn sm line" data-dedit="' + d.account.id + '">改</button>' +
        '<button class="btn sm danger" data-ddel="' + d.account.id + '" style="flex:none">删</button>' +
        '</div></div>'
    }).join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">借入借出 · 债权债务</span><button id="dbClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none;display:flex;gap:12px">' +
      '<div class="grow"><div class="small muted">我欠别人</div><div class="num" style="font-size:19px;font-weight:800;color:var(--expense)">¥' + F.yuan(totalIn) + '</div></div>' +
      '<div class="grow"><div class="small muted">别人欠我</div><div class="num" style="font-size:19px;font-weight:800;color:var(--income)">¥' + F.yuan(totalOut) + '</div></div>' +
      '</div>' +
      (rows || '<div class="empty" style="padding:24px"><div class="big">' + ic('users') + '</div><div>还没有借贷记录</div>' +
        '<div class="small" style="margin-top:6px">借钱、垫付、AA 代付都可以记在这里</div></div>') +
      '<button class="btn block" id="dbNew" style="margin-top:12px">＋ 新增一笔借贷</button>' +
      '<button class="btn ghost block" id="dbPlan" style="margin-top:10px">多还一点 · 债务清零计划</button>' +
      '<div class="hint">借贷会自动并入「资产」页的净资产，还款用转账记录，不重复计入收支</div>'
    )
    document.getElementById('dbClose').addEventListener('click', U().closeSheet)
    const dbp = document.getElementById('dbPlan')
    if (dbp) dbp.addEventListener('click', () => openDebtPlan())
    document.getElementById('dbNew').addEventListener('click', () => openDebtEditor(null))
    document.querySelectorAll('#sheet [data-drepay]').forEach(b =>
      b.addEventListener('click', () => openDebtFlow(Number(b.getAttribute('data-drepay')), 'repay')))
    document.querySelectorAll('#sheet [data-dadd]').forEach(b =>
      b.addEventListener('click', () => openDebtFlow(Number(b.getAttribute('data-dadd')), 'add')))
    document.querySelectorAll('#sheet [data-dedit]').forEach(b =>
      b.addEventListener('click', () => openDebtEditor(Number(b.getAttribute('data-dedit')))))
    document.querySelectorAll('#sheet [data-ddel]').forEach(b =>
      b.addEventListener('click', async () => {
        const id = Number(b.getAttribute('data-ddel'))
        if (!confirm('删除这笔借贷？相关转账记录会保留在账目里，需要的话请到明细里单独处理。')) return
        try {
          await S.deleteAccount(id)
          clearDebtMeta(id)
          U().toast('已删除')
          openDebtSheet()
          window.App.refresh()
        } catch (e) { U().toast('删除失败') }
      }))
  }

  function openDebtEditor(accountId) {
    const accs = S.allAccounts()
    const editing = accountId != null
    const a = editing ? accs.find(x => x.id === accountId) : null
    const meta = editing ? (debtMeta()[accountId] || {}) : {}
    const kind = a ? a.kind : LOAN_IN

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (editing ? '编辑借贷' : '新增借贷') + '</span><button id="deClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>类型</label><div class="chips" id="deKinds">' +
      '<button class="chip' + (kind === LOAN_IN ? ' on' : '') + '" data-dk="' + LOAN_IN + '">' + ic('download') + ' 我借入（我欠别人）</button>' +
      '<button class="chip' + (kind === LOAN_OUT ? ' on' : '') + '" data-dk="' + LOAN_OUT + '">' + ic('upload') + ' 我借出（别人欠我）</button>' +
      '</div></div>' +
      '<div class="field"><label>对方 / 事由</label><input id="deName" class="input" maxlength="20" placeholder="如：张三 / 帮同事垫付" value="' + F.escapeHtml(a ? a.name : '') + '"></div>' +
      '<div class="field"><label>本金（元）</label><input id="deAmt" class="input num" type="number" min="0.01" step="0.01" inputmode="decimal" value="' + (a ? (Math.abs(F.toCents(a.initial_balance)) / 100).toFixed(2) : '') + '"' + (editing ? ' disabled' : '') + '></div>' +
      (editing ? '<div class="small muted" style="margin:-6px 0 10px">本金创建后不可改，追加请用「再借 / 再借出」</div>' : '') +
      '<div class="field"><label>到期日（可留空）</label><input id="deDue" class="input" type="date" value="' + F.escapeHtml(meta.due || '') + '"></div>' +
      '<div class="err" id="deErr"></div>' +
      '<button class="btn block" id="deSave">' + (editing ? '保存' : '创建') + '</button>'
    )
    let k = kind
    document.querySelectorAll('#deKinds .chip').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#deKinds .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        k = b.getAttribute('data-dk')
      })
    })
    document.getElementById('deClose').addEventListener('click', U().closeSheet)
    document.getElementById('deSave').addEventListener('click', async () => {
      const name = document.getElementById('deName').value.trim()
      const err = document.getElementById('deErr')
      if (!name) { err.textContent = '请填写对方或事由'; return }
      const due = document.getElementById('deDue').value || null
      try {
        if (editing) {
          setDebtMeta(accountId, { due })
          U().closeSheet(); U().toast('已保存'); openDebtSheet()
          return
        }
        const amt = Number(document.getElementById('deAmt').value)
        if (!amt || amt <= 0) { err.textContent = '请输入大于 0 的本金'; return }
        const row = await S.addAccount({
          name,
          kind: k,
          icon: k === LOAN_IN ? '📥' : '📤',
          color: k === LOAN_IN ? '#e5484d' : '#12a150',
          initial_balance: k === LOAN_IN ? -amt : amt,
          sort_order: 50,
        })
        if (due) setDebtMeta(row.id, { due })
        U().closeSheet()
        U().toast('已创建')
        openDebtSheet()
        window.App.refresh()
      } catch (e) { err.textContent = '保存失败：' + (e.message || '') }
    })
  }

  /* mode: 'repay' 还款/收回 | 'add' 追加借入/借出 */
  function openDebtFlow(accountId, mode) {
    const a = S.allAccounts().find(x => x.id === accountId)
    if (!a) return
    const isIn = a.kind === LOAN_IN
    const accs = S.accounts().filter(x => !isDebtAccount(x))
    const label = mode === 'repay' ? (isIn ? '还一笔' : '收一笔') : (isIn ? '再借入' : '再借出')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + label + ' · ' + F.escapeHtml(a.name) + '</span><button id="dfClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:10px">' +
      (mode === 'repay'
        ? (isIn ? '从你的账户转出，抵减欠款。' : '对方还款给你，从债权转入你的账户。')
        : (isIn ? '又借进来一笔，欠款增加。' : '又借出去一笔，债权增加。')) +
      '</div>' +
      '<div class="field"><label>' + (mode === 'repay' ? (isIn ? '付款账户' : '收款账户') : (isIn ? '收款账户' : '付款账户')) + '</label>' +
      '<div class="chips" id="dfAccs">' +
      accs.map((x, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-fa="' + x.id + '">' + F.escapeHtml(x.icon) + ' ' + F.escapeHtml(x.name) + '</button>').join('') +
      '</div></div>' +
      '<div class="field"><label>金额（元）</label><input id="dfAmt" class="input num" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
      '<div class="field"><label>时间</label><input id="dfTime" class="input" type="datetime-local" value="' + F.localInput(new Date()) + '"></div>' +
      '<div class="field"><label>备注（可留空）</label><input id="dfNote" class="input" maxlength="40" placeholder="如：还第一期"></div>' +
      '<div class="err" id="dfErr"></div>' +
      '<button class="btn block" id="dfSave">确认' + label + '</button>'
    )
    let accId = accs.length ? accs[0].id : null
    document.querySelectorAll('#dfAccs .chip').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#dfAccs .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        accId = Number(b.getAttribute('data-fa'))
      })
    })
    document.getElementById('dfClose').addEventListener('click', U().closeSheet)
    document.getElementById('dfSave').addEventListener('click', async () => {
      const amt = Number(document.getElementById('dfAmt').value)
      const err = document.getElementById('dfErr')
      if (!amt || amt <= 0) { err.textContent = '请输入大于 0 的金额'; return }
      if (!accId) { err.textContent = '请先创建一个资金账户'; return }
      /* 借入账户：借入=转入(从负债账户转出到现金)，还款=转回(现金转入负债账户)
         借出账户：借出=从现金转入债权账户，收回=从债权账户转回现金 */
      let from, to
      if (isIn) {
        if (mode === 'repay') { from = accId; to = a.id }
        else { from = a.id; to = accId }
      } else {
        if (mode === 'repay') { from = a.id; to = accId }
        else { from = accId; to = a.id }
      }
      try {
        await S.addTransaction({
          txn_type: 'transfer', amount: amt,
          occurred_at: F.iso(F.parseInput(document.getElementById('dfTime').value)),
          account_id: from, to_account_id: to, category_id: null,
          note: document.getElementById('dfNote').value.trim() || (label + ' · ' + a.name),
          tags: ['借贷'], reimbursable: false,
        })
        U().closeSheet()
        U().toast('已记录')
        openDebtSheet()
        window.App.refresh()
      } catch (e) { err.textContent = '保存失败：' + (e.message || '') }
    })
  }

  /* ================= 二、账户对账 ================= */
  async function openReconcile(accountId) {
    const balances = await S.accountBalances()
    const row = balances.find(b => b.account.id === accountId)
    if (!row) return
    const a = row.account
    const currency = a.currency || 'CNY'
    const fmtAmount = cents => F.escapeHtml(F.moneySym(cents, F.currencySym(currency)))
    const originalInitial = F.toCents(a.initial_balance)
    const target = { mode: S.mode, uid: S.state && S.state.uid, sourceId: S.state && S.state.sourceId }
    const sameTarget = () => S.mode === target.mode && (S.state && S.state.uid) === target.uid &&
      (S.state && S.state.sourceId) === target.sourceId
    const log = readJson(RECON_LOG, []).filter(x => x.accountId === accountId).slice(-5).reverse()

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">对账 · ' + F.escapeHtml(a.name) + '</span><button id="rcClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="small muted">当前账面余额</div>' +
      '<div class="num" style="font-size:26px;font-weight:800">' + fmtAmount(row.balance) + ' <span class="small">' + F.escapeHtml(currency) + '</span></div>' +
      '</div>' +
      '<div class="field"><label>实际余额（' + F.escapeHtml(currency) + '）</label><input id="rcReal" class="input num" type="number" step="0.01" inputmode="decimal" placeholder="填入银行卡 / 钱包里的真实金额"></div>' +
      '<div class="small muted" id="rcHint" style="margin:-4px 0 12px">差额会写进期初余额并影响历史余额，请先检查漏记或重复账目。</div>' +
      '<div class="err" id="rcErr"></div>' +
      '<button class="btn block" id="rcSave">校准余额</button>' +
      (log.length ? '<div class="divider">最近校准</div>' + log.map(x =>
        '<div class="kv"><span>' + F.escapeHtml(x.at.slice(0, 16).replace('T', ' ')) + '</span>' +
        '<span class="num small">' + fmtAmount(x.from) + ' → ' + fmtAmount(x.to) + '</span></div>').join('') : '')
    )
    const inp = document.getElementById('rcReal')
    inp.addEventListener('input', () => {
      const v = inp.value.trim()
      const hint = document.getElementById('rcHint')
      if (v === '') { hint.textContent = '差额会写进期初余额并影响历史余额，请先检查漏记或重复账目。'; return }
      const diff = F.toCents(Number(v)) - row.balance
      hint.innerHTML = diff === 0 ? '和账面一致，无需调整 ' + ic('check') + ''
        : '差额 <b class="num">' + (diff > 0 ? '+' : '-') + fmtAmount(Math.abs(diff)) + '</b>，将写入期初余额并影响历史余额'
    })
    document.getElementById('rcClose').addEventListener('click', U().closeSheet)
    document.getElementById('rcSave').addEventListener('click', async () => {
      const v = document.getElementById('rcReal').value.trim()
      const err = document.getElementById('rcErr')
      if (v === '') { err.textContent = '请填写实际余额'; return }
      if (!Number.isFinite(Number(v))) { err.textContent = '请输入有效余额'; return }
      const real = F.toCents(Number(v))
      const diff = real - row.balance
      if (diff === 0) { U().closeSheet(); U().toast('账面一致，无需调整'); return }
      const button = document.getElementById('rcSave')
      button.disabled = true
      try {
        const current = (await S.accountBalances()).find(b => String(b.account.id) === String(a.id))
        if (!sameTarget() || !current || current.balance !== row.balance || F.toCents(current.account.initial_balance) !== originalInitial ||
            (current.account.currency || 'CNY') !== currency) {
          err.textContent = '账户余额或信息已变化，请关闭后重新对账。'
          return
        }
        if (!confirm('将修改期初余额并影响历史余额。请先检查漏记或重复账目，确定继续校准？')) return
        const newInit = originalInitial + diff
        await S.updateAccount(a.id, { initial_balance: newInit / 100 })
        const lg = readJson(RECON_LOG, [])
        lg.push({ accountId: a.id, at: new Date().toISOString(), from: row.balance, to: real })
        writeJson(RECON_LOG, lg.slice(-200))
        U().closeSheet()
        U().toast('已校准，账面与实际一致')
        window.App.refresh()
      } catch (e) { err.textContent = '校准失败：' + (e.message || '') }
      finally { button.disabled = false }
    })
  }

  /* ================= 三、预算增强（月 / 周 / 年 + 自动预算） ================= */
  function periodKey(kind, date) {
    const d = date || new Date()
    if (kind === 'year') return String(d.getFullYear())
    if (kind === 'week') {
      /* ISO 周：周四所在年份 + 周序 */
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7))
      const week1 = new Date(t.getFullYear(), 0, 4)
      const no = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
      return t.getFullYear() + '-W' + F.pad2(no)
    }
    return F.monthKey(d)
  }
  function periodRange(kind, date) {
    const d = date || new Date()
    if (kind === 'year') return { from: F.iso(new Date(d.getFullYear(), 0, 1)), to: F.iso(new Date(d.getFullYear() + 1, 0, 1)) }
    if (kind === 'week') {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      const off = (t.getDay() + 6) % 7
      const s = new Date(t); s.setDate(s.getDate() - off)
      const e = new Date(s); e.setDate(e.getDate() + 7)
      return { from: F.iso(s), to: F.iso(e) }
    }
    return { from: F.iso(F.monthStart(d.getFullYear(), d.getMonth() + 1)), to: F.iso(F.monthEnd(d.getFullYear(), d.getMonth() + 1)) }
  }
  function periodLabel(kind, date) {
    const d = date || new Date()
    if (kind === 'year') return d.getFullYear() + ' 年'
    if (kind === 'week') return '第 ' + periodKey('week', d).split('-W')[1] + ' 周'
    return (d.getMonth() + 1) + ' 月'
  }
  function prevPeriodDate(kind, date) {
    const d = new Date((date || new Date()).getTime())
    if (kind === 'year') d.setFullYear(d.getFullYear() - 1)
    else if (kind === 'week') d.setDate(d.getDate() - 7)
    else d.setMonth(d.getMonth() - 1)
    return d
  }

  function autoConfig() { return readJson(AUTOBUDGET, {}) }
  function setAutoConfig(kind, cfg) {
    const c = autoConfig(); c[kind] = cfg; writeJson(AUTOBUDGET, c)
  }

  /* 在打开应用时按规则生成本期预算（基础=固定额，累积=上期剩余滚存，纠偏=上期超支扣减） */
  async function applyAutoBudget() {
    const cfg = autoConfig()
    let made = 0
    for (const kind of ['month', 'week', 'year']) {
      const c = cfg[kind]
      if (!c || !c.on || !c.amount) continue
      const key = periodKey(kind)
      if (S.budgetOf(key, null) != null && F.toCents(S.budgetOf(key, null)) > 0) continue
      let amount = Number(c.amount)
      if (c.mode !== 'basic') {
        const prev = prevPeriodDate(kind)
        const prevKey = periodKey(kind, prev)
        const prevBudget = S.budgetOf(prevKey, null)
        const r = periodRange(kind, prev)
        const sum = await S.monthlySummary(r.from, r.to).catch(() => [])
        let spent = 0
        ;(sum || []).forEach(m => { spent += F.toCents(m.expense) })
        if (prevBudget != null && F.toCents(prevBudget) > 0) {
          const left = F.toCents(prevBudget) - spent
          amount = c.mode === 'growing' ? Number(c.amount) + Math.max(0, left) : Number(c.amount) + left
        }
      }
      if (amount > 0) {
        await S.setBudget(key, null, amount)
        made++
      }
    }
    return made
  }

  async function openBudgetCenter() {
    const cfg = autoConfig()
    const today = new Date()
    const cards = []
    for (const kind of ['month', 'week', 'year']) {
      const key = periodKey(kind, today)
      const r = periodRange(kind, today)
      const total = S.budgetOf(key, null)
      const sum = await S.monthlySummary(r.from, r.to).catch(() => [])
      let spent = 0
      ;(sum || []).forEach(m => { spent += F.toCents(m.expense) })
      const limit = total != null ? F.toCents(total) : 0
      const pct = limit > 0 ? Math.min(100, spent / limit * 100) : 0
      const cls = limit > 0 && spent > limit ? 'over' : pct > 80 ? 'warn' : ''
      const a = cfg[kind]
      cards.push('<div class="card">' +
        '<div class="between" style="margin-bottom:8px"><b>' + periodLabel(kind, today) + '预算</b>' +
        '<span class="small muted">' + key + '</span></div>' +
        (limit > 0
          ? '<div class="row" style="justify-content:space-between;font-size:13px"><span>已用 ¥' + F.yuan(spent) + '</span>' +
            '<span class="num">' + (spent / limit * 100).toFixed(0) + '%' + (spent > limit ? ' · 超 ¥' + F.yuan(spent - limit) : ' · 剩 ¥' + F.yuan(limit - spent)) + '</span></div>' +
            '<div class="progress ' + cls + '" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>'
          : '<div class="small muted">未设置</div>') +
        '<div class="row" style="gap:8px;margin-top:10px">' +
        '<input class="input num grow" style="height:38px" type="number" min="0" step="1" inputmode="decimal" placeholder="额度（元）" value="' + (limit > 0 ? (limit / 100) : '') + '" data-bk="' + kind + '">' +
        '<button class="btn sm" data-bksave="' + kind + '" style="flex:none">保存</button>' +
        '</div>' +
        (a && a.on ? '<div class="small" style="color:var(--brand);margin-top:6px">' + ic('robot') + ' 自动预算已开启 · ' +
          (a.mode === 'growing' ? '累积' : a.mode === 'corrected' ? '纠偏' : '基础') + ' · 基准 ¥' + F.yuan(F.toCents(a.amount)) + '</div>' : '') +
        '</div>')
    }

    const autoHtml = ['month', 'week', 'year'].map(kind => {
      const a = cfg[kind] || { on: false, mode: 'basic', amount: 0 }
      return '<div class="field"><label>' + periodLabel(kind, today) + '自动预算</label>' +
        '<div class="row" style="gap:8px">' +
        '<select class="select" style="width:110px;flex:none" data-abon="' + kind + '">' +
        '<option value="off"' + (!a.on ? ' selected' : '') + '>关闭</option>' +
        '<option value="basic"' + (a.on && a.mode === 'basic' ? ' selected' : '') + '>基础</option>' +
        '<option value="growing"' + (a.on && a.mode === 'growing' ? ' selected' : '') + '>累积</option>' +
        '<option value="corrected"' + (a.on && a.mode === 'corrected' ? ' selected' : '') + '>纠偏</option>' +
        '</select>' +
        '<input class="input num grow" type="number" min="0" step="1" inputmode="decimal" placeholder="基准额度" value="' + (a.amount ? a.amount : '') + '" data-abamt="' + kind + '">' +
        '</div></div>'
    }).join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">预算中心</span><button id="bcClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:12px">支持月 / 周 / 年三种周期。自动预算会在新周期开始时按规则生成本期额度。</div>' +
      cards.join('') +
      '<div class="card"><div class="between" style="margin-bottom:10px"><b>' + ic('robot') + ' 自动预算</b>' +
      '<span class="tiny muted">累积=上期剩余滚存 · 纠偏=上期超支扣减</span></div>' + autoHtml +
      '<button class="btn block" id="bcAutoSave">保存自动预算设置</button></div>' +
      '<button class="btn line block" id="bcCat">按分类设置预算 ›</button>' +
      '<button class="btn ghost block" id="bcCal" style="margin-top:8px">预算日历 ›</button>'
    )
    document.getElementById('bcClose').addEventListener('click', U().closeSheet)
    document.getElementById('bcCat').addEventListener('click', () => openCategoryBudget())
    const bcal = document.getElementById('bcCal')
    if (bcal) bcal.addEventListener('click', () => openBudgetCalendar())
    document.querySelectorAll('#sheet [data-bksave]').forEach(b => {
      b.addEventListener('click', async () => {
        const kind = b.getAttribute('data-bksave')
        const inp = document.querySelector('#sheet [data-bk="' + kind + '"]')
        const v = inp.value.trim()
        try {
          await S.setBudget(periodKey(kind, today), null, v === '' ? 0 : Number(v))
          U().toast('已保存')
          openBudgetCenter()
          window.App.refresh()
        } catch (e) { U().toast('保存失败') }
      })
    })
    document.getElementById('bcAutoSave').addEventListener('click', () => {
      const c = {}
      ;['month', 'week', 'year'].forEach(kind => {
        const sel = document.querySelector('#sheet [data-abon="' + kind + '"]')
        const amt = document.querySelector('#sheet [data-abamt="' + kind + '"]')
        const v = sel.value
        c[kind] = { on: v !== 'off', mode: v === 'off' ? 'basic' : v, amount: Number(amt.value || 0) }
      })
      writeJson(AUTOBUDGET, c)
      U().toast('自动预算已保存')
      openBudgetCenter()
    })
  }

  /* ================= 四、信用卡管家（额度 / 账单日 / 还款日） ================= */
  const CARD_META = 'ledger10_card_meta'   /* { [accountId]: { limit, billDay, dueDay } } */

  function isCredit(a) { return !!a && a.kind === 'credit' }
  function cardMetaAll() { return readJson(CARD_META, {}) }
  function setCardMeta(id, patch) {
    const m = cardMetaAll()
    m[id] = Object.assign({}, m[id] || {}, patch)
    writeJson(CARD_META, m)
  }
  function clearCardMeta(id) {
    const m = cardMetaAll()
    delete m[id]
    writeJson(CARD_META, m)
  }

  /* 下一个「每月 day 号」（今天当天算今天），day 取 1..28 避免月末错位 */
  function nextMonthly(day) {
    const d = new Date()
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const dd = Math.min(28, Math.max(1, Number(day) || 1))
    let t = new Date(today.getFullYear(), today.getMonth(), dd)
    if (t < today) t = new Date(t.getFullYear(), t.getMonth() + 1, dd)
    return t
  }
  function daysUntil(date) {
    const a = new Date(); a.setHours(0, 0, 0, 0)
    return Math.round((date - a) / 86400000)
  }

  /* balances 可由调用方传入，避免在同一屏里重复算一遍账户余额 */
  async function listCards(balances) {
    const list = balances || await S.accountBalances()
    const balMap = {}
    list.forEach(b => { balMap[b.account.id] = b.balance })
    const meta = cardMetaAll()
    return S.allAccounts().filter(isCredit).map(a => {
      const bal = balMap[a.id] || 0
      const used = Math.max(0, -bal)
      const m = meta[a.id] || {}
      const limit = m.limit != null ? F.toCents(m.limit) : 0
      const billDay = m.billDay || null
      const dueDay = m.dueDay || null
      return {
        account: a,
        balance: bal,
        used,
        limit,
        available: limit > 0 ? Math.max(0, limit - used) : 0,
        pct: limit > 0 ? Math.min(100, used / limit * 100) : 0,
        billDay,
        dueDay,
        nextBill: billDay ? nextMonthly(billDay) : null,
        nextDue: dueDay ? nextMonthly(dueDay) : null,
      }
    }).sort((x, y) => y.used - x.used)
  }

  async function openCardSheet() {
    const cards = await listCards()
    const totalUsed = cards.reduce((s, c) => s + c.used, 0)
    const totalLimit = cards.reduce((s, c) => s + c.limit, 0)

    const rows = cards.map(c => {
      const dueDays = c.nextDue ? daysUntil(c.nextDue) : null
      const urgent = dueDays != null && c.used > 0 && dueDays <= 3
      return '<div class="goal-card">' +
        '<div class="top"><span style="font-size:20px">💳</span>' +
        '<div class="grow"><div class="name">' + F.escapeHtml(c.account.name) + '</div>' +
        '<div class="deadline">' +
        (c.billDay ? '账单日 每月 ' + c.billDay + ' 号' : '未设账单日') +
        (c.dueDay ? ' · 还款日 每月 ' + c.dueDay + ' 号' : '') +
        (dueDays != null && c.used > 0 ? ' · <b style="color:' + (urgent ? 'var(--expense)' : 'var(--sub)') + '">' +
          (dueDays === 0 ? '今天到期' : dueDays + ' 天后到期') + '</b>' : '') +
        '</div></div>' +
        '<div class="num" style="font-weight:700;text-align:right">¥' + F.yuan(c.used) +
        '<div class="tiny muted" style="font-weight:400">' + (c.limit > 0 ? '额度 ¥' + F.yuan(c.limit) : '未设额度') + '</div></div></div>' +
        (c.limit > 0
          ? '<div class="progress' + (c.pct >= 90 ? ' over' : c.pct >= 70 ? ' warn' : '') + '"><i style="width:' + c.pct.toFixed(1) + '%"></i></div>' +
            '<div class="tiny muted" style="margin-top:4px">可用 ¥' + F.yuan(c.available) + ' · 已用 ' + c.pct.toFixed(0) + '%</div>'
          : '') +
        '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="btn sm ghost grow" data-ccpay="' + c.account.id + '">还款</button>' +
        '<button class="btn sm line grow" data-ccset="' + c.account.id + '">设置</button>' +
        '</div></div>'
    }).join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">信用卡管家</span><button id="ccClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none;display:flex;gap:12px">' +
      '<div class="grow"><div class="small muted">已用额度</div><div class="num" style="font-size:19px;font-weight:800;color:var(--expense)">¥' + F.yuan(totalUsed) + '</div></div>' +
      '<div class="grow"><div class="small muted">可用额度</div><div class="num" style="font-size:19px;font-weight:800;color:var(--income)">¥' + F.yuan(Math.max(0, totalLimit - totalUsed)) + '</div></div>' +
      '</div>' +
      (rows || '<div class="empty" style="padding:24px"><div class="big">💳</div><div>还没有信用卡账户</div>' +
        '<div class="small" style="margin-top:6px">在「新建账户」里把类型选成「信用卡」，就能在这里管额度了</div></div>') +
      '<button class="btn ghost block" id="ccPlan" style="margin-top:10px">多还一点 · 债务清零计划</button>' +
      '<div class="hint">还款用账户转账记录，不会重复计入当月支出；额度只保存在本机，不上传</div>'
    )
    document.getElementById('ccClose').addEventListener('click', U().closeSheet)
    const ccp = document.getElementById('ccPlan')
    if (ccp) ccp.addEventListener('click', () => openDebtPlan())
    document.querySelectorAll('#sheet [data-ccset]').forEach(b =>
      b.addEventListener('click', () => openCardEditor(Number(b.getAttribute('data-ccset')))))
    document.querySelectorAll('#sheet [data-ccpay]').forEach(b =>
      b.addEventListener('click', () => openCardRepay(Number(b.getAttribute('data-ccpay')))))
  }

  function openCardEditor(accountId) {
    const a = S.allAccounts().find(x => x.id === accountId)
    if (!a) return
    const m = cardMetaAll()[accountId] || {}
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">信用卡设置 · ' + F.escapeHtml(a.name) + '</span><button id="ceClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>信用额度（元）</label><input id="ceLimit" class="input num" type="number" min="0" step="100" inputmode="decimal" placeholder="如 20000" value="' + (m.limit != null ? m.limit : '') + '"></div>' +
      '<div class="field"><label>账单日（每月几号，1–28）</label><input id="ceBill" class="input num" type="number" min="1" max="28" step="1" inputmode="numeric" placeholder="如 5" value="' + (m.billDay || '') + '"></div>' +
      '<div class="field"><label>还款日（每月几号，1–28）</label><input id="ceDue" class="input num" type="number" min="1" max="28" step="1" inputmode="numeric" placeholder="如 25" value="' + (m.dueDay || '') + '"></div>' +
      '<div class="small muted" style="margin:-4px 0 12px">只支持 1–28 号，避开 29/30/31 造成的月末错位。</div>' +
      '<div class="err" id="ceErr"></div>' +
      '<button class="btn block" id="ceSave">保存</button>' +
      '<button class="btn ghost block" id="ceClear" style="margin-top:8px">清除这张卡的信息</button>'
    )
    document.getElementById('ceClose').addEventListener('click', U().closeSheet)
    document.getElementById('ceSave').addEventListener('click', () => {
      const lim = document.getElementById('ceLimit').value.trim()
      const bill = document.getElementById('ceBill').value.trim()
      const due = document.getElementById('ceDue').value.trim()
      const clamp = (v) => {
        const n = Number(v)
        if (!n) return null
        return Math.min(28, Math.max(1, Math.round(n)))
      }
      setCardMeta(accountId, {
        limit: lim === '' ? null : Number(lim),
        billDay: clamp(bill),
        dueDay: clamp(due),
      })
      U().closeSheet()
      U().toast('已保存')
      openCardSheet()
      window.App.refresh()
    })
    document.getElementById('ceClear').addEventListener('click', () => {
      if (!confirm('清除这张卡的额度与账单日信息？（账目不受影响）')) return
      clearCardMeta(accountId)
      U().closeSheet()
      U().toast('已清除')
      openCardSheet()
    })
  }

  /* 还款：从资金账户转账到信用卡，天然不进收支统计 */
  async function openCardRepay(accountId) {
    const a = S.allAccounts().find(x => x.id === accountId)
    if (!a) return
    const accs = S.accounts().filter(x => !isCredit(x) && !isDebtAccount(x))
    const balances = await S.accountBalances()
    const row = balances.find(b => b.account.id === accountId)
    const owed = row ? Math.max(0, -row.balance) : 0
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">还款 · ' + F.escapeHtml(a.name) + '</span><button id="cpClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="small muted">当前待还</div>' +
      '<div class="num" style="font-size:26px;font-weight:800;color:var(--expense)">¥' + F.yuan(owed) + '</div></div>' +
      '<div class="field"><label>付款账户</label><div class="chips" id="cpAccs">' +
      (accs.length
        ? accs.map((x, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-ca="' + x.id + '">' + F.escapeHtml(x.icon) + ' ' + F.escapeHtml(x.name) + '</button>').join('')
        : '<span class="small muted">还没有可用的付款账户</span>') +
      '</div></div>' +
      '<div class="field"><label>还款金额（元）</label><input id="cpAmt" class="input num" type="number" min="0.01" step="0.01" inputmode="decimal" value="' + (owed > 0 ? (owed / 100).toFixed(2) : '') + '"></div>' +
      '<div class="field"><label>时间</label><input id="cpTime" class="input" type="datetime-local" value="' + F.localInput(new Date()) + '"></div>' +
      '<div class="err" id="cpErr"></div>' +
      '<button class="btn block" id="cpSave">确认还款</button>'
    )
    let accId = accs.length ? accs[0].id : null
    document.querySelectorAll('#cpAccs .chip').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#cpAccs .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        accId = Number(b.getAttribute('data-ca'))
      })
    })
    document.getElementById('cpClose').addEventListener('click', U().closeSheet)
    document.getElementById('cpSave').addEventListener('click', async () => {
      const amt = Number(document.getElementById('cpAmt').value)
      const err = document.getElementById('cpErr')
      if (!amt || amt <= 0) { err.textContent = '请输入大于 0 的金额'; return }
      if (!accId) { err.textContent = '请先创建一个资金账户'; return }
      try {
        await S.addTransaction({
          txn_type: 'transfer', amount: amt,
          occurred_at: F.iso(F.parseInput(document.getElementById('cpTime').value)),
          account_id: accId, to_account_id: a.id, category_id: null,
          note: '还信用卡 · ' + a.name, tags: ['信用卡'], reimbursable: false,
        })
        U().closeSheet()
        U().toast('还款已记录')
        openCardSheet()
        window.App.refresh()
      } catch (e) { err.textContent = '保存失败：' + (e.message || '') }
    })
  }

  /* ---- 信封预算（从 ui.js 搬来：首屏 gzip 不允许它留在关键路径） ---- */
  const esc = F.escapeHtml
  const openSheet = (h) => U().openSheet(h)
  const closeSheet = () => U().closeSheet()
  const toast = (m) => U().toast(m)
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s))

  /* ---------- 分类预算：信封模型（待分配 + 结转 + 挪钱） ----------
     Actual Budget 的启发：预算页只回答一个问题「我还有多少钱可以分配」。
     总预算 = 本月可用；分类额度合计 = 已分配；差额 = 未分配。
     结转按上月「额度 - 已花」动态算，不写库（表结构不可改），开关存本机。 */
  const ROLL_KEY = 'ledger10_rollover'
  function rollMap() {
    try { return JSON.parse(localStorage.getItem(ROLL_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function setRoll(id, on) {
    const m = rollMap()
    if (on) m[id] = 1
    else delete m[id]
    try { localStorage.setItem(ROLL_KEY, JSON.stringify(m)) } catch (e) { /* 忽略 */ }
  }
  /* 大类（含子类）合计 */
  function rootSpent(rows) {
    const m = {}
    ;(rows || []).forEach(r => {
      if (r.category_id == null) return
      const c = S.category(r.category_id)
      if (!c) return
      const rid = c.parent_id || c.id
      m[rid] = (m[rid] || 0) + F.toCents(r.total)
    })
    return m
  }

  async function openCategoryBudget() {
    const now = new Date()
    const monthKey = F.monthKey(now)
    const from = F.iso(F.monthStart(now.getFullYear(), now.getMonth() + 1))
    const to = F.iso(F.monthEnd(now.getFullYear(), now.getMonth() + 1))
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevKey = F.monthKey(prev)
    const pFrom = F.iso(F.monthStart(prev.getFullYear(), prev.getMonth() + 1))
    const pTo = F.iso(F.monthEnd(prev.getFullYear(), prev.getMonth() + 1))
    const [cats, pCats] = await Promise.all([
      S.categorySummary(from, to, 'expense').catch(() => []),
      S.categorySummary(pFrom, pTo, 'expense').catch(() => []),
    ])
    const spentMap = rootSpent(cats)
    const pSpentMap = rootSpent(pCats)
    const roots = S.rootCategories('expense')
    const roll = rollMap()

    /* 结转额：上月有额度才谈得上结余；上月超支则记负数（从本月扣） */
    const carryOf = c => {
      if (!roll[c.id]) return 0
      const pb = S.budgetOf(prevKey, c.id)
      const base = pb != null ? F.toCents(pb) : 0
      if (!(base > 0)) return 0
      return base - (pSpentMap[c.id] || 0)
    }
    const baseOf = c => { const b = S.budgetOf(monthKey, c.id); return b != null ? F.toCents(b) : 0 }

    const totalRaw = S.budgetOf(monthKey, null)
    const total = totalRaw != null ? F.toCents(totalRaw) : 0
    let assigned = 0
    roots.forEach(c => { assigned += baseOf(c) })
    const unassigned = total - assigned

    const rows = roots.map(c => {
      const base = baseOf(c)
      const carry = carryOf(c)
      const eff = base + carry
      const spent = spentMap[c.id] || 0
      const over = eff > 0 && spent > eff
      const bits = ['已花 ¥' + F.yuan(spent)]
      if (carry) bits.push('结转 ' + (carry > 0 ? '+' : '−') + '¥' + F.yuan(Math.abs(carry)))
      if (over) bits.push('超 ¥' + F.yuan(spent - eff))
      return '<div class="row" style="gap:8px;margin-bottom:12px;align-items:center">' +
        '<span style="flex:none">' + esc(c.icon) + '</span>' +
        '<span class="grow" style="min-width:0"><span class="ellipsis">' + esc(c.name) + '</span>' +
        '<span class="tiny ' + (over ? '' : 'muted') + '" style="display:block' + (over ? ';color:var(--expense)' : '') + '">' + bits.join(' · ') + '</span></span>' +
        '<input class="input num" style="width:96px;flex:none;height:38px" type="number" min="0" step="1" inputmode="decimal" ' +
        'placeholder="未设置" value="' + (base > 0 ? base / 100 : '') + '" data-catbudget="' + c.id + '">' +
        '<button class="roll-btn' + (roll[c.id] ? ' on' : '') + '" data-roll="' + c.id + '" aria-pressed="' + (roll[c.id] ? 'true' : 'false') +
        '" aria-label="' + esc(c.name) + ' 上月结余是否滚入本月" title="上月结余滚入本月">↻</button>' +
        '</div>'
    }).join('')

    const summary = '<div class="card" style="box-shadow:none;background:var(--brand-soft)">' +
      '<div class="small muted">' + (total > 0 ? '本月可用（总预算）' : '还没设本月总预算') + '</div>' +
      (total > 0
        ? '<div class="num" style="font-size:26px;font-weight:800">¥' + F.yuan(total) + '</div>' +
          '<div class="small">已分配 <span class="num">¥' + F.yuan(assigned) + '</span> · 未分配 ' +
          '<b class="num" style="color:' + (unassigned < 0 ? 'var(--expense)' : 'var(--income)') + '">¥' + F.yuan(Math.abs(unassigned)) + '</b>' +
          (unassigned < 0 ? '（超分配）' : '') + '</div>'
        : '<div class="small" style="margin-top:4px">设一个总额度，就能看到「已分配 / 未分配」，也才有「本月还能花」。</div>') +
      '<div class="row" style="gap:8px;margin-top:10px">' +
      '<button class="btn sm line grow" id="cbTotal">' + (total > 0 ? '调整总预算' : '设总预算') + '</button>' +
      (total > 0 && assigned > 0 ? '<button class="btn sm line grow" id="cbMove">挪钱</button>' : '') +
      '</div></div>'

    openSheet(
      '<div class="sheet-head"><span class="sheet-title">预算 · ' + monthKey + '</span><button id="cbClose" class="btn sm line">关闭</button></div>' +
      summary +
      '<div class="divider">分类额度</div>' +
      '<div class="small muted" style="margin-bottom:10px">留空=不限制。点 <b>↻</b> 让该分类上月结余滚入本月（超支则从本月扣）。</div>' +
      rows +
      '<button class="btn block" id="cbSave">保存分类额度</button>'
    )
    $('#cbClose').addEventListener('click', closeSheet)
    $('#cbTotal').addEventListener('click', () => window.UI.openMonthBudget(window.App.state))
    const moveBtn = $('#cbMove')
    if (moveBtn) moveBtn.addEventListener('click', () => openBudgetMove(monthKey, roots, spentMap, total, assigned))
    $$('#sheet [data-roll]').forEach(b => {
      b.addEventListener('click', () => {
        const id = Number(b.getAttribute('data-roll'))
        setRoll(id, !rollMap()[id])
        openCategoryBudget()
      })
    })
    $('#cbSave').addEventListener('click', async () => {
      const inputs = $$('#sheet [data-catbudget]')
      try {
        for (const inp of inputs) {
          const cid = Number(inp.getAttribute('data-catbudget'))
          const v = inp.value.trim()
          await S.setBudget(monthKey, cid, v === '' ? 0 : Number(v))
        }
        closeSheet()
        toast('分类额度已保存')
        window.App.refresh()
      } catch (e) { toast('保存失败') }
    })
  }

  /* 分类之间挪钱：Actual 的「roll with the punches」——
     某类超支了不该逼用户改总预算，从别的类或未分配里挪过去就行。 */
  function openBudgetMove(monthKey, roots, spentMap, total, assigned) {
    const opts = (skip) => roots.filter(c => c.id !== skip).map(c => {
      const b = S.budgetOf(monthKey, c.id)
      const base = b != null ? F.toCents(b) : 0
      const left = base - (spentMap[c.id] || 0)
      return '<option value="' + c.id + '">' + esc(c.name) + (base > 0 ? '（剩 ¥' + F.yuan(Math.max(0, left)) + '）' : '（未设）') + '</option>'
    }).join('')
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">挪钱</span><button id="bmClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:12px">从「未分配」或某个分类挪额度给另一个分类，总预算不变。</div>' +
      '<div class="field"><label>从哪来</label><select id="bmFrom" class="select">' +
      '<option value="0">未分配额度（¥' + F.yuan(Math.max(0, total - assigned)) + '）</option>' + opts(0) + '</select></div>' +
      '<div class="field"><label>给谁</label><select id="bmTo" class="select">' + opts(0) + '</select></div>' +
      '<div class="field"><label>金额（元）</label><input id="bmAmt" class="input num" type="number" min="1" step="1" inputmode="decimal" placeholder="100"></div>' +
      '<div class="err" id="bmErr"></div><button class="btn block" id="bmSave">确认挪动</button>'
    )
    $('#bmClose').addEventListener('click', closeSheet)
    $('#bmSave').addEventListener('click', async () => {
      const err = $('#bmErr')
      const fromId = Number($('#bmFrom').value)
      const toId = Number($('#bmTo').value)
      const amt = Number($('#bmAmt').value)
      if (!(amt > 0)) { err.textContent = '请输入大于 0 的金额'; return }
      if (fromId === toId) { err.textContent = '来源和目标不能是同一个分类'; return }
      const cents = F.toCents(amt)
      const cur = id => { const b = S.budgetOf(monthKey, id); return b != null ? F.toCents(b) : 0 }
      if (fromId) {
        const left = cur(fromId) - (spentMap[fromId] || 0)
        if (cents > left) { err.textContent = '来源分类最多还能挪 ¥' + F.yuan(Math.max(0, left)); return }
      } else if (cents > total - assigned) {
        err.textContent = '未分配只剩 ¥' + F.yuan(Math.max(0, total - assigned)); return
      }
      try {
        if (fromId) await S.setBudget(monthKey, fromId, (cur(fromId) - cents) / 100)
        await S.setBudget(monthKey, toId, (cur(toId) + cents) / 100)
        closeSheet()
        toast('已挪动 ¥' + F.yuan(cents))
        window.App.refresh()
      } catch (e) { err.textContent = '挪动失败，请重试' }
    })
  }

  /* ---------- 未来 30 天预测（v4 建议 3.2 / PocketSmith forecast 轻量版） ----------
     首页锚点只回答「今天还能花多少」，点进来要能回答下一个问题：
     「接下来这 30 天，钱够不够」。做法是把周期账目按日排开，
     再叠上本月预算剩余，最后给一个预计余额。
     国内产品基本没人做这个 —— 它不需要银行直连，只靠周期规则就能算。 */
  async function forecastData(days) {
    const span = days || 30
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + span)
    const items = []
    let inflow = 0
    let outflow = 0
    const accounts = {}
    S.allAccounts().forEach(a => { accounts[a.id] = a })
    const isCash = a => !!a && !isCredit(a) && !isDebtAccount(a)
    const baseAmount = (cents, a) => F.toBase(cents, (a && a.currency) || 'CNY')
    try {
      const rules = await S.listRecurring()
      ;(rules || []).forEach(r => {
        if (!r.active) return
        /* 一条规则在窗口内可能到期多次（按日/按周），逐次推进 */
        let due = F.nextDue(r.last_run_date || null, String(r.start_date).slice(0, 10), r.freq)
        let guard = 0
        while (due && guard++ < 60) {
          const d = F.ymdLocal(due)
          if (d >= end) break
          const amount = F.toCents(r.amount)
          const fromAccount = accounts[r.account_id]
          const toAccount = accounts[r.to_account_id]
          let cents = baseAmount(amount, fromAccount)
          let cashDelta = 0
          if (r.txn_type === 'transfer') {
            /* 现金账户互转不改变现金总额；还信用卡/借贷则按现金一侧的币种折算。 */
            if (isCash(fromAccount) && !isCash(toAccount)) cashDelta = -cents
            else if (!isCash(fromAccount) && isCash(toAccount)) {
              cents = baseAmount(amount, toAccount)
              cashDelta = cents
            }
          } else if (isCash(fromAccount)) {
            if (r.txn_type === 'income') cashDelta = cents
            else if (r.txn_type === 'expense') cashDelta = -cents
          }
          const name = r.note || (r.category_id ? S.categoryName(r.category_id) : (window.TXN_TYPE_LABEL[r.txn_type] || '周期账目'))
          items.push({
            date: due, name: name, cents: cents,
            dir: cashDelta > 0 ? 'in' : cashDelta < 0 ? 'out' : 'neutral',
            txnType: r.txn_type,
            late: d < today,
          })
          if (cashDelta > 0) inflow += cashDelta
          else if (cashDelta < 0) outflow -= cashDelta
          if (r.freq === 'daily' || r.freq === 'weekly') due = F.nextDue(due, String(r.start_date).slice(0, 10), r.freq)
          else break
        }
      })
    } catch (e) { /* 读不到周期就只算预算部分 */ }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    /* 当前可用现金：所有账户余额合计（信用卡 / 借入借出不算现金） */
    let cash = 0
    try {
      const bal = await S.accountBalances()
      ;(bal || []).forEach(b => {
        const a = b.account || {}
        if (!isCash(a)) return
        cash += baseAmount(Number(b.balance) || 0, a)
      })
    } catch (e) { /* 余额读不到就给 0，预测只显示收支差 */ }
    return { items, inflow, outflow, cash, end, span }
  }

  async function openForecast() {
    const st = window.App.state
    const sym = esc(F.currencySym(F.baseCurrency()))
    const today = new Date()
    const monthKey = F.monthKey(new Date(today.getFullYear(), today.getMonth(), 1))
    const bud = S.budgetOf(monthKey, null)
    const total = bud != null ? F.toCents(bud) : 0
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const daysLeft = Math.max(lastDay - today.getDate() + 1, 1)
    let spent = 0
    try {
      const rows = await S.monthlySummary(F.iso(F.monthStart(today.getFullYear(), today.getMonth() + 1)), F.iso(F.monthEnd(today.getFullYear(), today.getMonth() + 1)))
      ;(rows || []).forEach(r => { spent += F.toCents(r.expense) })
    } catch (e) { /* 忽略 */ }

    const fc = await forecastData(30)
    const remain = total - spent
    /* 本月剩余天数内还要扣的固定支出 */
    const monthEnd = F.dstr(new Date(today.getFullYear(), today.getMonth(), lastDay))
    const todayStr = F.dstr(today)
    let monthOut = 0
    fc.items.forEach(it => { if (it.dir === 'out' && it.date >= todayStr && it.date <= monthEnd) monthOut += it.cents })
    const daily = total > 0 ? Math.floor((remain - monthOut) / daysLeft) : null
    const projBalance = fc.cash + fc.inflow - fc.outflow

    const head = '<div class="between"><b>未来 30 天</b>' +
      '<span class="small muted">' + F.dstr(today).slice(5) + ' – ' + F.dstr(fc.end).slice(5) + '</span></div>'

    const dailyBlock = total > 0
      ? '<div class="fc-daily"><div class="k">今天还能花</div>' +
        '<div class="v num' + (daily < 0 ? ' over' : '') + '">' + sym + F.yuan(Math.max(daily, 0)) + '</div>' +
        '<div class="small muted">本月还剩 ' + daysLeft + ' 天 · 已用 ' + Math.round(spent / total * 100) + '%' +
        (monthOut > 0 ? ' · 已排期现金流出 ' + sym + F.yuan(monthOut) : '') + '</div></div>'
      : '<div class="fc-daily"><div class="k">还没设本月预算</div>' +
        '<div class="small muted">设了预算才能算出「今天还能花多少」</div>' +
        '<button class="btn sm line" id="fcSetBudget" style="margin-top:8px">设预算</button></div>'

    /* 按日分组 */
    let list = ''
    if (!fc.items.length) {
      list = '<div class="small muted" style="padding:12px 0">未来 30 天没有排期中的周期账目。' +
        '在「我的 · 周期记账」里加一条房租/工资，这里就能排出日历。</div>'
    } else {
      let curDate = ''
      fc.items.forEach(it => {
        if (it.date !== curDate) {
          curDate = it.date
          const d = F.ymdLocal(it.date)
          const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
          const diff = Math.round((d - today) / 86400000)
          const rel = diff < 0 ? '逾期 ' + Math.abs(diff) + ' 天' : diff === 0 ? '今天' : diff === 1 ? '明天' : diff + ' 天后'
          list += '<div class="fc-day">' + it.date.slice(5) + ' 周' + wd + ' · ' + rel + '</div>'
        }
        const label = it.dir === 'neutral' ? '现金总额不变'
          : it.txnType === 'transfer' ? (it.dir === 'in' ? '转入现金' : '转出现金')
          : it.dir === 'in' ? '收入' : '支出'
        const sign = it.dir === 'in' ? '+' : it.dir === 'out' ? '−' : '⇄'
        list += '<div class="list-item fc-row"><div class="ico">' + (it.dir === 'in' ? '💰' : ic('repeat')) + '</div>' +
          '<div class="grow" style="min-width:0"><div class="ellipsis">' + esc(it.name) + '</div>' +
          '<div class="small muted">' + label + (it.late ? ' · 已到期未补记' : '') + '</div></div>' +
          '<span class="num ' + (it.dir === 'neutral' ? 'muted' : it.dir) + '" style="flex:none">' +
          sign + sym + F.yuan(it.cents) + '</span></div>'
      })
    }

    const foot = '<div class="fc-sum">' +
      '<div class="between"><span>预计现金流入</span><span class="num in">+' + sym + F.yuan(fc.inflow) + '</span></div>' +
      '<div class="between"><span>预计现金流出</span><span class="num out">−' + sym + F.yuan(fc.outflow) + '</span></div>' +
      '<div class="between fc-total"><span>30 天后余额</span><span class="num">' + sym + F.yuan(projBalance) + '</span></div>' +
      '<div class="tiny muted" style="margin-top:6px">按当前可用现金 ' + sym + F.yuan(fc.cash) + ' 加上周期账目推算，不含临时消费。</div>' +
      '</div>'

    /* 样式随弹层一起注入：这块只在这个面板里用，放 app.css 会白占首屏 gzip 预算 */
    const css = '<style>' +
      '.fc-daily{background:var(--bg);border-radius:var(--r-md);padding:14px 14px 12px;margin:4px 0 14px}' +
      '.fc-daily .k{font-size:var(--fs-caption);color:var(--sub)}' +
      '.fc-daily .v{font-size:var(--fs-hero);font-weight:750;letter-spacing:-.6px;margin:2px 0 4px}' +
      '.fc-daily .v.over{color:var(--expense)}' +
      '.fc-day{font-size:var(--fs-caption);color:var(--sub);font-weight:600;margin:14px 0 6px;letter-spacing:.02em}' +
      '.fc-row{padding:8px 0}.fc-row .num{font-size:var(--fs-meta);font-weight:650}' +
      '.num.in{color:var(--income)}.num.out{color:var(--expense)}' +
      '.fc-sum{margin-top:16px;padding-top:12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:7px}' +
      '.fc-sum .between{font-size:var(--fs-meta)}' +
      '.fc-sum .fc-total{font-size:var(--fs-body);font-weight:700;padding-top:7px;border-top:1px dashed var(--line)}' +
      '</style>'

    openSheet('<div class="sheet-head"><span class="sheet-title">今天还能花</span>' +
      '<button class="btn sm line" id="fcClose">关闭</button></div>' +
      css + dailyBlock + head + list + foot)

    const cl = $('#fcClose')
    if (cl) cl.addEventListener('click', closeSheet)
    const sb = $('#fcSetBudget')
    if (sb) sb.addEventListener('click', () => { closeSheet(); U().openMonthBudget(st) })
  }


  /* ================= 债务清零计划（对标 YNAB Loan Planner） =================
     从「记录负债」跨到「管理负债」：告诉用户「每月多还 X，能提前几个月、少付多少利息」，
     并按「先还哪张」排出顺序（雪崩法＝利率高的先还，雪球法＝余额小的先还）。
     利率和最低还款没有对应的表字段，存本机 `ledger10_debt_rate`：
       { [accountId]: { apr: 0.18, min: 500 } }   // apr 是年化小数，min 是每月最低还款（元）
     纯本地测算，不改动任何账目。 */
  const DEBT_RATE = 'ledger10_debt_rate'
  const PLAN_EXTRAS = [0, 200, 500, 1000]

  function rateCfg() { return readJson(DEBT_RATE, {}) }
  function setRateCfg(id, patch) {
    const m = rateCfg()
    m[id] = Object.assign({}, m[id] || {}, patch)
    writeJson(DEBT_RATE, m)
  }

  /* 把「信用卡 / 我欠别人」统一成 { id, name, bal(分), apr, min(分) } */
  async function debtItems() {
    const balances = await S.accountBalances()
    const balMap = {}
    balances.forEach(b => { balMap[b.account.id] = b.balance })
    const cfg = rateCfg()
    const out = []
    S.allAccounts().forEach(a => {
      const credit = isCredit(a)
      if (!credit && a.kind !== LOAN_IN) return
      const bal = Math.max(0, -(balMap[a.id] || 0))
      if (bal <= 0) return
      const c = cfg[a.id] || {}
      const apr = c.apr != null ? Number(c.apr) : (credit ? 0.18 : 0.08)
      const min = c.min != null ? F.toCents(c.min) : Math.max(Math.round(bal * 0.05), 10000)
      out.push({ id: a.id, name: a.name, bal: bal, apr: apr, min: min })
    })
    return out
  }

  /* 逐月模拟一篮子债务：每月先计息，再付最低还款，剩下的钱按 order 依次砸到第一张
     还没还清的债上（这正是雪崩 / 雪球法的实际打法）。还不上时返回 null。 */
  function planSim(items, extraCents, order) {
    const list = items.map(d => ({ bal: d.bal, apr: d.apr, min: d.min }))
    let months = 0
    let interest = 0
    while (months < 600) {
      const alive = list.filter(d => d.bal > 0)
      if (!alive.length) break
      months++
      alive.forEach(d => {
        const i = Math.round(d.bal * d.apr / 12)
        interest += i
        d.bal += i
      })
      const seq = alive.slice().sort(order === 'snowball'
        ? (x, y) => x.bal - y.bal
        : (x, y) => y.apr - x.apr)
      seq.forEach(d => { d.bal = Math.max(0, d.bal - Math.min(d.bal, d.min)) })
      let pool = extraCents
      for (let i = 0; i < seq.length && pool > 0; i++) {
        const d = seq[i]
        if (d.bal <= 0) continue
        const pay = Math.min(d.bal, pool)
        d.bal -= pay
        pool -= pay
      }
    }
    if (list.some(d => d.bal > 0)) return null
    return { months: months, interest: interest }
  }

  function planPct(apr) { return (apr * 100).toFixed(1) + '%' }

  /* 面板：一屏回答「总共欠多少、现在要还多久、多还一点能省多少、先还哪张」 */
  let planOrder = 'avalanche'
  let planExtra = 50000

  async function openDebtPlan() {
    const items = await debtItems()
    if (!items.length) { toast('没有需要还的债务，先记一笔信用卡消费或借入'); return }
    renderPlan(items)
  }

  function renderPlan(items) {
    const base = planSim(items, 0, planOrder)
    const plan = planSim(items, planExtra, planOrder)
    const total = items.reduce((s, d) => s + d.bal, 0)
    const seq = items.slice().sort(planOrder === 'snowball'
      ? (x, y) => x.bal - y.bal
      : (x, y) => y.apr - x.apr)

    const cmp = (!base || !plan)
      ? '<div class="small" style="margin-top:8px;color:var(--expense)">按现在的最低还款还盖不住利息，余额会越还越多 —— 先把「最低月还」调高一点。</div>'
      : planExtra > 0
        ? '<div class="small muted" style="margin-top:10px">每月多还 <b>¥' + F.yuan(planExtra) + '</b></div>' +
          '<div class="num" style="font-size:19px;font-weight:800;color:var(--income)">' + plan.months + ' 个月 · 利息 ¥' + F.yuan(plan.interest) + '</div>' +
          '<div class="small" style="margin-top:6px">提前 <b>' + Math.max(0, base.months - plan.months) + ' 个月</b> · 少付 <b>¥' +
          F.yuan(Math.max(0, base.interest - plan.interest)) + '</b> 利息</div>'
        : '<div class="small muted" style="margin-top:10px">下面选一个「每月多还」的档位，就能看到能省多少</div>'

    const rows = seq.map((d, i) =>
      '<div class="row" style="gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--line)">' +
      '<b class="num" style="width:18px;flex:none;color:var(--muted)">' + (i + 1) + '</b>' +
      '<div class="grow" style="min-width:0"><div style="font-weight:600;overflow-wrap:anywhere">' + esc(d.name) + '</div>' +
      '<div class="tiny muted">' + planPct(d.apr) + ' 年化 · 月还 ¥' + F.yuan(d.min) + '</div></div>' +
      '<div class="num" style="flex:none;font-weight:700">¥' + F.yuan(d.bal) + '</div></div>').join('')

    openSheet(
      '<div class="sheet-head"><span class="sheet-title">债务清零计划</span><button id="dpClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="small muted">总共还欠</div>' +
      '<div class="num" style="font-size:22px;font-weight:800">¥' + F.yuan(total) + '</div>' +
      '<div class="small muted" style="margin-top:10px">按现在的最低还款</div>' +
      '<div class="num" style="font-size:17px;font-weight:700">' +
      (base ? base.months + ' 个月 · 利息 ¥' + F.yuan(base.interest) : '永远还不完') + '</div>' +
      cmp + '</div>' +
      '<div class="divider">每月多还</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      PLAN_EXTRAS.map(v => '<button class="chip' + (v * 100 === planExtra ? ' on' : '') + '" data-dpx="' + v + '">' +
        (v === 0 ? '不多还' : '+' + v + ' 元') + '</button>').join('') + '</div>' +
      '<div class="divider">先还哪张</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<button class="chip' + (planOrder === 'avalanche' ? ' on' : '') + '" data-dpo="avalanche">雪崩法 · 利率高的先还</button>' +
      '<button class="chip' + (planOrder === 'snowball' ? ' on' : '') + '" data-dpo="snowball">雪球法 · 余额小的先还</button></div>' +
      rows +
      '<button class="btn ghost block" id="dpRate" style="margin-top:12px">调整利率 / 最低还款</button>' +
      '<div class="hint">算法：每月先计息，再付最低还款，多出来的钱全砸给第一张；利率和最低还款只存本机，不上传</div>'
    )
    document.getElementById('dpClose').addEventListener('click', closeSheet)
    $$('#sheet [data-dpx]').forEach(b => b.addEventListener('click', () => {
      planExtra = Number(b.getAttribute('data-dpx')) * 100
      renderPlan(items)
    }))
    $$('#sheet [data-dpo]').forEach(b => b.addEventListener('click', () => {
      planOrder = b.getAttribute('data-dpo')
      renderPlan(items)
    }))
    const rb = document.getElementById('dpRate')
    if (rb) rb.addEventListener('click', () => openDebtRateEditor(items))
  }

  function openDebtRateEditor(items) {
    const cfg = rateCfg()
    const rows = items.map(d => {
      const c = cfg[d.id] || {}
      const aprPct = c.apr != null ? Number(c.apr) * 100 : d.apr * 100
      const minYuan = c.min != null ? Number(c.min) : Math.round(d.min / 100)
      return '<div class="field"><label>' + esc(d.name) + '</label>' +
        '<div class="row" style="gap:8px">' +
        '<input class="input num grow" data-dpr="' + d.id + '" type="number" step="0.1" min="0" inputmode="decimal" value="' + aprPct.toFixed(1) + '">' +
        '<input class="input num grow" data-dpm="' + d.id + '" type="number" step="1" min="0" inputmode="decimal" value="' + minYuan + '">' +
        '</div><div class="tiny muted">左边是年化利率（%），右边是每月最低还款（元）</div></div>'
    }).join('')
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">利率与最低还款</span><button id="drClose" class="btn sm line">关闭</button></div>' +
      rows +
      '<button class="btn block" id="drSave">保存</button>'
    )
    document.getElementById('drClose').addEventListener('click', () => renderPlan(items))
    document.getElementById('drSave').addEventListener('click', () => {
      items.forEach(d => {
        const r = document.querySelector('[data-dpr="' + d.id + '"]')
        const m = document.querySelector('[data-dpm="' + d.id + '"]')
        const patch = {}
        const apr = r ? Number(r.value) : NaN
        const min = m ? Number(m.value) : NaN
        if (isFinite(apr) && apr >= 0) patch.apr = apr / 100
        if (isFinite(min) && min > 0) patch.min = min
        if (Object.keys(patch).length) setRateCfg(d.id, patch)
      })
      toast('已保存')
      debtItems().then(list => renderPlan(list))
    })
  }

  /* ================= 预算日历（对标 PocketSmith Budget Calendar） =================
     月历一格一天：已发生的收支直接写在格子里，计划中的周期账单用空心点。
     点某天看当天清单，能「补记一笔」；这是「未来 30 天」的月视图版本，共用同一套数据。 */
  const CAL_DOW = ['一', '二', '三', '四', '五', '六', '日']
  const CAL_CSS = '<style>' +
    '.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}' +
    '.cal-dow{text-align:center;font-size:11px;color:var(--muted);padding:2px 0 4px}' +
    '.cal-cell{position:relative;border-radius:var(--r-sm);background:var(--bg);padding:5px 3px 4px;min-height:52px;text-align:center;border:1px solid transparent}' +
    '.cal-cell.empty{background:transparent}' +
    '.cal-cell.today{border-color:var(--brand)}' +
    '.cal-cell.on{border-color:var(--brand);background:var(--brand-soft)}' +
    '.cal-d{font-size:12px;font-weight:600;line-height:1.2}' +
    '.cal-amt{display:block;font-size:10px;line-height:1.3;overflow-wrap:anywhere}' +
    '.cal-amt.out{color:var(--expense)}' +
    '.cal-amt.in{color:var(--income)}' +
    '.cal-dots{display:flex;gap:2px;justify-content:center;margin-top:2px;height:5px}' +
    '.cal-dot{width:4px;height:4px;border-radius:50%;display:inline-block}' +
    '.cal-dot.s{background:var(--text)}' +
    '.cal-dot.h{border:1px solid var(--muted);background:transparent}' +
    '.cal-dayrow{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line)}' +
    '</style>'

  function shortYuan(cents) {
    const v = Math.abs(cents)
    return v >= 100000 ? F.compactYuan(v) : String(Math.round(v / 100))
  }

  async function openBudgetCalendar(y, m) {
    const now = new Date()
    let year = y || now.getFullYear()
    let month = m || (now.getMonth() + 1)
    let pickDay = 0

    async function paint() {
      const first = new Date(year, month - 1, 1)
      const lastDay = new Date(year, month, 0).getDate()
      const lo = F.dstr(first)
      const hi = F.dstr(new Date(year, month - 1, lastDay))
      let rows = []
      try {
        const r = await S.listTransactions({ from: F.iso(first), to: F.iso(new Date(year, month, 1)), limit: 1000 })
        rows = r.rows || []
      } catch (e) { rows = [] }
      const byDay = {}
      const spent = {}
      const earned = {}
      rows.forEach(t => {
        const d = Number(String(t.occurred_at).slice(8, 10))
        if (!d) return
        ;(byDay[d] = byDay[d] || []).push(t)
        const c = F.toCents(t.amount)
        if (t.txn_type === 'expense') spent[d] = (spent[d] || 0) + c
        else if (t.txn_type === 'income') earned[d] = (earned[d] || 0) + c
      })
      /* 计划中的周期账单：按 nextDue 逐次推进，只留本月内的 */
      const planned = {}
      try {
        const rules = (await S.listRecurring()) || []
        rules.forEach(r => {
          if (r.active === false) return
          const start = String(r.start_date || '').slice(0, 10)
          if (!start) return
          let due = F.nextDue(r.last_run_date || null, start, r.freq)
          let guard = 0
          while (due && guard++ < 40) {
            if (due > hi) break
            if (due >= lo) {
              const d = Number(due.slice(8, 10))
              ;(planned[d] = planned[d] || []).push({
                name: r.note || (r.category_id ? S.categoryName(r.category_id) : '周期账目'),
                cents: F.toCents(r.amount),
                dir: r.txn_type === 'income' ? 'in' : 'out',
                due: due,
              })
            }
            if (r.freq === 'daily' || r.freq === 'weekly') due = F.nextDue(due, start, r.freq)
            else break
          }
        })
      } catch (e) { /* 读不到周期就只画已发生的 */ }

      const offset = (first.getDay() + 6) % 7
      let cells = ''
      for (let i = 0; i < offset; i++) cells += '<div class="cal-cell empty"></div>'
      for (let d = 1; d <= lastDay; d++) {
        const sp = spent[d] || 0
        const ea = earned[d] || 0
        const pl = planned[d] || []
        const isToday = year === now.getFullYear() && month === now.getMonth() + 1 && d === now.getDate()
        const amt = sp
          ? '<span class="cal-amt out">-' + shortYuan(sp) + '</span>'
          : ea ? '<span class="cal-amt in">+' + shortYuan(ea) + '</span>' : ''
        const dots = '<span class="cal-dots">' +
          (sp || ea ? '<i class="cal-dot s"></i>' : '') +
          (pl.length ? '<i class="cal-dot h"></i>' : '') + '</span>'
        cells += '<div class="cal-cell' + (isToday ? ' today' : '') + (pickDay === d ? ' on' : '') +
          '" data-cal="' + d + '"><span class="cal-d">' + d + '</span>' + amt + dots + '</div>'
      }

      const totSpent = Object.keys(spent).reduce((s, k) => s + spent[k], 0)
      const totPlan = Object.keys(planned).reduce((s, k) => s + planned[k].filter(x => x.dir === 'out').reduce((a, b) => a + b.cents, 0), 0)
      const dayName = pickDay ? (month + ' 月 ' + pickDay + ' 日') : '点某一天看当天明细'

      openSheet(
        CAL_CSS +
        '<div class="sheet-head"><span class="sheet-title">预算日历</span><button id="calClose" class="btn sm line">关闭</button></div>' +
        '<div class="row" style="align-items:center;gap:8px;margin-bottom:8px">' +
        '<button class="btn sm line" id="calPrev" style="flex:none">‹</button>' +
        '<b class="grow" style="text-align:center">' + year + ' 年 ' + month + ' 月</b>' +
        '<button class="btn sm line" id="calNext" style="flex:none">›</button></div>' +
        '<div class="small muted" style="margin-bottom:10px">已花 <b>¥' + F.yuan(totSpent) + '</b>' +
        (totPlan ? ' · 还有 <b>¥' + F.yuan(totPlan) + '</b> 计划支出' : '') + '</div>' +
        '<div class="cal-grid">' + CAL_DOW.map(w => '<div class="cal-dow">' + w + '</div>').join('') + cells + '</div>' +
        '<div class="row" style="gap:12px;margin-top:8px;font-size:11px;color:var(--muted)">' +
        '<span><i class="cal-dot s" style="margin-right:4px"></i>已发生</span>' +
        '<span><i class="cal-dot h" style="margin-right:4px"></i>计划中</span></div>' +
        '<div class="divider" id="calDayHead">' + dayName + '</div>' +
        '<div id="calDayBody">' + dayBody(pickDay, byDay, planned) + '</div>' +
        /* 按钮常驻，没选日子时藏起来 —— 点了某天才出现，避免整屏重绘 */
        '<button class="btn ghost block" id="calAdd" style="margin-top:10px' + (pickDay ? '' : ';display:none') + '">' +
        '补记 ' + (pickDay ? month + '/' + pickDay : '') + ' 的一笔</button>'
      )

      document.getElementById('calClose').addEventListener('click', closeSheet)
      document.getElementById('calPrev').addEventListener('click', () => {
        month--
        if (month < 1) { month = 12; year-- }
        pickDay = 0
        paint()
      })
      document.getElementById('calNext').addEventListener('click', () => {
        month++
        if (month > 12) { month = 1; year++ }
        pickDay = 0
        paint()
      })
      $$('#sheet [data-cal]').forEach(el => el.addEventListener('click', () => {
        pickDay = Number(el.getAttribute('data-cal'))
        /* 只换下半部分，不整屏重绘 —— 换月才重新取数 */
        document.getElementById('calDayHead').textContent = month + ' 月 ' + pickDay + ' 日'
        document.getElementById('calDayBody').innerHTML = dayBody(pickDay, byDay, planned)
        $$('#sheet [data-cal]').forEach(x => x.classList.toggle('on', x === el))
        const add = document.getElementById('calAdd')
        if (add) { add.style.display = ''; add.textContent = '补记 ' + month + '/' + pickDay + ' 的一笔' }
      }))
      const add = document.getElementById('calAdd')
      if (add) add.addEventListener('click', () => {
        const d = pickDay < 10 ? '0' + pickDay : String(pickDay)
        const mo = month < 10 ? '0' + month : String(month)
        U().openEditor(null, 'expense', { occurred: year + '-' + mo + '-' + d + 'T12:00' })
      })
    }

    paint()
  }

  /* 当天清单：已发生的账目 + 计划中的周期账单 */
  function dayBody(d, byDay, planned) {
    if (!d) return '<div class="small muted">上面点一天，这里显示当天的账目和还没扣的固定支出</div>'
    const list = (byDay[d] || []).slice()
    const pl = planned[d] || []
    if (!list.length && !pl.length) return '<div class="small muted">这天没有账目</div>'
    const one = t => '<div class="cal-dayrow"><div class="grow" style="min-width:0">' +
      '<div style="overflow-wrap:anywhere">' + esc(t.note || S.categoryName(t.category_id) || '账目') + '</div>' +
      '<div class="tiny muted">' + (S.accountName(t.account_id) || '') + '</div></div>' +
      '<b class="num" style="flex:none;color:' + (t.txn_type === 'income' ? 'var(--income)' : 'var(--expense)') + '">' +
      (t.txn_type === 'income' ? '+' : '-') + '¥' + F.yuan(F.toCents(t.amount)) + '</b></div>'
    const plan = x => '<div class="cal-dayrow"><div class="grow" style="min-width:0">' +
      '<div style="overflow-wrap:anywhere">' + esc(x.name) + '</div>' +
      '<div class="tiny muted">计划中 · 周期账单</div></div>' +
      '<b class="num" style="flex:none;color:var(--muted)">' + (x.dir === 'in' ? '+' : '-') + '¥' + F.yuan(x.cents) + '</b></div>'
    return list.map(one).join('') + pl.map(plan).join('')
  }

  /* ================= 攒钱目标编辑器 =================
     从 ui.js 搬来：攒钱目标属于理财模块，且这里不占首屏 gzip 预算。
     「关联账户 / 自动跟随 / 每月自动存入」三件套的存取仍在 ui.js，
     由 UI 导出表提供（goalLink / setGoalLink / goalAutoAll / setGoalAuto）。 */
  async function openGoalEditor(id) {
    const UI = U()
    const goals = S.listGoals() || []
    const g = id ? (goals.find(x => x.id === id) || (S.state.goals || []).find(x => x.id === id)) : null
    const lk = g ? UI.goalLink(g.id) : null
    const accs = S.allAccounts().filter(a => !isDebtAccount(a))
    const accOpts = '<option value="">不关联账户</option>' + accs.map(a =>
      '<option value="' + a.id + '"' + (lk && lk.accountId === a.id ? ' selected' : '') + '>' +
      esc(a.name) + '（' + (a.currency || 'CNY') + '）</option>').join('')

    openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (g ? '编辑攒钱目标' : '新建攒钱目标') + '</span>' +
      '<button id="gClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>目标名称</label><input id="gName" class="input" placeholder="如：旅行基金 / 换手机" maxlength="20" value="' + (g ? esc(g.name) : '') + '"></div>' +
      '<div class="field"><label>目标金额（元）</label><input id="gTarget" class="input" type="number" step="1" min="1" inputmode="decimal" placeholder="5000" value="' + (g ? Number(g.target_amount) : '') + '"></div>' +
      '<div class="field"><label>已存（元，可填 0）</label><input id="gSaved" class="input" type="number" step="0.01" min="0" inputmode="decimal" value="' + (g ? Number(g.saved_amount) : 0) + '"></div>' +
      '<div class="field"><label>目标日期（可留空）</label><input id="gDeadline" class="input" type="date" value="' + (g && g.deadline ? esc(String(g.deadline).slice(0, 10)) : '') + '">' +
      '<div class="small muted" id="gNeed" style="margin-top:6px"></div></div>' +
      '<div class="field"><label>图标</label><input id="gIcon" class="input" value="' + (g ? esc(g.icon || '🎯') : '🎯') + '" maxlength="4"></div>' +
      '<div class="field"><label>关联账户（可选）</label><select id="gAcc" class="select">' + accOpts + '</select>' +
      '<div class="small muted" style="margin-top:6px">关联后可以一键把目标进度同步为该账户的当前余额。</div></div>' +
      '<label class="row" style="gap:8px;align-items:center;margin-bottom:10px">' +
      '<input id="gAuto" type="checkbox"' + (lk && lk.auto ? ' checked' : '') + ' style="width:auto;flex:none">' +
      '<span class="small">自动跟随账户余额（每次打开自动同步，不用手动点）</span></label>' +
      /* 自动存入：Firefly piggy bank 的做法。这里不写周期表，按月在本机补一笔目标进度，
         不动账户余额，也不进收支统计 —— 和手动「存入」是同一个口径 */
      (g
        ? '<div class="field"><label>每月自动存入（元，留空=不自动）</label>' +
          '<input id="gAutoAmt" class="input num" type="number" step="1" min="0" inputmode="decimal" placeholder="如 500" value="' +
          ((UI.goalAutoAll()[String(g.id)] || {}).amount || '') + '"></div>' +
          '<div class="small muted" style="margin-top:-4px;margin-bottom:8px">每月 1 号自动加一笔进度；只在打开应用时补，不会改动账户余额。</div>'
        : '') +
      '<div class="err" id="gErr"></div>' +
      '<button class="btn block" id="gSave">' + (g ? '保存修改' : '创建目标') + '</button>'
    )

    /* 边填边算「每月需存」：YNAB Targets 的核心提示，填了日期马上看到月供 */
    const needLine = () => {
      const box = $('#gNeed')
      if (!box) return
      const target = Number($('#gTarget').value || 0)
      const savedV = Number($('#gSaved').value || 0)
      const dl = $('#gDeadline').value
      const remain = target - savedV
      if (!(target > 0) || remain <= 0) { box.textContent = ''; return }
      if (!dl) { box.textContent = '填个目标日期，就能算出每月该存多少'; return }
      const d = new Date(dl + 'T00:00:00')
      if (isNaN(d)) { box.textContent = ''; return }
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const days = Math.ceil((d - today) / 86400000)
      if (days <= 0) { box.textContent = '目标日期已过，还差 ¥' + F.yuan(F.toCents(remain)); return }
      const months = Math.max(1, Math.ceil(days / 30.4))
      box.innerHTML = '还差 <b>¥' + F.yuan(F.toCents(remain)) + '</b>，每月存 <b>¥' +
        F.yuan(F.toCents(Math.ceil(remain / months))) + '</b> 可在 ' + F.dstr(d) + ' 前达成（剩 ' + months + ' 个月）'
    }
    ;['#gTarget', '#gSaved', '#gDeadline'].forEach(sel => {
      const el = $(sel)
      if (el) el.addEventListener('input', needLine)
    })
    needLine()

    $('#gClose').addEventListener('click', closeSheet)
    $('#gSave').addEventListener('click', async () => {
      const name = $('#gName').value.trim()
      const target = Number($('#gTarget').value)
      if (!name) { $('#gErr').textContent = '请填写目标名称'; return }
      if (!target || target <= 0) { $('#gErr').textContent = '目标金额要大于 0'; return }
      const savedV = Number($('#gSaved').value || 0)
      const accId = Number($('#gAcc').value) || 0
      const auto = !!$('#gAuto').checked && accId > 0
      try {
        let gid = g ? g.id : null
        const payload = {
          name, icon: $('#gIcon').value.trim() || '🎯',
          target_amount: target, saved_amount: savedV,
          deadline: $('#gDeadline').value || null,
          done: savedV >= target,
        }
        if (g) {
          await S.updateGoal(gid, payload)
        } else {
          const created = await S.addGoal(Object.assign({}, payload))
          gid = created && created.id != null ? created.id : (S.listGoals().slice(-1)[0] || {}).id
        }
        if (gid != null) UI.setGoalLink(gid, accId ? { accountId: accId, auto: auto } : null)
        const autoEl = $('#gAutoAmt')
        if (gid != null && autoEl) {
          const amt = Number(autoEl.value || 0)
          UI.setGoalAuto(gid, amt > 0 ? { amount: amt, last: F.dstr(new Date()) } : null)
        }
        closeSheet()
        toast(g ? '目标已更新' : '目标已创建')
        window.App.renderTab()
      } catch (e) { $('#gErr').textContent = '保存失败：' + (e.message || '') }
    })
  }

  return {
    listDebts, openDebtSheet, openDebtEditor, openDebtFlow,
    openReconcile,
    periodKey, periodRange, periodLabel, applyAutoBudget, openBudgetCenter, openCategoryBudget,
    isDebtAccount, LOAN_IN, LOAN_OUT,
    listCards, openCardSheet, openCardEditor, openCardRepay, isCredit,
    openForecast, forecastData, openGoalEditor, openDebtPlan, debtItems, planSim, openBudgetCalendar,
  }
})()


