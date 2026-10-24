/* Product experience on top of the existing WorkBuddy ledger; no new data store. */
;(function () {
  'use strict'
  const U = window.UI, F = window.Fmt, S = window.DB
  const icon = name => '<svg class="sg-icon" aria-hidden="true"><use href="assets/icons.svg#' + name + '"></use></svg>'
  let revision = 0
  function header(st) {
    const titles = { home: ['收支明细', '每一笔，都心中有数。'], stats: ['收支统计', '看清钱花在哪里。'], assets: ['我的资产', '账户、负债与攒钱计划。'], me: ['我的', '管理账本，也照顾数据。'] }
    const text = titles[st.tab] || titles.home
    let el = document.getElementById('productHeading')
    if (!el) { el = document.createElement('header'); el.id = 'productHeading'; document.querySelector('.topbar').before(el) }
    el.innerHTML = '<div><div class="sg-eyebrow">拾光记账 <span>SHIGUANG</span></div><h1>' + text[0] + '</h1><p>' + text[1] + '</p></div>' +
      '<button class="btn line sg-heading-add" id="sgHeadingAdd">' + icon('plus') + '记一笔</button>'
    document.getElementById('sgHeadingAdd').onclick = () => U.openEditor(null)
    document.querySelectorAll('#tabbar [data-tab]').forEach(el => {
      if (el.dataset.tab === st.tab) el.setAttribute('aria-current', 'page')
      else el.removeAttribute('aria-current')
    })
  }
  async function home(st, ticket) {
    const target = document.getElementById('productHome')
    if (!target) return
    if (st.tab !== 'home') { target.innerHTML = ''; target.classList.add('hidden'); return }
    target.classList.remove('hidden')
    const today = new Date(), tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    const from = F.iso(new Date(today.getFullYear(), today.getMonth(), today.getDate()))
    const results = await Promise.allSettled([
      S.monthlySummary(from, F.iso(tomorrow)),
      S.listTransactions({ type: 'expense', limit: 200 })
    ])
    if (ticket !== revision || st.tab !== 'home') return
    /* 终审 P1（3.1）：账本全空时整块收起——「今天 ¥0.00」没有信息量，
       Welcome 卡的双按钮（记第一笔 / 载入示例数据）就是空账本的动作入口 */
    if (await U.ledgerEmpty()) { target.innerHTML = ''; target.classList.add('hidden'); return }
    /* 首页可定制：用户可以在「界面与配色」里关掉快捷记账条 */
    let quickOn = true
    try { quickOn = localStorage.getItem('ledger10_home_quick') !== 'off' } catch (e) { /* 忽略 */ }
    if (!quickOn) { target.innerHTML = ''; target.classList.add('hidden'); return }
    const sum = results[0].status === 'fulfilled' ? results[0].value : null
    let spent = 0, count = 0
    if (sum) sum.forEach(r => { spent += F.toCents(r.expense); count += Number(r.txn_count || 0) })
    const ranks = new Map()
    if (results[1].status === 'fulfilled') results[1].value.rows.forEach(t => {
      if (S.category(t.category_id)) ranks.set(t.category_id, (ranks.get(t.category_id) || 0) + 1)
    })
    const frequent = [...ranks].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => S.category(id))
    const roots = S.rootCategories('expense')
    for (const c of roots) { if (frequent.length >= 5) break; if (!frequent.some(x => x.id === c.id)) frequent.push(c) }
    /* 快捷记账条：一行「今天花了多少」+ 一行常用分类。
       原来「今日卡 216px + 三个工具入口 46px」共 262px，现在压到 ~100px，
       省下来的高度全部让给流水列表（首屏能看到最近的账，这才是记账 App 的刚需）。
       预算 / 报表 / 备份 三个入口移到「我的」页常用组，不占明细页首屏。 */
    target.innerHTML = '<section class="sg-quickbar card" aria-label="快捷记账">' +
      '<button class="qb-today" id="sgToday">' +
      '<span class="qb-k">今天</span>' +
      (sum
        ? '<span class="qb-v num">' + F.money(spent) + '</span><span class="qb-n">支出 · ' + count + ' 笔</span>'
        : '<span class="qb-v qb-off">今日收支暂不可用</span>') +
      icon('arrow-right') + '</button>' +
      '<div class="qb-cats">' +
      frequent.map(c => '<button data-quick-category="' + c.id + '" aria-label="用「' + F.escapeHtml(c.name) + '」记一笔">' +
        '<span class="qb-ic">' + F.escapeHtml(c.icon || '＋') + '</span><span class="qb-lb">' + F.escapeHtml(c.name) + '</span></button>').join('') +
      '<button id="sgMoreEntry" aria-label="更多分类"><span class="qb-ic qb-ic-more">' + icon('plus') + '</span><span class="qb-lb">更多</span></button>' +
      '</div></section>'
    target.querySelectorAll('[data-quick-category]').forEach(b => b.onclick = () => U.openEditor(null, 'expense', { categoryId: Number(b.dataset.quickCategory) }))
    document.getElementById('sgMoreEntry').onclick = () => U.openEditor(null)
    document.getElementById('sgToday').onclick = () => {
      Object.assign(st.filters, { type: '', accountId: null, categoryId: null, keyword: '', tag: '', minAmount: '', maxAmount: '', reimbursable: false })
      Object.assign(st, { year: today.getFullYear(), month: today.getMonth() + 1, scope: 'month', homeView: 'cal', calDay: F.dstr(today) })
      window.App.setTab('home')
    }
  }
  const overview = U.renderOverview
  U.renderOverview = async function (st) {
    const ticket = ++revision
    header(st)
    const target = document.getElementById('productHome')
    if (target && st.tab !== 'home') { target.innerHTML = ''; target.classList.add('hidden') }
    await Promise.all([overview(st), home(st, ticket)])
  }
  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.getElementById('tabbar')
    nav.setAttribute('aria-label', '主导航')
    const icons = { home: 'notebook', stats: 'chart-bar', add: 'plus', assets: 'wallet', me: 'user-circle' }
    nav.querySelectorAll('[data-tab]').forEach(b => {
      b.querySelector('.ic').innerHTML = icon(icons[b.dataset.tab])
      if (b.dataset.tab === 'add') b.insertAdjacentHTML('beforeend', '<span class="sg-nav-add-label">记一笔</span>')
    })
    nav.insertAdjacentHTML('afterbegin', '<div class="sg-sidebar-brand">' + icon('sun') + '<b>拾光记账</b><span>记下生活，花得从容。</span></div>')
    nav.insertAdjacentHTML('beforeend', '<div class="sg-sidebar-foot">随手记录，好好生活。<small>v' + ((window.App && window.App.version) || '—') + ' · 数据由你掌握</small></div>')
    const guest = document.getElementById('guestBtn')
    if (guest) guest.innerHTML = icon('plus') + '开始记账'
    document.querySelectorAll('.auth-logo').forEach(el => { if (el.closest('#authView')) el.innerHTML = icon('sun') })
    document.addEventListener('keydown', e => {
      if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable="true"]')) return
      if (document.getElementById('mainView').classList.contains('hidden') || document.getElementById('sheet').getAttribute('aria-hidden') === 'false') return
      e.preventDefault(); U.openEditor(null)
    })
  })
})()
