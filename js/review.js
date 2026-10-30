/* 待确认队列（懒加载模块）
 *
 * 对标 Copilot Money 的 "Transactions to review"（v4 评审 3.1）。
 *
 * 以前：CSV 导入 / AI 记账确认之后就直接落库，用户不知道这批分类对不对，
 * 于是「导入 200 笔 → 半年后才发现全是未分类」成了最常见的翻车。
 * 现在：这两条路径产生的账目先进「待确认」名单，首页给一条入口，
 * 点进去是卡片流（一屏一笔）：分类对就确认，不对点一下分类芯片就改，
 * 改完的分类写进 `smart.js` 已有的「分类纠正记忆」，下次同类备注自动命中。
 *
 * 数据边界（项目硬约束：不能改表结构、新字段只存 localStorage）：
 *   - 名单按数据来源分开存本机；旧版无归属名单保留但不自动认领
 *   - 确认 = 从名单划掉；改分类 = updateTransaction(category_id)
 *   - 换设备 / 清缓存后名单为空 → 全部视为已确认，不会凭空多出待办
 */
;(function () {
  'use strict'
  const F = window.Fmt
  const S = window.DB
  const U = window.UI
  const $ = U.$
  const $$ = U.$$
  const esc = F.escapeHtml
  const openSheet = U.openSheet
  const closeSheet = U.closeSheet
  const toast = U.toast
  const ic = window.ic || function () { return '' }

  /* 旧版名单没有所属身份，保留但不自动认领，避免串账号。 */
  function identity() {
    const id = S.mode === 'cloud' ? S.state && S.state.uid : S.mode === 'guest' ? S.state && S.state.sourceId : ''
    return id ? 'ledger10_pending_v2:' + encodeURIComponent(JSON.stringify([S.mode, String(id)])) : ''
  }

  function ids() {
    try {
      const key = identity()
      if (!key) return []
      const a = JSON.parse(localStorage.getItem(key) || '[]')
      if (!Array.isArray(a)) throw new Error('invalid')
      return a.filter(x => x != null)
    } catch (e) { throw new Error('读取待确认名单失败，请检查本机存储') }
  }
  function save(list) {
    try {
      const key = identity()
      if (!key) throw new Error('no identity')
      if (!list || !list.length) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(list))
    } catch (e) { throw new Error('保存待确认名单失败，请检查本机存储和当前身份') }
  }

  /* 导入 / AI 记账落库后登记。重复登记不会翻倍 */
  function add(list) {
    const cur = ids()
    const seen = {}
    cur.forEach(x => { seen[String(x)] = 1 })
    ;(list || []).forEach(x => {
      if (x == null) return
      const k = String(x)
      if (seen[k]) return
      seen[k] = 1
      cur.push(x)
    })
    save(cur)
    return cur.length
  }
  function remove(id) {
    const k = String(id)
    save(ids().filter(x => String(x) !== k))
  }
  function clear() { save([]) }
  /* 首页角标用：纯读 localStorage，不查库 */
  function count() { return ids().length }

  /* 批量取回待确认账目；已被删掉 / 已不存在的 id 顺手从名单里剔除 */
  async function list() {
    const owner = identity()
    if (!owner) return []
    const raw = ids()
    if (!raw.length) return []
    const out = []
    const gone = []
    for (let i = 0; i < raw.length; i += 20) {
      const chunk = raw.slice(i, i + 20)
      const got = await Promise.all(chunk.map(async id => {
        try { return { value: await S.getTransaction(id) } } catch (e) { return { failed: true } }
      }))
      if (identity() !== owner) return []
      got.forEach((result, j) => {
        if (result.failed) return
        const t = result.value
        if (t && !t.deleted_at) out.push(t)
        else gone.push(String(chunk[j]))
      })
    }
    if (gone.length) save(ids().filter(x => gone.indexOf(String(x)) < 0))
    /* 口径与明细页一致：发生时间倒序，同刻按 id 倒序 */
    out.sort((a, b) => (new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()) || (b.id - a.id))
    return out
  }

  /* ---------- 卡片流 ---------- */
  let cur = []
  let idx = 0
  let reviewOwner = ''

  const CSS = '<style>' +
    '.rv-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px}' +
    '.rv-bar .rv-left{font-size:13px;color:var(--muted)}' +
    '.rv-bar .rv-left b{color:var(--text);font-size:15px}' +
    '.rv-card{background:var(--bg);border-radius:var(--r-md);padding:16px 14px 12px;margin-bottom:12px;touch-action:pan-y}' +
    '.rv-meta{font-size:12px;color:var(--muted);margin-bottom:6px}' +
    '.rv-amt{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.1;overflow-wrap:anywhere}' +
    '.rv-amt.in{color:var(--up)}' +
    '.rv-note{font-size:15px;margin-top:6px;overflow-wrap:anywhere}' +
    '.rv-catline{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);margin-top:10px}' +
    '.rv-catline b{color:var(--text);font-weight:600}' +
    '.rv-cats{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;max-height:150px;overflow:auto}' +
    '.rv-cats .chip{padding:8px 11px;font-size:13px}' +
    '.rv-hint{font-size:11px;color:var(--muted);margin-top:10px}' +
    '.rv-foot{display:flex;gap:10px;position:sticky;bottom:0;background:var(--card);padding-top:8px}' +
    '.rv-foot .btn{flex:1}' +
    '.rv-sug{font-size:12px;color:var(--brand);margin-top:6px}' +
    '</style>'

  function catChips(t) {
    const kind = t.txn_type === 'income' ? 'income' : 'expense'
    const roots = S.rootCategories(kind) || []
    return roots.map(c =>
      '<button class="chip' + (String(t.category_id) === String(c.id) ? ' on' : '') + '" data-rv-cat="' + c.id + '">' +
      esc(c.icon || '') + ' ' + esc(c.name) + '</button>').join('')
  }

  function suggestion(t) {
    if (t.category_id || !t.note || !window.Smart) return null
    const kind = t.txn_type === 'income' ? 'income' : 'expense'
    try {
      const cid = window.Smart.suggestCategoryFix(t.note, kind)
      if (!cid || !S.category(cid)) return null
      return S.category(cid)
    } catch (e) { return null }
  }

  function cardHtml(t, left) {
    const kind = t.txn_type === 'income' ? 'income' : 'expense'
    const catName = t.category_id ? S.categoryName(t.category_id) : '未分类'
    const accName = S.accountName ? (S.accountName(t.account_id) || '') : ''
    const sign = t.txn_type === 'income' ? '+' : t.txn_type === 'transfer' ? '' : '-'
    const d = String(t.occurred_at || '').slice(0, 10)
    const sug = suggestion(t)
    return '<div class="sheet-head"><span class="sheet-title">待确认</span>' +
      '<button id="rvClose" class="btn sm line">关闭</button></div>' +
      '<div class="rv-bar"><span class="rv-left">还剩 <b>' + left + '</b> 笔</span>' +
      (left > 1 ? '<button class="btn sm ghost" id="rvAll">全部确认</button>' : '') + '</div>' +
      '<div class="rv-card" id="rvCard" data-id="' + t.id + '">' +
        '<div class="rv-meta">' + esc(d) + (accName ? ' · ' + esc(accName) : '') + '</div>' +
        '<div class="rv-amt' + (kind === 'income' ? ' in' : '') + '">' + sign + '¥' + (F.privacy && F.privacy() ? '****' : F.yuan(F.toCents(t.amount))) + '</div>' +
        '<div class="rv-note">' + esc(t.note || catName) + '</div>' +
        '<div class="rv-catline">' + ic('tag') + ' 分类 <b>' + esc(catName) + '</b></div>' +
        (sug ? '<div class="rv-sug">上次同类记成了「' + esc(sug.name) + '」，点一下就能用</div>' : '') +
        '<div class="rv-cats">' + catChips(t) + '</div>' +
        '<div class="rv-hint">点分类直接改 · 右滑确认 · 左滑跳过</div>' +
      '</div>' +
      '<div class="rv-foot">' +
        '<button class="btn ghost" id="rvSkip">跳过</button>' +
        '<button class="btn" id="rvOk">' + ic('check') + ' 确认</button>' +
      '</div>'
  }

  function render() {
    if (idx >= cur.length) { done(); return }
    openSheet(CSS + cardHtml(cur[idx], cur.length - idx))
    bind()
  }

  function bind() {
    const close = $('#rvClose')
    if (close) close.addEventListener('click', () => { closeSheet(); refreshHome() })
    const ok = $('#rvOk')
    if (ok) ok.addEventListener('click', () => confirmCur())
    const sk = $('#rvSkip')
    if (sk) sk.addEventListener('click', () => { idx++; render() })
    const all = $('#rvAll')
    if (all) all.addEventListener('click', () => confirmAll())
    $$('#sheet [data-rv-cat]').forEach(b => b.addEventListener('click', () => pickCat(b.getAttribute('data-rv-cat'))))
    bindSwipe()
  }

  /* 右滑确认 / 左滑跳过（手机上比按钮顺手；桌面端照样能点按钮） */
  function bindSwipe() {
    const card = $('#rvCard')
    if (!card) return
    let x0 = null
    let y0 = null
    card.addEventListener('touchstart', e => {
      const t = e.touches && e.touches[0]
      if (!t) return
      x0 = t.clientX
      y0 = t.clientY
    }, { passive: true })
    card.addEventListener('touchend', e => {
      if (x0 == null) return
      const t = e.changedTouches && e.changedTouches[0]
      const dx = t ? t.clientX - x0 : 0
      const dy = t ? t.clientY - y0 : 0
      x0 = null
      if (Math.abs(dx) < 56 || Math.abs(dy) > Math.abs(dx)) return
      if (dx > 0) confirmCur()
      else { idx++; render() }
    }, { passive: true })
  }

  async function pickCat(cid) {
    if (!reviewOwner || identity() !== reviewOwner) { toast('账号或账本已切换，请重新打开待确认'); closeSheet(); return }
    const t = cur[idx]
    if (!t || cid == null) return
    const id = Number(cid)
    if (String(t.category_id) === String(id)) return
    try {
      /* 带上读到的 updated_at 做乐观锁：另一台设备刚改过这条时提示冲突，
         而不是悄悄把它覆盖掉（与 smart.js 批量回刷同口径） */
      await S.updateTransaction(t.id, { category_id: id }, t.updated_at)
    } catch (e) { toast(e && e.code === 'CONFLICT' ? '这条刚被其他设备改过，请刷新后重试' : (e.message || '改分类失败，请重试')); return }
    if (identity() !== reviewOwner) return
    t.category_id = id
    /* 复用 smart.js 的「分类纠正记忆」：下次同类备注直接命中 */
    try {
      if (window.Smart && window.Smart.learnCategoryFix) {
        window.Smart.learnCategoryFix(t.note, id, { kind: t.txn_type === 'income' ? 'income' : 'expense' })
      }
    } catch (e) { /* 忽略 */ }
    toast('已改成「' + S.categoryName(id) + '」')
    render()
  }

  function confirmCur() {
    if (!reviewOwner || identity() !== reviewOwner) { toast('账号或账本已切换，请重新打开待确认'); closeSheet(); return }
    const t = cur[idx]
    try { if (t) remove(t.id) } catch (e) { toast(e.message); return }
    idx++
    render()
  }

  async function confirmAll() {
    if (!reviewOwner || identity() !== reviewOwner) { toast('账号或账本已切换，请重新打开待确认'); closeSheet(); return }
    /* 只确认「已经看过」的（含刚跳过的）：没翻到的卡片留在队列里，
       不能替用户把没看过的一键清空 */
    const seen = cur.slice(0, idx + 1)
    if (!seen.length) { done(); return }
    let left
    try {
      const seenIds = new Set(seen.map(t => String(t.id)))
      const remaining = ids().filter(id => !seenIds.has(String(id)))
      save(remaining)
      left = remaining.length
    } catch (e) { toast(e.message); return }
    closeSheet()
    toast('已确认 ' + seen.length + ' 笔' + (left ? '，还剩 ' + left + ' 笔待确认' : ''))
    refreshHome()
  }

  function done() {
    closeSheet()
    toast(cur.length ? '这批都过完了' : '没有待确认的账目')
    refreshHome()
  }

  function refreshHome() {
    try { if (window.App && window.App.refresh) window.App.refresh() } catch (e) { /* 忽略 */ }
  }

  function openReview() {
    const owner = identity()
    if (!owner) { toast('无法确认当前身份，请重新进入账本'); return Promise.resolve() }
    /* smart.js 也是懒加载：分类纠正记忆要用到它，先确保到位再出卡片 */
    return window.Lazy.need('smart')
      .then(() => list())
      .then(rows => {
        if (identity() !== owner) return
        reviewOwner = owner
        cur = rows
        idx = 0
        if (!cur.length) { toast(count() ? '待确认账目暂时无法读取，请检查网络后重试' : '没有待确认的账目'); refreshHome(); return }
        render()
      }).catch(e => { toast(e.message || '读取待确认名单失败') })
  }

  window.Review = {
    add, remove, clear, count, ids, list, openReview,
  }
})()

