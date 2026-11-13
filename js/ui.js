/* 界面渲染层 */
window.UI = (function () {
  const F = window.Fmt
  const S = window.DB

  /* 图表模块按需加载：只在「统计 / 资产」tab 与月度报表里用到，
     不在首屏渲染路径上。首屏 gzip 预算很紧，把它从关键路径摘下来；
     它已加入 Service Worker 预缓存，点开统计几乎无等待。 */
  function charts() {
    return window.Lazy.need('charts').then(function (m) {
      if (!m) throw new Error('图表模块加载失败，请检查网络后重试')
      return m
    })
  }

  function $(sel, root) { return (root || document).querySelector(sel) }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  function esc(s) { return F.escapeHtml(s) }

  /* ---------- 图标（全站唯一一套 SVG，见 assets/icons.svg） ----------
     v1.11.0 之前界面里 emoji 与 SVG 混用（tabbar 是 icons.svg，内容区是 ' + ic('receipt') + '' + ic('chart-bar') + '' + ic('heart') + '…），
     同一操作系统上字形还各不相同。现在所有「功能性图标」都走这里：
        ic('receipt')        → 22px 描边图标（默认）
        ic('receipt', 20)    → 20px
     颜色继承 currentColor，深浅主题自动反色，不需要为深色模式再写一套。
     ' + ic('alert') + ' 分类 / 账户 / 攒钱目标 的 emoji 属于「用户数据里的头像」（存在 icon 字段），
        保持原样——那是用户对自己分类的识别符号，不是界面图标。 */
  function ic(name, size) {
    const s = size === 20 ? ' s20' : size === 24 ? ' s24' : ''
    return '<svg class="sg-icon' + s + '" aria-hidden="true"><use href="assets/icons.svg#' + name + '"></use></svg>'
  }
  /* 关键词高亮（P1-4）：搜索结果里把命中的字标出来，用户才知道为什么这条会出来 */
  function hl(text) {
    const kw = ((window.App && window.App.state && window.App.state.filters && window.App.state.filters.keyword) || '').trim()
    const str = String(text == null ? '' : text)
    if (!kw) return esc(str)
    const low = str.toLowerCase()
    const k = kw.toLowerCase()
    let i = low.indexOf(k)
    if (i < 0) return esc(str)
    let out = ''
    let pos = 0
    while (i >= 0) {
      out += esc(str.slice(pos, i)) + '<mark>' + esc(str.slice(i, i + kw.length)) + '</mark>'
      pos = i + kw.length
      i = low.indexOf(k, pos)
    }
    return out + esc(str.slice(pos))
  }

  /* ---------- 通用组件 ---------- */
  /* toast 队列：旧实现是单例覆盖，连续多条提示只看得见最后一条。
     现在排成队列逐条展示；文本走 textContent（防注入），
     图标走 innerHTML 通道（调用方传 {icon} 时才渲染 SVG）。 */
  const toastQueue = []
  let toastBusy = false
  function toast(msg, opts) {
    toastQueue.push({ msg: msg, icon: opts && opts.icon ? String(opts.icon) : '' })
    if (toastQueue.length > 4) toastQueue.shift()   /* 洪峰时丢最旧的，别越积越多 */
    if (!toastBusy) nextToast()
  }
  function nextToast() {
    const el = $('#toast')
    const item = toastQueue.shift()
    if (!item || !el) { toastBusy = false; return }
    toastBusy = true
    if (item.icon) {
      el.innerHTML = ''
      const span = document.createElement('span')
      span.className = 'toast-ic'
      span.innerHTML = item.icon          /* 图标是本模块 ic() 生成的固定 SVG，非用户数据 */
      const txt = document.createElement('span')
      txt.textContent = item.msg
      el.appendChild(span)
      el.appendChild(txt)
    } else {
      el.textContent = item.msg
    }
    el.classList.add('on')
    setTimeout(() => {
      el.classList.remove('on')
      setTimeout(nextToast, 180)
    }, 2200)
  }

  /* 动效只负责反馈：不延后操作，不保留覆盖样式，重复触发和系统偏好变化均可取消。 */
  const feedbackByElement = new WeakMap(), runningFeedback = new Set()
  const motionPreference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  function cancelFeedback(el) {
    const previous = feedbackByElement.get(el)
    if (previous) previous.cancel()
  }
  function animateFeedback(el, kind) {
    if (!el) return
    cancelFeedback(el)
    if (!el.isConnected || !motionPreference || motionPreference.matches || typeof el.animate !== 'function') return
    try {
      const replace = kind === 'replace'
      const animation = el.animate(replace ? [{ opacity: .72 }, { opacity: 1 }] :
        [{ opacity: .8, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
        { duration: replace ? 140 : 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'none' })
      feedbackByElement.set(el, animation)
      runningFeedback.add(animation)
      const done = () => {
        runningFeedback.delete(animation)
        if (feedbackByElement.get(el) === animation) feedbackByElement.delete(el)
      }
      Promise.resolve(animation.finished).then(done, done)
    } catch (e) { /* 不支持动效时直接保留已就绪的界面 */ }
  }
  const onMotionPreference = () => {
    if (motionPreference.matches) runningFeedback.forEach(animation => animation.cancel())
  }
  if (motionPreference && motionPreference.addEventListener) motionPreference.addEventListener('change', onMotionPreference)
  else if (motionPreference && motionPreference.addListener) motionPreference.addListener(onMotionPreference)

  let sheetReturnFocus = null
  let sheetBackground = []
  let sheetOpen = false
  let sheetVersion = 0
  let sheetFrame = null
  let editorBaseline = null
  let editorKeyHandler = null
  function editorSnapshot() {
    syncDraftFromInputs()
    const expect = $('#reimExpect')
    if (expect) draft.reimbExpect = expect.value
    return JSON.stringify([draft.type, draft.amount, draft.categoryId, draft.accountId,
      draft.toAccountId, draft.occurred, draft.note, draft.tags, draft.freq,
      draft.reimbursable, draft.reimbStatus, draft.reimbExpect,
      draft.keepAtts, draft.newFiles.map(f => [f.file && f.file.name, f.file && f.file.size, f.file && f.file.lastModified])])
  }
  /* 编辑器是否有未保存改动。纯判定，不弹任何东西。 */
  function editorDirty() {
    return !!$('#edSave') && editorBaseline !== null && editorSnapshot() !== editorBaseline
  }
  /* 关闭回调是同步 API，放弃草稿仍保留同步确认。 */
  function mayLeaveEditor() {
    if (!editorDirty()) return true
    if (typeof confirm !== 'function') return true
    return !!confirm('有尚未保存的修改，确定放弃并关闭吗？')
  }

  let activeConfirm = null
  /* 确认层独立于 #sheet，取消时原面板的 DOM、草稿和监听器保持原样。 */
  function confirmSheet(opt) {
    const o = typeof opt === 'string' ? { body: opt } : (opt || {})
    if (!$('#sheet')) return Promise.resolve(typeof confirm === 'function' ? !!confirm(o.body || o.title || '') : false)
    if (editorSaving) return Promise.resolve(false)
    if (activeConfirm) activeConfirm.finish(false)
    return new Promise(resolve => {
      const opener = document.activeElement, wasOpen = document.body.classList.contains('sheet-open')
      const layer = document.createElement('div')
      layer.id = 'confirmLayer'; layer.className = 'confirm-layer'
      layer.innerHTML = '<div id="confirmDialog" class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-describedby="cfBody" tabindex="-1">' +
        '<div class="sheet-head"><span id="cfTitle" class="sheet-title">' + esc(o.title || '请确认') + '</span>' +
        '<button type="button" id="cfClose" class="btn sm line">关闭</button></div>' +
        '<div id="cfBody" class="small confirm-body">' + esc(o.body || '') + '</div>' +
        '<div class="row"><button type="button" id="cfNo" class="btn line grow">' + esc(o.cancelText || '取消') + '</button>' +
        '<button type="button" id="cfYes" class="btn grow' + (o.danger ? ' danger' : '') + '">' + esc(o.okText || '确定') + '</button></div></div>'
      const background = Array.from(document.body.children).filter(el => !['SCRIPT', 'STYLE'].includes(el.tagName))
        .map(el => ({ el, inert: el.hasAttribute('inert') }))
      background.forEach(({ el }) => el.setAttribute('inert', ''))
      document.body.appendChild(layer)
      document.body.classList.add('sheet-open')
      const box = $('#confirmDialog', layer)
      let finished = false
      const finish = value => {
        if (finished) return
        finished = true
        document.removeEventListener('keydown', onKey, true)
        layer.remove()
        background.forEach(({ el, inert }) => { if (!inert) el.removeAttribute('inert') })
        if (!wasOpen) document.body.classList.remove('sheet-open')
        activeConfirm = null
        if (opener && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
        resolve(value)
      }
      const onKey = e => {
        if (e.isComposing || e.keyCode === 229) return
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false) }
        else if (e.ctrlKey || e.metaKey) { e.stopImmediatePropagation(); if (e.key === 'Enter') e.preventDefault() }
        else if (e.key === 'Tab') {
          const items = $$('button:not(:disabled)', box), first = items[0], last = items[items.length - 1]
          if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus() }
        }
      }
      activeConfirm = { finish }
      document.addEventListener('keydown', onKey, true)
      $('#cfYes', layer).addEventListener('click', () => finish(true))
      $('#cfNo', layer).addEventListener('click', () => finish(false))
      $('#cfClose', layer).addEventListener('click', () => finish(false))
      layer.addEventListener('click', e => { if (e.target === layer) finish(false) })
      $('#cfNo', layer).focus({ preventScroll: true })
    })
  }

  window.addEventListener('beforeunload', e => {
    if (sheetOpen && $('#edSave') && editorBaseline !== null && editorSnapshot() !== editorBaseline) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  function openSheet(html) {
    const sheet = $('#sheet')
    if (editorSaving) return
    if (activeConfirm) activeConfirm.finish(false)
    const replacing = sheetOpen
    cancelFeedback(sheet)
    if (!sheetOpen) {
      sheetReturnFocus = document.activeElement
      sheetBackground = ['#mainView', '#authView', '#lockView', '#batchBar'].map(selector => $(selector)).filter(el => el && !el.contains(sheet))
        .map(el => ({ el, wasInert: el.hasAttribute('inert') }))
      sheetBackground.forEach(({ el }) => el.setAttribute('inert', ''))
    }
    sheetOpen = true
    sheetVersion++
    cancelAnimationFrame(sheetFrame)
    sheet.removeAttribute('inert')
    sheet.setAttribute('aria-hidden', 'false')
    sheet.classList.remove('editor-sheet', 'kp-open')
    sheet.innerHTML = html
    const title = $('.sheet-title', sheet)
    sheet.setAttribute('aria-label', title ? title.textContent : '操作面板')
    sheet.scrollTop = 0
    $('#mask').classList.add('on')
    document.body.classList.add('sheet-open')
    sheet.onkeydown = e => {
      if (e.key !== 'Tab') return
      const focusable = $$('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]', sheet)
        .filter(el => el.getClientRects().length && !el.closest('[inert]'))
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first) { e.preventDefault(); sheet.focus(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === sheet)) {
        e.preventDefault(); first.focus()
      }
    }
    sheetFrame = requestAnimationFrame(() => {
      sheet.classList.add('on')
      if (replacing) animateFeedback(sheet, 'replace')
      if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true })
    })
    return sheetVersion
  }
  function closeSheet(force) {
    if (activeConfirm) { activeConfirm.finish(false); if (force !== true) return }
    if (editorSaving) return
    /* 有未保存改动时先问一句（同步守卫，见 mayLeaveEditor 的注释） */
    if (force !== true && sheetOpen && !mayLeaveEditor()) return
    if (editorKeyHandler) document.removeEventListener('keydown', editorKeyHandler)
    editorKeyHandler = null
    editorBaseline = null
    cancelAnimationFrame(sheetFrame)
    cancelFeedback($('#sheet'))
    $('#sheet').classList.remove('on')
    $('#mask').classList.remove('on')
    document.body.classList.remove('sheet-open')
    sheetBackground.forEach(({ el, wasInert }) => { if (!wasInert) el.removeAttribute('inert') })
    sheetBackground = []
    if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus({ preventScroll: true })
    $('#sheet').setAttribute('aria-hidden', 'true')
    $('#sheet').setAttribute('inert', '')
    sheetReturnFocus = null
    sheetOpen = false
    sheetVersion++
  }

  function lightbox(url) {
    const box = document.createElement('div')
    box.className = 'lightbox'
    box.innerHTML = '<img src="' + esc(url) + '" alt="凭证"><button type="button" class="close" aria-label="关闭凭证图片">' + ic('close') + '</button>'
    box.addEventListener('click', () => box.remove())
    $('#lightboxRoot').appendChild(box)
  }

  function catChip(c, active, onclickAttr) {
    return '<button class="chip' + (active ? ' on' : '') + '" ' + onclickAttr + '>' + esc(c.icon || '') + ' ' + esc(c.name) + '</button>'
  }

  /* ---------- 概览卡 ---------- */
  function periodTitle(st) {
    if (st.scope === 'month') return st.year + '年' + st.month + '月'
    if (st.scope === 'year') return st.year + '年'
    return '全部时间'
  }

  function periodRange(st) {
    if (st.scope === 'month') {
      return { from: F.iso(F.monthStart(st.year, st.month)), to: F.iso(F.monthEnd(st.year, st.month)) }
    }
    if (st.scope === 'year') {
      return { from: F.iso(new Date(st.year, 0, 1)), to: F.iso(new Date(st.year + 1, 0, 1)) }
    }
    return { from: F.iso(new Date(2000, 0, 1)), to: F.iso(new Date(2100, 0, 1)) }
  }

  /* 终审 P1（3.1）：账本是否一条记录都没有。
     空账本时隐藏「0 结余」摘要条、「今天 ¥0.00」快捷条与「尚未备份」提示行 ——
     0 值没有信息量，空账本提示备份只会制造焦虑。查询失败时按「非空」处理，
     避免因为一次读失败把正常界面藏掉。 */
  async function ledgerEmpty() {
    try {
      const r = await S.listTransactions({ limit: 1 })
      return !(r && r.total > 0)
    } catch (e) { return false }
  }

  async function renderOverview(st) {
    const box = $('#overview')
    if (!box) return
    const tab = st.tab || 'home'
    /* 资产 / 我的页不需要概览：那里有自己的口径卡片，留着只会重复占首屏。
       明细页要的是「最近几笔」，统计页才是「看总数」的地方 —— 概览卡只在这两处出现。 */
    if (tab !== 'home' && tab !== 'stats') { box.innerHTML = ''; return }

    /* 终审 P1（3.1 / 3.2）：账本全空时，「0 结余」摘要条与「0 收支」对比条都不展示 ——
       0 值没有信息量（验收清单：0 数据页面不出现空图表和零值卡）。
       统计页此时靠 seg + 报表入口 + 「本月还没有支出记录 · 记一笔」指引。 */
    if ((tab === 'home' || tab === 'stats') && await ledgerEmpty()) { box.innerHTML = ''; return }

    const r = periodRange(st)
    const rows = await S.monthlySummary(r.from, r.to)
    let income = 0
    let expense = 0
    rows.forEach(m => { income += F.toCents(m.income); expense += F.toCents(m.expense) })
    const balance = income - expense
    const count = rows.reduce((s, m) => s + Number(m.txn_count || 0), 0)

    /* 摘要条只有一行 56px，百万级金额会把收支数字压成「¥13,9…」。
       超过 11 个字符就改用「122万」这类缩写；完整数字点进统计页看。 */
    const shortMoney = c => {
      const s = F.money(c)
      return s.length > 11 ? '¥' + F.compactYuan(c) : s
    }
    const stripCells =
      '<div class="grid">' +
      '<div class="cell"><div class="k">支出</div><div class="v num">' + shortMoney(expense) + '</div></div>' +
      '<div class="cell"><div class="k">收入</div><div class="v num">' + shortMoney(income) + '</div></div>' +
      '<div class="cell"><div class="k">笔数</div><div class="v">' + count + '</div></div>' +
      '</div>'

    if (tab === 'stats') {
      /* 终审 3.2：统计页不再重复明细页顶部的「结余」大卡（那里已经有了），
         换成支出/收入对比条 —— 一眼看出本期是净流出还是净流入，结构图让回第一位 */
      const maxV = Math.max(expense, income, 1)
      const cmpRow = (k, cents, cls) => '<div class="cmp-row"><span class="cmp-k">' + k + '</span>' +
        '<div class="cmp-bar"><i class="' + cls + '" style="width:' + Math.max(2, Math.round(cents / maxV * 100)) + '%"></i></div>' +
        '<span class="cmp-v num">¥' + F.yuan(cents) + '</span></div>'
      box.innerHTML = '<div class="card cmp-card">' +
        '<div class="label">' + esc(periodTitle(st)) + '收支对比</div>' +
        cmpRow('支出', expense, 'e') + cmpRow('收入', income, 'i') + '</div>'
      return
    }

    /* 明细页摘要条改成两行：第一行结余，第二行支出 / 收入 / 笔数（终审 细节 3）。
       一行塞五样东西在 390px 下挤成一团，拆两行只多 ~24px，读起来清楚得多 */
    /* 首页锚点（v1.13 起）：有预算时第一眼该看到的是「今天还能花多少」——
       结余是记账结果，「还能花多少」才是每天做决定时要用的数（v4 建议 3.2）。
       没预算时保留结余，右上角的「›」换成「设预算」，点一下就能设，不额外占高度。 */
    const nowDate = new Date()
    const isCurMonth = st.scope === 'month' && nowDate.getFullYear() === st.year && (nowDate.getMonth() + 1) === st.month
    const monthKey = F.monthKey(new Date(st.year, st.month - 1, 1))
    const budRaw = isCurMonth ? S.budgetOf(monthKey, null) : null
    const budgetCents = budRaw != null ? F.toCents(budRaw) : 0
    const hasBudget = budgetCents > 0
    const remain = budgetCents - expense
    const lastDayNum = new Date(st.year, st.month, 0).getDate()
    const daysLeft = Math.max(lastDayNum - nowDate.getDate() + 1, 1)
    /* 「今天还能花」＝(预算 − 已花 − 本月剩余天数内还没扣的固定支出) ÷ 剩余天数。
       不先扣固定支出的话，月中看着还有 3000，月底房租一扣就穿仓。 */
    let daily = null
    if (hasBudget && isCurMonth) {
      let upcoming = 0
      const todayStr = F.dstr(nowDate)
      const endStr = F.dstr(new Date(st.year, st.month - 1, lastDayNum))
      try {
        ;(await S.listRecurring() || []).forEach(r => {
          if (!r.active || r.txn_type === 'income') return
          const due = F.nextDue(r.last_run_date || null, String(r.start_date).slice(0, 10), r.freq)
          if (due && due >= todayStr && due <= endStr) upcoming += F.toCents(r.amount)
        })
      } catch (e) { /* 周期读不到就不扣，宁可乐观 */ }
      daily = Math.floor((remain - upcoming) / daysLeft)
    }
    const over = hasBudget && remain < 0
    /* 文案里必须带「预算」二字：原来写「本月已超支」，旁边又是收入/支出，
       用户会读成「本月收支为负」（v4 缺陷 2） */
    const anchorLabel = hasBudget ? (over ? '预算已超支' : '今天还能花') : esc(periodTitle(st)) + '结余'
    const balText = hasBudget
      ? shortMoney(over ? Math.abs(remain) : Math.max(daily == null ? remain : daily, 0))
      : shortMoney(balance)
    /* 副标题挤进 label 同一行，不额外占高度 —— 首屏第一条流水离 520px 硬线只剩 7px */
    const ovSub = hasBudget && isCurMonth
      ? '<span class="ov-sub">剩 ' + daysLeft + ' 天 · 已用 ' + Math.round(expense / budgetCents * 100) + '%</span>'
      : ''
    box.innerHTML =
      '<div class="overview ov-strip" id="ovStrip" role="button" tabindex="0" aria-label="' +
      esc(anchorLabel) + '，点按查看未来 30 天">' +
      '<div class="ov-top"><span class="label">' + anchorLabel + '</span>' + ovSub +
      (hasBudget
        ? '<span class="ov-go" aria-hidden="true">›</span>'
        : '<span class="ov-bud" id="ovSetBudget" role="button" tabindex="0">设预算 ›</span>') + '</div>' +
      /* 长金额降一档字号：百万级 + 桌面窄栏时会顶出卡片 */
      '<div class="balance num' + (balText.length > 10 ? ' long' : '') + (over ? ' over' : '') + '">' + balText + '</div>' +
      stripCells + '</div>'
    const strip = $('#ovStrip')
    if (strip) {
      /* 有预算时点开「未来 30 天」（v4 建议 3.2）；没预算时仍去统计页看结余构成 */
      const go = () => {
        if (hasBudget) Lazy.need('wealth').then(m => m && m.openForecast())
        else if (window.App && window.App.setTab) window.App.setTab('stats')
      }
      strip.addEventListener('click', go)
      strip.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
      })
      const budBtn = $('#ovSetBudget')
      if (budBtn) {
        const openBud = ev => {
          ev.stopPropagation()
          ev.preventDefault()
          openMonthBudget(window.App.state)
        }
        budBtn.addEventListener('click', openBud)
        budBtn.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') openBud(e)
        })
      }
    }
  }

  /* ---------- 本月预算执行卡片（P0-2） ---------- */
  /* 明细页与统计页共用：设了预算才谈得上执行，这里把「已花/预算/进度/还能花多少」讲清楚 */
  async function budgetExecCard(st, spentCents, forceMonth) {
    if (!forceMonth && st.scope !== 'month') return ''
    const key = F.monthKey(new Date(st.year, st.month - 1, 1))
    const b = S.budgetOf(key, null)
    const total = b != null ? F.toCents(b) : 0
    const lastDay = new Date(st.year, st.month, 0)
    const rangeLabel = st.month + '月1日 – ' + st.month + '月' + lastDay.getDate() + '日'
    const now = new Date()
    const isCurrent = now.getFullYear() === st.year && (now.getMonth() + 1) === st.month
    const periodName = isCurrent ? '本月' : st.month + '月'

    if (!(total > 0)) {
      /* 明细页（非统计页）不显示「未设预算」的空卡：那张 58px 的提示条会把
         第一条流水推到 520px 以下（P0-1 验收线）。预算入口在「我的 · 账户与预算」
         和统计页都有，明细页只显示真正有内容的预算执行情况。 */
      if (!forceMonth) return ''
      return '<div class="card budget-card budget-card--empty">' +
        '<div class="between"><span class="small muted">还没设' + periodName + '预算 · 定个额度就知道还能花多少</span>' +
        '<button class="btn sm line" id="budgetSetBtn" style="flex:none">设置</button></div>' +
        '</div>'
    }

    let spent = spentCents
    if (spent == null) {
      const rows = await S.monthlySummary(F.iso(F.monthStart(st.year, st.month)), F.iso(F.monthEnd(st.year, st.month)))
      spent = 0
      ;(rows || []).forEach(r => { spent += F.toCents(r.expense) })
    }

    const pctRaw = spent / total * 100
    const pct = Math.min(100, pctRaw)
    const over = spent > total
    const barColor = over ? 'var(--expense)' : pctRaw > 70 ? 'var(--warn)' : 'var(--income)'
    const cls = over ? 'over' : pctRaw > 70 ? 'warn' : ''

    let tip
    if (over) {
      tip = '支出已超过预算，可查看分类明细或调整预算。'
    } else if (isCurrent) {
      const remainDays = Math.max(lastDay.getDate() - now.getDate() + 1, 1)
      const perDay = Math.round((total - spent) / remainDays)
      tip = '含今天还剩 ' + remainDays + ' 天，日均可花 <span class="num">¥' + F.yuan(perDay) + '</span>'
    } else {
      tip = '预算剩余额度；不等同于账户余额或收支结余。'
    }

    const timePct = now.getDate() / lastDay.getDate() * 100
    const pace = isCurrent
      ? '<div class="budget-pace small muted">时间已过 ' + timePct.toFixed(0) + '% · 预算已用 ' + pctRaw.toFixed(0) + '%' +
        (pctRaw > timePct + 10 ? '，支出快于时间进度' : '，可结合固定账单安排支出') + '</div>' : ''

    const bar = '<div class="progress ' + cls + '"' + (forceMonth ? ' style="margin-top:8px;height:10px"' : '') + ' role="progressbar" aria-label="预算使用进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><i style="width:' + pct + '%;background:' + barColor + '"></i></div>'
    const head = '<div class="between" style="margin-bottom:8px"><b>' + periodName + '预算</b>' +
      '<button class="btn sm line" id="budgetSetBtn">调整预算</button></div>'

    /* 首页只保留预算执行摘要，正常进度不再重复顶部额度与日均说明。 */
    if (!forceMonth) {
      const briefTip = over ? '已超出预算，留意后续支出。' :
        isCurrent && pctRaw > timePct + 10 ? '支出快于本月时间进度。' : ''
      return '<div class="card budget-card budget-card--brief">' + head +
        '<div class="small muted">已花 <span class="num">¥' + F.yuan(spent) + '</span> / <span class="num">¥' + F.yuan(total) + '</span></div>' +
        bar +
        (briefTip ? '<div class="small budget-tip" style="color:' + (over ? 'var(--expense)' : 'var(--sub)') + '">' + briefTip + '</div>' : '') +
        '</div>'
    }

    return '<div class="card budget-card">' + head +
      '<div class="small muted">' + rangeLabel + ' · ' + (over ? '已超出' : '还可花') + '</div>' +
      '<div class="row budget-nums" style="justify-content:space-between;align-items:baseline">' +
      '<span style="font-size:26px;font-weight:800" class="num">¥' + F.yuan(Math.abs(total - spent)) + '</span>' +
      '<span class="small muted">已花 <span class="num">¥' + F.yuan(spent) + '</span> / <span class="num">¥' + F.yuan(total) + '</span></span></div>' +
      bar +
      '<div class="small budget-tip" style="margin-top:8px;color:' + (over ? 'var(--expense)' : 'var(--sub)') + '">' + tip + '</div>' + pace +
      '</div>'
  }

  /* 预算卡片上的「设置本月预算」入口 */
  function bindBudgetCard() {
    const btn = $('#budgetSetBtn')
    if (btn) btn.addEventListener('click', () => openMonthBudget(window.App.state))
  }

  function openMonthBudget(st) {
    const key = F.monthKey(new Date(st.year, st.month - 1, 1))
    const bookId = S.currentBookId()
    const ownBudget = S.state.budgets.find(b => b.month_key === key && !b.category_id && (b.book_id || S.defaultBookId()) === bookId)
    const amount = ownBudget ? ownBudget.amount : null
    const targetBook = S.bookName(bookId) || '日常账本'
    openSheet('<div class="sheet-head"><span class="sheet-title">' + st.year + '年' + st.month + '月预算</span>' +
      '<button id="mbClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label for="mbAmount">这个月计划花多少（元）</label>' +
      '<input id="mbAmount" class="input num" type="number" inputmode="decimal" min="0" step="0.01" value="' + (amount || '') + '" placeholder="例如 3000"></div>' +
      '<p class="small muted">正在调整「' + esc(targetBook) + '」的月度总预算。填 0 可取消额度；全部账本视图会汇总各账本预算。</p>' +
      '<div id="mbError" class="err" role="alert"></div><button id="mbSave" class="btn block">保存预算</button>')
    $('#mbClose').addEventListener('click', closeSheet)
    const input = $('#mbAmount'), button = $('#mbSave'), error = $('#mbError')
    const save = async () => {
      if (button.disabled) return
      const value = input.value.trim()
      if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(F.toCents(value))) {
        error.textContent = '请输入不小于 0 的金额，最多两位小数'; return
      }
      button.disabled = true
      try {
        await S.setBudget(key, null, Number(value))
        closeSheet(); toast('已保存 ' + key + ' 的预算'); await window.App.refresh()
      } catch (e) { error.textContent = '保存失败，请重试' }
      finally { button.disabled = false }
    }
    button.addEventListener('click', save)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save() } })
  }

  /* ---------- 空状态：区分「首次使用」「本期无记录」「筛选无结果」 ---------- */
  async function emptyStateHtml(st) {
    const f = st.filters || {}
    const filtered = !!(f.type || f.accountId || f.categoryId || f.keyword || f.tag ||
      f.minAmount || f.maxAmount || f.reimbursable)
    if (filtered) {
      return '<div class="empty"><div class="big">' + ic('search') + '</div><div>没有符合条件的记录</div>' +
        '<div class="small" style="margin-top:6px">试试放宽条件，或清空筛选</div>' +
        '<div class="empty-actions">' +
        (st.scope !== 'all' ? '<button class="btn sm" id="emptySearchAll">在全部时间查找</button>' : '') +
        '<button class="btn sm line" id="emptyClearFilter">清空筛选条件</button></div></div>'
    }
    let anyTxn = 0
    try { anyTxn = (await S.listTransactions({ limit: 1 })).total || 0 } catch (e) { anyTxn = 0 }
    if (!anyTxn) {
      /* 空账本只留一张卡：三件事按「先做什么」排 —— 记一笔、设预算、看示例。
         设预算放在这里，是因为它就是首页锚点（本月还能花）的来源，
         没有预算的人从第一屏就知道这个数怎么来的。 */
      return '<div class="card onboard-card">' +
        '<div class="between" style="margin-bottom:8px"><b>' + ic('sparkles') + ' 欢迎使用拾光记账</b></div>' +
        '<div class="small muted" style="margin-bottom:12px">记一笔就能看到结余、趋势和报表；先设个预算，这个月每天还能花多少就一目了然。</div>' +
        '<div class="row" style="gap:8px">' +
        '<button class="btn grow" id="emptyAdd">＋ 记第一笔</button>' +
        '<button class="btn line grow" id="emptyBudget">设个预算</button>' +
        '</div>' +
        '<button class="btn sm line block" id="emptyDemo" style="margin-top:8px">查看记账示例</button>' +
        '</div>'
    }
    return '<div class="empty"><div class="big">' + ic('receipt') + '</div><div>这段时间还没有记录</div>' +
      '<div class="small" style="margin-top:6px">点下方 ＋ 记第一笔</div></div>'
  }

  function bindEmptyState(st) {
    const all = $('#emptySearchAll')
    if (all) all.addEventListener('click', () => {
      st.scope = 'all'
      st.calDay = null
      window.App.refresh()
    })
    const clear = $('#emptyClearFilter')
    if (clear) clear.addEventListener('click', () => {
      Object.assign(st.filters, { type: '', accountId: null, categoryId: null, keyword: '', tag: '', minAmount: '', maxAmount: '', reimbursable: false })
      st.filterOpen = false
      renderHome(st).then(() => window.App.bindContentEvents())
    })
    const add = $('#emptyAdd')
    if (add) add.addEventListener('click', () => openEditor(null))
    const bud = $('#emptyBudget')
    if (bud) bud.addEventListener('click', () => openMonthBudget(window.App.state))
    const demo = $('#emptyDemo')
    if (demo) demo.addEventListener('click', () => openDemoData())
  }

  /* ---------- 示例数据 ----------
     分类×备注配对表约 130 行，只在空账本点一次，放首屏白占 gzip 预算，
     已整体搬进懒加载模块 js/demo.js（SW 预缓存，断网可用）。 */
  function openDemoData() {
    return Lazy.need('demo').then(m => m && m.openDemoData())
  }


  /* ---------- 明细 ---------- */
  function homeOpt(st, extra) {
    const r = periodRange(st)
    const opt = { from: r.from, to: r.to, limit: st.loaded || st.pageSize, offset: 0 }
    if (st.filters.type) opt.type = st.filters.type
    if (st.filters.reimbursable) opt.reimbursable = true
    if (st.filters.accountId) opt.accountId = st.filters.accountId
    if (st.filters.categoryId) opt.categoryId = st.filters.categoryId
    if (st.filters.keyword) opt.keyword = st.filters.keyword
    if (st.filters.tag) opt.tag = st.filters.tag
    if (st.filters.minAmount) opt.minAmount = st.filters.minAmount
    if (st.filters.maxAmount) opt.maxAmount = st.filters.maxAmount
    return Object.assign(opt, extra || {})
  }

  /* 每日记账提醒横幅：开启后过了设定时间还没记账就显示 */
  async function reminderBanner(st) {
    if (st.scope !== 'month') return ''
    let cfg = null
    try { cfg = JSON.parse(localStorage.getItem('ledger10_reminder') || 'null') } catch (e) { /* 忽略 */ }
    if (!cfg || !cfg.on || !cfg.time) return ''
    const now = new Date()
    if (now.getFullYear() !== st.year || (now.getMonth() + 1) !== st.month) return ''
    const hm = cfg.time.split(':')
    const due = new Date(now); due.setHours(+hm[0] || 21, +hm[1] || 30, 0, 0)
    if (now < due) return ''
    const todayKey = F.dstr(now)
    let dismissed = ''
    try { dismissed = localStorage.getItem('ledger10_remind_dismiss') || '' } catch (e) { /* 忽略 */ }
    if (dismissed === todayKey) return ''
    const from = F.iso(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
    const to = F.iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
    const res = await S.listTransactions({ from, to, limit: 1 }).catch(() => ({ total: 0 }))
    if ((res.total || 0) > 0) return ''
    return '<div class="remind-banner"><span style="font-size:18px">' + ic('clock') + '</span>' +
      '<div class="grow">今天还没记账，花 5 秒钟记一笔吧</div>' +
      '<button class="btn sm" id="remindAdd">记一笔</button>' +
      '<button class="btn sm line" id="remindDismiss">明天再说</button></div>'
  }

  /* 首页卡片显隐（P2：首页可定制）。只存本机，默认全开 */
  function homeShow(key) {
    try { return localStorage.getItem('ledger10_home_' + key) !== 'off' } catch (e) { return true }
  }

  let homeRenderVersion = 0

  function homeContext(st) {
    return JSON.stringify([S.mode, reimbKey(), S.activeBookId ? S.activeBookId() : null,
      st.scope, st.year, st.month, st.homeView])
  }

  /* 输入框保持在原位置，只替换它周围的控件与结果。 */
  function commitHome(content, html, context) {
    const input = $('#kwInput', content)
    if (input && document.activeElement === input && content.dataset.homeContext === context) {
      const template = document.createElement('template')
      template.innerHTML = html
      const next = $('#kwInput', template.content)
      if (next) {
        if (!input.dataset.composing && input.value.trim() !== next.value) input.value = next.value
        let keep = input, incoming = next
        while (keep !== content && incoming !== template.content) {
          const parent = incoming.parentNode
          const siblings = Array.from(parent.childNodes)
          const at = siblings.indexOf(incoming)
          Array.from(keep.parentNode.childNodes).forEach(node => { if (node !== keep) node.remove() })
          keep.before(...siblings.slice(0, at))
          keep.after(...siblings.slice(at + 1))
          keep = keep.parentNode
          incoming = parent
        }
        return
      }
    }
    /* 只在提交前仍停留筛选按钮时恢复焦点，不抢走用户异步期间已移开的焦点。 */
    const active = document.activeElement
    const focusAttr = active && content.contains(active) && content.dataset.homeContext === context
      ? ['data-ftype', 'data-facc', 'data-fpanel'].find(name => active.hasAttribute(name)) : null
    const focusValue = focusAttr ? active.getAttribute(focusAttr) : null
    content.innerHTML = html
    content.dataset.homeContext = context
    if (focusAttr) {
      const next = $$('[' + focusAttr + ']', content).find(el => el.getAttribute(focusAttr) === focusValue)
      if (next) next.focus({ preventScroll: true })
    }
  }

  async function renderHome(st) {
    /* 切到别的 Tab 时退出多选：否则批量操作条会留在统计/资产页上 */
    syncBatchContext(st)
    const content = $('#content')
    const version = ++homeRenderVersion
    const context = homeContext(st)
    const query = homeOpt(st)
    const queryKey = JSON.stringify(query)
    const selectedDay = st.calDay
    const current = () => version === homeRenderVersion && st.tab === 'home' && $('#content') === content &&
      !$('#mainView.hidden') && context === homeContext(st) && st.calDay === selectedDay &&
      queryKey === JSON.stringify(homeOpt(st))
    const toggle = '<div class="view-toggle" id="viewToggle">' +
      '<button class="' + (st.homeView !== 'cal' ? 'on' : '') + '" data-hv="list" aria-label="列表视图" aria-pressed="' + (st.homeView !== 'cal') + '">' + ic('list') + '<span class="vt-t">列表</span></button>' +
      '<button class="' + (st.homeView === 'cal' ? 'on' : '') + '" data-hv="cal" aria-label="日历视图" aria-pressed="' + (st.homeView === 'cal') + '">' + ic('calendar') + '<span class="vt-t">日历</span></button></div>'
    try {
      await renderHomeContent(st, query, current, content, context, toggle)
    } catch (e) {
      if (!current()) return
      st.txns = []
      st.attachments = {}
      st.total = 0
      const controls = st.homeView === 'cal' ? '<div class="card">' + toggle + '</div>' : renderFilterBar(st, toggle)
      commitHome(content, controls + '<div class="empty"><div class="big">' + ic('alert') + '</div>' +
        '<div role="status">账单暂时无法加载</div><button class="btn sm line" id="homeRetry">重新加载</button></div>', context)
      $('#homeRetry', content).addEventListener('click', () => window.App.renderTab())
      bindHomeTools()
    }
  }

  async function renderHomeContent(st, query, current, content, context, toggle) {
    const banner = pendingBanner() + (await dueBanner(st)) + (await reminderBanner(st))
    if (!current()) return
    const bCard = homeShow('budget') ? await budgetExecCard(st) : ''
    if (!current()) return

    if (st.homeView === 'cal') {
      await renderCalendar(st, banner + bCard, toggle, current)
      return
    }

    const res = await S.listTransactions(query)
    if (!current()) return
    await reimbPending()
    if (!current()) return
    const filterBar = renderFilterBar(st, toggle)
    const active = Object.keys(query).some(key => !['from', 'to', 'limit', 'offset'].includes(key))
    const resultCount = active
      ? '<div class="search-head" role="status">' + esc(periodTitle(st)) + ' · 找到 <b>' + res.total + '</b> 笔' +
        (res.total > res.rows.length ? ' · 已显示 ' + res.rows.length + ' 笔' : '') + '</div>'
      : ''
    if (!res.rows.length) {
      const emptyHtml = await emptyStateHtml(st)
      if (!current()) return
      /* 首次使用（账本全空）时把引导卡提到预算卡之前，保证「记第一笔」在首屏可见；
         本期无记录 / 筛选无结果时预算卡仍在前——此时用户已有数据，更关心预算执行 */
      const firstRun = emptyHtml.indexOf('onboard-card') >= 0
      /* 首次使用：账本全空，搜索框和「支出/收入/转账」筛选都没有可筛的东西，
         一起藏掉，只留一张引导卡（终审 3.1「空态收成一张卡」）。
         引导卡垂直居中：否则手机上一张 180px 的卡下面挂着近 500px 空白，
         看起来像页面没加载完。 */
      st.txns = []
      st.attachments = {}
      st.total = res.total
      commitHome(content, firstRun
        ? banner + '<div class="home-empty">' + emptyHtml + '</div>'
        : banner + bCard + filterBar + resultCount + emptyHtml, context)
      bindReminderEvents(st)
      bindHomeTools()
      bindBudgetCard()
      bindEmptyState(st)
      return
    }

    const atts = await S.listAttachments(res.rows.map(t => t.id))
    if (!current()) return
    st.txns = res.rows
    st.total = res.total
    st.attachments = atts

    const groups = groupByDay(res.rows)
    const accounts = new Map(S.allAccounts().map(a => [String(a.id), a]))
    const currencyOf = t => accounts.get(String(t.account_id))?.currency || 'CNY'
    const money = (cents, code) => F.privacy() ? '****' : esc(F.moneySym(cents, F.currencySym(code)))
    function subtotals(rows) {
      const sums = new Map()
      for (const t of rows) {
        if (t.txn_type !== 'expense' && t.txn_type !== 'income') continue
        const currency = currencyOf(t)
        const sum = sums.get(currency) || { expense: 0, income: 0 }
        sum[t.txn_type] += F.toCents(t.amount)
        sums.set(currency, sum)
      }
      return Array.from(sums, ([currency, sum]) => [
        sum.expense ? '支出 <span class="num">' + money(sum.expense, currency) + '</span>' : '',
        sum.income ? '收入 <span class="num">' + money(sum.income, currency) + '</span>' : ''
      ].filter(Boolean).join(' · ')).filter(Boolean).join(' · ')
    }
    const summary = active ? subtotals(res.rows) : ''
    let html = banner + bCard + filterBar + resultCount +
      (summary ? '<div class="search-head">' + (res.total > res.rows.length ? '已显示记录小计' : '筛选小计') + ' · ' + summary + '</div>' : '')
    html += groups.map(g => {
      const daySummary = subtotals(g.items)
      const partialDay = res.total > res.rows.length && g === groups[groups.length - 1]
      const head = '<div class="day-head"><span>' + F.humanDay(g.items[0].occurred_at) + '</span>' +
        '<span class="day-subtotal">' + (partialDay && daySummary ? '已显示 · ' : '') + daySummary + '</span></div>'
      const body = '<div class="card txn-list" style="padding:0">' + g.items.map(t => txnRow(t, atts[t.id] || [], currencyOf(t))).join('') + '</div>'
      return '<div class="day-group">' + head + body + '</div>'
    }).join('')

    if (res.total > res.rows.length) {
      html += '<button class="btn line block" id="loadMore" style="margin-top:4px">加载更多（共 ' + res.total + ' 笔，已显示 ' + res.rows.length + '）</button>'
    }
    commitHome(content, html, context)
    fillImages(st)
    bindTxnClicks()
    bindReminderEvents(st)
    bindHomeTools()
    bindBudgetCard()
  }

  function bindReminderEvents(st) {
    const add = $('#remindAdd')
    if (add) add.addEventListener('click', () => openEditor(null))
    const dis = $('#remindDismiss')
    if (dis) dis.addEventListener('click', () => {
      try { localStorage.setItem('ledger10_remind_dismiss', F.dstr(new Date())) } catch (e) { /* 忽略 */ }
      renderHome(st).then(() => window.App.bindContentEvents())
    })
    const due = $('#dueView')
    if (due) due.addEventListener('click', () => Lazy.need('manage').then(m => m && m.openRecurringManager()))
    const pend = $('#pendView')
    if (pend) pend.addEventListener('click', () => Lazy.need('review').then(m => m && m.openReview()))
  }

  /* 导入完一批账单后，它们先待在「待确认」队列里等用户过一眼。
     这里只读本机 localStorage，不查库，所以放在首页渲染路径上也不拖速度。 */
  function pendingBanner() {
    let n = 0, legacyIds = []
    let readFailed = false
    try {
      const id = S.mode === 'cloud' ? S.state && S.state.uid : S.mode === 'guest' ? S.state && S.state.sourceId : ''
      const key = id ? 'ledger10_pending_v2:' + encodeURIComponent(JSON.stringify([S.mode, String(id)])) : ''
      const a = key ? JSON.parse(localStorage.getItem(key) || '[]') : []
      if (!Array.isArray(a)) throw new Error('invalid')
      n = a.length
      const old = JSON.parse(localStorage.getItem('ledger10_pending') || '[]')
      legacyIds = Array.isArray(old) ? old.filter(x => typeof x === 'string' || typeof x === 'number') : []
    } catch (e) { readFailed = true }
    const current = n ? '<div class="remind-banner" id="pendBanner">' +
      '<span style="font-size:18px">' + ic('square-check') + '</span>' +
      '<div class="grow"><b>' + n + ' 笔</b>账目等你确认分类</div>' +
      '<button class="btn sm line" id="pendView">去确认</button></div>' : ''
    return (readFailed ? '<div class="remind-banner small">待确认名单读取失败，请检查本机存储；原数据未删除。</div>' : '') + current + (legacyIds.length ? '<div class="remind-banner small"><div>旧版待确认名单已保留，但因无法确定所属账号，未自动显示；请核对原账目。' +
      '<details><summary>查看旧记录编号（只读）</summary>' + esc(legacyIds.slice(0, 50).join('、')) + (legacyIds.length > 50 ? '……仅显示前 50 条' : '') + '</details></div></div>' : '')
  }

  /* 未来 7 天到期的周期账单：固定支出（房租/话费/会员）是高频场景，
     以前只能在「记一笔 → 更多选项 → 周期」里建，建完就再也看不见了。
     这里给一条最小提示，点「查看」进到期视图。 */
  async function dueBanner(st) {
    if (st.scope !== 'month') return ''
    let rules = []
    try { rules = await S.listRecurring() } catch (e) { return '' }
    const active = (rules || []).filter(r => r.active !== false)
    if (!active.length) return ''
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let best = null
    active.forEach(r => {
      const due = F.nextDue(r.last_run_date || null, String(r.start_date).slice(0, 10), r.freq)
      if (!due) return
      const days = Math.round((new Date(due + 'T00:00:00') - today) / 86400000)
      if (days < 0 || days > 7) return
      if (!best || days < best.days) best = { r: r, due: due, days: days }
    })
    if (!best) return ''
    const name = best.r.note || (best.r.category_id ? S.categoryName(best.r.category_id) : '') || '周期账目'
    const when = best.days === 0 ? '今天' : best.days === 1 ? '明天' : best.due.slice(5) + ' · ' + best.days + ' 天后'
    return '<div class="remind-banner" id="dueBanner">' +
      '<span style="font-size:18px">' + ic('repeat') + '</span>' +
      '<div class="grow">未来 7 天：' + esc(name) + ' <b class="num">¥' + F.yuan(F.toCents(best.r.amount)) + '</b>（' + esc(when) + '）</div>' +
      '<button class="btn sm line" id="dueView">查看</button></div>'
  }

  /* ---------- 月历视图（鲨鱼式） ---------- */
  async function renderCalendar(st, banner, toggle, current) {
    if (st.scope !== 'month') {
    $('#content').innerHTML = banner + '<div class="card"><div class="between"><b>日历视图</b>' + toggle + '</div>' +
        '<div class="empty" style="padding:24px">日历视图只在「月」范围内可用，点右上角切回月</div></div>'
      bindBudgetCard()
      return
    }
    const from = F.iso(F.monthStart(st.year, st.month))
    const to = F.iso(F.monthEnd(st.year, st.month))
    const res = await S.listTransactions({ from, to, limit: 5000 })
    if (!current()) return
    const daily = {}
    res.rows.forEach(t => {
      const k = F.isoDay(t.occurred_at)
      if (!daily[k]) daily[k] = { exp: 0, inc: 0, items: [] }
      const c = F.toCents(t.amount)
      if (t.txn_type === 'expense') daily[k].exp += c
      else if (t.txn_type === 'income') daily[k].inc += c
      daily[k].items.push(t)
    })

    const first = F.monthStart(st.year, st.month)
    /* 周一开始 */
    const offset = (first.getDay() + 6) % 7
    const start = new Date(first); start.setDate(start.getDate() - offset)
    const todayKey = F.dstr(new Date())
    const monthKey = F.monthKey(first)
    const focusDay = st.calDay && st.calDay.slice(0, 7) === monthKey ? st.calDay :
      todayKey.slice(0, 7) === monthKey ? todayKey : F.dstr(first)
    /* 热力基准：当月单日最大支出 */
    let maxExp = 1
    Object.keys(daily).forEach(k => { if (daily[k].exp > maxExp) maxExp = daily[k].exp })
    let cells = ''
    const heads = ['一', '二', '三', '四', '五', '六', '日'].map(d => '<div class="cal-head" aria-hidden="true">' + d + '</div>').join('')
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i)
      const key = F.dstr(d)
      const inMonth = d.getMonth() === (st.month - 1)
      const v = daily[key]
      /* 花得越多底色越深（只在当月内着色） */
      let heat = 0
      if (v && v.exp > 0 && inMonth) {
        const r = v.exp / maxExp
        heat = r > 0.66 ? 3 : r > 0.33 ? 2 : 1
      }
      /* 圆点：按分类颜色标记当天有记录的分类，收入用绿色 */
      let dots = ''
      if (v && v.items.length) {
        const seen = {}
        const list = []
        v.items.forEach(t => {
          const c = S.category(t.category_id)
          const col = t.txn_type === 'income' ? 'var(--income)' : (c && c.color ? c.color : 'var(--expense)')
          const k2 = col + '|' + (c ? c.name : t.txn_type)
          if (seen[k2]) return
          seen[k2] = 1
          list.push({ col, name: (c ? c.name : '未分类') })
        })
        dots = '<span class="dots">' + list.slice(0, 4).map(x =>
          '<i title="' + esc(x.name) + '" style="background:' + x.col + '"></i>').join('') +
          (list.length > 4 ? '<i style="background:var(--sub)"></i>' : '') + '</span>'
      }
      const label = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日，' +
        ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()] +
        (v ? '，' + v.items.length + '笔记录' + (F.privacy() ? '，金额已隐藏' :
          (v.exp ? '，支出' + F.yuan(v.exp) + '元' : '') + (v.inc ? '，收入' + F.yuan(v.inc) + '元' : '')) : '，暂无记录')
      cells += '<' + (inMonth ? 'button type="button"' : 'div aria-hidden="true"') + ' class="cal-cell' +
        (inMonth ? '' : ' other') + (key === todayKey ? ' today' : '') +
        (st.calDay === key ? ' sel' : '') + (heat ? ' h' + heat : '') + '" data-day="' + key + '"' +
        (inMonth ? ' tabindex="' + (key === focusDay ? '0' : '-1') + '" aria-pressed="' + (st.calDay === key) + '" aria-label="' + esc(label) + '"' +
          (key === todayKey ? ' aria-current="date"' : '') : '') + '>' +
        '<span class="d num">' + d.getDate() + '</span>' +
        (v && v.inc ? '<span class="a inc num">+' + F.compactYuan(v.inc) + '</span>' : '') +
        (v && v.exp ? '<span class="a exp num">-' + F.compactYuan(v.exp) + '</span>' : '') +
        dots + '</' + (inMonth ? 'button' : 'div') + '>'
      if (i >= 28 && d.getMonth() !== (st.month - 1) && d.getDay() === 0) break
    }

    /* 选中日期的账目 */
    let dayList = ''
    if (st.calDay && daily[st.calDay]) {
      const dd = daily[st.calDay]
      const atts = await S.listAttachments(dd.items.map(t => t.id))
      if (!current()) return
      st.attachments = atts
      st.txns = dd.items
      const sumTxt = (dd.exp ? '支 ' + F.yuan(dd.exp) : '') + (dd.exp && dd.inc ? '　' : '') + (dd.inc ? '收 ' + F.yuan(dd.inc) : '')
      dayList = '<div class="day-head" style="margin-top:4px"><span>' + F.humanDay(st.calDay + 'T12:00') + '</span>' +
        '<span class="num">' + sumTxt + '</span></div>' +
        '<div class="card txn-list" style="padding:0">' + dd.items.map(t => txnRow(t, atts[t.id] || [])).join('') + '</div>'
    } else if (st.calDay) {
      st.txns = []
      dayList = '<div class="empty" style="padding:18px">这一天没有记录</div>'
    } else {
      st.txns = res.rows
    }

    const activeDate = document.activeElement
    const restoreDate = activeDate && activeDate.matches('#content button.cal-cell') ? activeDate.dataset.day : null
    $('#content').innerHTML = banner +
      '<div class="card"><div class="between" style="margin-bottom:8px"><b>' + st.year + '年' + st.month + '月</b>' + toggle + '</div>' +
      '<div class="cal-grid" role="group" aria-label="' + st.year + '年' + st.month + '月收支日历">' + heads + cells + '</div></div>' +
      dayList
    const dateButtons = $$('#content button.cal-cell')
    const focusDate = button => {
      dateButtons.forEach(el => { el.tabIndex = el === button ? 0 : -1 })
      button.focus()
    }
    dateButtons.forEach((c, index) => {
      c.addEventListener('focus', () => dateButtons.forEach(el => { el.tabIndex = el === c ? 0 : -1 }))
      c.addEventListener('keydown', e => {
        if (e.altKey || e.ctrlKey || e.metaKey) return
        const weekday = (new Date(c.dataset.day + 'T12:00').getDay() + 6) % 7
        const moves = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - 7, ArrowDown: index + 7,
          Home: index - weekday, End: index + 6 - weekday }
        if (!(e.key in moves)) return
        e.preventDefault()
        focusDate(dateButtons[Math.max(0, Math.min(dateButtons.length - 1, moves[e.key]))])
      })
      c.addEventListener('click', () => {
        const key = c.dataset.day
        st.calDay = st.calDay === key ? null : key
        const work = renderHome(st), ticket = homeRenderVersion
        work.then(() => {
          if (ticket !== homeRenderVersion || st.tab !== 'home' || st.homeView !== 'cal') return
          window.App.bindContentEvents()
        })
      })
    })
    if (restoreDate) {
      const next = $('#content button.cal-cell[data-day="' + restoreDate + '"]')
      if (next) next.focus({ preventScroll: true })
    }
    if (st.calDay && daily[st.calDay]) {
      fillImages(st)
      bindTxnClicks()
    }
    bindReminderEvents(st)
    bindBudgetCard()
  }

  function groupByDay(rows) {
    const map = {}
    const order = []
    rows.forEach(t => {
      const k = F.isoDay(t.occurred_at)
      if (!map[k]) { map[k] = []; order.push(k) }
      map[k].push(t)
    })
    return order.map(k => ({ day: k, items: map[k] }))
  }

  function txnRow(t, atts, currency) {
    const cat = t.category_id ? S.category(t.category_id) : null
    const icon = cat ? (cat.icon || '📦') : (t.txn_type === 'transfer' ? '🔄' : t.txn_type === 'income' ? '💰' : '📦')
    const color = cat ? (cat.color || '#8a93a6') : (t.txn_type === 'transfer' ? '#7c5cff' : '#8a93a6')
    const name = t.txn_type === 'transfer'
      ? (S.accountName(t.account_id) + ' → ' + S.accountName(t.to_account_id))
      : (cat ? (cat.parent_id ? S.categoryName(cat.parent_id) + ' · ' + cat.name : cat.name) : '未分类')
    const time = F.isoLocal(t.occurred_at).slice(11)
    const sub = [time, t.txn_type !== 'transfer' ? S.accountName(t.account_id) : '', t.note].filter(Boolean).join(' · ')
    const sign = t.txn_type === 'income' ? '+' : t.txn_type === 'expense' ? '-' : ''
    const thumbs = atts.length
      ? '<span class="row" style="gap:3px">' + atts.slice(0, 2).map(a => '<img class="thumb" data-aid="' + a.id + '" alt="">').join('') +
        (atts.length > 2 ? '<span class="tiny muted">+' + (atts.length - 2) + '</span>' : '') + '</span>'
      : ''
    /* 报销徽标：待报销 / 部分 / 已报销 三态都标出来，已收的用中性色，
       避免「已报销」和「还没拿回来」看起来一样 */
    const rst = reimbStatusOf(t)
    const reim = !rst ? '' :
      '<span class="tiny reim-badge ' + rst + '" style="border-radius:5px;padding:0 4px;margin-left:4px">' +
      (rst === 'done' ? '已报销' : rst === 'partial' ? '部分报销' : '待报销') + '</span>'
    /* 周期记账补记出来的账目带 tags:['auto']，标出来才能一眼分辨「我没记过这笔」 */
    const auto = (Array.isArray(t.tags) && t.tags.indexOf('auto') >= 0)
      ? '<span class="tiny auto-badge">自动</span>' : ''
    /* 批量编辑（B3）：多选态下行首多一个勾选位，行本身仍可点击（点击=切换选中） */
    const picked = batch.on && batch.sel.has(String(t.id))
    const pickBox = batch.on
      ? '<span class="pick-box' + (picked ? ' on' : '') + '" aria-hidden="true">' + (picked ? ic('check') : '') + '</span>'
      : ''
    return '<div class="txn' + (batch.on ? ' pick' : '') + (picked ? ' sel' : '') + '" role="button" tabindex="0"' +
      (batch.on ? ' aria-pressed="' + (picked ? 'true' : 'false') + '"' : '') +
      ' aria-label="' + (batch.on ? (picked ? '取消选择 ' : '选择 ') : '编辑 ') + esc(name) + '" data-id="' + t.id + '">' +
      pickBox +
      '<div class="ico" style="background:' + color + '1f">' + icon + '</div>' +
      '<div class="grow"><div class="ellipsis">' + hl(name) + reim + auto + '</div>' +
      '<div class="small muted ellipsis">' + hl(sub) + '</div></div>' +
      thumbs +
      '<div class="amt ' + t.txn_type + ' num">' + (F.privacy() ? '****' :
        sign + (currency ? esc(F.currencySym(currency)) : '') + F.yuan(F.toCents(t.amount))) + '</div>' +
      '</div>'
  }

  async function fillImages(st) {
    const byId = {}
    const map = st.attachments || {}
    Object.keys(map).forEach(k => map[k].forEach(a => { byId[a.id] = a }))
    const imgs = $$('#content img[data-aid]')
    await Promise.all(imgs.map(async img => {
      const att = byId[img.getAttribute('data-aid')]
      if (!att) return
      const url = await S.imageUrl(att)
      if (url) img.src = url
      img.addEventListener('click', ev => {
        ev.stopPropagation()
        if (img.src) lightbox(img.src)
      })
    }))
  }

  function bindTxnClicks() {
    const st = window.App.state
    const context = homeContext(st)
    $$('#content .txn').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } })
      el.addEventListener('click', () => {
        if (st.tab !== 'home' || context !== homeContext(st) || $('#mainView.hidden')) return
        const id = Number(el.getAttribute('data-id'))
        /* 多选态：点行 = 切换选中，不打开编辑器 */
        if (batch.on) { batchToggleOne(id); return }
        const txn = window.App.state.txns.find(t => t.id === id)
        if (txn) openEditor(txn)
      })
    })
  }

  /* ---------- 批量编辑（B3） ----------
     对标钱迹/随手记的「多选改分类/账户/删除」。本应用以前只能逐条进编辑器改，
     整理历史数据（比如把「餐饮」批量归到「外卖」）要点几十次。
     实现上刻意不发明新的写路径：改分类/改账户走 updateTransaction，
     删除走 deleteTransaction —— 都是已有的同步包装方法，
     断网时自然进本地待上传队列，幂等标记也照旧生效。 */
  let batch = { on: false, sel: new Set() }
  let batchObserver = null
  function batchContext(st) { return JSON.stringify([homeContext(st), st.filters]) }
  function endBatch() {
    batch = { on: false, sel: new Set() }
    repaintBatch()
  }
  function syncBatchContext(st) {
    if (batch.on && (st.tab !== 'home' || batch.context !== batchContext(st))) endBatch()
  }
  function batchRows() {
    return (window.App.state.txns || []).filter(t => batch.sel.has(String(t.id)))
  }
  function batchCategoryKind() {
    const rows = batchRows(), kinds = new Set(rows.map(t => t.txn_type))
    return rows.length === batch.sel.size && kinds.size === 1 && !kinds.has('transfer') ? rows[0].txn_type : ''
  }
  function batchPatchError(t, patch) {
    if (!t || t.deleted_at) return '账目已删除或不存在'
    if (patch.category_id != null) {
      const c = S.category(patch.category_id)
      if (!c || t.txn_type === 'transfer' || c.kind !== t.txn_type) return '分类与账目的收支类型不一致'
    }
    if (patch.account_id != null) {
      const accounts = S.allAccounts()
      const from = accounts.find(a => String(a.id) === String(t.account_id))
      const to = accounts.find(a => String(a.id) === String(patch.account_id))
      const cur = a => String(a && a.currency || 'CNY').toUpperCase()
      if (!from) return '原账户不明确，请先逐笔确认币种'
      if (!to) return '账户已不存在'
      if (cur(from) !== cur(to)) return '仅支持改到同币种账户，金额不会自动换算'
      if (t.txn_type === 'transfer') {
        const receiving = accounts.find(a => String(a.id) === String(t.to_account_id))
        if (!receiving || String(to.id) === String(receiving.id)) return '转出和转入账户不能相同'
        if (cur(to) !== cur(receiving)) return '暂不支持跨币种转账'
      }
    }
    return ''
  }
  function batchBarEl() {
    let el = $('#batchBar')
    if (!el) {
      el = document.createElement('div')
      el.id = 'batchBar'; el.className = 'batch-bar'
      el.setAttribute('role', 'toolbar'); el.setAttribute('aria-label', '批量操作')
      document.body.appendChild(el)
      const measure = () => {
        if (el.classList.contains('on')) document.body.style.setProperty('--batch-height', (el.getBoundingClientRect().height || 100) + 'px')
      }
      if (typeof ResizeObserver === 'function') { batchObserver = new ResizeObserver(measure); batchObserver.observe(el) }
      else window.addEventListener('resize', measure)
    }
    return el
  }
  function syncBatchBar() {
    const el = $('#batchBar') || (batch.on ? batchBarEl() : null)
    document.body.classList.toggle('batch-active', batch.on)
    if (!el) return
    if (!batch.on) { el.classList.remove('on'); el.innerHTML = ''; document.body.style.removeProperty('--batch-height'); return }
    const focused = el.contains(document.activeElement) ? document.activeElement.id : ''
    el.classList.add('on')
    const n = batch.sel.size, busy = batch.busy, disabled = busy ? ' disabled' : ''
    el.innerHTML =
      '<div class="batch-count" role="status">已选 <b class="num">' + n + '</b> 笔' + (busy ? ' · 正在处理…' : '') + '</div>' +
      '<div class="batch-acts">' +
      '<button type="button" class="btn sm line" id="batchAll"' + disabled + '>' + (n && n === (window.App.state.txns || []).length ? '取消全选' : '全选') + '</button>' +
      '<button type="button" class="btn sm line" id="batchCat"' + (!n || busy || !batchCategoryKind() ? ' disabled' : '') + '>改分类</button>' +
      '<button type="button" class="btn sm line" id="batchAcc"' + (!n || busy ? ' disabled' : '') + '>改账户</button>' +
      '<button type="button" class="btn sm danger" id="batchDel"' + (!n || busy ? ' disabled' : '') + '>删除</button>' +
      '<button type="button" class="btn sm line" id="batchExit"' + disabled + '>退出</button></div>'
    $('#batchAll').addEventListener('click', () => {
      if (batch.busy) return
      const all = (window.App.state.txns || []).map(t => String(t.id))
      if (batch.sel.size === all.length) batch.sel.clear()
      else all.forEach(id => batch.sel.add(id))
      repaintBatch()
    })
    $('#batchCat').addEventListener('click', batchPickCategory)
    $('#batchAcc').addEventListener('click', batchPickAccount)
    $('#batchDel').addEventListener('click', batchDelete)
    $('#batchExit').addEventListener('click', () => { if (!batch.busy) endBatch() })
    if (focused && $('#' + focused) && !$('#' + focused).disabled) $('#' + focused).focus({ preventScroll: true })
    requestAnimationFrame(() => {
      if (batch.on) document.body.style.setProperty('--batch-height', (el.getBoundingClientRect().height || 100) + 'px')
    })
  }
  function repaintBatch() {
    syncBatchBar()
    $$('[data-batch]').forEach(b => {
      b.classList.toggle('on', batch.on)
      b.setAttribute('aria-pressed', batch.on ? 'true' : 'false')
      b.disabled = !!batch.busy
    })
    $$('#content .txn').forEach(el => {
      const picked = batch.on && batch.sel.has(String(el.getAttribute('data-id')))
      el.classList.toggle('sel', picked); el.classList.toggle('pick', batch.on)
      const name = (el.getAttribute('aria-label') || '').replace(/^(编辑|选择|取消选择) /, '')
      el.setAttribute('aria-label', (batch.on ? picked ? '取消选择 ' : '选择 ' : '编辑 ') + name)
      if (batch.on) el.setAttribute('aria-pressed', picked ? 'true' : 'false')
      else el.removeAttribute('aria-pressed')
      let box = el.querySelector('.pick-box')
      if (!batch.on) { if (box) box.remove(); return }
      if (!box) {
        box = document.createElement('span'); box.className = 'pick-box'
        box.setAttribute('aria-hidden', 'true'); el.insertBefore(box, el.firstChild)
      }
      box.classList.toggle('on', picked); box.innerHTML = picked ? ic('check') : ''
    })
  }
  function batchToggleOne(id) {
    if (batch.busy) return
    const key = String(id)
    if (batch.sel.has(key)) batch.sel.delete(key)
    else batch.sel.add(key)
    repaintBatch()
  }
  function startBatch() {
    batch = { on: true, sel: new Set(), context: batchContext(window.App.state), busy: false }
    repaintBatch()
    toast('已进入多选：点账目选中，再选操作')
  }
  function batchPickCategory() {
    const kind = batchCategoryKind()
    if (batch.busy || !kind) return
    const roots = S.rootCategories(kind)
    let html = '<div class="sheet-head"><span class="sheet-title">批量改分类</span><button id="bcClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:8px">只修改同一收支类型的分类，金额保持原样。</div>'
    roots.forEach(p => {
      html += '<div class="field"><label>' + esc(p.icon || '') + ' ' + esc(p.name) + '</label><div class="chips">' +
        '<button type="button" class="chip" data-bcat="' + p.id + '">用「' + esc(p.name) + '」</button>' +
        S.childCategories(p.id).filter(c => c.kind === kind).map(c => '<button type="button" class="chip" data-bcat="' + c.id + '">' + esc(c.name) + '</button>').join('') + '</div></div>'
    })
    openSheet(html)
    $('#bcClose').addEventListener('click', closeSheet)
    $$('[data-bcat]', $('#sheet')).forEach(b => b.addEventListener('click', () => {
      closeSheet(); batchUpdate({ category_id: idNum(b.getAttribute('data-bcat')) }, '改分类')
    }))
  }
  function batchPickAccount() {
    if (batch.busy || !batch.sel.size) return
    const rows = batchRows(), list = S.allAccounts()
    openSheet('<div class="sheet-head"><span class="sheet-title">批量改账户</span><button id="baClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:8px">仅支持同币种账户，金额不换算；转出和转入账户不能相同。</div>' +
      list.map(a => {
        const reason = rows.length !== batch.sel.size ? '账目已变化，请重新选择' : rows.map(t => batchPatchError(t, { account_id: a.id })).find(Boolean)
        return '<button type="button" class="list-item" data-bacc="' + a.id + '"' + (reason ? ' disabled' : '') + ' style="width:100%;border:0;background:none;text-align:left">' +
          '<div class="ico">' + esc(a.icon || '💰') + '</div><div class="grow"><div>' + esc(a.name) + '</div><div class="small muted">' +
          esc(reason || a.currency || 'CNY') + '</div></div></button>'
      }).join(''))
    $('#baClose').addEventListener('click', closeSheet)
    $$('[data-bacc]', $('#sheet')).forEach(b => b.addEventListener('click', () => {
      closeSheet(); batchUpdate({ account_id: idNum(b.getAttribute('data-bacc')) }, '改账户')
    }))
  }
  async function runBatch(patch, label, remove) {
    syncBatchContext(window.App.state)
    const job = batch, ids = Array.from(job.sel).map(Number)
    if (!job.on || job.busy || !ids.length) return
    const reviewedRows = new Map(batchRows().map(t => [String(t.id), Object.assign({}, t)]))
    job.busy = true; repaintBatch()
    let ok = 0, reason = ''
    const failed = []
    for (let i = 0; i < ids.length; i++) {
      try {
        if (job !== batch || job.context !== batchContext(window.App.state) || window.App.state.tab !== 'home') throw new Error('页面或账本已切换，已停止操作')
        let t
        try { t = await S.getTransaction(ids[i]) }
        catch (e) {
          const writer = remove ? S.deleteTransaction : S.updateTransaction
          if (S.mode !== 'cloud' || !window.Sync || !window.Sync.isNetworkError(e) || !writer.__syncWrapped) throw e
          t = reviewedRows.get(String(ids[i]))
        }
        if (job !== batch || job.context !== batchContext(window.App.state)) throw new Error('页面或账本已切换，已停止操作')
        const error = batchPatchError(t, patch)
        if (error) throw new Error(error)
        if (remove) { const id = ids[i]; await S.deleteTransaction(id) }
        else await S.updateTransaction(ids[i], Object.assign({}, patch), t.updated_at)
        ok++
      } catch (e) { failed.push(ids[i]); reason = reason || e.message || '请重试' }
    }
    syncBatchContext(window.App.state)
    if (job === batch) {
      job.busy = false
      if (failed.length) { job.sel = new Set(failed.map(String)); repaintBatch() }
      else endBatch()
    }
    toast(failed.length ? label + '完成 ' + ok + ' 笔，失败 ' + failed.length + ' 笔：' + reason : '已' + label + ' ' + ok + ' 笔')
    window.App.refresh()
  }
  async function batchUpdate(patch, label) { return runBatch(patch, label, false) }
  async function batchDelete() {
    if (!batch.on || batch.busy || !batch.sel.size) return
    const job = batch
    if (!(await confirmSheet({ title: '批量删除', danger: true, okText: '删除 ' + job.sel.size + ' 笔',
      body: '选中的账目将移入回收站，可随时恢复。确定继续？' }))) return
    if (job === batch) return runBatch({}, '删除', true)
  }


  function idNum(v) { return /^\d+$/.test(String(v)) ? Number(v) : v }

  /* 常用筛选只保存条件；账本和日期始终使用应用时当前选择。 */
  function savedFilterKey() {
    const id = S.mode === 'cloud' ? S.state && S.state.uid : S.mode === 'guest' ? S.state && S.state.sourceId : ''
    if (!id) throw new Error('无法确认当前身份，不能使用常用筛选')
    return 'ledger10_saved_filters_v1:' + encodeURIComponent(JSON.stringify([S.mode, String(id)]))
  }
  function savedFilterList() {
    const key = savedFilterKey()
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return []
      const items = JSON.parse(raw)
      if (!Array.isArray(items) || items.some(x => !x || typeof x.name !== 'string' || !x.filters || typeof x.filters !== 'object')) throw new Error('invalid')
      return items
    } catch (e) { throw new Error('无法读取本机常用筛选，请检查浏览器存储') }
  }
  function savedFilterWrite(items) {
    const key = savedFilterKey()
    try { localStorage.setItem(key, JSON.stringify(items)) } catch (e) { throw new Error('保存失败，请检查本机存储空间和权限') }
  }
  function savedFilterSave(name, filters) {
    name = String(name || '').trim()
    if (!name || name.length > 40) throw new Error('名称需为 1 至 40 个字')
    const items = savedFilterList()
    if (items.some(x => x.name === name)) throw new Error('名称已存在，请换一个名称')
    if (items.length >= 30) throw new Error('最多保存 30 个筛选，请先删除不用的')
    const f = filters || {}
    items.push({ name, filters: { type: f.type || '', accountId: f.accountId || null, categoryId: f.categoryId || null,
      keyword: f.keyword || '', tag: f.tag || '', minAmount: f.minAmount || '', maxAmount: f.maxAmount || '', reimbursable: !!f.reimbursable } })
    savedFilterWrite(items)
  }
  function savedFilterApply(name) {
    const item = savedFilterList().find(x => x.name === name)
    if (!item) throw new Error('筛选已不存在，请重新选择')
    const f = item.filters
    if (f.accountId && !S.accounts().some(a => String(a.id) === String(f.accountId))) throw new Error('筛选中的账户已不存在或已归档，请删除后重新保存')
    if (f.categoryId && !S.category(f.categoryId)) throw new Error('筛选中的分类已不存在，请删除后重新保存')
    return Object.assign({}, f)
  }
  function savedFilterDelete(name) {
    const items = savedFilterList()
    if (!items.some(x => x.name === name)) throw new Error('筛选已不存在，请重新选择')
    savedFilterWrite(items.filter(x => x.name !== name))
  }

  function legacyReimbNotice() {
    try {
      const old = JSON.parse(localStorage.getItem('ledger10_reimb') || '{}')
      if (old && typeof old === 'object' && !Array.isArray(old) && Object.keys(old).length) {
        return '<div class="small muted" style="margin-top:6px">旧版报销进度未计入，待报销金额可能偏高，请核对。</div>'
      }
    } catch (e) { /* 保留无法读取的旧数据 */ }
    return ''
  }

  function renderFilterBar(st, toggle) {
    const f = st.filters
    const types = [['', '全部'], ['expense', '支出'], ['income', '收入'], ['transfer', '转账']]
    /* v4 缺陷 5：「待报销 ¥128.00」比「待报销 ¥128」宽 28px，390px 下正好把 chip
       顶出这一行的右缘，而这一行是单行横滚，顶出去等于被裁掉。所以金额做紧凑化：
       整元不显示小数；过千用过 k/万，把 chip 宽度封在 ~110px 以内。
       （不能改成换行：多出来的 48px 会把首屏第一条流水顶破 520px 硬线） */
    const reimbCents = reimbCache.owner === reimbKey() ? reimbCache.cents : 0
    const reimbTxt = reimbCents >= 100000 ? F.compactYuan(reimbCents) : F.yuan(reimbCents).replace(/\.00$/, '')
    const reimbAmt = reimbCache.owner === reimbKey() && reimbCache.count ? ' ¥' + reimbTxt : ''
    const chips = types.map(([v, label]) =>
      '<button class="chip' + (f.type === v ? ' on' : '') + '" data-ftype="' + v + '" aria-pressed="' + (f.type === v) + '">' + label + '</button>').join('') +
      '<button class="chip" id="reimEntry" title="查看待报销的账目">' + ic('receipt') + ' 待报销' + reimbAmt + '</button>'
    /* 「筛选」是工具不是过滤条件，放进搜索行做图标按钮：
       一是它和「支出/收入/转账」并排本来就不合语义，二是 chips 行在 390px 下会把它挤出卡片右缘 */
    const fActive = !!(f.tag || f.minAmount || f.maxAmount)
    const filterBtn = '<button class="chip filter-tool' + (st.filterOpen || fActive ? ' on' : '') +
      '" data-fpanel="1" aria-label="筛选" aria-expanded="' + (st.filterOpen ? 'true' : 'false') + '">' +
      ic('filter') + '</button>' +
      /* 多选（B3）：和「筛选」一样属于工具而不是过滤条件，放搜索行做图标按钮。
         放 chips 行会被 390px 的右缘裁掉，放筛选面板里又没人找得到。 */
      '<button class="chip filter-tool' + (batch.on ? ' on' : '') + '" data-batch="1" aria-label="批量编辑" aria-pressed="' + (batch.on ? 'true' : 'false') + '">' +
      ic('list') + '</button>'
    const accs = S.accounts()
    const accChips = accs.length > 1 && (st.filterOpen || f.accountId)
      ? '<div class="chips" style="margin-top:8px">' +
        '<button class="chip' + (!f.accountId ? ' on' : '') + '" data-facc="" aria-pressed="' + !f.accountId + '">全部账户</button>' +
        accs.map(a => '<button class="chip' + (f.accountId === a.id ? ' on' : '') + '" data-facc="' + a.id + '" aria-pressed="' + (f.accountId === a.id) + '">' + esc(a.icon) + ' ' + esc(a.name) + '</button>').join('') +
        '</div>'
      : ''
    /* 从统计页跳转过来时带着分类筛选，这里给一个可清除的提示 chip */
    const catChip = f.categoryId
      ? '<div class="chips" style="margin-top:8px">' +
        '<button class="chip on" data-fcatclear="1">' + ic('tag') + ' ' + esc(S.categoryName(f.categoryId)) + ' ' + ic('close') + '</button>' +
        '</div>'
      : ''
    const applied = [
      ['tag', '标签', f.tag],
      ['minAmount', '最低金额', F.privacy() && f.minAmount ? '****' : f.minAmount],
      ['maxAmount', '最高金额', F.privacy() && f.maxAmount ? '****' : f.maxAmount]
    ].filter(([, , value]) => value !== '' && value != null)
    const appliedChips = applied.length ? '<div class="applied-filters" role="group" aria-label="已生效条件">' +
      applied.map(([field, label, value]) => '<button class="chip" data-fremove="' + field + '" aria-label="取消' +
        label + '条件，当前为 ' + esc(value) + '"><span>' + label + '：' + esc(value) + '</span>' + ic('close') + '</button>').join('') + '</div>' : ''
    let saved = []
    let savedError = ''
    if (st.filterOpen) { try { saved = savedFilterList() } catch (e) { savedError = e.message } }
    const savedPanel = '<div class="small muted" style="margin-top:10px">常用筛选仅保存在本机，应用时使用当前账本和时间；请先应用上方条件再保存。</div>' +
      (savedError ? '<div class="small">' + esc(savedError) + '</div>' :
        '<div class="row" style="gap:8px;margin-top:6px"><select id="savedFilterSelect" class="select grow" aria-label="常用筛选">' +
        '<option value="">选择常用筛选</option>' + saved.map(x => '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>').join('') + '</select>' +
        '<button class="btn sm line" id="savedFilterApply">使用</button><button class="btn sm line" id="savedFilterDelete">删除</button></div>' +
        '<button class="btn sm line" id="savedFilterSave" style="margin-top:6px">保存当前筛选</button>')
    const panel = st.filterOpen
      ? '<div class="filter-panel">' +
        '<div class="row" style="gap:8px">' +
        '<input id="fMinAmt" class="input" style="height:38px" type="number" inputmode="decimal" aria-label="最小金额" placeholder="最小金额" value="' + esc(f.minAmount || '') + '">' +
        '<span class="muted">—</span>' +
        '<input id="fMaxAmt" class="input" style="height:38px" type="number" inputmode="decimal" aria-label="最大金额" placeholder="最大金额" value="' + esc(f.maxAmount || '') + '">' +
        '</div>' +
        '<div class="row" style="gap:8px;margin-top:8px">' +
        '<input id="fTag" class="input grow" style="height:38px" aria-label="按标签筛选" placeholder="按标签筛选，如「聚餐」" value="' + esc(f.tag || '') + '">' +
        '<button class="btn sm" id="fApply" style="flex:none">应用</button>' +
        '<button class="btn sm line" id="fClear" style="flex:none">清空</button>' +
        '</div><div class="err" id="filterError" role="alert"></div>' + savedPanel + '</div>'
      : ''
    return '<div class="card filter-bar">' +
      '<div class="row"><div class="keyword-field grow"><input id="kwInput" type="search" aria-label="搜索账单" enterkeyhint="search" class="input" placeholder="搜索备注 / 分类 / 账户 / 金额" value="' + esc(f.keyword) + '">' +
      '<button type="button" id="clearKeyword" aria-label="清除搜索关键词"' + (f.keyword ? '' : ' hidden') + '>' + ic('close') + '</button></div>' +
      filterBtn + (toggle || '') + '</div><div id="searchProgress" class="small muted" role="status" hidden>正在查找…</div>' +
      '<div class="chips scroll mask-fade" style="margin-top:8px">' + chips + '</div>' + legacyReimbNotice() + catChip + accChips +
      appliedChips +
      '<div class="chips scroll mask-fade' + (st.filterOpen ? '' : ' hidden') + '" style="margin-top:8px">' +
      '<button class="chip" id="homeGallery">' + ic('image') + ' 凭证相册</button>' +
      '<button class="chip" id="homeTag">' + ic('tag') + ' 标签</button>' +
      '<button class="chip" id="homeReport">' + ic('chart-bar') + ' 报表中心</button>' +
      '</div>' + panel +
      '</div>'
  }

  /* 明细页工具入口：相册 / 标签 / 报表中心 */
  function bindHomeTools() {
    $$('[data-batch]').forEach(b => b.addEventListener('click', () => {
      if (batch.busy) return
      if (batch.on) endBatch()
      else startBatch()
    }))
    const sfSave = $('#savedFilterSave')
    if (sfSave) sfSave.addEventListener('click', () => {
      const name = prompt('为当前筛选命名（仅保存在本机）')
      if (name == null) return
      try { savedFilterSave(name, window.App.state.filters); toast('筛选已保存在本机'); window.App.renderTab() } catch (e) { toast(e.message) }
    })
    const sfApply = $('#savedFilterApply')
    if (sfApply) sfApply.addEventListener('click', () => {
      try {
        const name = $('#savedFilterSelect').value
        if (!name) throw new Error('请先选择常用筛选')
        Object.assign(window.App.state.filters, savedFilterApply(name))
        toast('已应用筛选，账本和时间保持当前选择')
        window.App.renderTab()
      } catch (e) { toast(e.message) }
    })
    const sfDelete = $('#savedFilterDelete')
    if (sfDelete) sfDelete.addEventListener('click', async () => {
      try {
        const name = $('#savedFilterSelect').value
        if (!name) throw new Error('请先选择常用筛选')
        if (!(await confirmSheet({ title: '删除常用筛选', danger: true, okText: '删除', body: '删除常用筛选「' + name + '」？' }))) return
        savedFilterDelete(name); toast('已删除常用筛选'); window.App.renderTab()
      } catch (e) { toast(e.message) }
    })
    const rb = $('#reimEntry')
    if (rb) rb.addEventListener('click', () => { Lazy.need('reimb').then(m => m && m.openPanel()) })
    const g = $('#homeGallery')
    if (g) g.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openGallerySheet()) })
    const t = $('#homeTag')
    if (t) t.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openTagManager()) })
    const r = $('#homeReport')
    if (r) r.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openReportCenter()) })
  }

  async function loadMore(st) {
    /* 分页的正确做法是「扩大本次查询的条数」而不是追加：
       renderHome 会整体重绘并重新查询，若仍按首页条数取，追加的内容会被覆盖掉 */
    st.loaded = (st.loaded || st.pageSize) + st.pageSize
    await renderHome(st)
    if (window.App && window.App.bindContentEvents) window.App.bindContentEvents()
  }

  /* ---------- 统计 ---------- */
  let statsRenderVersion = 0
  function statsContext(st) {
    return JSON.stringify([S.mode, reimbKey(), S.activeBookId ? S.activeBookId() : null,
      st.statRange, st.scope, st.year, st.month])
  }
  async function renderStats(st) {
    const content = $('#content'), version = ++statsRenderVersion
    const context = statsContext(st), snapshot = Object.assign({}, st)
    const current = () => version === statsRenderVersion && st.tab === 'stats' &&
      $('#content') === content && !$('#mainView.hidden') && context === statsContext(st)
    if (!current()) return
    const active = document.activeElement
    const focusedRange = active && active.matches('#statSeg [data-sr]') ? active.getAttribute('data-sr') : null
    const seg = '<div class="seg" id="statSeg" role="group" aria-label="统计范围">' +
      [['month', '本月'], ['year', '本年'], ['decade', '全部']].map(([v, l]) =>
        '<button class="' + (snapshot.statRange === v ? 'on' : '') + '" data-sr="' + v + '" aria-pressed="' + (snapshot.statRange === v) + '">' + l + '</button>').join('') +
      '</div>'
    let body = ''
    try {
      if (snapshot.statRange === 'month') body = await statsMonth(snapshot)
      else if (snapshot.statRange === 'year') body = await statsYear(snapshot)
      else body = await statsDecade(snapshot)
    } catch (e) {
      body = '<div class="empty"><div class="big">' + ic('alert') + '</div>统计失败：' + esc(e.message || '') + '</div>'
    }
    if (!current()) return
    const tools = '<div class="row" style="gap:8px;margin-bottom:12px">' +
      '<button class="btn line grow" id="stReport">' + ic('chart-bar') + ' 报表中心</button>' +
      '<button class="btn line grow" id="stHealth">' + ic('heart') + ' 财务健康度</button>' +
      '</div>'
    const restoreRangeFocus = focusedRange && document.activeElement === active
    content.innerHTML = seg + tools + body
    if (restoreRangeFocus) {
      const rangeButton = $('[data-sr="' + focusedRange + '"]', content)
      if (rangeButton) rangeButton.focus({ preventScroll: true })
    }
    $$('#statSeg button').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-sr')
        st.statRange = v
        /* 一套控件管一个期间（P1-2）：顶部期间栏在统计页是隐藏的，
           这里把 scope 一起改掉，概览卡的结余/支出/收入才会跟着变 */
        st.scope = v === 'year' ? 'year' : v === 'decade' ? 'all' : 'month'
        if (v === 'month' || v === 'year') {
          const now = new Date()
          if (v === 'month' && (st.year !== now.getFullYear())) st.year = now.getFullYear()
          if (v === 'month') st.month = now.getMonth() + 1
        }
        renderStats(st)
        if (window.App && window.App.renderOverview) window.App.renderOverview()
      })
    })
    const stR = $('#stReport')
    if (stR) stR.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openReportCenter()) })
    const stH = $('#stHealth')
    if (stH) stH.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openHealth()) })
    /* 终审 3.2：支出结构空态里的「记一笔」 */
    const sea = $('#stEmptyAdd')
    if (sea) sea.addEventListener('click', () => openEditor(null))
    bindBudgetCard()
    /* 年度热力图默认滚到当前月份：自然年日历有 53 列，窄屏只能露出 1 月，
       不滚的话用户看不到当月数据，会误以为「没记账」 */
    const hs = $('#heatScroll')
    if (hs && st.year === new Date().getFullYear()) {
      const m = new Date().getMonth()
      requestAnimationFrame(() => {
        hs.scrollLeft = Math.max(0, Math.round(hs.scrollWidth * (m / 12) - hs.clientWidth / 2))
      })
    }
    /* renderStats 会被「本月/本年/十年」切换直接再次调用，重绘后需要重新绑定
       分类排行跳转、逐月跳转等由 bindContentEvents 负责的交互 */
    if (window.App && window.App.bindContentEvents) window.App.bindContentEvents()
  }

  /* ---------- 资金流向（账户 → 支出分类） ---------- */
  async function flowData(from, to) {
    const { rows } = await S.listTransactions({ from, to, type: 'expense', limit: 100000 })
    const accMap = {}
    const catMap = {}
    const links = {}
    rows.forEach(t => {
      const cents = F.toCents(t.amount)
      if (t.account_id != null) accMap[t.account_id] = (accMap[t.account_id] || 0) + cents
      if (t.category_id != null) catMap[t.category_id] = (catMap[t.category_id] || 0) + cents
      const k = (t.account_id == null ? -1 : t.account_id) + '|' + (t.category_id == null ? -1 : t.category_id)
      links[k] = (links[k] || 0) + cents
    })
    const accArr = Object.keys(accMap).map(id => ({
      key: 'a' + id, id: Number(id),
      name: S.accountName(Number(id)) || '账户', color: '#2f6bff', value: accMap[id],
    })).sort((x, y) => y.value - x.value).slice(0, 5)
    const catArr = Object.keys(catMap).map(id => {
      const c = S.category(Number(id))
      return { key: 'c' + id, id: Number(id), name: c ? c.name : '未分类', color: c ? c.color : '#e5484d', value: catMap[id] }
    }).sort((x, y) => y.value - x.value).slice(0, 7)
    const accKeys = new Set(accArr.map(x => x.id))
    const catKeys = new Set(catArr.map(x => x.id))
    const linkArr = Object.keys(links).map(k => {
      const parts = k.split('|')
      const a = Number(parts[0]); const c = Number(parts[1])
      return { l: 'a' + a, r: 'c' + c, value: links[k] }
    }).filter(l => accKeys.has(Number(l.l.slice(1))) && catKeys.has(Number(l.r.slice(1))))
    return { left: accArr, right: catArr, links: linkArr }
  }

  async function renderFlowCard(st) {
    const C = await charts()
    const { from, to } = periodRange(st)
    let flow
    try { flow = await flowData(from, to) } catch (e) { return '' }
    if (!flow.left.length || !flow.right.length) return ''
    return '<div class="card">' +
      '<div class="between" style="margin-bottom:10px"><b>资金流向</b><span class="small muted">账户 → 支出分类</span></div>' +
      '<div class="chart-scroll">' + C.sankey(flow) + '</div>' +
      '<div class="small muted" style="margin-top:6px">越粗的连线代表花得越多，点击可看金额</div>' +
      '</div>'
  }

  async function statsMonth(st) {
    const C = await charts()
    const from = F.iso(F.monthStart(st.year, st.month))
    const to = F.iso(F.monthEnd(st.year, st.month))
    const prev = new Date(st.year, st.month - 2, 1)
    const pFrom = F.iso(F.monthStart(prev.getFullYear(), prev.getMonth() + 1))
    const pTo = F.iso(F.monthEnd(prev.getFullYear(), prev.getMonth() + 1))
    const [cats, days, pCats, pDays] = await Promise.all([
      S.categorySummary(from, to, 'expense'), S.monthlySummary(from, to),
      S.categorySummary(pFrom, pTo, 'expense'), S.monthlySummary(pFrom, pTo),
    ])
    let expense = 0
    let income = 0
    days.forEach(d => { expense += F.toCents(d.expense); income += F.toCents(d.income) })
    let pExpense = 0
    let pIncome = 0
    pDays.forEach(d => { pExpense += F.toCents(d.expense); pIncome += F.toCents(d.income) })
    const items = cats.filter(c => c.category_id != null).map(c => {
      const cat = S.category(c.category_id)
      return { name: cat ? cat.name : '未分类', value: F.toCents(c.total), color: cat ? cat.color : '#8a93a6', id: c.category_id }
    }).sort((a, b) => b.value - a.value)

    const flowCard = await renderFlowCard(st)
    const budgetCard = await budgetExecCard(st, expense, true)
    const dnum = new Date(st.year, st.month, 0).getDate()
    const passed = (new Date() >= F.monthStart(st.year, st.month) && new Date() < F.monthEnd(st.year, st.month))
      ? new Date().getDate() : dnum

    /* 环比卡片（一木式结论） */
    const momLine = (label, cur, prevV, isExpense) => {
      if (!prevV) return '<div class="kv"><span>' + label + '</span><span class="muted small">上月无数据</span></div>'
      const diff = cur - prevV
      const pct = Math.round(diff / prevV * 100)
      const up = diff > 0
      const bad = isExpense ? up : !up
      return '<div class="kv"><span>' + label + '</span><span class="num" style="color:' + (bad ? 'var(--expense)' : 'var(--income)') + '">' +
        (up ? '↑' : '↓') + ' ' + Math.abs(pct) + '%（' + (up ? '+' : '-') + F.money(Math.abs(diff)) + '）</span></div>'
    }
    /* 分类异动：比上月涨得最多的 3 类 */
    const pMap = {}
    pCats.forEach(c => { if (c.category_id != null) pMap[c.category_id] = F.toCents(c.total) })
    const movers = items.map(it => ({ name: it.name, diff: it.value - (pMap[it.id] || 0), value: it.value, prev: pMap[it.id] || 0 }))
      .filter(m => m.diff !== 0)
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 3)
    const moverHtml = movers.length
      ? movers.map(m => '<div class="kv"><span>' + esc(m.name) + '</span><span class="num" style="color:' + (m.diff > 0 ? 'var(--expense)' : 'var(--income)') + '">' +
          (m.diff > 0 ? '↑ +' : '↓ -') + F.money(Math.abs(m.diff)) + '</span></div>').join('')
      : '<div class="small muted">与上月持平</div>'

    /* 分类预算进度（本月） */
    const monthKey = F.monthKey(new Date(st.year, st.month - 1, 1))
    const catBudgetRows = S.rootCategories('expense').map(c => {
      const b = S.budgetOf(monthKey, c.id)
      if (b == null || F.toCents(b) <= 0) return null
      const spentItem = items.find(it => {
        const cat = S.category(it.id)
        return cat && (cat.id === c.id || cat.parent_id === c.id)
      })
      /* 含子分类合计 */
      let spent = 0
      items.forEach(it => {
        const cat = S.category(it.id)
        if (cat && (cat.id === c.id || cat.parent_id === c.id)) spent += it.value
      })
      const total = F.toCents(b)
      const pct = Math.min(100, total ? spent / total * 100 : 0)
      const cls = spent > total ? 'over' : pct > 80 ? 'warn' : ''
      return '<div style="margin-bottom:10px">' +
        '<div class="row" style="font-size:13px;justify-content:space-between"><span>' + esc(c.icon) + ' ' + esc(c.name) + '</span>' +
        '<span class="num small muted">¥' + F.yuan(spent) + ' / ¥' + F.yuan(total) + '</span></div>' +
        '<div class="progress ' + cls + '" style="margin-top:4px"><i style="width:' + pct + '%"></i></div></div>'
    }).filter(Boolean).join('')

    /* 预算卡移到最后（P1-2）：进统计页先看到「钱花在哪」的图，
       预算执行是看完结构之后才关心的第二层信息 */
    return '<div class="card">' +
      (items.length
        ? '<div class="between" style="margin-bottom:10px"><b>支出结构</b><span class="small muted">共 ' + items.length + ' 类</span></div>' + C.donut(items)
        : /* 终审 3.2 / 细节 11：空态时藏起「共 0 类」（像数据而不是空态），
             压到 80px 以内，并把「记一笔」放进空态当动作 */
          '<div class="between" style="margin-bottom:10px"><b>支出结构</b></div>' +
          '<div class="empty" style="padding:14px 8px">本月还没有支出记录<br>' +
          '<button class="btn sm line" id="stEmptyAdd" style="margin-top:10px">记一笔</button></div>') +
      '</div>' +
      '<div class="card">' +
      '<div class="between" style="margin-bottom:6px"><b>环比上月</b><span class="small muted">' + (prev.getMonth() + 1) + '月 → ' + st.month + '月</span></div>' +
      /* 终审 3.2：上月整月无记录时，两行「上月无数据」+ Top3 合并成一句人话 */
      ((pExpense > 0 || pIncome > 0)
        ? momLine('支出', expense, pExpense, true) +
          momLine('收入', income, pIncome, false) +
          '<div style="margin-top:6px;margin-bottom:2px" class="small muted">分类异动 Top3</div>' + moverHtml
        : '<div class="small muted">上月没有记录，下个月就能看到环比</div>') +
      '</div>' +
      (catBudgetRows
        ? '<div class="card"><div class="between" style="margin-bottom:10px"><b>分类预算</b><span class="small muted">本月进度</span></div>' + catBudgetRows + '</div>'
        : '') +
      '<div class="card">' +
      '<div class="between" style="margin-bottom:10px"><b>分类排行</b></div>' +
      (items.length ? C.barList(items.slice(0, 12)) : '<div class="small muted">暂无数据</div>') +
      '</div>' +
      flowCard +
      '<div class="card">' +
      '<div class="kv"><span>本月支出</span><b class="num" style="color:var(--expense)">¥' + F.yuan(expense) + '</b></div>' +
      '<div class="kv"><span>本月收入</span><b class="num" style="color:var(--income)">¥' + F.yuan(income) + '</b></div>' +
      '<div class="kv"><span>日均支出</span><b class="num">¥' + F.yuan(Math.round(expense / Math.max(passed, 1))) + '</b></div>' +
      '</div>' + budgetCard
  }

  async function statsYear(st) {
    const C = await charts()
    const from = F.iso(new Date(st.year, 0, 1))
    const to = F.iso(new Date(st.year + 1, 0, 1))
    const [rows, cats] = await Promise.all([S.monthlySummary(from, to), S.categorySummary(from, to, 'expense')])
    const byMonth = {}
    rows.forEach(r => { byMonth[r.month_key] = r })
    const trendData = []
    for (let m = 1; m <= 12; m++) {
      const key = st.year + '-' + F.pad2(m)
      const r = byMonth[key]
      trendData.push({ label: m + '月', income: r ? F.toCents(r.income) : 0, expense: r ? F.toCents(r.expense) : 0 })
    }
    const items = cats.filter(c => c.category_id != null).map(c => {
      const cat = S.category(c.category_id)
      return { name: cat ? cat.name : '未分类', value: F.toCents(c.total), color: cat ? cat.color : '#8a93a6', id: c.category_id }
    }).sort((a, b) => b.value - a.value)
    const flowCard = await renderFlowCard(st)
    /* 月均口径：当年只统计到当前月份，避免「今年才 10 月却除以 12」把均值拉低 */
    const nowD = new Date()
    const isCurYear = st.year === nowD.getFullYear()
    const monthCount = isCurYear ? (nowD.getMonth() + 1) : 12
    const avgLabel = isCurYear ? '月均支出（1–' + monthCount + '月）' : '月均支出'
    let yExpense = 0
    let yIncome = 0
    rows.forEach(r => { yExpense += F.toCents(r.expense); yIncome += F.toCents(r.income) })

    /* ---------- 年度账单（各家年终总结式） ---------- */
    const res = await S.listTransactions({ from, to, limit: 20000 })
    const txns = res.rows
    let biggest = null
    const daySet = {}
    const monthExp = {}
    txns.forEach(t => {
      const c = F.toCents(t.amount)
      if (t.txn_type === 'expense') {
        if (!biggest || c > biggest.cents) biggest = { cents: c, note: t.note || S.categoryName(t.category_id), day: F.isoDay(t.occurred_at) }
        const mk = F.monthOf(t.occurred_at)
        monthExp[mk] = (monthExp[mk] || 0) + c
      }
      if (t.txn_type !== 'transfer') daySet[F.isoDay(t.occurred_at)] = true
    })
    let topMonth = null
    Object.keys(monthExp).forEach(k => { if (!topMonth || monthExp[k] > topMonth.v) topMonth = { k, v: monthExp[k] } })
    /* 连续记账天数（截至今天/年末往前推） */
    let streak = 0
    {
      const end = new Date(Math.min(new Date().getTime(), F.monthEnd(st.year, 12).getTime()))
      const d = new Date(end)
      if (!daySet[F.dstr(d)]) d.setDate(d.getDate() - 1) /* 今天还没记不算断 */
      while (daySet[F.dstr(d)]) { streak++; d.setDate(d.getDate() - 1) }
    }
    const topCat = items[0]
    const reportHtml = txns.length
      ? '<div class="report-hero">' +
        '<div class="sub">' + st.year + ' 年度账单</div>' +
        '<div class="big-num num">¥' + F.yuan(yExpense) + '</div>' +
        '<div class="sub">全年支出 · 收入 ¥' + F.yuan(yIncome) + '</div>' +
        '<div class="report-grid" style="margin-top:12px">' +
        '<div class="report-cell"><div class="k">记账天数</div><div class="v num">' + Object.keys(daySet).length + ' 天</div></div>' +
        '<div class="report-cell"><div class="k">连续记账</div><div class="v num">' + streak + ' 天</div></div>' +
        '<div class="report-cell"><div class="k">最大单笔支出</div><div class="v num" style="font-size:14px">¥' + (biggest ? F.yuan(biggest.cents) : '0.00') + '</div>' +
        '<div class="k ellipsis">' + (biggest ? esc(biggest.note) + ' · ' + biggest.day.slice(5) : '') + '</div></div>' +
        '<div class="report-cell"><div class="k">花钱最多的月份</div><div class="v num">' + (topMonth ? Number(topMonth.k.slice(5)) + '月' : '—') + '</div>' +
        '<div class="k">' + (topCat ? '最爱花在 ' + esc(topCat.name) : '') + '</div></div>' +
        '</div></div>'
      : ''

    /* 无数据的月份显示灰色「—」而不是红绿 0.00，避免整片零值噪音 */
    const cellV = (val, color) =>
      '<div class="v num" style="color:' + (val > 0 ? color : 'var(--sub)') + ';opacity:' + (val > 0 ? '1' : '.5') + '">' +
      (val > 0 ? F.yuan(val) : '—') + '</div>'
    const grid = '<div class="year-grid">' + trendData.map((d, i) => {
      const mm = st.year + '-' + F.pad2(i + 1)
      return '<div class="year-cell" data-month="' + mm + '"><div class="m">' + (i + 1) + '月</div>' +
        cellV(d.expense, 'var(--expense)') + cellV(d.income, 'var(--income)') + '</div>'
    }).join('') + '</div>'

    return reportHtml +
      '<div class="card">' +
      '<div class="between" style="margin-bottom:6px"><b>' + st.year + ' 年月度趋势</b>' +
      '<span class="tiny muted"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#12a150"></i> 收入　<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#e5484d"></i> 支出</span></div>' +
      C.trend(trendData) + '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:10px"><b>年度支出结构</b></div>' +
      (items.length ? C.donut(items) : '<div class="small muted">暂无数据</div>') + '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:10px"><b>逐月明细</b><span class="small muted">点击可跳转</span></div>' + grid + '</div>' +
      flowCard +
      '<div class="card">' +
      '<div class="kv"><span>全年支出</span><b class="num" style="color:var(--expense)">¥' + F.yuan(yExpense) + '</b></div>' +
      '<div class="kv"><span>全年收入</span><b class="num" style="color:var(--income)">¥' + F.yuan(yIncome) + '</b></div>' +
      '<div class="kv"><span>' + avgLabel + '</span><b class="num">¥' + F.yuan(Math.round(yExpense / monthCount)) + '</b></div>' +
      '</div>'
  }

  async function statsDecade(st) {
    const C = await charts()
    const nowYear = new Date().getFullYear()
    const fromYear = nowYear - 9
    const from = F.iso(new Date(fromYear, 0, 1))
    const to = F.iso(new Date(nowYear + 1, 0, 1))
    const rows = await S.monthlySummary(from, to)
    const byYear = {}
    rows.forEach(r => {
      const y = r.month_key.slice(0, 4)
      byYear[y] = byYear[y] || { income: 0, expense: 0, months: 0 }
      byYear[y].income += F.toCents(r.income)
      byYear[y].expense += F.toCents(r.expense)
      byYear[y].months++
    })
    const trendData = []
    for (let y = fromYear; y <= nowYear; y++) {
      const v = byYear[String(y)] || { income: 0, expense: 0 }
      trendData.push({ label: String(y).slice(2) + '年', income: v.income, expense: v.expense })
    }

    /* 热力图：当前年份每日支出 */
    const hFrom = F.iso(new Date(st.year, 0, 1))
    const hTo = F.iso(new Date(st.year + 1, 0, 1))
    const res = await S.listTransactions({ from: hFrom, to: hTo, limit: 5000 })
    const daily = {}
    res.rows.forEach(t => {
      if (t.txn_type !== 'expense') return
      const k = F.isoDay(t.occurred_at)
      daily[k] = (daily[k] || 0) + F.toCents(t.amount)
    })

    const yearRows = Object.keys(byYear).sort().map(y => {
      const v = byYear[y]
      return '<div class="kv"><span>' + y + ' 年</span>' +
        '<span><b class="num" style="color:var(--expense)">¥' + F.yuan(v.expense) + '</b>' +
        ' <span class="muted">/</span> <b class="num" style="color:var(--income)">¥' + F.yuan(v.income) + '</b></span></div>'
    }).join('')

    return '<div class="card">' +
      '<div class="between" style="margin-bottom:6px"><b>近十年收支趋势</b><span class="tiny muted">单位：元</span></div>' +
      C.trend(trendData) + '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:10px"><b>' + st.year + ' 年支出日历</b>' +
      '<span class="tiny muted">颜色越深花得越多</span></div>' +
      C.heatmap(st.year, daily) + '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:6px"><b>年度汇总</b></div>' +
      (yearRows || '<div class="small muted">暂无数据</div>') + '</div>'
  }

  /* ---------- 攒钱目标 × 账户联动 ----------
     目标表结构不可改（无法加列），关联关系存本机 localStorage。
     auto=true 时目标进度自动跟随关联账户余额（封顶在目标金额）。 */
  const GOALLINK_KEY = 'ledger10_goallink'
  function goalLinks() {
    try { return JSON.parse(localStorage.getItem(GOALLINK_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function goalLink(id) { return goalLinks()[String(id)] || null }
  function setGoalLink(id, link) {
    const m = goalLinks()
    if (!link || !link.accountId) delete m[String(id)]
    else m[String(id)] = link
    try { localStorage.setItem(GOALLINK_KEY, JSON.stringify(m)) } catch (e) { /* 忽略 */ }
  }
  /* 攒钱目标的「每月自动存入」配置：只存本机（不改表结构）。
     每次打开应用补记该补的月份，和手动存入同一个口径（只改进度，不动账户余额）。 */
  const GOALAUTO_KEY = 'ledger10_goalauto'
  function goalAutoAll() {
    try { return JSON.parse(localStorage.getItem(GOALAUTO_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function setGoalAuto(id, cfg) {
    const m = goalAutoAll()
    if (!cfg || !(Number(cfg.amount) > 0)) delete m[String(id)]
    else m[String(id)] = cfg
    try { localStorage.setItem(GOALAUTO_KEY, JSON.stringify(m)) } catch (e) { /* 忽略 */ }
  }
  async function applyGoalAuto() {
    const m = goalAutoAll()
    const keys = Object.keys(m)
    if (!keys.length) return 0
    const goals = S.listGoals() || []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let made = 0
    for (const key of keys) {
      const cfg = m[key]
      const g = goals.find(x => String(x.id) === key)
      if (!g || g.done) continue
      const cents = F.toCents(cfg.amount)
      if (!(cents > 0)) continue
      let cursor = cfg.last ? new Date(cfg.last + 'T00:00:00') : today
      for (let guard = 0; guard < 12; guard++) {
        const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
        if (next > today) break
        /* 第三个参数传调用时刻的余额快照：断网重试时云端按「值没变才写」判定，
           不会把同一个月的自动存入加两次 */
        try { await S.goalDeposit(g.id, cents, Number(g.saved_amount)) } catch (e) { break }
        cursor = next
        made++
        const cur = (S.listGoals() || []).find(x => String(x.id) === String(g.id))
        if (cur) g.saved_amount = cur.saved_amount
      }
      cfg.last = F.dstr(cursor)
    }
    try { localStorage.setItem(GOALAUTO_KEY, JSON.stringify(m)) } catch (e) { /* 忽略 */ }
    return made
  }

  /* 反向推算：按目标金额与期限算每月该存多少；再按「当前速度」反推预计达成月份，
     跟目标日期差几个月也一并说出来 —— 这就是 YNAB Targets 那句「晚 3 个月」。 */
  function goalAdvice(g, saved) {
    const target = F.toCents(g.target_amount)
    const remain = Math.max(0, target - saved)
    if (g.done || remain <= 0) return ''
    const head = '还差 <b>¥' + F.yuan(remain) + '</b>'
    const t0 = Date.parse(g.created_at || '')
    let rate = 0
    if (isFinite(t0) && saved > 0 && Date.now() > t0) {
      rate = saved / Math.max(1, (Date.now() - t0) / (86400000 * 30.4))
    }
    const etaMonths = rate > 0 ? Math.max(1, Math.ceil(remain / rate)) : 0
    const eta = new Date()
    if (etaMonths) eta.setMonth(eta.getMonth() + etaMonths)
    const etaLabel = eta.getFullYear() + '-' + F.pad2(eta.getMonth() + 1)
    if (g.deadline) {
      const dl = new Date(String(g.deadline).slice(0, 10) + 'T00:00:00')
      if (!isNaN(dl)) {
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const days = Math.ceil((dl - today) / 86400000)
        if (days <= 0) return head + '，目标日期已过'
        const need = Math.max(1, Math.ceil(days / 30.4))
        let out = head + ' · 每月存 <b>¥' + F.yuan(Math.ceil(remain / need)) + '</b> 可赶上 ' + F.dstr(dl)
        if (etaMonths) {
          const late = etaMonths - need
          out += ' · 按当前速度预计 <b>' + etaLabel + '</b>' + (late > 0 ? '，晚 ' + late + ' 个月' : '，来得及')
        }
        return out
      }
    }
    if (etaMonths) return head + ' · 按当前速度每月约存 ¥' + F.yuan(Math.round(rate)) + '，预计 <b>' + etaLabel + '</b> 达成'
    return head + ' · 填个目标日期，就能算出每月该存多少'
  }

  /* ---------- 资产 ---------- */
  async function renderAssets(st) {
    /* wealth.js 是懒加载模块（借贷 / 对账 / 预算 / 信用卡），
       首屏绘制完成后由 Lazy 预取；这里 await 一次，之后全程用 W。 */
    const W = await Lazy.need('wealth')
    const C = await charts()
    const list = await S.accountBalances()
    const [netSeries, cards, anyTxn] = await Promise.all([
      S.netWorthSeries(12).catch(() => []),
      W ? W.listCards(list).catch(() => []) : Promise.resolve([]),
      S.listTransactions({ limit: 1 }).catch(() => null),
    ])
    /* 终审 3.3：净值趋势的展示条件从「非零」放宽到「非零 或 记满 5 笔」——
       一天记 10 笔但净额正好抵平的用戶不该看空图 */
    const txnTotal = anyTxn && anyTxn.total ? anyTxn.total : 0
    const cardMap = {}
    cards.forEach(c => { cardMap[c.account.id] = c })
    /* 多币种：总资产按基准币种折算，账户行保留原币种金额 */
    const base = F.baseCurrency()
    const baseSym = F.currencySym(base)
    let total = 0
    let foreignCount = 0
    list.forEach(x => {
      const cur = x.account.currency || base
      if (cur !== base) foreignCount++
      total += F.toBase(x.balance, cur)
    })
    const debtTotal = list.reduce((s, x) => {
      if (!W || !W.isDebtAccount(x.account)) return s
      const v = x.account.kind === W.LOAN_IN ? Math.max(0, -x.balance) : Math.max(0, x.balance)
      return s + F.toBase(v, x.account.currency || base)
    }, 0)
    const rows = list.map(x => {
      const a = x.account
      const debt = W ? W.isDebtAccount(a) : false
      const card = cardMap[a.id]
      const cur = a.currency || base
      const isForeign = cur !== base
      const kindLabel = window.ACCOUNT_KIND_LABEL[a.kind] || '账户'
      const sub = ((kindLabel && a.name !== kindLabel) ? kindLabel : '') +
        (isForeign ? ' · ' + cur : '') +
        (card && card.limit > 0 ? ' · 可用 ¥' + F.yuan(card.available) : '') +
        (card && card.dueDay && card.used > 0 ? ' · 还款日 ' + card.dueDay + ' 号' : '')
      const amtColor = x.balance < 0 ? 'var(--expense)' : 'var(--text)'
      const amtHtml = isForeign
        ? '<div style="text-align:right"><div class="num" style="font-weight:700;color:' + amtColor + '">' +
            F.moneySym(x.balance, F.currencySym(cur)) + '</div>' +
          '<div class="tiny muted">≈ ' + baseSym + F.yuan(F.toBase(x.balance, cur)) + '</div></div>'
        : '<div class="num" style="font-weight:700;color:' + amtColor + '">' + F.moneySym(x.balance, baseSym) + '</div>'
      return '<div class="list-item">' +
        '<div class="ico">' + esc(a.icon || '💰') + '</div>' +
        '<div class="grow"><div>' + esc(a.name) +
        (debt ? ' <span class="pill ' + (a.kind === W.LOAN_IN ? 'pill-exp' : 'pill-inc') + '">' +
          (a.kind === W.LOAN_IN ? '我欠别人' : '别人欠我') + '</span>' : '') + '</div>' +
        '<div class="small muted">' + sub + '</div></div>' +
        amtHtml +
        /* 即使账面为零，也可能与实际余额不符。 */
        (debt ? '' : '<button class="btn sm line" data-recon="' + a.id + '" style="flex:none">对账</button>') +
        '</div>'
    }).join('')

    /* 攒钱目标 —— 先做一次「自动跟随」同步，再渲染 */
    const balMap = {}
    list.forEach(x => { balMap[x.account.id] = x.balance })
    const accById = {}
    S.allAccounts().forEach(a => { accById[a.id] = a })
    const goals0 = S.listGoals()
    let synced = false
    for (const g of goals0) {
      const lk = goalLink(g.id)
      if (!lk || !lk.auto || !lk.accountId) continue
      const b = balMap[lk.accountId]
      if (b == null) continue
      const tgt = F.toCents(g.target_amount)
      const next = Math.max(0, Math.min(tgt, b))
      if (Math.abs(next - F.toCents(g.saved_amount)) >= 1) {
        try {
          await S.updateGoal(g.id, { saved_amount: next / 100, done: next >= tgt && tgt > 0 })
          synced = true
        } catch (e) { /* 同步失败不阻塞渲染 */ }
      }
    }
    const goals = synced ? S.listGoals() : goals0

    const goalHtml = goals.map(g => {
      const target = F.toCents(g.target_amount)
      const saved = F.toCents(g.saved_amount)
      const pct = target > 0 ? Math.min(100, saved / target * 100) : 0
      const lk = goalLink(g.id)
      const linkedAcc = lk && lk.accountId ? accById[lk.accountId] : null
      const linkedCur = linkedAcc ? (linkedAcc.currency || base) : base
      const advice = goalAdvice(g, saved)
      const linkLine = linkedAcc
        ? '<div class="row" style="gap:6px;margin-top:4px;align-items:center">' +
          '<span class="small muted grow" style="min-width:0;overflow-wrap:anywhere">' + ic('link') + ' 「' + esc(linkedAcc.name) + '」' +
          F.moneySym(balMap[linkedAcc.id] || 0, F.currencySym(linkedCur)) +
          (lk.auto ? ' · 自动跟随' : ' · 差 ¥' + F.yuan(Math.max(0, target - Math.max(0, balMap[linkedAcc.id] || 0)))) +
          '</span>' +
          (lk.auto ? '' : '<button class="btn sm ghost" data-gsync="' + g.id + '" style="flex:none;padding:2px 8px">同步</button>') +
          '</div>'
        : ''
      return '<div class="goal-card">' +
        '<div class="top"><span style="font-size:20px">' + esc(g.icon || '🎯') + '</span>' +
        '<div class="grow"><div class="name">' + esc(g.name) + (g.done ? ' <span class="goal-done">已达成</span>' : '') + '</div>' +
        '<div class="deadline">' + (g.deadline ? '目标日期 ' + esc(String(g.deadline).slice(0, 10)) : '无期限') + '</div></div>' +
        '<div class="num" style="font-weight:700">' + baseSym + F.yuan(saved) + '<span class="muted small"> / ' + baseSym + F.yuan(target) + '</span></div></div>' +
        '<div class="progress' + (g.done ? '' : pct > 80 ? ' warn' : '') + '"><i style="width:' + pct + '%;' + (g.done ? 'background:var(--income)' : '') + '"></i></div>' +
        linkLine +
        (advice ? '<div class="small muted" style="margin-top:4px">' + advice + '</div>' : '') +
        '<div class="row" style="gap:8px;margin-top:8px">' +
        '<button class="btn sm ghost grow" data-gdep="' + g.id + '">存入</button>' +
        '<button class="btn sm line grow" data-gwd="' + g.id + '">取出</button>' +
        '<button class="btn sm line grow" data-gedit="' + g.id + '">' + (linkedAcc ? '设置' : '关联') + '</button>' +
        '<button class="btn sm danger" data-gdel="' + g.id + '" style="flex:none">删</button>' +
        '</div></div>'
    }).join('')

    $('#content').innerHTML =
      '<div class="card">' +
      '<div class="between" style="margin-bottom:8px"><b>净资产</b>' +
      '<span class="ic-info" title="净资产 = 全部账户余额（含负债）之和，与「本月结余」不是同一口径">' + ic('info') + '</span>' +
      '<button class="btn sm ghost" id="fxBtn" style="padding:2px 10px">' + ic('exchange') + ' ' +
      (foreignCount ? base + ' 折算 · ' + foreignCount + ' 个外币账户' : '汇率设置') + '</button></div>' +
      '<div style="font-size:26px;font-weight:700" class="num" id="netWorthVal">' + baseSym + F.yuan(total) + '</div>' +
      (debtTotal > 0 ? '<div class="small muted" style="margin-top:4px">含未结清的借入借出 ' + baseSym + F.yuan(debtTotal) + '</div>' : '') +
      '</div>' +
      ((netSeries.length && netSeries.some(p => p.value !== 0)) || txnTotal >= 5
        ? '<div class="card"><div class="between" style="margin-bottom:6px"><b>净资产趋势</b>' +
          '<span class="tiny muted">近 12 个月' + (foreignCount ? ' · 折算为 ' + base : '') + '</span></div>' + C.line(netSeries) + '</div>'
        : '<div class="card"><div class="between" style="margin-bottom:6px"><b>净资产趋势</b></div>' +
          '<div class="empty" style="padding:20px 8px">记一笔，这里会出现净值趋势</div></div>') +
      '<div class="card" style="padding:0">' + (rows || '<div class="empty" style="padding:24px">还没有账户</div>') + '</div>' +
      '<div style="margin-bottom:12px">' +
      '<div class="row" style="gap:8px">' +
      '<button class="btn line grow" id="addAccountBtn">＋ 新建账户</button>' +
      '<button class="btn grow" id="transferBtn">账户转账</button>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:8px">' +
      '<button class="btn sm line grow" id="debtBtn">' + ic('users') + ' 借入借出</button>' +
      '<button class="btn sm line grow" id="cardBtn">' + ic('credit-card') + ' 信用卡</button>' +
      '<button class="btn sm line grow" id="budgetCenterBtn">' + ic('target') + ' 预算</button>' +
      '</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="between" style="margin-bottom:' + (goals.length ? '10' : '0') + 'px"><b>攒钱目标</b>' +
      '<button class="btn sm ghost" id="addGoalBtn">＋ 新目标</button></div>' +
      (goalHtml || '<div class="small muted" style="margin-top:8px">还没目标。设一个「旅行基金」或「换手机」，每存一笔都能看到进度。</div>') +
      '</div>'
    $('#addAccountBtn').addEventListener('click', openAccountEditor)
    $('#transferBtn').addEventListener('click', () => openEditor(null, 'transfer'))
    $('#debtBtn').addEventListener('click', () => { Lazy.need('wealth').then(m => m && m.openDebtSheet()) })
    $('#cardBtn').addEventListener('click', () => { Lazy.need('wealth').then(m => m && m.openCardSheet()) })
    $('#budgetCenterBtn').addEventListener('click', () => { Lazy.need('wealth').then(m => m && m.openBudgetCenter()) })
    $$('#content [data-recon]').forEach(b => {
      b.addEventListener('click', () => {
        Lazy.need('wealth').then(m => m && m.openReconcile(Number(b.getAttribute('data-recon'))))
      })
    })
    $('#addGoalBtn').addEventListener('click', () => openGoalEditor())
    const fxB = $('#fxBtn')
    if (fxB) fxB.addEventListener('click', () => openFxSettings())
    $$('#content [data-gdep]').forEach(b => {
      b.addEventListener('click', () => openGoalDeposit(Number(b.getAttribute('data-gdep')), 1))
    })
    $$('#content [data-gwd]').forEach(b => {
      b.addEventListener('click', () => openGoalDeposit(Number(b.getAttribute('data-gwd')), -1))
    })
    $$('#content [data-gdel]').forEach(b => {
      b.addEventListener('click', async () => {
        const gid = Number(b.getAttribute('data-gdel'))
        if (!(await confirmSheet({ title: '删除目标', body: '删除这个攒钱目标？', danger: true, okText: '删除' }))) return
        await S.deleteGoal(gid)
        setGoalLink(gid, null)
        toast('已删除')
        renderAssets(st)
      })
    })
    $$('#content [data-gedit]').forEach(b => {
      b.addEventListener('click', () => openGoalEditor(Number(b.getAttribute('data-gedit'))))
    })
    $$('#content [data-gsync]').forEach(b => {
      b.addEventListener('click', async () => {
        const gid = Number(b.getAttribute('data-gsync'))
        const g = S.listGoals().find(x => x.id === gid)
        const lk = goalLink(gid)
        if (!g || !lk) return
        const b0 = (balMap[lk.accountId] != null) ? balMap[lk.accountId] : 0
        const tgt = F.toCents(g.target_amount)
        const next = Math.max(0, Math.min(tgt, b0))
        try {
          await S.updateGoal(gid, { saved_amount: next / 100, done: next >= tgt && tgt > 0 })
          toast('已同步为账户余额')
          renderAssets(st)
        } catch (e) { toast('同步失败') }
      })
    })
  }

  /* 目标编辑器已搬进 wealth.js（攒钱目标是理财模块的事，也顺带省首屏预算） */
  function openGoalEditor(id) { return Lazy.need('wealth').then(m => m && m.openGoalEditor(id)) }

  function openGoalDeposit(id, sign) {
    const g = S.listGoals().find(x => x.id === id) || S.state.goals.find(x => x.id === id)
    if (!g) return
    const lk = goalLink(g.id)
    const la = lk && lk.accountId ? S.allAccounts().find(a => a.id === lk.accountId) : null
    const autoNote = (la && lk.auto)
      ? '<div class="small" style="color:var(--warn,#e08b00);margin-bottom:8px">该目标已开启「自动跟随」，下次打开资产页会用「' + esc(la.name) + '」的余额覆盖这里的手动调整。</div>'
      : (la ? '<div class="small muted" style="margin-bottom:8px">关联账户：「' + esc(la.name) + '」</div>' : '')
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (sign > 0 ? '存入' : '取出') + ' · ' + esc(g.name) + '</span>' +
      '<button id="gdClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:8px">已存 ¥' + F.yuan(F.toCents(g.saved_amount)) + ' / 目标 ¥' + F.yuan(F.toCents(g.target_amount)) + '（不影响账户余额与收支统计）</div>' +
      autoNote +
      '<div class="field"><label>金额（元）</label><input id="gdAmt" class="input" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="100"></div>' +
      '<div class="err" id="gdErr"></div>' +
      '<button class="btn block" id="gdSave">确认' + (sign > 0 ? '存入' : '取出') + '</button>'
    )
    $('#gdClose').addEventListener('click', closeSheet)
    $('#gdSave').addEventListener('click', async () => {
      const v = Number($('#gdAmt').value)
      if (!v || v <= 0) { $('#gdErr').textContent = '请输入大于 0 的金额'; return }
      if (sign < 0 && v > Number(g.saved_amount)) { $('#gdErr').textContent = '取出不能超过已存金额'; return }
      try {
        /* 传调用时刻的余额快照（幂等存入），断网重试不会重复加钱 */
        await S.goalDeposit(id, sign * v, Number(g.saved_amount))
        closeSheet()
        toast(sign > 0 ? '已存入，离目标更近了' : '已取出')
        window.App.renderTab()
      } catch (e) { $('#gdErr').textContent = e && e.code === 'CONFLICT' ? '目标刚被其他设备修改过，请刷新后重试' : '操作失败' }
    })
  }

  function openAccountEditor() {
    /* 借入 / 借出账户由「借入借出」统一创建，这里不暴露，避免余额方向搞反 */
    const kinds = Object.keys(window.ACCOUNT_KIND_LABEL).filter(k => k !== 'loan_in' && k !== 'loan_out')
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">新建账户</span><button id="accClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>名称</label><input id="accName" class="input" placeholder="如：招行储蓄卡" maxlength="20"></div>' +
      '<div class="field"><label>类型</label><div class="chips" id="accKinds">' +
      kinds.map((k, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-kind="' + k + '">' + window.ACCOUNT_KIND_LABEL[k] + '</button>').join('') +
      '</div></div>' +
      '<div class="field"><label>币种</label><select id="accCur" class="select">' +
      F.CURRENCIES.map(c => '<option value="' + c.code + '"' + (c.code === F.baseCurrency() ? ' selected' : '') + '>' +
        c.code + ' · ' + c.name + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>期初余额</label><input id="accInit" class="input" type="number" step="0.01" value="0" inputmode="decimal"></div>' +
      '<div class="field"><label>图标（emoji）</label><input id="accIcon" class="input" value="💰" maxlength="4"></div>' +
      '<div class="err" id="accErr"></div>' +
      '<button class="btn block" id="accSave">保存</button>'
    )
    let kind = kinds[0]
    $$('#accKinds .chip').forEach(b => {
      b.addEventListener('click', () => {
        $$('#accKinds .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        kind = b.getAttribute('data-kind')
      })
    })
    $('#accClose').addEventListener('click', closeSheet)
    $('#accSave').addEventListener('click', async () => {
      const name = $('#accName').value.trim()
      if (!name) { $('#accErr').textContent = '请填写账户名称'; return }
      try {
        await S.addAccount({
          name, kind, icon: $('#accIcon').value.trim() || '💰',
          color: '#2f6bff', initial_balance: Number($('#accInit').value || 0), sort_order: 99,
          currency: $('#accCur').value || F.baseCurrency(),
        })
        closeSheet()
        toast('账户已添加')
        window.App.renderTab()
      } catch (e) {
        $('#accErr').textContent = '保存失败：' + (e.message || '请重试')
      }
    })
  }

  /* ---------- 汇率设置 ---------- */

  /* ---------- 期间快选（点顶部年月标题） ---------- */
  async function openPeriodPicker(st) {
    let y = st.year || new Date().getFullYear()
    const curM = st.month || (new Date().getMonth() + 1)
    const today = new Date()
    let monthsWithData = {}

    async function loadMarks() {
      monthsWithData = {}
      try {
        const rows = await S.monthlySummary(F.iso(new Date(y, 0, 1)), F.iso(new Date(y + 1, 0, 1)))
        ;(rows || []).forEach(r => {
          if (F.toCents(r.expense) > 0 || F.toCents(r.income) > 0) monthsWithData[Number(String(r.month_key).slice(5))] = true
        })
      } catch (e) { /* 拿不到就不显示小圆点 */ }
    }

    function body() {
      const cells = []
      for (let m = 1; m <= 12; m++) {
        const on = st.scope === 'month' && y === st.year && m === curM
        const future = y > today.getFullYear() || (y === today.getFullYear() && m > today.getMonth() + 1)
        cells.push('<button class="pp-cell' + (on ? ' on' : '') + (future ? ' future' : '') + (monthsWithData[m] ? ' has' : '') +
          '" data-pp-month="' + m + '">' + m + '月<span class="dot"></span></button>')
      }
      return '<div class="pp-yearbar">' +
        '<button class="period-btn" id="ppPrev" aria-label="上一年">‹</button>' +
        '<span class="pp-year num">' + y + ' 年</span>' +
        '<button class="period-btn" id="ppNext" aria-label="下一年">›</button>' +
        '</div>' +
        '<div class="pp-grid" id="ppGrid">' + cells.join('') + '</div>' +
        '<div class="pp-quick">' +
        '<button class="btn sm line grow" id="ppThisMonth">回到本月</button>' +
        '<button class="btn sm line grow" id="ppThisYear">看本年</button>' +
        '<button class="btn sm line grow" id="ppAll">全部时间</button>' +
        '</div>' +
        '<div class="hint">点月份直接跳转；有记录的月份下方会有小圆点</div>'
    }

    openSheet('<div class="sheet-head"><span class="sheet-title">选择期间</span><button id="ppClose" class="btn sm line">关闭</button></div>' +
      '<div id="ppBody"><div class="small muted" style="padding:10px 0">加载中…</div></div>')
    $('#ppClose').addEventListener('click', closeSheet)

    async function paint() {
      await loadMarks()
      const box = $('#ppBody')
      if (!box) return
      box.innerHTML = body()
      $('#ppPrev').addEventListener('click', () => { y--; paint() })
      $('#ppNext').addEventListener('click', () => { y++; paint() })
      $$('#ppGrid .pp-cell').forEach(b => b.addEventListener('click', () => {
        st.year = y
        st.month = Number(b.getAttribute('data-pp-month'))
        st.scope = 'month'
        st.calDay = null
        closeSheet()
        window.App.setTab('home')
      }))
      $('#ppThisMonth').addEventListener('click', () => {
        const n = new Date()
        st.year = n.getFullYear(); st.month = n.getMonth() + 1; st.scope = 'month'; st.calDay = null
        closeSheet(); window.App.setTab('home')
      })
      $('#ppThisYear').addEventListener('click', () => {
        st.year = new Date().getFullYear(); st.scope = 'year'; st.calDay = null
        closeSheet(); window.App.setTab('home')
      })
      $('#ppAll').addEventListener('click', () => {
        st.scope = 'all'; st.calDay = null
        closeSheet(); window.App.setTab('home')
      })
    }
    await paint()
  }

  /* ---------- 我的 ---------- */
  /* 数据安全状态卡：按「登录态 + 上次备份时间」分级提示。
     目的是把「防丢失」变成一个顺手的小习惯，而不是靠吓唬用户。
     实现放在懒加载的 vault.js（statusCardHtml），避免占首屏体积。 */
  /* 数据状态卡（P2-2）：原来「游客模式」和「备份状态」是两张卡，
     说的是同一件事、合计 321px，深色模式下标题还是浅色叠浅底（对比度 1.13:1）。
     现在合并成一张：懒加载模块就绪前先给一个同步兜底卡，加载后原地替换。 */
  function backupStatusCard() {
    const isGuest = window.DB.mode === 'guest'
    return '<div id="bkCard"><div class="card callout callout--warn">' +
      '<div class="callout-title">' + (isGuest ? '数据只在这台设备上' : '数据在云端，建议留一份本机备份') + '</div>' +
      '<p class="small" style="margin:6px 0 0">' +
      (isGuest ? '换手机、清浏览器数据都会丢。登录可跨设备同步，或先导出一份备份。'
               : '备份文件在你自己手里，是最后的保险。') +
      '</p></div></div>'
  }

  async function fillBackupCard() {
    const box = document.getElementById('bkCard')
    if (!box) return
    try {
      const V = await Lazy.need('vault')
      if (V && V.statusCardHtml) box.innerHTML = V.statusCardHtml()
    } catch (e) { /* 忽略 */ }
  }

  const meFolds = new Map()
  let meRenderVersion = 0
  async function renderMe(st) {
    const version = ++meRenderVersion, content = $('#content'), context = homeContext(st)
    const current = () => version === meRenderVersion && content === $('#content') && st.tab === 'me' &&
      homeContext(st) === context && !$('#mainView.hidden')
    const isGuest = window.DB.mode === 'guest'
    const usage = await S.storageUsage().catch(() => ({ count: 0, bytes: 0 }))
    const txnCount = await S.listTransactions({ limit: 1 }).catch(() => ({ total: 0 }))
    const monthKey = F.monthKey(new Date(st.year, st.month - 1, 1))
    const budget = S.budgetOf(monthKey, null)
    /* 周期补记的账目数：只取 total，不拉正文 */
    const autoN = await S.listTransactions({ tag: 'auto', limit: 1 }).then(r => r.total || 0).catch(() => 0)
    if (!current()) return
    $$('[data-me-fold]', content).forEach(el => meFolds.set(el.dataset.meFold, el.open))

    /* 我的页重排（P1-5）：39 项平铺 4.3 屏、没有分组标题，找「加密备份」要滑很久。
       现在按五组归类（记账设置 / 账户与预算 / 报表与凭证 / 数据与安全 / 外观与提醒
       / 帮助与关于），演示与开发项收进折叠的「高级」。 */
    const it = (id, icon, title, sub, subId, label, labelId) =>
      '<button type="button" class="list-item me-action" id="' + id + '"><span class="ico">' + icon + '</span>' +
      '<span class="grow"><span>' + title + '</span>' +
      (sub ? '<span class="small muted"' + (subId ? ' id="' + subId + '"' : '') + '>' + sub + '</span>' : '') +
      '</span><span class="muted me-action-tail"' + (labelId ? ' id="' + labelId + '"' : ' aria-hidden="true"') + '>' + (label || '›') + '</span></button>'
    const grp = (title, items) => '<div class="me-group"><div class="grp-title">' + title + '</div>' +
      '<div class="card" style="padding:0">' + items.join('') + '</div></div>'
    /* 可折叠分组（C4）：「我的」页 7 组平铺要滑 2~3 屏，找备份/锁屏要滑很久。
       记账设置、账户与预算、数据与安全这三组是高频，保持展开；
       报表与凭证、外观与提醒、帮助与关于默认收起。
       注意用 <details> 而不是把内容从 DOM 里摘掉 —— 按钮与 id 必须继续存在，
       既有测试和「跳到某个设置」的深链都依赖它们。 */
    const grpFold = (title, items, open) => '<details class="me-group me-fold" data-me-fold="' + esc(title) + '"' + ((meFolds.has(title) ? meFolds.get(title) : open) ? ' open' : '') + '>' +
      '<summary class="grp-title">' + title + '</summary>' +
      '<div class="card" style="padding:0">' + items.join('') + '</div></details>'

    $('#content').innerHTML =
      backupStatusCard() +
      '<div class="card me-stats">' +
      '<div class="kv"><span>累计记录</span><b class="num">' + (txnCount.total || 0) + ' 笔</b></div>' +
      '<div class="kv"><span>凭证图片</span><b class="num">' + usage.count + ' 张' + (usage.bytes ? ' · ' + F.bytes(usage.bytes) : '') + '</b></div>' +
      '<div class="kv"><span>' + (isGuest ? '数据位置' : '云端存储') + '</span><b>' + (isGuest ? '本机浏览器（未同步）' : '已开通 · 请确认同步状态') + '</b></div>' +
      '</div>' +
      '<div class="card" style="padding:0"><button type="button" class="list-item me-action" id="budgetRow" aria-expanded="false" aria-controls="budgetEdit">' +
      '<span class="ico">' + ic('target') + '</span>' +
      '<span class="grow"><span>本月总预算</span><span class="small muted" id="budgetVal">' + (budget != null ? '¥' + budget : '未设置') + '</span></span>' +
      '<span class="muted" aria-hidden="true">›</span></button>' +
      '<div id="budgetEdit" class="hidden" style="padding:12px 14px">' +
      '<div class="row"><input id="budgetInput" class="input grow" type="number" aria-label="本月总预算（元）" step="1" inputmode="decimal" placeholder="设置本月预算（元）" value="' + (budget != null ? budget : '') + '">' +
      '<button class="btn" id="budgetSave" style="flex:none">保存</button></div>' +
      '<div class="small muted" style="margin-top:6px">留空并保存可清除预算</div></div></div>' +
      grp('记账设置', [
        it('smartRulesBtn', '' + ic('wand') + '', '记账规则', '备注命中关键词自动归类 · 打标签'),
        it('aiBtn', '' + ic('sparkles') + '', 'AI 智能记账', '说一句话 / 拍张小票，自动填好单子'),
        it('tplBtn', '' + ic('star') + '', '记账模板', '常用的一笔快速套用'),
        it('recManage', '' + ic('repeat') + '', '周期记账', '房租 / 话费等到期自动补记'),
        it('undoAutoBtn', '' + ic('undo') + '', '撤销自动补记', autoN ? '现有 <b class="num">' + autoN + '</b> 笔周期补记 · 可一键清掉' : '暂无周期补记的账目'),
        it('catManage', '' + ic('tag') + '', '分类管理', '增删改 · 图标与颜色'),
        it('tagBtn', '' + ic('tag') + '', '标签管理', '重命名 · 合并 · 删除 · 标签报表'),
        it('trashBtn', '' + ic('trash') + '', '回收站', '误删可恢复'),
      ]) +
      grp('账户与预算', [
        it('accManage', '' + ic('briefcase') + '', '账户管理', '余额 · 信用卡 · 负债'),
        it('catBudgetBtn', ic('target'), '分类预算', '给每个分类定一个额度'),
        it('subBtn', '' + ic('pin') + '', '固定支出 · 订阅追踪', '识别每月重复扣款'),
        it('debtBtn2', '' + ic('users') + '', '借入借出', '我欠别人 / 别人欠我，还款不计收支'),
        it('cardBtn2', ic('credit-card'), '信用卡管家', '额度 · 账单日 · 还款提醒'),
        it('bookManage', '' + ic('book') + '', '账本管理', '多账本切换'),
        it('fxSettingsBtn', '' + ic('exchange') + '', '汇率与基准币种', '多币种账户折算 · 当前基准 <b id="fxBaseLabel">¥ CNY</b>', 'fxSub'),
      ]) +
      grpFold('报表与凭证', [
        it('reportCenterBtn', '' + ic('chart-bar') + '', '报表中心', '财务健康度 · 年同比 · 分类趋势 · 海报'),
        it('reportBtn', '' + ic('printer') + '', '生成月度报表', '海报 / PDF'),
        it('galleryBtn', '' + ic('image') + '', '凭证相册', '所有小票的图片墙'),
        it('filesBtn', '' + ic('folder') + '', '文件柜', '保单 / 合同 / 保修卡，不挂账也能存'),
      ]) +
      grp('数据与安全', [
        it('syncHubBtn', isGuest ? '' + ic('smartphone') + '' : '' + ic('cloud') + '', '账号与同步', isGuest ? '数据只在本机 · 登录可跨设备同步' : '数据已绑账号 · 换设备前请确认同步完成'),
        it('syncBtn', '' + ic('refresh') + '', '数据与同步', '连接状态 · 待上传 · 冲突检查', 'syncSub'),
        it('backupBtn', '' + ic('database') + '', 'JSON 备份 / 恢复', '查看备份范围并导出'),
        it('vaultBtn', '' + ic('lock') + '', '加密备份到云端', '口令加密后上传，服务端只存密文'),
        it('localEncBtn', '' + ic('database') + '', '导出加密文件到本机', '不经过服务器，最保险的一招'),
        it('exportBtn', '' + ic('upload') + '', '导出 CSV', '含全部明细，可用 Excel 打开'),
        it('importCsvBtn', '' + ic('download') + '', '导入 CSV', '支持微信 / 支付宝账单'),
        it('shareBtn', '' + ic('users') + '', '共享账本', '加密发布 / 用共享码加入'),
        it('lockBtn', '' + ic('lock') + '', '应用锁', '打开 App 时输入 4 位 PIN', '', '›', 'lockLabel'),
      ]) +
      grpFold('外观与提醒', [
        it('themeBtn', '' + ic('palette') + '', '外观 · 深色模式', '跟随系统 / 常亮 / 常暗', '', '›', 'themeModeLabel'),
        it('uiBtn', '' + ic('sliders') + '', '界面与配色', '字号大小 · 涨跌配色', '', '›', 'uiModeLabel'),
        it('remindBtn', '' + ic('clock') + '', '每日记账提醒', '到点还没记账就提醒一次'),
        it('installBtn', '' + ic('smartphone') + '', '添加到主屏幕', '像 App 一样打开，离线也能记账', 'installSub'),
      ]) +
      grpFold('帮助与关于', [
        it('helpBtn', '' + ic('book') + '', '新手指引 · 使用帮助', '3 分钟上手，含快捷键与常见问题'),
        it('privacyBtn2', '' + ic('shield') + '', '用户隐私保护指引', '我们收集什么、怎么用、你有哪些权利'),
        it('aboutBtn', '' + ic('info') + '', '关于拾光记账', '版本 · 数据与隐私说明', 'aboutSub'),
      ]) +
      '<details class="me-adv" data-me-fold="advanced"' + (meFolds.get('advanced') ? ' open' : '') + '><summary>高级 · 演示与开发</summary>' +
      '<div class="card" style="padding:0">' +
      it('demoBtn', '' + ic('zap') + '', '查看记账示例', '预览虚构数据，不修改账本') +
      it('seedBtn', '' + ic('sparkles') + '', '重置为推荐分类', '在现有分类之外补充一套') +
      '</div></details>' +
      (isGuest ? '' : '<button class="btn danger block" id="logoutBtn" style="margin-top:12px">退出登录</button>') +
      '<p class="hint">v' + (window.App.version || '—') + ' · ' + (isGuest ? '绑定后数据只属于你本人，服务端按账号隔离' : '数据只属于你本人，服务端按账号隔离') + '</p>'

    $$('[data-me-fold]', content).forEach(el => el.addEventListener('toggle', () => {
      if (el.isConnected) meFolds.set(el.dataset.meFold, el.open)
    }))
    const shb2 = $('#syncHubBtn')
    if (shb2) shb2.addEventListener('click', openSyncHub)
    /* 数据安全状态卡：登录 / 导出加密备份（卡片内容由懒加载模块填充） */
    fillBackupCard().then(() => {
      if (!current()) return
      const bkLocal = $('#bkLocal')
      if (bkLocal) bkLocal.addEventListener('click', () => {
        Lazy.need('vault').then(m => m && m.openLocalSheet && m.openLocalSheet())
      })
      const bkLogin = $('#bkLogin')
      if (bkLogin) bkLogin.addEventListener('click', () => window.App.backToAuth())
    })
    const budgetRowEl = $('#budgetRow')
    if (budgetRowEl) budgetRowEl.addEventListener('click', () => {
      const ed = $('#budgetEdit')
      if (!ed) return
      const expanded = ed.classList.toggle('hidden') === false
      budgetRowEl.setAttribute('aria-expanded', String(expanded))
      if (expanded) $('#budgetInput').focus({ preventScroll: true })
    })
    $('#budgetSave').addEventListener('click', async () => {
      const v = $('#budgetInput').value.trim()
      try {
        await S.setBudget(monthKey, null, v === '' ? 0 : Number(v))
        const bv = $('#budgetVal'); if (bv) bv.textContent = v === '' ? '未设置' : '¥' + v
        const ed = $('#budgetEdit'); if (ed) ed.classList.add('hidden')
        if (budgetRowEl && budgetRowEl.isConnected) budgetRowEl.setAttribute('aria-expanded', 'false')
        toast('预算已保存')
      } catch (e) { toast('保存失败') }
    })
    $('#recManage').addEventListener('click', openRecurringManager)
    const uab = $('#undoAutoBtn')
    if (uab) uab.addEventListener('click', undoAutoTxns)
    $('#catManage').addEventListener('click', openCategoryManager)
    $('#accManage').addEventListener('click', openAccountManager)
    const shb = $('#shareBtn')
    if (shb) shb.addEventListener('click', () => { Lazy.need('share').then(m => m && m.openShareCenter()) })
    const vtb = $('#vaultBtn')
    if (vtb) vtb.addEventListener('click', () => { Lazy.need('vault').then(m => m && m.openCenter()) })
    const leb = $('#localEncBtn')
    if (leb) leb.addEventListener('click', () => { Lazy.need('vault').then(m => m && m.openLocalSheet()) })
    const syb = $('#syncBtn')
    if (syb) {
      syb.addEventListener('click', () => { if (window.Sync) window.Sync.openCenter() })
      const sub = $('#syncSub')
      if (sub && window.Sync) {
        const n = window.Sync.outboxCount()
        sub.innerHTML = (S.mode === 'cloud' ? '云端同步中' : '本机存储（游客）') +
          (n ? ' · <b style="color:var(--warn,#d98600)">待上传 ' + n + ' 条</b>' : ' · 无待上传') +
          ' · 冲突检查'
      }
    }
    const fxsb = $('#fxSettingsBtn')
    if (fxsb) {
      fxsb.addEventListener('click', openFxSettings)
      const lbl = $('#fxBaseLabel')
      if (lbl && window.Fmt) lbl.textContent = window.Fmt.currencySym(window.Fmt.baseCurrency()) + ' ' + window.Fmt.baseCurrency()
    }
    $('#exportBtn').addEventListener('click', () => Lazy.csv().then(m => m && m.exportCsv()))
    $('#bookManage').addEventListener('click', openBookSheet)
    $('#catBudgetBtn').addEventListener('click', openCategoryBudget)
    $('#subBtn').addEventListener('click', openSubscriptionSheet)
    $('#remindBtn').addEventListener('click', openReminderSettings)
    $('#themeBtn').addEventListener('click', openThemeSettings)
    const tml = $('#themeModeLabel')
    if (tml) {
      const m = window.App.themeMode()
      tml.innerHTML = m === 'dark' ? '' + ic('moon') + ' 深色' : m === 'light' ? '' + ic('sun') + ' 浅色' : '' + ic('sun') + ' 跟随系统'
    }
    $('#importCsvBtn').addEventListener('click', () => Lazy.csv().then(m => m && m.importCsv()))
    $('#tplBtn').addEventListener('click', openTemplateManager)
    $('#trashBtn').addEventListener('click', openTrash)
    $('#reportBtn').addEventListener('click', openMonthReport)
    $('#backupBtn').addEventListener('click', openBackupSheet)
    const sr = $('#smartRulesBtn')
    if (sr) sr.addEventListener('click', () => Lazy.need('smart').then(m => m && m.openRuleManager()))
    const ai = $('#aiBtn')
    if (ai) ai.addEventListener('click', () => Lazy.need('smart').then(m => m && m.openAiSheet()))
    const dbt2 = $('#debtBtn2')
    if (dbt2) dbt2.addEventListener('click', () => { Lazy.need('wealth').then(m => m && m.openDebtSheet()) })
    const cc2 = $('#cardBtn2')
    if (cc2) cc2.addEventListener('click', () => { Lazy.need('wealth').then(m => m && m.openCardSheet()) })
    const rc = $('#reportCenterBtn')
    if (rc) rc.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openReportCenter()) })
    const gl = $('#galleryBtn')
    if (gl) gl.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openGallerySheet()) })
    const fbtn = $('#filesBtn')
    if (fbtn) fbtn.addEventListener('click', () => { Lazy.need('files').then(m => m && m.openFiles()) })
    const tg = $('#tagBtn')
    if (tg) tg.addEventListener('click', () => { Lazy.need('insight').then(m => m && m.openTagManager()) })
    const ub = $('#uiBtn')
    if (ub) ub.addEventListener('click', openUiSettings)
    const lb = $('#lockBtn')
    if (lb) lb.addEventListener('click', openLockSettings)
    const hb = $('#helpBtn')
    if (hb) hb.addEventListener('click', openHelp)
    const ib = $('#installBtn')
    if (ib) {
      /* 小程序 web-view 里没有「添加到主屏幕」这回事。P1-5 重排我的页时
         把原来的 .no-mp 隐藏丢了，这里按 body.mp 判断补回来（App 启动时会加这个类）。 */
      if (document.body.classList.contains('mp')) ib.classList.add('hidden')
      ib.addEventListener('click', openInstallGuide)
    }
    const db2 = $('#demoBtn')
    if (db2) db2.addEventListener('click', () => openDemoData())
    const pv2 = $('#privacyBtn2')
    if (pv2) pv2.addEventListener('click', openPrivacy)
    const ab = $('#aboutBtn')
    if (ab) ab.addEventListener('click', openAbout)
    const iSub = $('#installSub')
    if (iSub && window.App.isStandalone && window.App.isStandalone()) iSub.innerHTML = '已在独立窗口中运行 ' + ic('check') + ''
    const aSub = $('#aboutSub')
    if (aSub) aSub.textContent = '版本 ' + (window.App.version || '—') + ' · 数据与隐私说明'
    const lkl = $('#lockLabel')
    if (lkl) lkl.textContent = window.App.lockConfig().on ? '已开启' : '未开启'
    const uil = $('#uiModeLabel')
    if (uil) {
      const u = window.App.uiSettings()
      const parts = []
      if (u.scale === 'compact') parts.push('小字')
      else if (u.scale === 'large') parts.push('大字')
      if (u.palette === 'colorblind') parts.push('色盲友好')
      uil.textContent = parts.length ? parts.join(' · ') : '›'
    }
    $('#seedBtn').addEventListener('click', async () => {
      if (!(await confirmSheet({ title: '补充推荐分类', body: '会在现有分类之外补充一套推荐分类，确定继续？' }))) return
      try { await S.seedPresets(); toast('已补充推荐分类'); window.App.renderTab() } catch (e) { toast('操作失败') }
    })
    if (!isGuest) {
      $('#logoutBtn').addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '退出登录', body: '退出后需要重新验证手机号才能查看账目，确定退出？', danger: true, okText: '退出' }))) return
        await window.Cloud.signOut()
        location.reload()
      })
    }
  }

  /* ---------- 月度报表（海报 / PDF） ---------- */
  /* 月度报表整块搬进懒加载的 insight.js（94 行，只在点「报表中心」时用）：
     首屏 gzip 硬线 158720B，v4 新增的「今天还能花」要占地方，这里让出来。 */
  function openMonthReport() { return Lazy.need('insight').then(m => m && m.openMonthReport()) }

  /* ---------- 管理类面板转发层 ----------
     分类/账户管理、回收站、周期规则、汇率、界面配色合计约 12KB 源码，
     只在「我的」里点进去才用，已整体搬进懒加载模块 js/manage.js。 */
  const needManage = () => Lazy.need('manage')
  function openCategoryManager() { return needManage().then(m => m && m.openCategoryManager()) }
  function openAccountManager() { return needManage().then(m => m && m.openAccountManager()) }
  function openTrash() { return needManage().then(m => m && m.openTrash()) }
  function openRecurringManager() { return needManage().then(m => m && m.openRecurringManager()) }
  function openFxSettings() { return needManage().then(m => m && m.openFxSettings()) }
  function openUiSettings() { return needManage().then(m => m && m.openUiSettings()) }
  /* 周期记账规则管理 */

  /* 一键撤销周期补记：只删带 auto 标记的，手工记的不动。软删除，回收站可恢复。 */
  async function undoAutoTxns() {
    let rows = []
    try {
      const r = await S.listTransactions({ tag: 'auto', limit: 2000 })
      rows = r.rows || []
    } catch (e) { toast('读取失败，请重试'); return }
    const n = rows.length
    if (!n) { toast('没有需要撤销的自动补记账目'); return }
    const sample = rows.slice(0, 3).map(t => '· ' + F.isoDay(t.occurred_at) + ' ' + (t.note || '周期账目') + ' ¥' + F.yuan(F.toCents(t.amount)))
    if (!(await confirmSheet({ title: '撤销自动补记', danger: true, okText: '删除',
      body: '将删除 ' + n + ' 笔由周期规则自动补记的账目（手工记的不受影响）：\n\n' + sample.join('\n') +
        (n > 3 ? '\n· 另有 ' + (n - 3) + ' 笔…' : '') + '\n\n删除后可在「回收站」恢复，确定继续？' }))) return
    let ok = 0
    for (const t of rows) {
      try { await S.deleteTransaction(t.id); ok++ } catch (e) { /* 单条失败继续 */ }
    }
    toast(ok === n ? '已撤销 ' + ok + ' 笔自动补记' : '已撤销 ' + ok + '/' + n + ' 笔')
    window.App.refresh()
  }



  /* ---------- 多账本（随手记式） ---------- */
  function openBookSheet() { return Lazy.need('manage').then(m => m && m.openBookSheet()) }

  /* ---------- 分类预算：信封模型（待分配 + 结转 + 挪钱） ----------
     实现在懒加载的 wealth.js（预算中心本来就在那儿）。这段 UI 有 170 行，
     留在首屏会把 gzip 硬线顶穿，这里只留转发层，接口名不变。 */
  function openCategoryBudget() {
    return Lazy.need('wealth').then(m => m && m.openCategoryBudget())
  }

  /* ---------- 固定支出 / 订阅追踪（一木式） ---------- */
  /* 固定支出 · 订阅面板已搬到懒加载模块 js/manage.js（首屏 gzip 硬线 158720B，
     低频面板不占首屏；SW 已预缓存，断网也能打开） */
  function openSubscriptionSheet() { return Lazy.need('manage').then(m => m && m.openSubscriptionSheet()) }

  /* ---------- 每日记账提醒 ---------- */
  function openReminderSettings() {
    let cfg = { on: false, time: '21:30' }
    try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem('ledger10_reminder') || '{}')) } catch (e) { /* 忽略 */ }
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">每日记账提醒</span><button id="rmClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:12px">到点后如果今天还没记账，打开应用时会看到醒目提醒。</div>' +
      '<div class="field"><label>开关</label><div class="chips" id="rmOnChips">' +
      '<button class="chip' + (cfg.on ? ' on' : '') + '" data-rmon="1">开启</button>' +
      '<button class="chip' + (!cfg.on ? ' on' : '') + '" data-rmon="0">关闭</button></div></div>' +
      '<div class="field"><label>提醒时间</label><input id="rmTime" class="input" type="time" value="' + esc(cfg.time) + '"></div>' +
      '<button class="btn block" id="rmSave">保存</button>'
    )
    let on = cfg.on
    $$('#rmOnChips .chip').forEach(b => {
      b.addEventListener('click', () => {
        $$('#rmOnChips .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        on = b.getAttribute('data-rmon') === '1'
      })
    })
    $('#rmClose').addEventListener('click', closeSheet)
    $('#rmSave').addEventListener('click', () => {
      try {
        localStorage.setItem('ledger10_reminder', JSON.stringify({ on, time: $('#rmTime').value || '21:30' }))
        localStorage.removeItem('ledger10_remind_dismiss')
      } catch (e) { /* 忽略 */ }
      closeSheet()
      toast('提醒设置已保存')
      window.App.refresh()
    })
  }

  /* ---------- 本机覆盖层备份（A3） ----------
     报销进度、对账标记、目标↔账户联动、预算结转、智能规则、自定义汇率这些
     "第二层数据"只存在 localStorage，既不进 IndexedDB 也不进云表 ——
     换手机时用户精心维护的报销进度会悄悄归零。这里按【前缀白名单】
     把它们一起写进备份文件，恢复时再写回去。
     必须是白名单：PIN 哈希（ledger10_lock）、分享密钥（ledger10_shares）、
     同步队列（ledger10_sync2:*）绝对不能进备份文件。 */
  const OVERLAY_PREFIX = [
    'ledger10_reimb', 'ledger10_reimb_v2', 'ledger10_reconcile_marks_v1', 'ledger10_recon_log',
    'ledger10_goallink', 'ledger10_goalauto', 'ledger10_rollover', 'ledger10_rules',
    'ledger10_fx', 'ledger10_base', 'ledger10_saved_filters_v1', 'ledger10_lastpick',
    'ledger10_import_accounts_v1', 'ledger10_debt_rate', 'ledger10_debt_meta', 'ledger10_card_meta',
  ]
  const OVERLAY_MAX = 200000
  const OVERLAY_META = '__ledger10_overlay'
  const OVERLAY_NAMES = {
    ledger10_reimb: '旧版报销进度', ledger10_reimb_v2: '报销进度', ledger10_reconcile_marks_v1: '对账标记',
    ledger10_recon_log: '余额校准记录', ledger10_goallink: '目标账户联动', ledger10_goalauto: '目标自动存入',
    ledger10_rollover: '预算结转', ledger10_rules: '智能分类规则', ledger10_fx: '汇率', ledger10_base: '基准币种',
    ledger10_saved_filters_v1: '常用筛选', ledger10_lastpick: '上次账户分类', ledger10_import_accounts_v1: '导入账户映射',
    ledger10_debt_rate: '债务利率', ledger10_debt_meta: '借款附加信息', ledger10_card_meta: '信用卡设置',
  }
  function overlayIdentity() {
    const state = S.state || {}
    const owner = S.mode === 'cloud' ? state.uid : S.mode === 'guest' ? state.sourceId : ''
    return owner ? { mode: S.mode, owner: String(owner) } : null
  }
  function overlayOwner(v) {
    return v && ['guest', 'cloud'].includes(v.mode) && typeof v.owner === 'string' && v.owner ? v : null
  }
  function overlayScope(text) {
    try { const v = JSON.parse(text); return Array.isArray(v) && v.length >= 2 ? overlayOwner({ mode: v[0], owner: v[1] }) : null } catch (e) { return null }
  }
  function sameOverlayOwner(a, b) { return !!a && !!b && a.mode === b.mode && a.owner === b.owner }
  function overlayObject(v) { return v && typeof v === 'object' && !Array.isArray(v) }
  function overlayCount(v) { return v && typeof v === 'object' ? Object.keys(v).length : 1 }
  function overlayIssue(report, key, count) {
    if (!count) return
    const name = OVERLAY_NAMES[key] || '未知本机设置'
    report.skipped = (report.skipped || 0) + count
    report.items = report.items || []
    const old = report.items.find(x => x.name === name)
    if (old) old.count += count
    else report.items.push({ name, count })
  }
  function overlayMessage(report) {
    if (!report || !report.skipped) return ''
    return '；未覆盖 ' + report.skipped + ' 项：' + report.items.map(x => x.name + ' ' + x.count).join('、') + '。归属或关联无法确认，请保留原设备和旧备份'
  }
  function isOverlayKey(k) {
    return OVERLAY_PREFIX.includes(k) || ['ledger10_reimb_v2', 'ledger10_saved_filters_v1'].some(p => k.indexOf(p + ':') === 0)
  }
  function collectOverlays() {
    const out = {}, source = overlayIdentity(), report = { skipped: 0, items: [] }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || !isOverlayKey(k)) continue
        const raw = localStorage.getItem(k)
        if (typeof raw !== 'string' || raw.length > OVERLAY_MAX) { overlayIssue(report, k, 1); continue }
        if (k === 'ledger10_fx' || k === 'ledger10_base') { out[k] = raw; continue }
        const scoped = ['ledger10_reimb_v2', 'ledger10_saved_filters_v1'].find(p => k.indexOf(p + ':') === 0)
        if (scoped) {
          let owner
          try { owner = overlayScope(decodeURIComponent(k.slice(scoped.length + 1))) } catch (e) { /* 非法命名空间不认领 */ }
          if (sameOverlayOwner(owner, source)) out[k] = raw
          continue
        }
        let v
        try { v = JSON.parse(raw) } catch (e) { overlayIssue(report, k, 1); continue }
        if (k === 'ledger10_reconcile_marks_v1' || k === 'ledger10_import_accounts_v1') {
          const selected = Object.create(null)
          if (source && overlayObject(v)) Object.keys(v).forEach(scope => {
            if (sameOverlayOwner(overlayScope(scope), source)) selected[scope] = v[scope]
          })
          if (Object.keys(selected).length) out[k] = JSON.stringify(selected)
          continue
        }
        /* 旧全局键没有owner，数字ID碰号不能证明归属。只报告数量，不导出可能属于别人的内容。 */
        overlayIssue(report, k, overlayCount(v))
      }
    } catch (e) { overlayIssue(report, '本机存储', 1) }
    out[OVERLAY_META] = { version: 2, source, omitted: report.items }
    return out
  }
  function applyOverlays(obj, context) {
    if (!overlayObject(obj)) return 0
    const ctx = context || {}, report = ctx.report || {}, target = overlayOwner(ctx.target) || overlayIdentity()
    report.skipped = 0; report.items = []; report.applied = 0
    const meta = overlayObject(obj[OVERLAY_META]) && obj[OVERLAY_META].version === 2 ? obj[OVERLAY_META] : {}
    const source = overlayOwner(ctx.source) || overlayOwner(meta.source)
    const data = ctx.data || {}, maps = ctx.maps
    const sameIds = !maps && source && target && (sameOverlayOwner(source, target) ||
      (ctx.replace && target.mode === 'guest' && data.sourceId === target.owner))
    const mapId = (kind, id) => {
      if (id == null || id === '') return id
      const table = { txnMap: 'transactions', accMap: 'accounts', catMap: 'categories', goalMap: 'goals', bookMap: 'books' }[kind]
      if (Array.isArray(data[table]) && !data[table].some(x => String(x.id) === String(id))) return undefined
      if (maps) return maps[kind] && Object.prototype.hasOwnProperty.call(maps[kind], String(id)) ? maps[kind][id] : undefined
      if (!sameIds) return undefined
      return /^\d+$/.test(String(id)) ? Number(id) : id
    }
    const parse = raw => { try { return JSON.parse(raw) } catch (e) { return undefined } }
    const merge = (incoming, existing) => {
      if (overlayObject(incoming) && overlayObject(existing)) {
        const out = Object.assign(Object.create(null), incoming)
        Object.keys(existing).forEach(k => { out[k] = Object.prototype.hasOwnProperty.call(out, k) ? merge(out[k], existing[k]) : existing[k] })
        return out
      }
      if (Array.isArray(incoming) && Array.isArray(existing)) {
        const out = existing.slice()
        incoming.forEach(x => {
          if (!out.some(y => x && y && (x.id != null ? x.id === y.id : x.name != null ? x.name === y.name : JSON.stringify(x) === JSON.stringify(y)))) out.push(x)
        })
        return out
      }
      return existing === undefined ? incoming : existing
    }
    const signature = t => JSON.stringify([t.txn_type, t.amount, t.occurred_at, t.account_id, t.to_account_id, t.category_id, t.note, t.updated_at])
    const sameImportedRow = (row, targetRow) => {
      if (!row || !targetRow || row.txn_type !== targetRow.txn_type || Number(row.amount) !== Number(targetRow.amount) ||
        new Date(row.occurred_at).getTime() !== new Date(targetRow.occurred_at).getTime() || String(row.note || '') !== String(targetRow.note || '')) return false
      return [['account_id', 'accMap'], ['to_account_id', 'accMap'], ['category_id', 'catMap']].every(([field, kind]) => {
        const id = mapId(kind, row[field])
        return (row[field] == null || id != null) && String(id == null ? '' : id) === String(targetRow[field] == null ? '' : targetRow[field])
      })
    }
    Object.keys(obj).forEach(k => {
      if (!isOverlayKey(k)) return
      const prefix = OVERLAY_PREFIX.find(p => k === p || k.indexOf(p + ':') === 0)
      const raw = obj[k], issue = n => overlayIssue(report, prefix, n)
      if (typeof raw !== 'string' || raw.length > OVERLAY_MAX) { issue(1); return }
      let v = parse(raw), dest = k, out
      if (prefix === 'ledger10_fx' || prefix === 'ledger10_base') {
        if (v === undefined) v = raw
        out = v
      } else {
        if (!source || !target || v === undefined) { issue(overlayCount(v)); return }
        const scoped = prefix === 'ledger10_reimb_v2' || prefix === 'ledger10_saved_filters_v1'
        if (scoped) {
          let owner
          try { owner = overlayScope(decodeURIComponent(k.slice(prefix.length + 1))) } catch (e) { /* 跳过 */ }
          if (!sameOverlayOwner(owner, source)) { issue(overlayCount(v)); return }
          dest = prefix + ':' + encodeURIComponent(JSON.stringify([target.mode, target.owner]))
        }
        const byId = (value, kind, convert) => {
          const result = Object.create(null)
          if (!overlayObject(value)) { issue(1); return result }
          Object.keys(value).forEach(id => {
            const to = mapId(kind, id), item = convert ? convert(value[id]) : value[id]
            if (to == null || item === undefined) issue(1)
            else result[to] = item
          })
          return result
        }
        const fields = (value, spec) => {
          if (!overlayObject(value)) return undefined
          const item = Object.assign({}, value)
          for (const field of Object.keys(spec)) if (item[field] != null && item[field] !== '') {
            const to = mapId(spec[field], item[field])
            if (to == null) return undefined
            item[field] = to
          }
          return item
        }
        switch (prefix) {
          case 'ledger10_reimb': issue(overlayCount(v)); return /* 旧无owner数据永不认领 */
          case 'ledger10_reimb_v2': out = byId(v, 'txnMap', x => overlayObject(x) ? x : undefined); break
          case 'ledger10_goallink': out = byId(v, 'goalMap', x => x && x.accountId != null ? fields(x, { accountId: 'accMap' }) : undefined); break
          case 'ledger10_goalauto': out = byId(v, 'goalMap', x => overlayObject(x) ? x : undefined); break
          case 'ledger10_debt_meta': case 'ledger10_debt_rate': case 'ledger10_card_meta': out = byId(v, 'accMap', x => overlayObject(x) ? x : undefined); break
          case 'ledger10_rollover': out = byId(v, 'catMap'); break
          case 'ledger10_lastpick':
            out = Object.create(null)
            for (const [part, kind] of [['acc', 'accMap'], ['cat', 'catMap']]) {
              const result = Object.create(null)
              if (v && overlayObject(v[part])) Object.keys(v[part]).forEach(type => {
                const id = mapId(kind, v[part][type]); if (id != null) result[type] = id; else issue(1)
              })
              if (Object.keys(result).length) out[part] = result
            }
            break
          case 'ledger10_recon_log':
            out = Array.isArray(v) ? v.map(x => { const row = fields(x, { accountId: 'accMap' }); if (!row) issue(1); return row }).filter(Boolean) : []
            break
          case 'ledger10_rules':
            out = Array.isArray(v) ? v.map(x => { const row = fields(x, { setAccountId: 'accMap', setCategoryId: 'catMap' }); if (!row) issue(1); return row }).filter(Boolean) : []
            break
          case 'ledger10_saved_filters_v1':
            out = Array.isArray(v) ? v.map(x => {
              const f = x && fields(x.filters, { accountId: 'accMap', categoryId: 'catMap' })
              if (!f || typeof x.name !== 'string') { issue(1); return null }
              return Object.assign({}, x, { filters: f })
            }).filter(Boolean) : []
            break
          case 'ledger10_import_accounts_v1': {
            out = Object.create(null)
            if (!overlayObject(v)) { issue(1); return }
            Object.keys(v).forEach(scope => {
              if (!sameOverlayOwner(overlayScope(scope), source)) { issue(overlayCount(v[scope])); return }
              const entries = Object.create(null)
              if (overlayObject(v[scope])) Object.keys(v[scope]).forEach(name => {
                const id = mapId('accMap', v[scope][name]); if (id != null) entries[name] = id; else issue(1)
              })
              if (Object.keys(entries).length) out[JSON.stringify([target.mode, target.owner])] = entries
            })
            break
          }
          case 'ledger10_reconcile_marks_v1': {
            out = Object.create(null)
            if (!overlayObject(v)) { issue(1); return }
            Object.keys(v).forEach(scope => {
              if (!sameOverlayOwner(overlayScope(scope), source)) { issue(overlayCount(v[scope])); return }
              let parts
              try { parts = JSON.parse(scope) } catch (e) { return }
              const account = mapId('accMap', parts[2]), entries = Object.create(null)
              if (account == null || parts.length !== 3 || !overlayObject(v[scope])) { issue(overlayCount(v[scope])); return }
              Object.keys(v[scope]).forEach(id => {
                const to = mapId('txnMap', id), row = (data.transactions || []).find(t => String(t.id) === id)
                const targetRow = maps ? maps.txnRows && maps.txnRows[id] : row
                if (to == null || !row || !targetRow || signature(row) !== v[scope][id] || String(targetRow.id) !== String(to) || !sameImportedRow(row, targetRow)) { issue(1); return }
                entries[to] = signature(targetRow)
              })
              if (Object.keys(entries).length) out[JSON.stringify([target.mode, target.owner, String(account)])] = entries
            })
            break
          }
          default: issue(overlayCount(v)); return
        }
      }
      if (out && typeof out === 'object' && !Object.keys(out).length) return
      try {
        const previous = localStorage.getItem(dest)
        const existing = previous == null ? undefined : parse(previous)
        if (previous != null && existing === undefined && prefix !== 'ledger10_base') { issue(overlayCount(out)); return }
        const result = ctx.replace && sameIds && prefix !== 'ledger10_reconcile_marks_v1' && prefix !== 'ledger10_import_accounts_v1' ? out : merge(out, existing)
        const text = prefix === 'ledger10_base' && typeof result === 'string' ? result : JSON.stringify(result)
        if (text.length > OVERLAY_MAX) { issue(overlayCount(out)); return }
        localStorage.setItem(dest, text); report.applied++
      } catch (e) { issue(overlayCount(out)) }
    })
    if (Array.isArray(meta.omitted)) meta.omitted.forEach(x => {
      if (!x || typeof x.name !== 'string' || !Number.isFinite(x.count) || x.count <= 0) return
      report.skipped += x.count; report.items.push({ name: x.name, count: x.count })
    })
    report.message = overlayMessage(report)
    return report.applied
  }

  /* ---------- JSON 备份 / 恢复 ---------- */
  function backupImportWarning(result) {
    const failed = ['txnFail', 'imgFail', 'ruleFail', 'tplFail'].flatMap(key => result && result[key] || [])
    if (!failed.length) return ''
    const reasons = Array.from(new Set(failed.map(x => x.msg || '写入失败'))).slice(0, 3).join('；')
    return '；有 ' + failed.length + ' 项未恢复：' + reasons + '。已保留当前数据，请核对冲突或网络后重试'
  }
  function openBackupSheet() {
    const isGuest = window.DB.mode === 'guest'
    const backupOwner = overlayIdentity()
    const backupActive = () => sameOverlayOwner(backupOwner, overlayIdentity())
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">JSON 备份 / 恢复</span><button id="bakClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:12px">' +
      (isGuest ? '备份包含账目、图片、账本、预算、目标，以及当前身份的报销进度、对账标记等本机设置。'
               : '备份包含账目、账户、分类、账本、预算、周期规则、目标，以及报销进度、对账标记等本机设置。') +
      '旧版目标联动、预算结转、分类规则等无身份信息的本机设置不会自动认领，导出后会列出未覆盖项目；请保留原设备和旧副本。' +
      (isGuest ? '图片会保存在备份文件中，模板和回收站账目一并备份。' : '<b>不含凭证图片文件</b>、模板和回收站账目；云端凭证原图请另外保存。') +
      '</div>' +
      '<button class="btn block" id="bakExport">导出账目备份</button>' +
      '<div class="divider">恢复</div>' +
      '<input type="file" id="bakFile" accept=".json,application/json" class="hidden">' +
      '<button class="btn line block" id="bakImport">选择备份文件并恢复</button>' +
      '<div class="err" id="bakErr" role="alert"></div>' +
      '<div class="hint">' + (isGuest ? '恢复会覆盖本机现有游客数据' : '恢复会把备份内容合并进云端账号') + '，建议先导出一份当前数据</div>'
    )
    const backupError = $('#bakErr')
    const setBackupMessage = message => {
      if (backupError.isConnected && $('#sheet').getAttribute('aria-hidden') !== 'true') backupError.textContent = message
      else toast(message)
    }
    let backupBusy = false
    const setBackupBusy = busy => {
      backupBusy = busy
      ;['#bakExport', '#bakImport'].forEach(selector => { const b = $(selector); if (b) b.disabled = busy })
    }
    $('#bakClose').addEventListener('click', closeSheet)
    $('#bakExport').addEventListener('click', async () => {
      if (backupBusy) return
      setBackupBusy(true)
      setBackupMessage('正在准备备份…')
      try {
        let payload
        if (isGuest) {
          payload = await window.GuestStore.backup()
          if (!backupActive()) throw new Error('账号或本机账本已切换，请重新打开备份')
          payload.overlays = collectOverlays()
        } else {
          const txns = await S.listTransactions({ limit: 100000, ignoreBook: true })
          if (!txns || !Array.isArray(txns.rows) || (Number.isFinite(txns.total) && txns.total > txns.rows.length)) {
            throw new Error('账目读取不完整或数量过多，未生成备份')
          }
          const dump = {
            sourceId: 'cloud:' + backupOwner.owner,
            accounts: S.allAccounts(),
            categories: S.state.categories,
            transactions: txns.rows,
            attachments: [],
            budgets: S.state.budgets,
            recurring: (await S.listRecurring({ ignoreBook: true })),
            books: S.books(),
            goals: S.state.goals,
          }
          if (!backupActive()) throw new Error('账号或本机账本已切换，请重新打开备份')
          payload = { app: 'ledger10', version: 2, exportedAt: F.iso(new Date()), data: dump, overlays: collectOverlays() }
        }
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = '拾光记账-备份-' + F.dstr(new Date()) + '.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 3000)
        try { localStorage.setItem('ledger10_bk1', F.iso(new Date())) } catch (e) { /* 忽略 */ }
        const omitted = payload.overlays.__ledger10_overlay.omitted
        const warning = overlayMessage({ skipped: omitted.reduce((n, x) => n + x.count, 0), items: omitted })
        setBackupMessage(warning)
        toast('已发起备份下载，请确认文件已保存' + warning)
      } catch (e) { setBackupMessage('导出失败：' + (e.message || '')) }
      finally { setBackupBusy(false) }
    })
    $('#bakImport').addEventListener('click', () => $('#bakFile').click())
    $('#bakFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file || backupBusy) return
      setBackupBusy(true)
      setBackupMessage('正在检查并恢复备份…')
      try {
        const text = await file.text()
        const payload = JSON.parse(text)
        const overlayReport = {}
        let importWarning = ''
        if (!backupActive()) throw new Error('账号或本机账本已切换，请重新打开备份')
        if (isGuest) {
          if (!(await confirmSheet({ title: '恢复备份', danger: true, okText: '覆盖恢复', body: '恢复会覆盖本机现有游客数据，确定继续？' }))) return
          if (!backupActive()) throw new Error('账号或本机账本已切换，请重新打开备份')
          const r = await window.GuestStore.restore(payload, { isActive: backupActive })
          if (S.mode !== 'guest') throw new Error('恢复期间账号已切换，本机设置未恢复，请回游客模式核对')
          /* 覆盖层要在 init 之前写回：init 之后首页可能立刻渲染报销角标 */
          const nOv = applyOverlays(payload && payload.overlays, { replace: true, data: payload.data || payload,
            target: { mode: 'guest', owner: window.GuestStore.state.sourceId }, report: overlayReport })
          await S.useGuest()
          toast('已恢复 ' + r.txns + ' 笔账目' + (nOv ? '，含 ' + nOv + ' 项本机设置' : ''))
        } else {
          if (!(await confirmSheet({ title: '恢复备份', okText: '合并导入', body: '会把备份内容合并进当前云端账号（重复的账户/分类自动跳过），确定继续？' }))) return
          if (!backupActive()) throw new Error('账号或本机账本已切换，请重新打开备份')
          const data = payload && payload.data ? payload.data : payload
          const r = await window.DB.importDumpToCloud(data, m => toast(m))
          importWarning = backupImportWarning(r)
          if (!backupActive()) throw new Error('账号已切换，本机设置未恢复，请回原账号重试')
          const nOv = applyOverlays(payload && payload.overlays, { maps: r, data, report: overlayReport })
          toast('已导入 ' + r.txns + ' 笔账目' + (nOv ? '，含 ' + nOv + ' 项本机设置' : ''))
        }
        if (importWarning || overlayReport.message) setBackupMessage(importWarning + (overlayReport.message || ''))
        else closeSheet()
        window.App.refresh()
      } catch (err) {
        setBackupMessage('恢复失败：' + (err.message || '文件格式不正确'))
      } finally {
        setBackupBusy(false)
        e.target.value = ''
      }
    })
  }

  /* ---------- 报销状态（本机覆盖层） ----------
     账目表只有 reimbursable 一个布尔位，不能加列；三态（待报销 / 部分 / 已收）
     按数据来源存本机覆盖层。台账面板见 js/reimb.js（懒加载）。 */
  function reimbKey() {
    const id = S.mode === 'cloud' ? S.state && S.state.uid : S.mode === 'guest' ? S.state && S.state.sourceId : ''
    return id ? 'ledger10_reimb_v2:' + encodeURIComponent(JSON.stringify([S.mode, String(id)])) : ''
  }
  function reimbMap() {
    try { const key = reimbKey(); return key ? JSON.parse(localStorage.getItem(key) || '{}') || {} : {} } catch (e) { return {} }
  }
  function reimbStatusOf(t) {
    const r = reimbMap()[String(t.id)]
    if (r && r.status) return r.status
    return t.reimbursable ? 'pending' : ''
  }
  function writeReimb(id, status, expectYuan, owner) {
    if (id == null) return
    if (!owner || owner !== reimbKey()) throw new Error('账号或账本已切换，报销状态未保存')
    const m = JSON.parse(localStorage.getItem(owner) || '{}') || {}
    const key = String(id)
    if (!status) {
      delete m[key]
    } else {
      m[key] = Object.assign({}, m[key] || {}, { status: status, at: new Date().toISOString() })
      const cents = F.toCents(Number(String(expectYuan || '').replace(/[^\d.]/g, '')) || 0)
      if (cents > 0) m[key].expect = cents
    }
    localStorage.setItem(owner, JSON.stringify(m))
    reimbCache.at = 0
  }
  /* 待收合计：明细页筛选条上要显示「待报销 ¥N」，这里做 60 秒缓存，
     避免每次重绘都多打一次云查询 */
  let reimbCache = { at: 0, cents: 0, count: 0, owner: '' }
  /* 数据变了要重算「待报销」合计：App.refresh() 里会调它 */
  function invalidateReimb() { reimbCache.at = 0 }
  async function reimbPending() {
    const owner = reimbKey()
    if (!owner) return { at: 0, cents: 0, count: 0, owner: '' }
    if (reimbCache.owner === owner && Date.now() - reimbCache.at < 60000) return reimbCache
    reimbCache = { at: 0, cents: 0, count: 0, owner: owner }
    try {
      const res = await S.listTransactions({ reimbursable: true, limit: 2000, ignoreBook: true })
      if (owner !== reimbKey()) return { at: 0, cents: 0, count: 0, owner: '' }
      const map = reimbMap()
      let cents = 0
      let count = 0
      ;(res.rows || []).forEach(t => {
        const r = map[String(t.id)] || {}
        if (r.status === 'done') return
        count++
        cents += Math.max(0, F.toCents(t.amount) - Number(r.received || 0))
      })
      reimbCache = { at: Date.now(), cents: cents, count: count, owner: owner }
    } catch (e) { if (owner !== reimbKey()) return { at: 0, cents: 0, count: 0, owner: '' }; reimbCache = { at: Date.now(), cents: 0, count: 0, owner: owner } }
    return reimbCache
  }

  /* ---------- 常用分类记忆（只存本机，用于把常用分类排到前面） ---------- */
  const CATUSE_KEY = 'ledger10_catuse'

  function catUse() {
    try { return JSON.parse(localStorage.getItem(CATUSE_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function bumpCatUse(id) {
    if (!id) return
    try {
      const m = catUse()
      m[id] = (Number(m[id]) || 0) + 1
      const keys = Object.keys(m)
      /* 上限保护：只留最常用的 150 个，避免长期使用后无限增长 */
      if (keys.length > 300) {
        keys.sort((a, b) => m[b] - m[a]).slice(150).forEach(k => { delete m[k] })
      }
      localStorage.setItem(CATUSE_KEY, JSON.stringify(m))
    } catch (e) { /* 忽略 */ }
  }
  /* 按使用频次降序；同频次保持原有顺序（稳定排序），没用过的分类不会被打乱 */
  function sortByUse(list) {
    const m = catUse()
    return list.map((c, i) => ({ c: c, i: i }))
      .sort((a, b) => {
        const d = (Number(m[b.c.id]) || 0) - (Number(m[a.c.id]) || 0)
        return d !== 0 ? d : a.i - b.i
      })
      .map(x => x.c)
  }

  /* ---------- 上次用过的账户 / 分类（只存本机，新建时预选；编辑账目时不影响） ----------
     主流记账 App（钱迹 / 鲨鱼 / 随手记）都会记住「上次用的账户与分类」，
     让连续记账时不用反复点。这里按「收支类型」分别记忆，
     账户 + 分类各一份，删掉或归档过的会回退到默认值。 */
  const LASTPICK_KEY = 'ledger10_lastpick'
  function lastPick() {
    try { return JSON.parse(localStorage.getItem(LASTPICK_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function saveLastPick(type, accId, catId) {
    if (!type) return
    try {
      const m = lastPick()
      m.acc = m.acc || {}; m.cat = m.cat || {}
      if (accId) m.acc[type] = Number(accId)
      if (catId) m.cat[type] = Number(catId)
      localStorage.setItem(LASTPICK_KEY, JSON.stringify(m))
    } catch (e) { /* 忽略 */ }
  }
  /* 记忆的账户可能已被删除或归档 → 回退到传入的默认账户 */
  function pickAccount(type, fallbackId) {
    const id = Number((lastPick().acc || {})[type])
    if (!id) return fallbackId
    const hit = S.accounts().filter(a => a.id === id)[0]
    return hit ? hit.id : fallbackId
  }
  /* 记忆的分类必须仍存在、且收支类型对得上，否则视为没有记忆 */
  function pickCategory(type) {
    const id = Number((lastPick().cat || {})[type])
    if (!id) return null
    const hit = S.category(id)
    return (hit && hit.kind === type) ? hit.id : null
  }

  /* 记账后即时校验本月预算：只在「跨过 80% / 100% 阈值」的那一笔提示，不每笔都弹 */
  async function checkBudgetAlert(addedCents) {
    try {
      const now = new Date()
      const b = S.budgetOf(F.monthKey(now), null)
      const total = b != null ? F.toCents(b) : 0
      if (!(total > 0)) return
      const rows = await S.monthlySummary(
        F.iso(F.monthStart(now.getFullYear(), now.getMonth() + 1)),
        F.iso(F.monthEnd(now.getFullYear(), now.getMonth() + 1))
      )
      let spent = 0
      ;(rows || []).forEach(r => { spent += F.toCents(r.expense) })
      const after = spent / total * 100
      const before = (spent - (addedCents || 0)) / total * 100
      if (before < 100 && after >= 100) {
        toast('本月预算已超支 ¥' + F.yuan(spent - total), { icon: ic('alert') })
      } else if (before < 80 && after >= 80) {
        toast('本月预算已用 ' + Math.round(after) + '%，还剩 ¥' + F.yuan(total - spent))
      }
    } catch (e) { /* 预算提醒失败不影响记账本身 */ }
  }

  /* ---------- 记账编辑器 ---------- */
  const draft = {
    type: 'expense',
    amount: '',
    categoryId: null,
    accountId: null,
    toAccountId: null,
    occurred: F.localInput(new Date()),
    note: '',
    tags: '',
    newFiles: [],
    keepAtts: [],
    removeAtts: [],
    freq: '',
    reimbursable: false,
    /* 报销三态（'' / pending / partial / done）与预计报销金额 */
    reimbStatus: '',
    reimbExpect: '',
    /* 机器（AI / 规则 / 纠正记忆）给出的分类建议，用于在保存时学习用户的纠正 */
    suggestedCatId: null,
    /* 当前选中的分类是否只是「上次用过」的记忆值（不是用户主动选的） */
    catFromMemory: false,
    /* 分类的子分类行是否展开（用户主动点父分类才展开） */
    subOpen: false,
  }

  /* 编辑器每次重绘自增，用来作废过期的异步回调（如备注补全） */
  let editorSeq = 0
  /* 「更多选项」展开状态，跨重绘保持 */
  let editorMoreOpen = false
  /* 数字键盘是否展开（默认收起，点金额框才展开），跨重绘保持 */
  let editorKpOpen = false
  /* 下次重绘是否抢焦点（只在真正打开弹窗时置位） */
  let editorFocusPending = false

  async function openEditor(txn, forceType, preset) {
    if (editorSaving) return
    const editing = !!txn
    draft.aiReview = !editing && !!(preset && preset.aiReview === true)
    draft.aiCurrency = draft.aiReview && typeof preset.aiCurrency === 'string' && /^[A-Z]{3}$/.test(preset.aiCurrency) ? preset.aiCurrency : null
    editorMoreOpen = false
    editorKpOpen = false
    editorFocusPending = true
    draft.type = forceType || (txn ? txn.txn_type : 'expense')
    draft.amount = txn ? String(txn.amount) : ''
    draft.categoryId = txn ? txn.category_id : null
    const defAcc = S.accounts()[0] ? S.accounts()[0].id : null
    draft.accountId = txn ? txn.account_id : pickAccount(draft.type, defAcc)
    draft.toAccountId = txn ? txn.to_account_id : (S.accounts()[1] ? S.accounts()[1].id : null)
    /* 新建时预选「上次用过的分类」；编辑已有账目时一律以账目自身的值为准。
       标记为「记忆来的」，这样规则填充 / AI 建议仍可以覆盖它（见 applyRulesToDraft）。 */
    draft.catFromMemory = false
    if (!txn && draft.type !== 'transfer') {
      const memCat = pickCategory(draft.type)
      if (memCat) { draft.categoryId = memCat; draft.catFromMemory = true }
      else {
        /* 第一次记账：给最常用的分类一个默认选中态（支出默认「餐饮美食」），
           避免用户以为「没选分类」而反复点，或点了保存才报错。
           仍标记为「记忆值」，规则 / AI 可以覆盖它。 */
        const roots = sortByUse(S.rootCategories(draft.type))
        if (roots.length) { draft.categoryId = roots[0].id; draft.catFromMemory = true }
      }
    }
    /* 子分类行只在「明确选过子分类」时展开：编辑已有账目、AI 记账预填、从分类点进来。
       「记住上次分类」不展开 —— 那只是默认值，展开会让弹层变高、把保存按钮挤出屏幕。 */
    draft.subOpen = false
    const preCat = (txn && txn.category_id != null)
      ? S.category(txn.category_id)
      : (draft.categoryId != null && !draft.catFromMemory ? S.category(draft.categoryId) : null)
    if (preCat && preCat.parent_id != null) draft.subOpen = true
    draft.occurred = txn ? F.localInput(F.parseIso(txn.occurred_at)) : F.localInput(new Date())
    draft.note = txn ? (txn.note || '') : ''
    draft.tags = txn ? (txn.tags || []).filter(t => String(t).slice(0, 5) !== '_ord:' && String(t).slice(0, 4) !== '_op:').join(',') : ''
    /* 导入时记下的交易单号（隐藏标记）：编辑保存要原样带上，
       否则改过备注的账目会失去「导过没导过」的判据 */
    draft.ordNo = txn
      ? (txn._ord || ((txn.tags || []).find(t => String(t).slice(0, 5) === '_ord:') || '').slice(5))
      : ''
    draft.newFiles = []
    draft.keepAtts = editing ? ((window.App.state.attachments || {})[txn.id] || []).slice() : []
    draft.removeAtts = []
    draft.ownerKey = reimbKey()
    draft.freq = ''
    draft.reimbursable = txn ? !!txn.reimbursable : false
    draft.reimbStatus = ''
    draft.reimbExpect = ''
    if (txn) {
      const rr = reimbMap()[String(txn.id)] || {}
      draft.reimbStatus = rr.status || (txn.reimbursable ? 'pending' : '')
      if (rr.expect) draft.reimbExpect = String(F.toCents(rr.expect) / 100)
    }
    draft.suggestedCatId = null
    /* 乐观锁版本：保存时带上它，若云端已被别的设备改过就会检出冲突而不是静默覆盖 */
    draft.baseUpdatedAt = txn ? (txn.updated_at || '') : ''

    /* 预填（AI 识别结果 / 规则命中 / 模板）——只在新建时生效，不覆盖已有账目 */
    if (preset && !editing) {
      if (preset.type) draft.type = preset.type
      if (preset.amount != null && preset.amount !== '') draft.amount = String(preset.amount)
      const aiReview = preset.aiReview === true
      if (preset.categoryId || (aiReview && Object.prototype.hasOwnProperty.call(preset, 'categoryId'))) {
        draft.categoryId = preset.categoryId; draft.catFromMemory = false
      }
      if (preset.accountId || (aiReview && Object.prototype.hasOwnProperty.call(preset, 'accountId'))) draft.accountId = preset.accountId
      if (preset.toAccountId || (aiReview && Object.prototype.hasOwnProperty.call(preset, 'toAccountId'))) draft.toAccountId = preset.toAccountId
      if (preset.occurred) draft.occurred = preset.occurred
      if (preset.note) draft.note = preset.note
      if (preset.tags) draft.tags = Array.isArray(preset.tags) ? preset.tags.join(',') : String(preset.tags)
      if (preset.reimbursable != null) draft.reimbursable = !!preset.reimbursable
      if (!draft.reimbStatus && draft.reimbursable) draft.reimbStatus = 'pending'
      if (preset.suggestedCatId) draft.suggestedCatId = preset.suggestedCatId
    }

    renderEditor(editing ? txn.id : null)
    editorBaseline = editorSnapshot()

    /* Esc 关闭（只在记账弹窗还开着时生效，避免监听泄漏） */
    const onKey = e => {
      if (!sheetOpen || !$('#edSave')) { document.removeEventListener('keydown', onKey); return }
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEditor(editing ? txn.id : null) }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSheet() }
    }
    if (editorKeyHandler) document.removeEventListener('keydown', editorKeyHandler)
    editorKeyHandler = onKey
    document.addEventListener('keydown', onKey)
  }

  /* 规则引擎：命中后只填补空白字段，不覆盖用户已经选好的分类 / 账户 */
  function applySmartRules(silent, explicit) {
    if (!window.Smart || (draft.aiReview && !explicit)) return []
    syncDraftFromInputs()
    const amtEl = $('#amtInput')
    const amt = amtEl ? evalAmount(amtEl.value) : NaN
    const payload = {
      txn_type: draft.type,
      amount: isNaN(amt) ? 0 : amt,
      /* 「上次用过的分类」不算用户主动选择：交给规则/AI 判断，命中就覆盖它 */
      category_id: draft.catFromMemory ? null : draft.categoryId,
      account_id: draft.accountId,
      note: draft.note || '',
      tags: (draft.tags || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
    }
    const hits = window.Smart.applyRules(payload, { fillOnly: true })
    if (!hits.length) return []
    draft.tags = payload.tags.join(',')
    if (payload.category_id) {
      /* 记住「这是自动给的分类」，用户若改动，保存时记入纠正记忆 */
      if (payload.category_id !== draft.categoryId) draft.suggestedCatId = payload.category_id
      draft.categoryId = payload.category_id
      draft.catFromMemory = false
    }
    if (payload.account_id) draft.accountId = payload.account_id
    if (!silent) toast('规则命中：' + hits.join('、'))
    return hits
  }

  function syncDraftFromInputs() {
    const amt = $('#amtInput')
    if (amt) draft.amount = amt.value
    const note = $('#noteInput')
    if (note) draft.note = note.value
    const tags = $('#tagInput')
    if (tags) draft.tags = tags.value
    const time = $('#timeInput')
    if (time) draft.occurred = time.value
    const expect = $('#reimExpect')
    if (expect) draft.reimbExpect = expect.value
  }

  /* 分类单元格点击绑定：带「只绑一次」守卫（原地同步会重复建单元格，不能重复绑） */
  function bindCatCells(editingId) {
    $$('#catGrid .cat-cell, #subGrid .cat-cell').forEach(b => {
      if (b.dataset.catBound) return
      b.dataset.catBound = '1'
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        draft.categoryId = Number(b.getAttribute('data-cid'))
        draft.catFromMemory = false
        draft.subOpen = true
        renderEditor(editingId)
      })
    })
  }

  /* blur 触发规则命中后，只原地同步选中态，不整体重绘。
     整体重绘会把用户正点击的元素换掉（那一击被吞掉）、收起已展开的键盘、弹回顶部。
     这里补齐重绘本会产生的三处变化：根分类选中、子分类行、账户 ✓。 */
  function syncEditorSelection(editingId) {
    const selCat = draft.categoryId ? S.category(draft.categoryId) : null
    const rootId = selCat ? (selCat.parent_id || selCat.id) : null
    $$('#catGrid .cat-cell').forEach(c => c.classList.toggle('on', Number(c.getAttribute('data-cid')) === rootId))
    const subs = (rootId && draft.subOpen) ? S.childCategories(rootId) : []
    let sub = $('#subGrid')
    if (subs.length) {
      const html = subs.map(c => '<button type="button" class="cat-cell' + (draft.categoryId === c.id ? ' on' : '') + '" data-cid="' + c.id + '">' +
        '<span class="cn">' + esc(c.name) + '</span></button>').join('')
      if (sub) { sub.innerHTML = html }
      else {
        sub = document.createElement('div')
        sub.className = 'cat-grid sub'
        sub.id = 'subGrid'
        sub.style.marginTop = '8px'
        sub.innerHTML = html
        const grid = $('#catGrid')
        if (grid && grid.parentNode) grid.parentNode.insertBefore(sub, grid.nextSibling)
      }
      bindCatCells(editingId)
    } else if (sub) { sub.remove() }
    const accs = S.accounts()
    $$('#accChips .chip').forEach(ch => {
      const acc = accs.find(a => a.id === Number(ch.getAttribute('data-aid')))
      if (!acc) return
      const on = Number(ch.getAttribute('data-aid')) === draft.accountId
      ch.classList.toggle('on', on)
      ch.innerHTML = (on ? '✓ ' : '') + esc(acc.icon) + ' ' + esc(acc.name)
    })
    syncEditorPressed()
  }

  function syncEditorPressed() {
    $$('#typeSeg button, #catGrid button, #subGrid button, #accChips button, #toAccChips button, #freqChips button, #reimChips button')
      .forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))))
  }

  /* 安全四则运算：只允许数字与 + - * / ( ) . 空格 */
  /* 表达式金额求值（B4）
     ------------------------------------------------------------------
     原来用 Function('return (表达式)') 求值，虽然前面有字符白名单挡着注入，
     但它是整站无法启用严格 CSP 的唯一原因（需要 unsafe-eval）。这里换成
     自研递归下降解析器，行为与原实现一致：
       expr   := term (('+'|'-') term)*
       term   := unary (('*'|'/') unary)*
       unary  := ('+'|'-') unary | primary
       primary:= number | '(' expr ')'
     任何非法输入、除零、残留字符一律返回 NaN（调用方按「不是合法金额」处理）。 */
  function evalAmount(expr) {
    /* 自研键盘输出的是 × ÷ −（跟主流记账 App 一致，可读性更好），
       求值前统一归一化成 ASCII 运算符。 */
    const raw = String(expr || '').trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    if (!raw) return NaN
    if (!/^[0-9+\-*/().\s]+$/.test(raw)) return NaN
    const text = raw.replace(/\s+/g, '')
    let i = 0
    const peek = () => (i < text.length ? text[i] : '')
    function num() {
      const start = i
      while (i < text.length && /[0-9.]/.test(text[i])) i++
      if (start === i) throw new Error('expr')
      const v = Number(text.slice(start, i))
      if (!isFinite(v)) throw new Error('expr')
      return v
    }
    function primary() {
      if (peek() === '(') {
        i++
        const v = sum()
        if (peek() !== ')') throw new Error('expr')
        i++
        return v
      }
      return num()
    }
    function unary() {
      if (peek() === '-') { i++; return -unary() }
      if (peek() === '+') { i++; return unary() }
      return primary()
    }
    function term() {
      let v = unary()
      for (;;) {
        const c = peek()
        if (c === '*') { i++; v *= unary() } else if (c === '/') { i++; v /= unary() } else break
      }
      return v
    }
    function sum() {
      let v = term()
      for (;;) {
        const c = peek()
        if (c === '+') { i++; v += term() } else if (c === '-') { i++; v -= term() } else break
      }
      return v
    }
    try {
      const v = sum()
      if (i !== text.length) return NaN     /* 末尾还有没吃掉的字符 → 不合法 */
      if (typeof v !== 'number' || !isFinite(v)) return NaN
      return Math.round(v * 100) / 100
    } catch (e) { return NaN }
  }

  /* ---------- 语音记账（Web Speech API，中文） ---------- */
  function startVoice(editingId) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { toast('当前浏览器不支持语音记账，请用 Chrome / Edge 手机版'); return }
    let rec
    try { rec = new SR() } catch (e) { toast('语音初始化失败'); return }
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    const btn = $('#voiceBtn')
    const orig = btn ? btn.innerHTML : '' + ic('mic') + ' 语音记账'
    if (btn) btn.innerHTML = '' + ic('mic') + ' 正在听…'
    let settled = false
    rec.onresult = (e) => {
      let txt = ''
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript
      const isFinal = e.results[e.results.length - 1].isFinal
      if (!isFinal) { if (btn) btn.innerHTML = '' + ic('mic') + ' ' + esc(txt.slice(-14)); return }
      applyVoice(txt, editingId)
      settled = true
      if (btn) btn.innerHTML = orig
      try { rec.stop() } catch (e2) { /* 忽略 */ }
    }
    rec.onerror = () => { if (btn) btn.textContent = orig; toast('语音识别失败，请重试') }
    rec.onend = () => { if (btn && !settled) btn.textContent = orig }
    try { rec.start() } catch (e) { if (btn) btn.textContent = orig; toast('无法启动语音，请检查麦克风权限') }
  }

  function applyVoice(txt, editingId) {
    syncDraftFromInputs()
    const m = txt.match(/(\d+(?:\.\d+)?)/)
    if (m) draft.amount = m[1]
    const cats = S.state.categories || []
    let found = null
    for (const c of cats) { if (c.name && txt.indexOf(c.name) >= 0) { found = c; break } }
    if (!found) {
      const kw = [
        ['工资', '工资'], ['发工资', '工资'], ['吃饭', '餐饮'], ['吃', '餐饮'], ['外卖', '外卖'],
        ['打车', '打车'], ['地铁', '公交地铁'], ['公交', '公交地铁'], ['买菜', '日用'], ['超市', '日用'],
        ['购物', '购物'], ['衣服', '服饰'], ['租房', '房租'], ['房租', '房租'], ['电影', '电影演出'],
        ['健身', '运动健身'], ['红包', '红包'], ['转账', '转账'], ['报销', '报销'],
        ['水电', '水电燃气'], ['话费', '话费'], ['充值', '话费'], ['药', '药品'], ['医院', '门诊'],
        ['学习', '学费'], ['书', '书籍'], ['游戏', '游戏'], ['旅游', '旅行'], ['加油', '加油'],
        ['咖啡', '零食饮料'], ['奶茶', '零食饮料'], ['零食', '零食饮料'],
      ]
      for (const pair of kw) { if (txt.indexOf(pair[0]) >= 0) { found = cats.find(c => c.name === pair[1]) || null; if (found) break } }
    }
    if (found) { draft.categoryId = found.id; draft.type = found.kind }
    draft.note = txt
    renderEditor(editingId)
    toast('已填入语音内容，确认后保存')
  }

  function renderEditor(editingId) {
    if (editorSaving) return
    editorSeq++
    /* 重绘后恢复表单滚动位置和当前控件，键盘操作可以接着往下走。 */
    const sheetEl = $('#sheet')
    const bodyEl = $('#editorBody')
    const keepBodyScroll = !editorFocusPending && bodyEl ? bodyEl.scrollTop : 0
    const active = sheetEl && sheetEl.contains(document.activeElement) ? document.activeElement : null
    const activeAttr = active && ['data-etype', 'data-cid', 'data-aid', 'data-freq', 'data-reim'].find(a => active.hasAttribute(a))
    const focusSelector = active && (active.id ? '#' + active.id :
      activeAttr && active.parentElement.id ? '#' + active.parentElement.id + ' [' + activeAttr + '="' + active.getAttribute(activeAttr) + '"]' : null)
    const selection = active && active.tagName === 'INPUT' && active.type === 'text'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null
    const accs = S.accounts()
    /* 常用分类置顶：按本机记录的使用频次降序，对齐主流记账 App 的"高频优先" */
    const cats = sortByUse(S.rootCategories(draft.type))
    const useMap = catUse()
    const selCat = draft.categoryId ? S.category(draft.categoryId) : null
    const rootId = selCat ? (selCat.parent_id || selCat.id) : null
    /* 子分类只在「用户主动点了父分类」或「编辑的子分类本来就属于它」时展开。
       否则默认预选的父分类会立刻多带一排子分类，把账户区顶出首屏。 */
    const subCats = (rootId && draft.subOpen) ? S.childCategories(rootId) : []

    const typeSeg = ['expense', 'income', 'transfer'].map(t =>
      '<button class="' + (draft.type === t ? 'on' : '') + '" data-etype="' + t + '">' + window.TXN_TYPE_LABEL[t] + '</button>').join('')

    const catBlock = draft.type === 'transfer' ? '' :
      '<div class="field"><label>分类</label><div class="cat-grid five" id="catGrid">' +
      cats.map(c => '<button type="button" class="cat-cell' + (rootId === c.id ? ' on' : '') + '" data-cid="' + c.id + '">' +
        ((Number(useMap[c.id]) || 0) >= 2 ? '<span class="cat-freq">常用</span>' : '') +
        '<span class="ci">' + esc(c.icon || '📁') + '</span><span class="cn">' + esc(c.name) + '</span></button>').join('') +
      '</div>' +
      (subCats.length ? '<div class="cat-grid sub" style="margin-top:8px" id="subGrid">' +
        subCats.map(c => '<button type="button" class="cat-cell' + (draft.categoryId === c.id ? ' on' : '') + '" data-cid="' + c.id + '">' +
          '<span class="cn">' + esc(c.name) + '</span></button>').join('') +
        '</div>' : '') +
      '</div>'

    /* P0-5（终审）：账户不再横滑 —— 6 个账户 3×2 换行网格一次看全。
       横滑找账户的成本比多一行高，而且渐隐末尾那个没文字的白块会被当成渲染残留。 */
    const accBlock = '<div class="field"><label>' + (draft.type === 'transfer' ? '转出账户' : '账户') + '</label>' +
      '<div class="chips" id="accChips">' +
      accs.map(a => '<button class="chip' + (draft.accountId === a.id ? ' on' : '') + '" data-aid="' + a.id + '">' + (draft.accountId === a.id ? '✓ ' : '') + esc(a.icon) + ' ' + esc(a.name) + '</button>').join('') +
      '</div></div>' +
      (draft.type === 'transfer'
        ? '<div class="field"><label>转入账户</label><div class="chips scroll mask-fade" id="toAccChips">' +
          accs.map(a => '<button class="chip' + (draft.toAccountId === a.id ? ' on' : '') + '" data-aid="' + a.id + '">' + (draft.toAccountId === a.id ? '✓ ' : '') + esc(a.icon) + ' ' + esc(a.name) + '</button>').join('') +
          '</div></div>'
        : '')

    const imgBlock = '<div class="field"><label>凭证图片（可多张' + (window.DB.mode === 'guest' ? '，存在本机' : '，自动压缩后上传云端') + '）</label>' +
      '<div class="img-grid" id="imgGrid">' +
      draft.keepAtts.map(a => '<div class="img-cell"><img data-aid="' + a.id + '" alt=""><button class="img-del" data-remove="' + a.id + '" data-path="' + esc(a.storage_path || '') + '">' + ic('close') + '</button></div>').join('') +
      draft.newFiles.map((f, i) => '<div class="img-cell"><img src="' + f.url + '" alt=""><button class="img-del" data-removenew="' + i + '">' + ic('close') + '</button></div>').join('') +
      '<button class="img-add" id="pickImg">＋</button>' +
      '</div>' +
      '<input type="file" id="fileInput" accept="image/*" multiple class="hidden">' +
      '</div>'

    const extraBlock = (editingId ? '' :
      '<div class="field"><label>周期记账（到期自动补记）</label><div class="chips" id="freqChips">' +
      [['', '不重复'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月'], ['yearly', '每年']].map(([v, l]) =>
        '<button class="chip' + (draft.freq === v ? ' on' : '') + '" data-freq="' + v + '">' + l + '</button>').join('') +
      '</div></div>') +
      '<div class="field"><label>报销 <span class="tiny muted" style="font-weight:400">代垫已计入支出，核销不改收支</span></label>' +
      '<div class="chips" id="reimChips">' +
      [['', '不用报销'], ['pending', '' + ic('receipt') + ' 待报销'], ['partial', '部分已收'], ['done', '已报销']].map(([v, l]) =>
        '<button class="chip' + (draft.reimbStatus === v ? ' on' : '') + '" data-reim="' + v + '">' + l + '</button>').join('') +
      '</div>' +
      (draft.reimbStatus && draft.reimbStatus !== 'done'
        ? '<input id="reimExpect" class="input" style="height:34px;margin-top:8px" type="number" inputmode="decimal" placeholder="预计报销金额（可留空）" value="' + esc(draft.reimbExpect || '') + '">'
        : '') +
      '</div>'

    /* 金额 → 分类 → 账户 → 备注；标题与保存区固定，表单单独滚动。 */
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (editingId ? '编辑记录' : '记一笔') + '</span>' +
      '<span class="row" style="gap:6px;flex:none">' +
      '<button id="edMore" class="btn sm line" aria-label="更多操作" aria-haspopup="true" aria-expanded="false">⋯</button>' +
      '<button id="edClose" class="btn sm line">关闭</button></span></div>' +
      '<div class="editor-body" id="editorBody">' +
      '<div class="ed-menu hidden" id="edMenu">' +
      (!editingId ? '<button class="btn sm line block" id="edContinue">保存，再记一笔</button>' : '') +
      '<button class="btn sm line block" id="edTpl">' + ic('star') + ' 存为模板</button>' +
      '<button class="btn sm line block" id="tplPickBtn">' + ic('star') + ' 套用模板</button>' +
      '<button class="btn sm line block" id="edRuleBtn">' + ic('wand') + ' 按规则填充</button>' +
      '<button class="btn sm line block" id="edRuleCfg">' + ic('settings') + ' 规则设置</button>' +
      (editingId ? '<button class="btn sm line block" id="edDup">复制再记一笔</button>' : '') +
      (editingId ? '<button class="btn danger block" id="edDelete">删除这笔</button>' : '') +
      '</div>' +
      '<div class="seg" id="typeSeg">' + typeSeg + '</div>' +
      (draft.aiReview && draft.aiCurrency ? '<div class="small muted">本次识别币种：' + esc(draft.aiCurrency) + '，请选择同币种账户；不会自动换算。</div>' : '') +
      '<div class="amount-box" id="amtBox"><span class="sym">' + (draft.aiReview && draft.aiCurrency ? esc(F.currencySym(draft.aiCurrency)) : '¥') + '</span>' +
      '<input id="amtInput" class="amount-input num" type="text" inputmode="none" placeholder="0.00" aria-label="金额" value="' + esc(draft.amount) + '"></div>' +
      '<div class="calc-row"><div class="calc-echo grow" id="calcEcho">支持算式，如 12+8.5×2</div>' +
      '<button type="button" class="qt" id="voiceBtn" aria-label="语音记账">' + ic('mic') + '</button>' +
      '<button type="button" class="qt" id="edAiBtn" aria-label="AI 记账">' + ic('sparkles') + '</button></div>' +
      catBlock + accBlock +
      '<div class="field"><label for="noteInput">备注</label><input id="noteInput" class="input" aria-describedby="noteLimit" placeholder="如：和室友吃火锅" maxlength="80" value="' + esc(draft.note) + '"><div id="noteLimit" class="tiny muted"></div></div>' +
      '<div class="chips scroll" id="noteSug" style="margin:-6px 0 10px"></div>' +
      '<button class="btn sm line block" id="moreToggle" aria-controls="moreBox" aria-expanded="' + editorMoreOpen + '" style="margin:12px 0">' +
      (editorMoreOpen ? '收起更多选项 ⌃' : '更多选项：时间 · 标签 · 周期 · 报销 · 凭证图片 ⌄') + '</button>' +
      '<div id="moreBox"' + (editorMoreOpen ? '' : ' class="hidden"') + '>' +
      '<div class="field"><label for="timeInput">时间</label>' +
      '<div class="row"><input id="timeInput" class="input grow" type="datetime-local" value="' + draft.occurred + '">' +
      '<button class="btn sm line" id="nowBtn" style="flex:none">此刻</button></div></div>' +
      '<div class="field"><label for="tagInput">标签（逗号分隔，可留空）</label><input id="tagInput" class="input" placeholder="如：聚餐,AA" maxlength="40" value="' + esc(draft.tags) + '"></div>' +
      extraBlock +
      imgBlock +
      '</div>' +
      '</div>' +
      '<div class="sheet-foot">' +
      '<div class="err" id="edErr" role="alert"></div>' +
      /* 全弹层只有一个「保存」。键盘贴着它展开，右下角是「完成」（只收起键盘） */
      '<button class="btn block" id="edSave">' + (editingId ? '保存修改' : '保存') + '</button>' +
      '<div class="keypad-wrap hidden" id="keypadWrap">' +
      '<div class="keypad" id="keypad">' +
      [['7', ''], ['8', ''], ['9', ''], ['⌫', 'fn'],
       ['4', ''], ['5', ''], ['6', ''], ['+', 'op'],
       ['1', ''], ['2', ''], ['3', ''], ['−', 'op'],
       ['.', ''], ['0', ''], ['×', 'op'], ['÷', 'op'],
       ['清空', 'fn wide'], ['完成', 'ok wide']].map(([k, cls]) =>
        '<button type="button" class="' + cls + '" data-k="' + esc(k) + '" aria-label="' + ({'⌫': '删除前一位', '清空': '清空金额', '完成': '收起数字键盘', '+': '加', '−': '减', '×': '乘', '÷': '除', '.': '小数点'}[k] || k) + '">' + esc(k) + '</button>').join('') +
      '</div></div>' +
      '</div>'
    )
    $('#sheet').classList.add('editor-sheet')
    syncEditorPressed()

    const moreBtn = $('#moreToggle')
    if (moreBtn) moreBtn.addEventListener('click', () => {
      syncDraftFromInputs()
      editorMoreOpen = !editorMoreOpen
      renderEditor(editingId)
      const box = $('#moreBox')
      if (box && editorMoreOpen && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' })
    })

    /* 事件绑定 */
    $('#edClose').addEventListener('click', closeSheet)
    $$('#typeSeg button').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        draft.type = b.getAttribute('data-etype')
        /* 换了收支类型 → 换成该类型「上次用过的分类」（各自独立记忆） */
        draft.categoryId = draft.type === 'transfer' ? null : pickCategory(draft.type)
        draft.catFromMemory = !!draft.categoryId
        renderEditor(editingId)
      })
    })
    bindCatCells(editingId)
    $$('#accChips .chip').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        draft.accountId = Number(b.getAttribute('data-aid'))
        renderEditor(editingId)
      })
    })

    $$('#toAccChips .chip').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        draft.toAccountId = Number(b.getAttribute('data-aid'))
        renderEditor(editingId)
      })
    })
    $('#nowBtn').addEventListener('click', () => { $('#timeInput').value = F.localInput(new Date()) })
    $$('#freqChips .chip').forEach(b => {
      b.addEventListener('click', () => {
        $$('#freqChips .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        draft.freq = b.getAttribute('data-freq')
        syncEditorPressed()
      })
    })
    $$('#reimChips .chip').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        const ex = $('#reimExpect')
        if (ex) draft.reimbExpect = ex.value
        draft.reimbStatus = b.getAttribute('data-reim') || ''
        draft.reimbursable = !!draft.reimbStatus
        renderEditor(editingId)
      })
    })
    $('#pickImg').addEventListener('click', () => $('#fileInput').click())
    $('#fileInput').addEventListener('change', e => {
      syncDraftFromInputs()
      const files = Array.prototype.slice.call(e.target.files || [])
      files.forEach(f => draft.newFiles.push({ file: f, url: URL.createObjectURL(f) }))
      renderEditor(editingId)
    })
    $$('[data-removenew]').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        const i = Number(b.getAttribute('data-removenew'))
        draft.newFiles.splice(i, 1)
        renderEditor(editingId)
      })
    })
    $$('[data-remove]').forEach(b => {
      b.addEventListener('click', () => {
        syncDraftFromInputs()
        const id = b.getAttribute('data-remove')
        const att = draft.keepAtts.find(a => String(a.id) === String(id))
        if (!att) return
        draft.removeAtts.push(att)
        draft.keepAtts = draft.keepAtts.filter(a => String(a.id) !== id)
        renderEditor(editingId)
      })
    })
    /* 已有图片取显示 URL */
    $$('#imgGrid img[data-aid]').forEach(async img => {
      const att = draft.keepAtts.find(a => String(a.id) === img.getAttribute('data-aid'))
      if (!att) return
      const url = await S.imageUrl(att)
      if (url) img.src = url
      img.addEventListener('click', () => { if (img.src) lightbox(img.src) })
    })

    /* 右上角「⋯」：把「再记一笔 / 存为模板 / 删除」从吸底栏收进来，
       吸底栏只留一个主按钮（全站唯一的「保存」） */
    const moreOp = $('#edMore')
    const edMenu = $('#edMenu')
    if (moreOp && edMenu) {
      moreOp.addEventListener('click', () => {
        const on = edMenu.classList.contains('hidden')
        edMenu.classList.toggle('hidden', !on)
        moreOp.setAttribute('aria-expanded', on ? 'true' : 'false')
        if (on) {
          if (edMenu.scrollIntoView) edMenu.scrollIntoView({ block: 'start' })
          const first = $('button', edMenu)
          if (first) first.focus({ preventScroll: true })
        }
      })
    }
    $('#edSave').addEventListener('click', () => saveEditor(editingId))
    const cont = $('#edContinue')
    if (cont) cont.addEventListener('click', () => saveEditor(null, false, true))
    const tplBtn = $('#edTpl')
    if (tplBtn) tplBtn.addEventListener('click', () => saveAsTemplate())
    const vb = $('#voiceBtn')
    if (vb) vb.addEventListener('click', () => startVoice(editingId))
    const tpb = $('#tplPickBtn')
    if (tpb) tpb.addEventListener('click', () => openTemplatePicker(sheetVersion))
    const aiBtn = $('#edAiBtn')
    if (aiBtn) aiBtn.addEventListener('click', () => {
      const version = sheetVersion
      Lazy.need('smart').then(m => { if (m && version === sheetVersion && $('#edSave') && mayLeaveEditor()) m.openAiSheet() })
    })
    const ruleBtn = $('#edRuleBtn')
    if (ruleBtn) ruleBtn.addEventListener('click', () => {
      if (editingId) { toast('编辑已有账目时不套用规则'); return }
      const hits = applySmartRules(false, true)
      if (!hits.length) { toast('没有命中任何规则'); return }
      /* 规则命中的常是子分类（如「餐饮·零食饮料」），必须展开子分类行，
         否则界面上只看到父分类被选中，用户以为规则没生效 */
      draft.subOpen = true
      renderEditor(editingId)
    })
    const ruleCfg = $('#edRuleCfg')
    if (ruleCfg) ruleCfg.addEventListener('click', () => {
      const version = sheetVersion
      Lazy.need('smart').then(m => { if (m && version === sheetVersion && $('#edSave') && mayLeaveEditor()) m.openRuleManager() })
    })

    /* 备注智能补全：点历史备注直接填，并顺手跑一遍规则 */
    const noteInput = $('#noteInput')
    const updateNoteLimit = () => {
      if (!noteInput) return
      const remaining = Math.max(0, noteInput.maxLength - noteInput.value.length)
      $('#noteLimit').textContent = remaining <= 20 ? '还可输入 ' + remaining + ' 个字符（表情可能占两个）' : '最多 80 个字符'
    }
    if (noteInput) {
      updateNoteLimit()
      noteInput.addEventListener('input', updateNoteLimit)
      noteInput.addEventListener('blur', () => {
        if (editingId) return
        const before = JSON.stringify([draft.categoryId, draft.accountId, draft.tags])
        const hits = applySmartRules()
        const after = JSON.stringify([draft.categoryId, draft.accountId, draft.tags])
        /* 只原地同步选中态：整体重绘会吞掉用户接下来的那一击（焦点切换与点击同程），
           还会收起已展开的键盘、把弹层弹回顶部 */
        if (hits.length && before !== after) { draft.subOpen = true; syncEditorSelection(editingId) }
      })
    }
    Lazy.need('smart').then(m => {
      if (!m) return
      const seq = editorSeq
      m.noteSuggestions().then(list => {
        if (seq !== editorSeq) return
        const box = $('#noteSug')
        if (!box || !list || !list.length) return
        const cur = (draft.note || '').trim()
        const hits = list.filter(n => n !== cur).slice(0, 10)
        if (!hits.length) { box.innerHTML = ''; return }
        box.innerHTML = '<span class="tiny muted" style="align-self:center">常用：</span>' +
          hits.map(n => '<button class="chip" data-note="' + esc(n) + '">' + esc(n) + '</button>').join('')
        $$('#noteSug .chip').forEach(b => b.addEventListener('click', () => {
          const el = $('#noteInput')
          if (!el) return
          syncDraftFromInputs()
          el.value = b.getAttribute('data-note')
          draft.note = el.value
          updateNoteLimit()
          const hits = editingId ? [] : applySmartRules()
          if (hits.length) {
            draft.subOpen = true
            syncEditorSelection(editingId)
            const tags = $('#tagInput')
            if (tags) tags.value = draft.tags
          }
        }))
      })
    })
    /* 计算器实时回显：以运算符结尾时先算前面一段，当作「当前累计」，
       这样边按边算（7 → + → 8 → ×）都能看到数，而不是一直提示算式错误 */
    const amtEl = $('#amtInput')
    const echoEl = $('#calcEcho')
    const echo = () => {
      const s = amtEl.value.trim()
      if (!s) { echoEl.textContent = '支持算式，如 12+8.5×2'; return }
      if (/^[0-9.]+$/.test(s)) { echoEl.textContent = ''; return }
      const tail = /[+\-*/×÷−]$/.test(s)
      const v = evalAmount(tail ? s.slice(0, -1) : s)
      echoEl.innerHTML = isNaN(v)
        ? '<span style="color:var(--expense)">算式无法识别</span>'
        : (tail ? '当前 ' : '= ') + '<b>¥' + F.yuan(F.toCents(v)) + '</b>'
    }
    amtEl.addEventListener('input', echo)
    echo()

    /* 保留光标和选区，修正中间数字时无需清空整笔金额。 */
    const kp = $('#keypad')
    const kpWrap = $('#keypadWrap')
    const setKp = (on, reveal) => {
      editorKpOpen = on
      if (kpWrap) kpWrap.classList.toggle('hidden', !on)
      const s = $('#sheet')
      if (s) {
        s.classList.toggle('kp-open', on)
        /* 展开键盘时把金额送到表单顶部；横屏并排布局不需要重新滚动。 */
        if (on && reveal !== false && getComputedStyle(s).display !== 'grid') {
          const box = $('#amtBox')
          const body = $('#editorBody')
          if (box && body) body.scrollTop = Math.max(0, box.offsetTop - 8)
        }
      }
    }
    /* 点金额区才展开键盘：默认收起，让「分类 / 账户 / 保存」都在首屏 */
    const amtBox = $('#amtBox')
    if (amtBox) amtBox.addEventListener('click', () => { if (!editorKpOpen) setKp(true) })
    amtEl.addEventListener('focus', () => {
      const touch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches
      if ((window.innerWidth < 640 || touch) && !editorKpOpen) setKp(true)
    })
    $('#noteInput').addEventListener('focus', () => setKp(false))
    if (kpWrap) setKp(!!editorKpOpen, false)
    $('#editorBody').scrollTop = keepBodyScroll
    if (kp) kp.addEventListener('pointerdown', e => {
      if (e.target.closest('button[data-k]') && document.activeElement === amtEl) e.preventDefault()
    })
    if (kp) kp.addEventListener('click', e => {
      const btn = e.target.closest ? e.target.closest('button[data-k]') : null
      if (!btn) return
      const k = btn.getAttribute('data-k')
      /* 「完成」只收起键盘，不提交 —— 提交只有一个入口：#edSave */
      if (k === '完成') { setKp(false); $('#edSave').focus({ preventScroll: true }); return }
      const v = amtEl.value
      let start = amtEl.selectionStart == null ? v.length : amtEl.selectionStart
      const end = amtEl.selectionEnd == null ? start : amtEl.selectionEnd
      let insert = k
      if (k === '清空') { amtEl.value = ''; amtEl.setSelectionRange(0, 0) }
      else {
        if (k === '⌫') { if (start === end) start = Math.max(0, start - 1); insert = '' }
        else if (k === '+' || k === '−' || k === '×' || k === '÷') {
          if (start === end && /[+\-*/×÷−]$/.test(v.slice(0, start))) start--
        } else if (k === '.') {
          const left = v.slice(0, start).split(/[+\-*/×÷−()]/).pop()
          const right = v.slice(end).split(/[+\-*/×÷−()]/)[0]
          if ((left + right).indexOf('.') >= 0) return
          insert = left === '' ? '0.' : '.'
        }
        amtEl.setRangeText(insert, start, end, 'end')
      }
      draft.amount = amtEl.value
      echo()
    })
    /* Enter 直接保存 */
    amtEl.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey) return
      if (e.key === 'Enter') { e.preventDefault(); saveEditor(editingId) }
    })
    /* 桌面端打开时自动聚焦金额并全选，省去一次点击（重绘时不重复抢焦点） */
    if (editorFocusPending) {
      editorFocusPending = false
      const touch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches
      if (window.innerWidth >= 640 && !touch) { try { amtEl.focus(); amtEl.select() } catch (e) { /* 忽略 */ } }
    } else if (focusSelector) {
      const target = $(focusSelector)
      if (target) {
        target.focus({ preventScroll: true })
        if (selection) target.setSelectionRange(selection[0], selection[1], selection[2])
      }
    }
    if (editingId) {
      $('#edDup').addEventListener('click', () => saveEditor(editingId, true))
      $('#edDelete').addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '删除账目', danger: true, okText: '删除', body: '删除后会进入回收站，可随时恢复，确定删除？' }))) return
        await S.deleteTransaction(editingId)
        closeSheet(true)
        toast('已移入回收站')
        window.App.refresh()
      })
    }
  }

  /* 校验失败在保存操作旁保留说明，同时提示、定位字段并标记红框。 */
  function edFail(msg, fieldId) {
    const err = $('#edErr')
    if (err) err.textContent = msg
    toast(msg)
    if (!fieldId) return
    const el = $('#' + fieldId)
    if (!el) return
    el.classList.add('invalid')
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: motionPreference && motionPreference.matches ? 'auto' : 'smooth' }) } catch (e) { /* 忽略 */ }
    setTimeout(() => { try { el.classList.remove('invalid') } catch (e) { /* 忽略 */ } }, 2400)
  }

  let editorSaving = false
  async function saveEditor(editingId, duplicate, keepAdding) {
    if (editorSaving) return
    const amount = evalAmount($('#amtInput').value)
    if (!amount || amount <= 0) { edFail('请输入大于 0 的金额（可用算式）', 'amtBox'); return }
    const timeInput = $('#timeInput')
    if (!timeInput.value || !timeInput.validity.valid) {
      editorMoreOpen = true
      $('#moreBox').classList.remove('hidden')
      $('#moreToggle').textContent = '收起更多选项 ⌃'
      edFail('请选择有效的记账时间', 'timeInput')
      return
    }

    /* AI 未匹配的字段须由用户确认，保存时不能被规则悄悄填回默认项。 */
    if (draft.aiReview) {
      if (!draft.accountId) { edFail('请确认并选择账户', 'accChips'); return }
      if (draft.type !== 'transfer' && !draft.categoryId) { edFail('请确认并选择分类', 'catGrid'); return }
    }

    /* 规则引擎兜底：只在字段为空时补齐，并合并规则里的标签 */
    let ruleHits = []
    if (window.Smart && draft.type !== 'transfer') {
      const preview = {
        txn_type: draft.type,
        amount: amount,
        /* 同 applySmartRules：记忆来的分类不阻挡规则命中 */
        category_id: draft.catFromMemory ? null : draft.categoryId,
        account_id: draft.accountId,
        note: $('#noteInput').value.trim(),
        tags: $('#tagInput').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
      }
      ruleHits = window.Smart.applyRules(preview, { fillOnly: true })
      if (preview.category_id) { draft.categoryId = preview.category_id; draft.catFromMemory = false }
      if (preview.account_id) draft.accountId = preview.account_id
      $('#tagInput').value = preview.tags.join(',')
    }

    if (draft.type !== 'transfer' && !draft.categoryId) { edFail('请选择分类', 'catGrid'); return }
    if (!draft.accountId) { edFail('请选择账户', 'accChips'); return }
    if (draft.type === 'transfer' && (!draft.toAccountId || String(draft.toAccountId) === String(draft.accountId))) {
      edFail('转账需要选择两个不同账户', 'toAccChips'); return
    }
    if (draft.type === 'transfer') {
      const accounts = S.allAccounts()
      const fromAccount = accounts.find(a => String(a.id) === String(draft.accountId))
      const toAccount = accounts.find(a => String(a.id) === String(draft.toAccountId))
      if (!fromAccount || !toAccount) { edFail('账户已不可用，请重新选择', 'accChips'); return }
      if (String(fromAccount.currency || 'CNY').toUpperCase() !== String(toAccount.currency || 'CNY').toUpperCase()) {
        edFail('暂不支持跨币种转账，请选择同币种账户', 'toAccChips'); return
      }
    }

    /* AI 的已知币种必须跟随草稿到最终选定账户，避免人工选账户时丢失单位。 */
    if (draft.aiReview) {
      const account = S.accounts().find(a => String(a.id) === String(draft.accountId))
      const toAccount = draft.type === 'transfer' ? S.accounts().find(a => String(a.id) === String(draft.toAccountId)) : null
      if (!account || (draft.type === 'transfer' && !toAccount)) {
        edFail('账户已不可用，请重新选择', 'accChips'); return
      }
      if (draft.aiCurrency && String(account.currency || 'CNY').toUpperCase() !== draft.aiCurrency) {
        edFail('识别金额币种为 ' + draft.aiCurrency + '，请选择同币种账户；如需换算，请退出后手动核对金额', 'accChips'); return
      }
      if (toAccount && String(account.currency || 'CNY').toUpperCase() !== String(toAccount.currency || 'CNY').toUpperCase()) {
        edFail('跨币种转账不能沿用同一个识别金额，请退出后手动核对两边金额', 'toAccChips'); return
      }
    }

    const payload = {
      txn_type: draft.type,
      amount: amount,
      occurred_at: F.iso(F.parseInput($('#timeInput').value)),
      account_id: draft.accountId,
      to_account_id: draft.type === 'transfer' ? draft.toAccountId : null,
      category_id: draft.type === 'transfer' ? null : draft.categoryId,
      note: $('#noteInput').value.trim(),
      tags: $('#tagInput').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
      /* 三种报销状态都保留 reimbursable=true（「这笔是代垫」），
         具体到哪一步由本机覆盖层记录 —— 已报销的也要能在台账里看到 */
      reimbursable: draft.type === 'expense' && !!draft.reimbStatus,
    }
    /* 复制一笔时不继承单号：那是原账目的身份，复制品不该冒用 */
    if (draft.ordNo && !duplicate) payload.tags = payload.tags.concat('_ord:' + draft.ordNo)

    const btn = $('#edSave')
    const reimbOwner = reimbKey()
    editorSaving = true
    btn.disabled = true
    $('#edErr').textContent = ''
    btn.textContent = '保存中…'
    btn.classList.add('is-loading')
    btn.setAttribute('aria-busy', 'true')
    let committedId = null
    let partialWarning = ''
    /* 用户把 AI / 规则给的分类改了 → 记住「这条备注 → 你选的分类」，下次自动套用 */
    let learnedFix = null
    if (window.Smart && draft.suggestedCatId && payload.txn_type !== 'transfer' &&
        payload.category_id && payload.category_id !== draft.suggestedCatId && payload.note) {
      try { learnedFix = window.Smart.learnCategoryFix(payload.note, payload.category_id, { kind: payload.txn_type }) } catch (e) { learnedFix = null }
    }
    try {
      let id = editingId
      if (editingId && !duplicate) {
        await S.updateTransaction(editingId, payload, draft.baseUpdatedAt)
        committedId = editingId
      } else {
        if (duplicate) payload.occurred_at = F.iso(new Date())
        const t = await S.addTransaction(payload)
        id = t.id
        committedId = id
        if (!duplicate && draft.freq) {
          const day = F.dstr(F.parseInput($('#timeInput').value))
          await S.addRecurring({
            txn_type: payload.txn_type, amount: payload.amount,
            account_id: payload.account_id, to_account_id: payload.to_account_id,
            category_id: payload.category_id, note: payload.note, tags: payload.tags,
            reimbursable: payload.reimbursable,
            freq: draft.freq,
            start_date: day,
            last_run_date: day,   /* 当前这条本身就是第一期，补记从下一期开始 */
            active: true,
          })
        }
      }
      if (!duplicate && draft.newFiles.length) {
        btn.textContent = '上传图片…'
        const uploaded = []
        for (const f of draft.newFiles) {
          try {
            const up = await S.uploadImage(f.file)
            uploaded.push(up)
          } catch (e) { partialWarning = '部分凭证上传失败，请重新添加' }
        }
        if (uploaded.length) await S.addAttachments(id, uploaded)
      }
      let removalUncertain = false
      if (editingId && !duplicate && draft.removeAtts.length) {
        for (const att of draft.removeAtts) {
          if (!draft.ownerKey || reimbKey() !== draft.ownerKey) { removalUncertain = true; break }
          try { await S.removeAttachment(att.id, att.storage_path || '') }
          catch (e) { removalUncertain = true; break }
        }
      }
      editorSaving = false
      /* 报销状态写本机覆盖层（不改表结构）：核销只改状态，不写新账目，
         所以月支出 / 收入 / 净资产都不变 */
      try {
        const exEl = $('#reimExpect')
        if (payload.reimbursable || editingId) writeReimb(committedId, draft.type === 'expense' ? draft.reimbStatus : '', exEl ? exEl.value : draft.reimbExpect, reimbOwner)
      } catch (e) { partialWarning = '账目已保存，但报销状态未保存；请核对本机存储及账号' }
      closeSheet(true)
      if (window.Smart) window.Smart.invalidateNoteCache()
      /* 记录分类使用频次，下次打开记账弹窗时常用分类排到前面 */
      if (!editingId || duplicate) bumpCatUse(payload.category_id)
      /* 记住这次用的账户与分类，下次新建时预选（编辑已有账目时也更新，跟随最近习惯） */
      saveLastPick(payload.txn_type, payload.account_id, payload.category_id)
      let msg = duplicate ? '已复制再记一笔（时间取现在，图片不复制）' : editingId ? '已更新' : '已记录'
      if (ruleHits.length) msg += ' · 自动归类：' + ruleHits.join('、')
      if (learnedFix) msg += ' · 已记住「' + learnedFix.kw + '」以后归到' + (S.categoryName(payload.category_id) || '该分类')
      toast(msg + (partialWarning ? ' · ' + partialWarning : ''),
        partialWarning || removalUncertain ? undefined : { icon: ic('check') })
      window.App.refresh()
      if (removalUncertain) {
        openSheet('<div class="sheet-head"><b class="sheet-title">账目已保存</b><button class="btn sm line" id="attachmentPartialClose">关闭</button></div>' +
          '<p>账目已保存，但凭证删除结果需要核对。请重新打开账目查看凭证，不要重复保存账目。</p>')
        $('#attachmentPartialClose').addEventListener('click', closeSheet)
      }
      if (keepAdding && !partialWarning && !removalUncertain) openEditor(null, payload.txn_type, { accountId: payload.account_id, categoryId: payload.category_id })
      /* 预算阈值提醒（异步执行，不阻塞保存；只在跨过阈值时提示） */
      if (payload.txn_type === 'expense') checkBudgetAlert(F.toCents(amount))
    } catch (e) {
      if (e && e.code === 'CONFLICT') {
        /* 别的设备在我们编辑期间改过这条。绝不静默覆盖 —— 把两版摆出来让用户选。 */
        editorSaving = false
        showConflictLazy(e, editingId, payload, draft.removeAtts.length > 0)
        return
      }
      if (committedId != null) {
        editorSaving = false
        closeSheet(true)
        window.App.refresh()
        openSheet('<div class="sheet-head"><b class="sheet-title">账目已保存</b><button class="btn sm line" id="partialClose">关闭</button></div>' +
          '<p>账目已保存，但周期规则或凭证未完成：' + esc(e.message || '请检查网络') + '</p><p class="small muted">请在已保存的账目中补充凭证，或在周期记账中检查规则。无需重新记账。</p>')
        $('#partialClose').addEventListener('click', closeSheet)
      } else {
        btn.disabled = false
        btn.textContent = editingId ? '保存修改' : '保存'
        $('#edErr').textContent = '保存失败：' + (e.message || '请检查网络后重试')
      }
    } finally {
      editorSaving = false
      btn.classList.remove('is-loading')
      btn.removeAttribute('aria-busy')
    }
  }

  /* 冲突弹窗放在懒加载模块 js/sync-sheet.js 里 —— 只有真的冲突时才用得上，
     首屏余量极薄（155KB 硬线），这类长文案不该占预算。 */
  function showConflictLazy(err, id, payload, hasPendingRemovals) {
    window.Lazy.need('syncui').then(function (m) {
      if (!m || !m.showConflict) throw new Error('模块不可用')
      m.showConflict(err, id, payload, hasPendingRemovals ? { pendingAttachmentNotice: '所选凭证尚未删除，请重新打开账目核对。' } : undefined)
    }).catch(function () {
      const b = $('#edSave')
      if (b) { b.disabled = false; b.textContent = '保存修改' }
      const box = $('#edErr')
      if (box) box.textContent = '这条已被其他设备改过。请刷新页面后重新打开这条记录再保存。'
    })
  }

  /* ---------- 记账模板 ---------- */
  async function saveAsTemplate() {
    syncDraftFromInputs()
    const def = draft.note || (draft.categoryId ? S.categoryName(draft.categoryId) : '')
    const name = (prompt('给这个模板起个名字（如：午饭、地铁通勤）：', def) || '').trim()
    if (!name) return
    try {
      await S.addTemplate({
        name,
        txn_type: draft.type,
        amount: draft.amount ? Number(draft.amount) : null,
        account_id: draft.accountId || null,
        to_account_id: draft.type === 'transfer' ? draft.toAccountId : null,
        category_id: draft.type === 'transfer' ? null : draft.categoryId,
        note: draft.note || '',
        tags: (draft.tags || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        book_id: S.currentBookId(),
      })
      toast('已存为模板「' + name + '」')
    } catch (e) { toast('保存模板失败') }
  }

  async function applyTemplate(tpl) {
    await openEditor(null, tpl.txn_type, {
      amount: tpl.amount, categoryId: tpl.category_id, accountId: tpl.account_id,
      toAccountId: tpl.to_account_id, note: tpl.note, tags: tpl.tags,
    })
  }

  async function openTemplatePicker(editorVersion) {
    const tpls = await S.listTemplates().catch(() => [])
    if (editorVersion != null && (editorVersion !== sheetVersion || !$('#edSave') || !mayLeaveEditor())) return
    let html = '<div class="sheet-head"><span class="sheet-title">套用模板</span><button id="tplClose" class="btn sm line">关闭</button></div>'
    if (!tpls.length) {
      html += '<div class="empty" style="padding:24px"><div class="big">📋</div><div>还没有模板</div><div class="small" style="margin-top:6px">在记账页点「' + ic('star') + ' 存为模板」即可保存常用一笔</div></div>'
    } else {
      html += tpls.map(t => {
        const cat = t.category_id ? S.categoryName(t.category_id) : ''
        const amt = t.amount != null ? F.money(F.toCents(t.amount)) + ' · ' : ''
        return '<div class="list-item" data-tpl="' + t.id + '">' +
          '<div class="ico">' + ic('star') + '</div>' +
          '<div class="grow"><div>' + esc(t.name) + '</div>' +
          '<div class="small muted">' + amt + esc(cat) + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
          '<button class="btn sm danger" data-tpldel="' + t.id + '">删</button></div>'
      }).join('')
    }
    openSheet(html)
    $('#tplClose').addEventListener('click', closeSheet)
    $$('#sheet [data-tpl]').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.hasAttribute('data-tpldel')) return
        const tpl = tpls.find(x => x.id === Number(el.getAttribute('data-tpl')))
        if (tpl) applyTemplate(tpl)
      })
    })
    $$('#sheet [data-tpldel]').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!(await confirmSheet({ title: '删除模板', danger: true, okText: '删除', body: '删除该模板？' }))) return
        await S.deleteTemplate(Number(b.getAttribute('data-tpldel')))
        openTemplatePicker()
      })
    })
  }

  async function openTemplateManager() { await openTemplatePicker() }

  /* ---------- 回收站 ---------- */

  /* ---------- 界面与配色（字号 / 涨跌配色） ---------- */

  /* ---------- 应用锁（本机 PIN）→ 已搬进 manage.js ---------- */
  function openLockSettings() { return Lazy.need('manage').then(m => m && m.openLockSettings()) }

  function openThemeSettings() { return Lazy.need('manage').then(m => m && m.openThemeSettings()) }

  /* ---------- 新手指引 / 安装引导 / 关于 ---------- */
  /* 帮助 / 安装指引 / 关于：长静态文案搬到懒加载模块 js/legal.js，
     这里只留转发层（首屏 gzip 预算硬线，见 tests/_perf4.js） */
  function openHelp() { return Lazy.need('legal').then(m => m && m.openHelp()) }
  function openInstallGuide() { return Lazy.need('legal').then(m => m && m.openInstallGuide()) }
  function openAbout() { return Lazy.need('legal').then(m => m && m.openAbout()) }

  /* ---------- 账号与同步 / 首次引导（转发到懒加载模块）----------
     这三个界面不常用但很重要，代码放懒加载的 vault.js，避免顶破首屏 150KB 硬线。 */
  const hub = fn => Lazy.need('vault').then(m => m && m[fn] && m[fn]())
  function openSyncHub() { return hub('openSyncHub') }
  function replayOnboard() { return hub('replayOnboard') }


  /* ---------- 法律文本 ----------
     主体名称与联系方式从 window.APP_INFO 读取（见 js/config.js）。
     留空时不静默使用占位符，而是在文首插一条醒目的「未配置」提示条，
     避免开发者忘了填就提交审核（微信审核会核对主体与联系方式是否真实）。 */
  const APP_INFO = window.APP_INFO || {}
  const OPERATOR = String(APP_INFO.operator || '').trim()
  const CONTACT = String(APP_INFO.contact || '').trim()
  /* 隐私指引 / 用户协议同样搬进 js/legal.js */
  function openPrivacy() { return Lazy.need('legal').then(m => m && m.openPrivacy()) }
  function openTerms() { return Lazy.need('legal').then(m => m && m.openTerms()) }

  /* 隐私同意标记（P1-12 起确认前移到登录页勾选，这里只读写标记） */
  function needConsent() {
    try { return localStorage.getItem('ledger10_privacy_ok') !== '1' } catch (e) { return false }
  }
  function markConsent() {
    try { localStorage.setItem('ledger10_privacy_ok', '1') } catch (e) { /* 忽略 */ }
  }
  /* ---------- CSV 导入/导出转发层（实现已迁到懒加载 js/csv.js，v1.9.4 首屏瘦身） ---------- */
  async function importCsvText(text) {
    const m = await Lazy.csv()
    if (!m) throw new Error('CSV 解析组件未加载，请刷新页面后重试')
    return m.importCsvText(text)
  }
  async function parseCsvText(text) {
    const m = await Lazy.csv()
    if (!m) throw new Error('CSV 解析组件未加载，请刷新页面后重试')
    return m.parseCsvText(text)
  }
  function commitRows(rows, options) {
    return Lazy.csv().then(m => m.commitRows(rows, options))
  }
  function openImportPreview(parsed, fileName) {
    return Lazy.csv().then(m => m.openImportPreview(parsed, fileName))
  }
  function exportCsv() {
    return Lazy.csv().then(m => m.exportCsv())
  }

  return {
    $, $$, toast, openSheet, closeSheet, lightbox, ic, animateFeedback, confirmSheet,
    savedFilterList, savedFilterSave, savedFilterApply, savedFilterDelete, pendingBanner, reimbStatusOf, writeReimb, reimbPending, legacyReimbNotice,
    renderOverview, renderHome, renderStats, renderAssets, renderMe, ledgerEmpty, syncBatchContext,
    openEditor, loadMore, periodRange, periodTitle, openPeriodPicker,
    openBookSheet, openCategoryBudget, openSubscriptionSheet, openReminderSettings,
    openThemeSettings, openBackupSheet, openGoalEditor, evalAmount, openUiSettings, applyGoalAuto,
    goalLink, setGoalLink, goalAutoAll, setGoalAuto,
    openFxSettings, invalidateReimb,
    importCsvText, parseCsvText, commitRows, openImportPreview, budgetExecCard, openMonthBudget, openLockSettings,
    openHelp, openInstallGuide, openAbout, openDemoData,
    openPrivacy, openTerms, needConsent, markConsent,
    openSyncHub, replayOnboard, exportCsv,
    collectOverlays, applyOverlays, backupImportWarning,
  }
})()

/* 各模块直接调 ic() / confirmSheet()，挂全局别名 */
window.ic = window.UI.ic
window.confirmSheet = window.UI.confirmSheet


