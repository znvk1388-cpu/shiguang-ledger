/* 应用入口：登录门禁、状态管理、导航与事件绑定 */
window.App = (function () {
  const UI = window.UI
  const S = window.DB
  const F = window.Fmt
  const $ = UI.$
  const $$ = UI.$$

  const now = new Date()
  const VERSION = '1.18.6'
  const state = {
    /* 运行容器：true 表示页面被微信小程序的 <web-view> 承载。
       小程序的 web-view 里没有地址栏、PWA 安装无意义、OAuth 跳转会被拦截，
       所以这个标记决定了一批入口的显示与交互方式。 */
    inMiniProgram: false,
    tab: 'home',
    scope: 'month',
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    statRange: 'month',
    filters: { type: '', accountId: null, categoryId: null, keyword: '', tag: '', minAmount: '', maxAmount: '', reimbursable: false },
    filterOpen: false,
    homeView: 'list',   /* list | cal */
    calDay: null,
    pageSize: 100,
    loaded: 100,        /* 当前已请求的条数（「加载更多」会逐步增大） */
    txns: [],
    total: 0,
    attachments: {},
  }

  /* ---------- 隐私模式（钱迹式）：一键隐藏所有金额 ---------- */
  function privacyOn() {
    try { return localStorage.getItem('ledger10_privacy') === '1' } catch (e) { return false }
  }
  /* P1-12：进入应用前的隐私确认（登录页勾选即同意）。
     同意写入 localStorage；老用户已同意过则会被整行隐藏，不会二次打扰。
     P0-4（终审）：未勾选时行内红字报错（role=alert）+ 勾选框描红，不再用离场一米的底部 toast。 */
  function consentOk() {
    if (!UI.needConsent()) return true
    const chk = $('#consentChk')
    if (chk && chk.checked) {
      UI.markConsent()
      const err = $('#consentErr'); if (err) { err.hidden = true; err.textContent = '' }
      const row = $('#authConsent'); if (row) row.classList.remove('err')
      return true
    }
    const row = $('#authConsent')
    if (row) { row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake'); row.classList.add('err') }
    const err = $('#consentErr')
    if (err) { err.hidden = false; err.textContent = '请先阅读并同意《用户隐私保护指引》与《用户协议》' }
    return false
  }
  function applyPrivacy() {
    document.body.classList.toggle('privacy', privacyOn())
    const btn = $('#privacyBtn')
    if (btn) btn.innerHTML = privacyOn() ? ic('eye-off') : ic('eye')
  }

  /* ---------- 深色模式（手动 / 跟随系统） ---------- */
  function themeMode() {
    try {
      const m = localStorage.getItem('ledger10_theme')
      return (m === 'light' || m === 'dark' || m === 'auto') ? m : 'auto'
    } catch (e) { return 'auto' }
  }
  function applyTheme() {
    const m = themeMode()
    const dark = m === 'dark' || (m === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    /* 同步移动端浏览器地址栏配色 */
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#121419' : '#f5f6fa')
  }
  function setThemeMode(m) {
    try { localStorage.setItem('ledger10_theme', m) } catch (e) { /* 忽略 */ }
    applyTheme()
  }

  /* ---------- 界面偏好：字号大小 / 支出收入配色 ---------- */
  function uiSettings() {
    const def = { scale: 'normal', palette: 'bright' }
    try {
      const raw = localStorage.getItem('ledger10_ui')
      if (!raw) return def
      const v = JSON.parse(raw) || {}
      return {
        scale: (v.scale === 'compact' || v.scale === 'large') ? v.scale : 'normal',
        palette: v.palette === 'colorblind' ? 'colorblind' : 'bright',
      }
    } catch (e) { return def }
  }
  function applyUi() {
    const u = uiSettings()
    document.documentElement.dataset.ui = u.scale
    document.documentElement.dataset.palette = u.palette
  }
  function setUiSettings(patch) {
    const next = Object.assign(uiSettings(), patch || {})
    try { localStorage.setItem('ledger10_ui', JSON.stringify(next)) } catch (e) { /* 忽略 */ }
    applyUi()
  }

  /* ---------- 首次进入时的初始化：默认规则 + 自动预算 ---------- */
  /* 自动预算依赖 js/wealth.js（已改为懒加载），所以这里不 await，
     改成「空闲时再补」，避免把 wealth 拉回首屏关键路径。 */
  function later(fn, ms) {
    try {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: ms || 4000 })
      else setTimeout(fn, Math.min(ms || 4000, 1200))
    } catch (e) { setTimeout(fn, 1200) }
  }

  async function applyAutoBudgetLater() {
    try {
      const W = window.Lazy ? await window.Lazy.need('wealth') : null
      if (!W) return
      const made = await W.applyAutoBudget()
      if (made > 0) UI.toast('已按自动预算规则生成本期额度')
    } catch (e) { /* 忽略 */ }
  }

  /* 终审：smart.js 已移出首屏（6.9KB gz），这里不 await 它，避免拖慢首屏 */
  function seedExtras() {
    Lazy.need('smart').then(m => {
      const n = m ? m.seedDefaultRules() : 0
      if (n > 0) UI.toast('已准备 ' + n + ' 条自动归类规则，可随时修改')
    }).catch(() => { /* 忽略 */ })
    later(applyAutoBudgetLater, 4000)
  }

  /* ---------- 周期账目补记 ----------
     补记会产生用户没有亲手录入的账目，必须先说清楚补什么再补。
     预演（pendingRecurring）只读，确认后才 applyRecurring。 */
  async function runRecurring() {
    try {
      const pend = await S.pendingRecurring(new Date())
      if (!pend.length) return
      const total = pend.reduce((s, p) => s + p.dates.length, 0)
      const lines = pend.slice(0, 3).map(p => {
        const nm = p.note || window.TXN_TYPE_LABEL[p.txn_type] || '周期账目'
        return '· ' + nm + ' ¥' + F.yuan(p.amount) + ' × ' + p.dates.length + ' 笔（' + p.dates[0] + ' 起）'
      })
      if (pend.length > 3) lines.push('· 另有 ' + (pend.length - 3) + ' 条规则')
      const ok = confirm('有 ' + total + ' 笔到期的周期账目待补记：\n\n' + lines.join('\n') +
        '\n\n补记出来的账目带「自动」标记，可在明细里一键撤销。')
      if (!ok) return
      const gen = await S.applyRecurring(new Date())
      if (gen > 0) { UI.toast('已补记 ' + gen + ' 笔周期账目'); await refresh() }
    } catch (e) { /* 忽略：周期记账失败不影响主流程 */ }
  }

  /* 等首屏落定再问，避免和记账弹层抢浮层 */
  function queueRecurring() {
    later(() => {
      try {
        if (document.body.classList.contains('sheet-open')) return
      } catch (e) { /* 忽略 */ }
      runRecurring()
      /* 攒钱目标的「每月自动存入」：静默补，不弹确认（只改进度，不动账户余额） */
      try {
        if (UI.applyGoalAuto) UI.applyGoalAuto().then(n => { if (n) refresh() }).catch(() => {})
      } catch (e) { /* 忽略 */ }
    }, 3000)
  }

  /* ---------- 应用锁（本机便捷锁，防的是身边人随手翻手机） ---------- */
  const LOCK_KEY = 'ledger10_lock'
  const LOCK_ATTEMPT_KEY = 'ledger10_lock_attempts'
  /* 新配置一律用 PBKDF2 慢哈希 + 随机盐存储；旧的常数盐单轮哈希仅用于
     验证老配置（升级后首次成功解锁时自动迁移成 PBKDF2）。4 位 PIN 的穷举
     空间本来就只有 10⁴，再叠加连续失败退避，离线暴力试码不再可行。 */
  const PBKDF2_ITER = 150000

  function lockConfig() {
    try {
      const v = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null')
      if (v && v.on === true && v.hash) return { on: true, hash: String(v.hash) }
    } catch (e) { /* 忽略 */ }
    return { on: false, hash: '' }
  }

  function b64(bytes) {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  }
  function unb64(str) {
    const s = atob(str)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }

  async function pbkdf2Hash(pin, saltBytes, iterations) {
    const enc = new TextEncoder()
    const key = await window.crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
    const bits = await window.crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iterations },
      key, 256)
    return new Uint8Array(bits)
  }
  /* 存储格式：pbkdf2-<轮次>-<盐b64>-<哈希b64> */
  async function makePbkdf2PinHash(pin) {
    try {
      if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return null
      const salt = window.crypto.getRandomValues(new Uint8Array(16))
      const bits = await pbkdf2Hash(pin, salt, PBKDF2_ITER)
      return 'pbkdf2-' + PBKDF2_ITER + '-' + b64(salt) + '-' + b64(bits)
    } catch (e) { return null }
  }
  async function recomputePbkdf2(pin, stored) {
    try {
      const parts = String(stored).split('-')
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') return null
      const iter = Number(parts[1])
      if (!(iter > 0) || iter > 2000000) return null
      const bits = await pbkdf2Hash(pin, unb64(parts[2]), iter)
      return 'pbkdf2-' + parts[1] + '-' + parts[2] + '-' + b64(bits)
    } catch (e) { return null }
  }

  /* FNV-1a：非安全上下文（crypto.subtle 不可用）时的降级散列 */
  function fnv(s) {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return 'fnv' + h.toString(16)
  }
  /* 同时给出两种算法的结果：换环境（http/https）打开时也能对上 */
  async function candidateHashes(pin) {
    const salt = 'ledger10|' + pin
    const out = [fnv(salt)]
    try {
      if (window.crypto && window.crypto.subtle && window.TextEncoder) {
        const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt))
        out.push('sha256-' + Array.prototype.map.call(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join(''))
      }
    } catch (e) { /* 降级到 fnv */ }
    return out
  }
  async function hashPin(pin) {
    const pb = await makePbkdf2PinHash(pin)
    if (pb) return pb
    const list = await candidateHashes(pin)
    return list[list.length - 1]
  }
  async function enableLock(pin) {
    const hash = await hashPin(pin)
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ on: true, hash: hash })) } catch (e) { /* 忽略 */ }
    return hash
  }
  function disableLock() {
    try { localStorage.removeItem(LOCK_KEY) } catch (e) { /* 忽略 */ }
    try { localStorage.removeItem(LOCK_ATTEMPT_KEY) } catch (e) { /* 忽略 */ }
  }
  /* 连续失败退避：5 次后开始锁 1 分钟，之后每次翻倍，封顶 15 分钟 */
  function attemptState() {
    try {
      const v = JSON.parse(localStorage.getItem(LOCK_ATTEMPT_KEY) || 'null')
      if (v && typeof v.n === 'number' && typeof v.until === 'number') return v
    } catch (e) { /* 忽略 */ }
    return { n: 0, until: 0 }
  }
  function saveAttemptState(v) {
    try { localStorage.setItem(LOCK_ATTEMPT_KEY, JSON.stringify(v)) } catch (e) { /* 忽略 */ }
  }
  function lockoutRemainMs() {
    const v = attemptState()
    return v.until > Date.now() ? (v.until - Date.now()) : 0
  }
  function registerFail() {
    const v = attemptState()
    v.n = (v.n || 0) + 1
    if (v.n >= 5) {
      const sec = Math.min(900, 60 * Math.pow(2, v.n - 5))
      v.until = Date.now() + sec * 1000
    }
    saveAttemptState(v)
  }
  function registerSuccess() {
    try { localStorage.removeItem(LOCK_ATTEMPT_KEY) } catch (e) { /* 忽略 */ }
  }
  async function verifyPin(pin) {
    const cfg = lockConfig()
    if (!cfg.on) return true
    const h = String(cfg.hash)
    if (h.slice(0, 7) === 'pbkdf2-') {
      const recomputed = await recomputePbkdf2(pin, h)
      return !!recomputed && recomputed === h
    }
    const cands = await candidateHashes(pin)
    const ok = cands.indexOf(h) >= 0
    /* 老配置首次验证通过后顺手迁移到 PBKDF2（有 crypto.subtle 才做） */
    if (ok) {
      const upgraded = await makePbkdf2PinHash(pin)
      if (upgraded) {
        try { localStorage.setItem(LOCK_KEY, JSON.stringify({ on: true, hash: upgraded })) } catch (e) { /* 忽略 */ }
      }
    }
    return ok
  }

  /* 锁屏：返回一个 Promise，解锁后 resolve(true) */
  function requireUnlock() {
    return new Promise(resolve => {
      const cfg = lockConfig()
      if (!cfg.on) { resolve(true); return }
      const view = $('#lockView')
      const inp = $('#lockPin')
      const err = $('#lockErr')
      const btn = $('#lockSubmit')
      const forget = $('#lockForget')
      view.classList.remove('hidden')
      $('#authView').classList.add('hidden')
      $('#mainView').classList.add('hidden')
      inp.value = ''
      err.textContent = ''
      setTimeout(() => { try { inp.focus() } catch (e) { /* 忽略 */ } }, 60)

      let settled = false
      function finish(okv) {
        if (settled) return
        settled = true
        btn.removeEventListener('click', onSubmit)
        inp.removeEventListener('keydown', onKey)
        forget.removeEventListener('click', onForget)
        view.classList.add('hidden')
        resolve(okv)
      }
      let busy = false
      async function onSubmit() {
        if (busy) return
        /* 连续失败退避：把「4 位 PIN 离线穷举」的性价比打掉 */
        const remain = lockoutRemainMs()
        if (remain > 0) {
          err.textContent = '失败次数过多，请 ' + Math.ceil(remain / 60000) + ' 分钟后再试'
          return
        }
        const pin = (inp.value || '').trim()
        if (!/^\d{4}$/.test(pin)) { err.textContent = '请输入 4 位数字'; return }
        busy = true
        const good = await verifyPin(pin)
        busy = false
        if (!good) {
          registerFail()
          const next = lockoutRemainMs()
          err.textContent = next > 0
            ? 'PIN 不正确，请 ' + Math.ceil(next / 60000) + ' 分钟后再试'
            : 'PIN 不正确'
          inp.value = ''
          try { inp.focus() } catch (e) { /* 忽略 */ }
          return
        }
        registerSuccess()
        finish(true)
      }
      function onKey(e) { if (e.key === 'Enter') onSubmit() }
      function onForget() {
        if (!confirm('清除应用锁？\n\n这是本机的便捷锁，清除后任何人都能打开本 App；账目数据不会被删除。')) return
        disableLock()
        finish(true)
      }
      btn.addEventListener('click', onSubmit)
      inp.addEventListener('keydown', onKey)
      forget.addEventListener('click', onForget)
    })
  }

  /* ---------- 账本按钮 ---------- */
  function renderBookBtn() {
    const el = $('#bookBtnName')
    if (!el) return
    const id = window.DB.activeBookId()
    el.textContent = id == null ? '全部' : (window.DB.bookName(id) || '账本')
  }

  /* ---------- 渲染 ---------- */
  async function renderOverview() {
    try { await UI.renderOverview(state) } catch (e) { /* 概览失败不影响列表 */ }
  }

  async function renderGuestBanner() {
    const el = $('#guestBanner')
    if (!el) return
    if (window.DB.mode !== 'guest') { el.innerHTML = ''; return }
    /* 终审 P1（3.1）：空账本连「尚未备份」也推迟到有数据之后 —— 空的账本没什么可丢，
      这时候提示备份只会制造焦虑 */
    if (await UI.ledgerEmpty()) { el.innerHTML = ''; return }
    let backed = ''
    try { backed = localStorage.getItem('ledger10_bk1') || '' } catch (e) { /* 忽略 */ }
    /* 明细页首屏寸土寸金：只有「还没备份过」时才留一行 28px 提示，
       备份过一次就永久收起（备份入口固定在「我的 · 数据与安全」里）。
       统计 / 资产 / 我的 页不再重复这条提示。 */
    if (backed || state.tab !== 'home') { el.innerHTML = ''; return }
    el.innerHTML = '<div class="slim-note"><span>本机账本 · 尚未备份</span>' +
      '<button id="bannerBackup">备份</button><button id="bannerBind">登录同步</button></div>'
    $('#bannerBind').addEventListener('click', () => backToAuth())
    $('#bannerBackup').addEventListener('click', () => UI.openBackupSheet())
  }

  async function renderTab() {
    /* 每次切换 Tab / 刷新都回到第一页；「加载更多」只增大 loaded 后局部重绘 */
    state.loaded = state.pageSize
    $('#periodTitle').innerHTML = '<span class="period-title">' + UI.periodTitle(state) + '</span>'
    $('#scopeBtn').textContent = state.scope === 'month' ? '月' : state.scope === 'year' ? '年' : '全部'
    /* 统计页有自己的「本月 / 本年 / 十年」分段，顶部期间栏会变成第二套时间控件
       （P1-2：两套控件各自维护状态，用户不知道该信哪个）。这里只保留账本与隐私按钮。 */
    const pb = document.querySelector('.period-bar')
    if (pb) pb.classList.toggle('only-actions', state.tab === 'stats' || state.tab === 'assets' || state.tab === 'me')
    try {
      if (state.tab === 'home') await UI.renderHome(state)
      else if (state.tab === 'stats') await UI.renderStats(state)
      else if (state.tab === 'assets') await UI.renderAssets(state)
      else if (state.tab === 'me') await UI.renderMe(state)
    } catch (e) {
      $('#content').innerHTML = '<div class="empty"><div class="big">' + ic('alert') + '</div>' +
        F.escapeHtml(e.message || '加载失败') +
        '<div class="small" style="margin-top:6px">可能是网络波动，重试一下</div>' +
        '<button class="btn sm line" id="tabRetry" style="margin-top:12px">重新加载</button></div>'
      const rt = $('#tabRetry')
      if (rt) rt.addEventListener('click', () => refresh())
    }
    bindContentEvents()
    syncShellLayout()
  }

  /* 宽屏双栏开关：有概览卡才启用左栏（否则左栏会留白）。
     顺便把「本月预算执行」这类汇总卡片也挪到左栏 —— 它是概览性质的内容，
     放在 420px 宽的窄栏里反而比横跨 700px 更好读；移动端再挪回来。
     挪动 DOM 节点不会丢事件监听（不是 clone），所以 bindBudgetCard 依然有效。 */
  function syncShellLayout() {
    const shell = document.querySelector('.shell')
    const ov = document.getElementById('overview')
    const content = document.getElementById('content')
    if (!shell || !ov || !content) return
    let wide = false
    try { wide = window.matchMedia('(min-width: 1080px)').matches } catch (e) { wide = false }
    const inContent = content.querySelector(':scope > .budget-card')
    const inRail = ov.querySelector(':scope > .budget-card')
    if (wide && inContent) ov.appendChild(inContent)
    else if (!wide && inRail) content.insertBefore(inRail, content.firstChild)
    shell.classList.toggle('has-aside', ov.children.length > 0)
  }

  let shellResizeTimer = 0
  function onShellResize() {
    clearTimeout(shellResizeTimer)
    shellResizeTimer = setTimeout(syncShellLayout, 120)
  }

  function refresh() {
    try { if (UI.invalidateReimb) UI.invalidateReimb() } catch (e) { /* 忽略 */ }
    renderBookBtn()
    applyPrivacy()
    /* renderGuestBanner 现在是 async（空账本门控要查库），并入同一条等待链，
       避免竞态：等 refresh 完成时提示行必须已经渲染到位 */
    const p = Promise.all([renderGuestBanner(), renderOverview(), renderTab()])
    /* 数据变了就把摘要同步给小程序宿主页（不在小程序里则直接返回） */
    p.then(() => { syncShellLayout(); notifyShareInfo() }).catch(() => { /* 忽略 */ })
    return p
  }

  /* 同一元素只绑一次：renderStats 等会自行重绘并再次触发绑定，
     没有这个保护会让「筛选」这类取反开关被触发两次而看似失效 */
  function bindOnce(el, evt, fn) {
    const key = '__bound_' + evt
    if (el[key]) return
    el[key] = true
    el.addEventListener(evt, fn)
  }

  function bindContentEvents() {
    $$('#content [data-ftype]').forEach(b => {
      bindOnce(b, 'click', () => {
        state.filters.type = b.getAttribute('data-ftype')
        renderTab()
      })
    })
    $$('#content [data-facc]').forEach(b => {
      bindOnce(b, 'click', () => {
        const v = b.getAttribute('data-facc')
        state.filters.accountId = v ? Number(v) : null
        renderTab()
      })
    })
    $$('#content [data-freim]').forEach(b => {
      bindOnce(b, 'click', () => {
        state.filters.reimbursable = !state.filters.reimbursable
        renderTab()
      })
    })
    $$('#content [data-fpanel]').forEach(b => {
      bindOnce(b, 'click', () => {
        state.filterOpen = !state.filterOpen
        renderTab()
      })
    })
    /* 统计页的分类排行 / 环形图图例：点击跳到明细并按该分类筛选 */
    const jumpCat = (id) => {
      state.filters.categoryId = id
      state.filters.type = 'expense'
      state.calDay = null
      /* 从统计页跳明细一定要落到「列表」视图，否则若首页停在日历上会看不到该分类的流水 */
      state.homeView = 'list'
      if (state.statRange === 'year') state.scope = 'year'
      else if (state.statRange === 'month') state.scope = 'month'
      setTab('home')
      UI.toast('已按「' + S.categoryName(id) + '」筛选明细')
    }
    $$('#content [data-cat]').forEach(el => {
      bindOnce(el, 'click', () => jumpCat(Number(el.getAttribute('data-cat'))))
      bindOnce(el, 'keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpCat(Number(el.getAttribute('data-cat'))) }
      })
    })
    /* v4 缺陷 4：饼图「扇区 ↔ 图例」互相高亮。14 类共用一套短色板时，
       相邻扇区同色系、图例又对不上号，用户只能靠猜；现在鼠标指到哪一条，
       扇环和图例同时亮起来，颜色不用记。 */
    const donutHL = (box, idx, on) => {
      if (!box || idx == null) return
      box.classList.toggle('has-hl', !!on)
      $$('[data-arc]', box).forEach(el => {
        el.classList.toggle('arc-hl', on && el.getAttribute('data-arc') === String(idx))
      })
    }
    ;[document.getElementById('content'), document.getElementById('sheet')].forEach(root => {
      if (!root) return
      bindOnce(root, 'mouseover', e => {
        const t = e.target && e.target.closest ? e.target.closest('[data-arc]') : null
        if (t) donutHL(t.closest('.donut-box'), t.getAttribute('data-arc'), true)
      })
      bindOnce(root, 'mouseout', e => {
        const t = e.target && e.target.closest ? e.target.closest('[data-arc]') : null
        if (t) donutHL(t.closest('.donut-box'), t.getAttribute('data-arc'), false)
      })
    })
    $$('#content [data-fcatclear]').forEach(b => {
      bindOnce(b, 'click', () => {
        state.filters.categoryId = null
        renderTab()
      })
    })
    const fApply = $('#fApply')
    if (fApply) {
      bindOnce(fApply, 'click', () => {
        state.filters.minAmount = ($('#fMinAmt') || {}).value || ''
        state.filters.maxAmount = ($('#fMaxAmt') || {}).value || ''
        state.filters.tag = (($('#fTag') || {}).value || '').trim()
        renderTab()
      })
    }
    const fClear = $('#fClear')
    if (fClear) {
      bindOnce(fClear, 'click', () => {
        state.filters.minAmount = ''
        state.filters.maxAmount = ''
        state.filters.tag = ''
        renderTab()
      })
    }
    $$('#content [data-hv]').forEach(b => {
      bindOnce(b, 'click', () => {
        const next = b.getAttribute('data-hv')
        if (next === state.homeView) return
        state.homeView = next
        /* 切换后把列表容器滚到视口顶部（P1-3）：原来内容在屏幕外换了，
           眼前什么都没变，用户以为「点了没反应」 */
        Promise.resolve(renderTab()).then(() => {
          const c = document.getElementById('content')
          if (!c) return
          const y = Math.max(0, c.getBoundingClientRect().top + window.scrollY - 8)
          try { window.scrollTo({ top: y, behavior: 'smooth' }) } catch (e) { window.scrollTo(0, y) }
        })
      })
    })
    $$('#content [data-month]').forEach(b => {
      bindOnce(b, 'click', () => {
        const mm = b.getAttribute('data-month').split('-')
        state.year = Number(mm[0])
        state.month = Number(mm[1])
        state.scope = 'month'
        state.calDay = null
        setTab('home')
      })
    })
    const more = $('#loadMore')
    if (more) {
      bindOnce(more, 'click', async () => {
        more.disabled = true
        more.textContent = '加载中…'
        await UI.loadMore(state)
      })
    }
    const kw = $('#kwInput')
    if (kw) {
      let timer = null
      let composing = false
      /* 中文输入法适配：composition 期间（拼音还没上屏）不触发搜索重绘，
         否则打字到一半列表就重排、光标被重置，输入被打断 */
      bindOnce(kw, 'compositionstart', () => { composing = true })
      bindOnce(kw, 'compositionend', () => {
        composing = false
        kw.dispatchEvent(new Event('input'))
      })
      bindOnce(kw, 'input', () => {
        if (composing) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          state.filters.keyword = kw.value.trim()
          if (state.tab === 'home') {
            const focused = document.activeElement === kw
            const pos = kw.selectionStart
            UI.renderHome(state).then(() => {
              bindContentEvents()
              const next = $('#kwInput')
              if (focused && next) { next.focus({ preventScroll: true }); try { next.setSelectionRange(pos, pos) } catch (e) {} }
            })
          }
        }, 380)
      })
    }
  }

  function setTab(tab) {
    if (tab === 'add') {
      UI.openEditor(null)
      return
    }
    state.tab = tab
    $$('#tabbar .tab').forEach(b => b.classList.toggle('on', b.getAttribute('data-tab') === tab))
    refresh()
  }

  function shiftPeriod(delta) {
    if (state.scope === 'month') {
      let m = state.month + delta
      let y = state.year
      while (m < 1) { m += 12; y-- }
      while (m > 12) { m -= 12; y++ }
      state.year = y
      state.month = m
    } else if (state.scope === 'year') {
      state.year += delta
    }
    refresh()
  }

  /* ---------- 登录 ---------- */
  function showAuth() {
    /* 首屏兜底骨架（index.html 里的 3 秒看门狗）可以撤了 —— 已经有内容可见 */
    if (window.__sgBootClear) window.__sgBootClear()
    $('#authView').classList.remove('hidden')
    $('#mainView').classList.add('hidden')
    /* 首屏脚注：把「数据属于你」这句话和版本号放在第一屏最底下 */
    const af = $('#authFoot')
    if (af) af.textContent = '本机存储 · 可导出备份 · v' + VERSION
    /* 退出登录后停掉自动拉取，别让轮询在登录页空转 */
    if (window.Sync && window.Sync.stopAuto) window.Sync.stopAuto()
  }

  function showMain() {
    /* 首屏兜底骨架（index.html 里的 3 秒看门狗）可以撤了 —— 已经有内容可见 */
    if (window.__sgBootClear) window.__sgBootClear()
    $('#authView').classList.add('hidden')
    $('#mainView').classList.remove('hidden')
  }

  let sendTimer = null
  function countdown(btn, sec) {
    let left = sec
    btn.disabled = true
    btn.textContent = left + 's 后重发'
    clearInterval(sendTimer)
    sendTimer = setInterval(() => {
      left--
      if (left <= 0) {
        clearInterval(sendTimer)
        btn.disabled = false
        btn.textContent = '获取验证码'
      } else {
        btn.textContent = left + 's 后重发'
      }
    }, 1000)
  }

  function bindAuth() {
    /* 欢迎页登录卡默认折叠（P1-11）：点标题才展开登录表单 */
    const authTitle = $('#authTitle')
    const authForm = $('#authForm')
    const toggleAuth = () => {
      if (!authForm) return
      authForm.classList.toggle('collapsed')
      if (authTitle) authTitle.setAttribute('aria-expanded', authForm.classList.contains('collapsed') ? 'false' : 'true')
    }
    if (authTitle) {
      authTitle.addEventListener('click', toggleAuth)
      authTitle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAuth() } })
    }
    /* P1-12：隐私确认行。已同意过的用户直接隐藏这一行 */
    if (!UI.needConsent()) { const cr = $('#authConsent'); if (cr) cr.style.display = 'none' }
    /* P0-4：勾选即清除行内报错 */
    const chk0 = $('#consentChk')
    if (chk0) chk0.addEventListener('change', () => {
      if (!chk0.checked) return
      const err = $('#consentErr'); if (err) { err.hidden = true; err.textContent = '' }
      const row = $('#authConsent'); if (row) row.classList.remove('err')
    })
    const pl = $('#authPrivacyLink'); if (pl) pl.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); UI.openPrivacy() })
    const tl = $('#authTermsLink'); if (tl) tl.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); UI.openTerms() })
    const tabs = $$('#authTabs button')
    tabs.forEach(b => {
      b.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        const t = b.getAttribute('data-tab')
        $('#phonePane').classList.toggle('hidden', t !== 'phone')
        $('#emailPane').classList.toggle('hidden', t !== 'email')
      })
    })

    $('#phoneSend').addEventListener('click', async () => {
      const phone = $('#phoneInput').value.trim()
      $('#phoneErr').textContent = ''
      const r = await window.Cloud.sendPhoneCode(phone)
      if (r.error) { $('#phoneErr').textContent = r.error.message || '发送失败'; return }
      countdown($('#phoneSend'), 60)
      UI.toast('验证码已发送')
    })

    $('#phoneSubmit').addEventListener('click', async () => {
      if (!consentOk()) return
      const btn = $('#phoneSubmit')
      btn.disabled = true
      btn.textContent = '登录中…'
      const r = await window.Cloud.verifyPhoneCode($('#phoneInput').value.trim(), $('#phoneCode').value.trim())
      btn.disabled = false
      btn.textContent = '登录 / 注册'
      if (r.error) { $('#phoneErr').textContent = r.error.message || '登录失败'; return }
      await enterApp(r.session)
    })

    $('#emailSend').addEventListener('click', async () => {
      $('#emailErr').textContent = ''
      const r = await window.Cloud.sendEmailCode($('#emailInput').value.trim())
      if (r.error) { $('#emailErr').textContent = r.error.message || '发送失败'; return }
      countdown($('#emailSend'), 60)
      UI.toast('验证码已发送')
    })

    $('#emailSubmit').addEventListener('click', async () => {
      if (!consentOk()) return
      const btn = $('#emailSubmit')
      btn.disabled = true
      btn.textContent = '登录中…'
      const r = await window.Cloud.verifyEmailCode(
        $('#emailInput').value.trim(),
        $('#emailCode').value.trim(),
        $('#emailPwd').value
      )
      btn.disabled = false
      btn.textContent = '登录 / 注册'
      if (r.error) { $('#emailErr').textContent = r.error.message || '登录失败'; return }
      await enterApp(r.session)
    })

    $('#pwdSubmit').addEventListener('click', async () => {
      if (!consentOk()) return
      $('#pwdErr').textContent = ''
      const r = await window.Cloud.signInWithPassword($('#loginEmail').value.trim(), $('#loginPwd').value)
      if (r.error) { $('#pwdErr').textContent = r.error.message || '邮箱或密码不正确'; return }
      await enterApp(r.session)
    })

    $('#wechatBtn').addEventListener('click', async () => {
      if (!consentOk()) return
      if (state.inMiniProgram) {
        UI.toast('小程序内无法跳转微信授权，请用手机号或邮箱登录')
        return
      }
      const r = await window.Cloud.wechatLogin()
      if (r.error) UI.toast(r.error.message || '微信登录暂不可用')
    })

    $('#guestBtn').addEventListener('click', () => { if (consentOk()) enterGuest() })
  }

  /* ---------- 进入应用 ---------- */
  async function enterGuest() {
    showMain()
    UI.toast('游客模式已开启')
    try {
      await S.useGuest()
      try { localStorage.setItem('ledger10_mode', 'guest') } catch (e) { /* 隐私模式忽略 */ }
      if (!S.state.categories.length || !S.state.accounts.length) {
        await S.seedPresets()
        UI.toast('已为你准备好常用分类和账户')
      }
      await seedExtras()
      await refresh()
      handleQuickAction()
      queueRecurring()
    } catch (e) {
      $('#content').innerHTML = '<div class="empty"><div class="big">' + ic('alert') + '</div>初始化失败：' +
        F.escapeHtml(e.message || '') + '</div>'
    }
  }

  async function enterApp(session) {
    const uid = session && session.user && session.user.id
    if (!uid) { showAuth(); return }
    showMain()
    UI.toast('正在同步云端数据…')
    try {
      /* 游客数据存在则先迁移，图片一起上传。
         注意：迁移**不会**清空本机数据 —— 本机是这份数据的唯一副本，
         清理改为用户在「我的 → 数据与同步」里显式操作。 */
      if (await S.guestHasData()) {
        const ok = confirm('检测到本机有游客账目，要迁移到云端账号吗？\n（账目和凭证图片都会上传；本机副本会保留，确认迁移完整后可再手动清理）')
        if (ok) {
          const r = await S.migrateGuestToCloud(session, m => UI.toast(m))
          if (r.complete) UI.toast('迁移完成：' + r.txns + ' 笔账目、' + r.images + ' 张图片；本机副本已保留')
          else UI.toast('迁移未完成：' + (r.problems || []).join('；') + '。本机数据仍在，可稍后继续')
        } else {
          await S.useCloud(session)
        }
      } else {
        await S.useCloud(session)
      }
      if (!S.state.categories.length || !S.state.accounts.length) {
        await S.seedPresets()
        UI.toast('已为你准备好常用分类和账户')
      }
      try { localStorage.setItem('ledger10_mode', 'cloud') } catch (e) { /* 忽略 */ }
      await seedExtras()
      await refresh()
      handleQuickAction()
      /* 登录态下开启「回到前台就对齐云端」的自动拉取，保证多设备一致 */
      if (window.Sync && window.Sync.startAuto) window.Sync.startAuto()
      queueRecurring()
    } catch (e) {
      $('#content').innerHTML = '<div class="empty"><div class="big">' + ic('alert') + '</div>数据初始化失败：' +
        F.escapeHtml(e.message || '') + '<div class="small" style="margin-top:8px">请下拉刷新重试</div></div>'
    }
  }

  /* PWA 快捷方式 / 系统分享 / 外部 URL scheme（v1.15：把「记一笔」压到一步）
   *
   *   ?action=add|ai|stats|report|budget|review        长按桌面图标出来的快捷方式
   *   ?action=add&amount=28&note=午饭&type=expense&cat=餐饮&date=2026-10-22&tag=工作日
   *                                                    iOS 快捷指令：「嘿 Siri，记一笔」
   *   ?text=…&title=…&url=…                            Android 分享目标：把别处的账单文本
   *                                                    直接丢进 AI 记账
   *
   * 说明：iOS 的快捷指令不能自定义 scheme，只能打开一个 https 链接，所以参数直接挂在
   * 本站链接上（等价于 `shiguang://add?…` 的效果），不需要额外注册协议。
   */
  function handleQuickAction() {
    let q
    try { q = new URLSearchParams(location.search) } catch (e) { return }
    const shared = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join(' ').trim()
    let action = q.get('action') || ''
    if (!action && shared) action = 'ai'
    if (!action) return
    if (action === 'add') {
      const type = q.get('type') === 'income' ? 'income' : q.get('type') === 'transfer' ? 'transfer' : 'expense'
      const preset = { type: type }
      const amt = Number(q.get('amount'))
      if (isFinite(amt) && amt > 0) preset.amount = amt
      if (q.get('note')) preset.note = q.get('note')
      if (q.get('tag')) preset.tags = q.get('tag')
      const d = q.get('date') || ''
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) preset.occurred = d + 'T12:00'
      const catKey = q.get('cat')
      if (catKey) {
        const cats = (window.DB && window.DB.state && window.DB.state.categories) || []
        const hit = cats.find(c => String(c.id) === catKey) ||
          cats.find(c => c.name === catKey && c.kind === type && !c.parent_id)
        if (hit) preset.categoryId = hit.id
      }
      UI.openEditor(null, type, preset)
    }
    else if (action === 'ai') {
      /* smart.js 是懒加载的，冷启动时 window.Smart 还没到，必须先 need 一次 */
      if (window.Lazy) window.Lazy.need('smart').then(m => m && m.openAiSheet(shared))
      else if (window.Smart) window.Smart.openAiSheet(shared)
    }
    else if (action === 'stats') setTab('stats')
    else if (action === 'report') { if (window.Lazy) window.Lazy.need('insight').then(m => m && m.openReportCenter()) }
    else if (action === 'budget') { if (window.Lazy) window.Lazy.need('wealth').then(m => m && m.openBudgetCenter()) }
    else if (action === 'review') { if (window.Lazy) window.Lazy.need('review').then(m => m && m.openReview()) }
  }

  /* 游客返回登录页（数据保留在本机，登录成功后自动提示迁移） */
  function backToAuth() {
    showAuth()
  }

  function bindMain() {
    $$('#tabbar .tab').forEach(b => {
      b.addEventListener('click', () => setTab(b.getAttribute('data-tab')))
    })
    $('#prevBtn').addEventListener('click', () => shiftPeriod(-1))
    $('#nextBtn').addEventListener('click', () => shiftPeriod(1))
    /* 顶部年月标题：打开期间快选（原先是个点了没反应的按钮） */
    const pt = $('#periodTitle')
    if (pt) pt.addEventListener('click', () => UI.openPeriodPicker(state))
    $('#scopeBtn').addEventListener('click', () => {
      state.scope = state.scope === 'month' ? 'year' : state.scope === 'year' ? 'all' : 'month'
      if (state.scope === 'month') {
        const n = new Date()
        state.year = n.getFullYear()
        state.month = n.getMonth() + 1
      }
      state.calDay = null
      refresh()
    })
    $('#mask').addEventListener('click', () => UI.closeSheet())
    $('#bookBtn').addEventListener('click', () => UI.openBookSheet())
    $('#privacyBtn').addEventListener('click', () => {
      try { localStorage.setItem('ledger10_privacy', privacyOn() ? '0' : '1') } catch (e) { /* 忽略 */ }
      applyPrivacy()
      UI.toast(privacyOn() ? '隐私模式已开启：金额已隐藏' : '隐私模式已关闭')
      /* 图表里的金额由渲染层决定是否遮罩，需要重绘一次 */
      refresh()
    })
    /* Esc 关闭任意弹层（记账弹窗自身也监听，重复调用无副作用） */
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return
      const sheet = $('#sheet')
      if (sheet && sheet.classList.contains('on')) UI.closeSheet()
    })
  }

  /* ---------- 添加到主屏幕（PWA 安装） ---------- */
  let deferredInstall = null
  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true
    } catch (e) { return false }
  }
  async function promptInstall() {
    if (!deferredInstall) return false
    try {
      deferredInstall.prompt()
      const r = await deferredInstall.userChoice
      deferredInstall = null
      if (r && r.outcome === 'accepted') UI.toast('已开始安装，请稍候…')
      return true
    } catch (e) { return false }
  }

  /* ---------- 版本更新提示（Service Worker 检测到新版本） ---------- */
  function showUpdateBar(reg) {
    const el = $('#updateBar')
    if (!el || el.getAttribute('data-on') === '1') return
    el.setAttribute('data-on', '1')
    el.innerHTML = '<div class="notice-bar"><span style="font-size:18px">' + ic('sparkles') + '</span>' +
      '<div class="grow">新版本已就绪，刷新即可体验最新功能</div>' +
      '<button class="btn sm" id="updateNow">立即更新</button></div>'
    const btn = $('#updateNow')
    if (btn) btn.addEventListener('click', async () => {
      if (btn.disabled) return
      const workers = navigator.serviceWorker
      const waiting = reg && reg.waiting
      if (!waiting || !workers) { location.reload(); return }
      btn.disabled = true
      btn.textContent = '正在更新…'
      let timer = null
      let reloaded = false
      const cleanup = () => {
        workers.removeEventListener('controllerchange', onChange)
        if (timer != null) clearTimeout(timer)
      }
      const onChange = () => {
        if (reloaded) return
        reloaded = true
        cleanup()
        location.reload()
      }
      try {
        /* 新版本的预缓存必须保留；旧缓存由 worker 激活时按版本清理。
           先监听接管再发消息，避免重载仍由旧 worker 响应。 */
        workers.addEventListener('controllerchange', onChange)
        timer = setTimeout(() => {
          cleanup()
          btn.disabled = false
          btn.textContent = '重试更新'
          UI.toast('更新尚未完成，请稍后重试')
        }, 15000)
        waiting.postMessage({ type: 'SKIP_WAITING' })
      } catch (e) {
        cleanup()
        btn.disabled = false
        btn.textContent = '重试更新'
        UI.toast('暂时无法更新，请稍后重试')
      }
    })
  }

  /* ---------- 全局兜底：脚本异常与离线状态 ---------- */
  /* 技术性报错翻译成用户能懂的话；技术细节不外抛（可从「数据与同步」里拿诊断信息） */
  function humanError(m) {
    const s = String(m || '')
    if (/Failed to fetch|NetworkError|network|fetch failed|ERR_|ECONN|offline/i.test(s)) return '网络不太顺畅，稍后自动重试即可'
    if (/quota|QuotaExceeded/i.test(s)) return '本机存储空间不足，请清理其他页面或删除部分凭证图片'
    if (/CONFLICT/i.test(s)) return '数据刚被其他设备改过，刷新后再试'
    if (/RLS_NO_ROWS/i.test(s)) return '这条记录可能已不存在，请刷新后再试'
    if (/Timeout|timed out/i.test(s)) return '操作超时，请重试'
    return ''
  }
  function bindGlobalSafety() {
    window.addEventListener('error', e => {
      if (!e || !e.message) return
      if (/ResizeObserver|Script error/i.test(e.message)) return
      const h = humanError(e.message)
      UI.toast(h || '出了点小状况，操作没有完成')
    })
    window.addEventListener('unhandledrejection', e => {
      const m = (e && e.reason && (e.reason.message || e.reason)) || ''
      if (/abort|AbortError/i.test(String(m))) return
      if (String(m)) UI.toast(humanError(m) || '操作未完成，请重试')
    })
    window.addEventListener('offline', () => UI.toast('网络已断开，已加载的页面仍可使用'))
    window.addEventListener('online', () => UI.toast('网络已恢复'))
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault()
      deferredInstall = e
    })
    window.addEventListener('appinstalled', () => {
      deferredInstall = null
      UI.toast('已添加到主屏幕', { icon: ic('sparkles') })
    })
  }

  /* ---------- 运行容器适配（微信小程序 web-view / 微信内置浏览器） ---------- */
  function setupContainer() {
    const env = window.Env
    if (!env) return

    const inMp = env.isMiniProgram()
    state.inMiniProgram = inMp
    if (inMp) {
      document.body.classList.add('mp')
      /* 小程序的导航栏由原生控制，页面里的 <title> 不生效 */
      env.setNavigationBarTitle('拾光记账')
    }

    /* web-view 里没有「添加到主屏幕」这回事，入口已在 renderMe 里用 .no-mp 隐藏，
       这里再兜底一次，避免用户从其它路径看到它 */
    const installRow = $('#installBtn')
    if (inMp && installRow) installRow.classList.add('hidden')

    /* 微信登录依赖 OAuth 跳转，小程序 web-view 会拦截这个跳转，
       点了只会白屏。所以直接换成明确说明，并把用户引到可用的方式上。 */
    const wb = $('#wechatBtn')
    if (wb && inMp) {
      wb.textContent = '小程序内请用手机号或邮箱登录'
      wb.disabled = true
      wb.style.opacity = '.6'
      wb.style.cursor = 'default'
    } else if (wb && env.isWechat()) {
      /* 微信内置浏览器（公众号/聊天窗口）里 OAuth 是通的，保持不变 */
      wb.title = '使用微信账号快速登录'
    }

    /* 异步复核一次：UA 误判时纠正（例如安卓部分机型不写 miniProgram 标识） */
    env.detect().then(real => {
      if (real === inMp) return
      state.inMiniProgram = real
      document.body.classList.toggle('mp', real)
      if (real) {
        if (installRow) installRow.classList.add('hidden')
        if (wb) { wb.textContent = '小程序内请用手机号或邮箱登录'; wb.disabled = true; wb.style.opacity = '.6' }
      }
    }).catch(() => { /* 探测失败就按 UA 结论走 */ })
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    applyTheme()
    applyUi()
    setupContainer()
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (themeMode() === 'auto') applyTheme() })
    } catch (e) { /* 不支持则忽略 */ }
    bindAuth()
    bindMain()
    bindGlobalSafety()
    try { window.addEventListener('resize', onShellResize) } catch (e) { /* 忽略 */ }

    /* 应用锁：先解锁，再走后面的登录门禁 */
    if (lockConfig().on) {
      const unlocked = await requireUnlock()
      if (!unlocked) return
    }

    /* 微信回调必须无条件先跑，且早于任何登录门禁 */
    try {
      const cb = await window.Cloud.handleWechatCallback()
      if (cb.session) {
        await enterApp(cb.session)
        return
      }
    } catch (e) { /* 非回调访问，正常继续 */ }

    let session = null
    try {
      session = await window.Cloud.getSession()
    } catch (e) { session = null }

    if (session) {
      await enterApp(session)
    } else {
      let lastMode = ''
      try { lastMode = localStorage.getItem('ledger10_mode') || '' } catch (e) { /* 忽略 */ }
      if (lastMode === 'guest') await enterGuest()
      else showAuth()
    }

    /* 分享链接（#sg=共享码）→ 直接进入「加入共享账本」流程。
       共享模块平时是懒加载的，带 hash 时必须先把模块要出来再解析。 */
    const hasShareHash = /(^|[#&])sg=/.test(location.hash || '')
    if (hasShareHash && window.Lazy) { try { await window.Lazy.need('share') } catch (e) { /* 忽略 */ } }
    if (window.Share && window.Share.handleUrlHash) {
      try { await window.Share.handleUrlHash() } catch (e) { /* 忽略 */ }
    }

    /* 首屏已经画完，趁空闲把「报表 / 共享」两个非关键模块预取回来，
       等用户真正点开时直接从缓存执行，不产生等待感。 */
    if (window.Lazy) window.Lazy.preload()

    try {
      window.Cloud.onAuthChange((event, s) => {
        /* 只有登录态才响应登出事件：游客模式本来就没有 session，
           网络抖动时的误报 SIGNED_OUT 不该把人踢回登录页（实测复现过「刷新后回到欢迎页」） */
        if (event === 'SIGNED_OUT' && window.DB && window.DB.mode === 'cloud') { showAuth() }
      })
    } catch (e) { /* 云 SDK 离线时跳过 */ }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      /* updateViaCache:'none' —— 不让浏览器拿 HTTP 缓存里的旧 sw.js，否则新版 SW 探测被拖慢；
         再主动 reg.update() 问一次有没有新版。两者配合，用户才能及时看到「立即更新」提示条。 */
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        try { if (reg) reg.update() } catch (e) {}
        /* 已有新版本在等待激活时立刻提示 */
        if (reg && reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg)
        if (reg) {
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing
            if (!sw) return
            sw.addEventListener('statechange', () => {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg)
            })
          })
        }
      }).catch(() => { /* 忽略 */ })
    }
  }

  /* boot 的兜底包装：路由过程中任何未捕获异常都不能把用户留在白屏/骨架页。
     有游客模式记录就直接进游客模式（纯本地，不需要网络），否则回登录页。 */
  async function bootSafe() {
    let lastMode = ''
    try { lastMode = localStorage.getItem('ledger10_mode') || '' } catch (e) { /* 忽略 */ }
    try {
      await boot()
    } catch (e) {
      try {
        if (window.__sgBootClear) window.__sgBootClear()
        if (lastMode === 'guest') await enterGuest()
        else showAuth()
      } catch (e2) { /* 实在不行就停在首屏骨架，看门狗会给提示 */ }
    }
  }

  document.addEventListener('DOMContentLoaded', bootSafe)

  /* 把「当前这一个月」的摘要回传给小程序宿主页。
     宿主在 <web-view bindmessage> 里接住并缓存，onShareAppMessage 时就能生成
     带真实数据的分享卡片（如「10 月花了 ¥1,234」）。
     微信只在分享 / 后退 / 组件销毁时才投递消息，所以这里不能当实时通道用。 */
  let lastSharePost = 0
  function notifyShareInfo() {
    const env = window.Env
    if (!env || !state.inMiniProgram || !env.postMessage) return
    const t = Date.now()
    if (t - lastSharePost < 3000) return
    lastSharePost = t
    let expense = 0
    let income = 0
    ;(state.txns || []).forEach(x => {
      const account = S.allAccounts().find(a => a.id === x.account_id)
      const c = F.toBase(F.toCents(x.amount), (account && account.currency) || 'CNY')
      if (x.txn_type === 'expense') expense += c
      else if (x.txn_type === 'income') income += c
    })
    env.postMessage({
      action: 'summary',
      month: state.year + '-' + F.pad2(state.month),
      expense: F.yuan(expense),
      income: F.yuan(income),
      currency: F.baseCurrency(),
      version: VERSION,
    })
  }

  return {
    version: VERSION,
    state, refresh, renderTab, renderOverview, setTab, enterApp, enterGuest, backToAuth, bindContentEvents,
    themeMode, setThemeMode, applyTheme, uiSettings, setUiSettings, applyUi,
    lockConfig, enableLock, disableLock, verifyPin, requireUnlock,
    isStandalone, promptInstall, showUpdateBar, notifyShareInfo,
    inMiniProgram: () => state.inMiniProgram,
  }
})()


