/* 游客模式数据层：接口与云端 Store 完全镜像，数据存 IndexedDB，图片存 Blob */
window.GuestStore = (function () {
  const idb = window.Idb
  const F = window.Fmt

  const state = { uid: 'guest', accounts: [], categories: [], budgets: [], books: [], goals: [], bookId: null, ready: false }

  function unwrap(v) { return v }

  /* ---------- 交易行内存缓存 ----------
     统计页一屏要跑 4~5 次聚合，每次都得 idb.getAll 一遍，3000 笔就是 15ms/次。
     真正的计算只要 1ms 左右，瓶颈全在重复读盘。这里缓存原始行，
     任何写入（新增/修改/软删/恢复/清空/导入）立即失效。
     行数超过 2 万就不缓存，避免大账本吃内存。 */
  const CACHE_MAX = 20000
  let txnCache = null
  function invalidateTxnCache() { txnCache = null }
  async function allTxns() {
    if (txnCache) return txnCache
    const rows = await idb.all('transactions')
    if (rows.length <= CACHE_MAX) txnCache = rows
    return rows
  }

  async function init() {
    state.uid = 'guest'
    invalidateTxnCache()
    const [a, c, b, bk, g] = await Promise.all([
      idb.all('accounts'), idb.all('categories'), idb.all('budgets'), idb.all('books'), idb.all('goals'),
    ])
    state.accounts = a || []
    state.categories = c || []
    state.budgets = b || []
    state.books = bk || []
    state.goals = g || []
    await ensureDefaultBook()
    state.ready = true
  }

  /* ---------- 多账本 ---------- */
  async function ensureDefaultBook() {
    if (state.books.length) return state.books[0]
    const row = { name: '日常账本', icon: '📒', sort_order: 0, created_at: F.iso(new Date()) }
    row.id = await idb.add('books', row)
    state.books.push(row)
    return row
  }
  function books() { return state.books.slice().sort((x, y) => (x.sort_order - y.sort_order) || (x.id - y.id)) }
  function activeBookId() { return state.bookId }
  function defaultBookId() { return state.books.length ? books()[0].id : null }
  function currentBookId() { return state.bookId || defaultBookId() }
  function setActiveBook(id) { state.bookId = id || null }
  function bookName(id) {
    const b = state.books.find(x => x.id === id)
    return b ? b.name : ''
  }
  async function addBook(b) {
    b.created_at = F.iso(new Date())
    b.id = await idb.add('books', b)
    state.books.push(b)
    return b
  }
  async function renameBook(id, patch) {
    const b = state.books.find(x => x.id === id)
    if (b) { Object.assign(b, patch); await idb.put('books', b) }
  }
  /* 删除账本：其下数据转移到剩余的第一个账本。
     转移后复核四张子表不再有挂在旧账本下的行，有任何残留即中止删除 ——
     宁可让用户重试，也不能删了账本让预算/账目变成谁都看不见的孤儿。 */
  async function deleteBook(id) {
    if (state.books.length <= 1) throw new Error('至少保留一个账本')
    const target = state.books.find(b => b.id !== id)
    if (!target) throw new Error('至少保留一个账本')
    const move = async (store) => {
      const rows = await idb.all(store)
      for (const r of rows) {
        if (r.book_id === id) { r.book_id = target.id; await idb.put(store, r) }
      }
    }
    await move('transactions')
    await move('budgets')
    await move('recurring')
    await move('goals')
    const leftovers = [
      (await idb.all('transactions')).some(r => r.book_id === id),
      (await idb.all('budgets')).some(r => r.book_id === id),
      (await idb.all('recurring')).some(r => r.book_id === id),
      (await idb.all('goals')).some(r => r.book_id === id),
    ].some(Boolean)
    if (leftovers) throw new Error('账本下还有数据未能转移，已中止删除，请重试')
    await idb.del('books', id)
    state.books = state.books.filter(x => x.id !== id)
    state.budgets = await idb.all('budgets')
    state.goals = await idb.all('goals')
    if (state.bookId === id) state.bookId = null
  }

  /* ---------- 攒钱目标 ---------- */
  function listGoals() {
    if (state.bookId == null) return state.goals
    return state.goals.filter(g => g.book_id === state.bookId)
  }
  async function addGoal(g) {
    g.book_id = g.book_id || currentBookId()
    g.created_at = F.iso(new Date())
    g.id = await idb.add('goals', g)
    state.goals.push(g)
    return g
  }
  async function updateGoal(id, patch) {
    const g = state.goals.find(x => x.id === id)
    if (g) { Object.assign(g, patch); await idb.put('goals', g) }
  }
  async function deleteGoal(id) {
    await idb.del('goals', id)
    state.goals = state.goals.filter(x => x.id !== id)
  }
  /* 存入/取出：delta 为元，可正可负。baseSaved 是调用时刻的余额快照，
     云端侧用它做「值没变才写」的条件更新实现幂等重试；游客侧本机写入无重试，直接用当前值。 */
  async function goalDeposit(id, delta, baseSaved) {
    const g = state.goals.find(x => x.id === id)
    if (!g) throw new Error('目标不存在')
    const base = baseSaved != null ? Number(baseSaved) : Number(g.saved_amount)
    const next = Math.max(0, base + Number(delta))
    await updateGoal(id, { saved_amount: next, done: next >= Number(g.target_amount) })
    return next
  }

  async function seedPresets() {
    const accRows = window.PRESET_ACCOUNTS.map((a, i) => ({
      name: a.name, kind: a.kind, icon: a.icon, color: a.color, initial_balance: 0,
      currency: 'CNY', sort_order: i, archived: false, created_at: F.iso(new Date()),
    }))
    for (const r of accRows) r.id = await idb.add('accounts', r)

    let order = 0
    const parentId = {}
    for (const kind of ['expense', 'income']) {
      for (const p of window.PRESET_CATEGORIES[kind]) {
        const row = { name: p.name, kind, parent_id: null, icon: p.icon, color: p.color, sort_order: order++, created_at: F.iso(new Date()) }
        row.id = await idb.add('categories', row)
        parentId[kind + ':' + p.name] = row.id
      }
    }
    for (const kind of ['expense', 'income']) {
      for (const p of window.PRESET_CATEGORIES[kind]) {
        for (const c of (p.children || [])) {
          const row = { name: c, kind, parent_id: parentId[kind + ':' + p.name], icon: p.icon, color: p.color, sort_order: order++, created_at: F.iso(new Date()) }
          await idb.add('categories', row)
        }
      }
    }
    await init()
    return true
  }

  /* ---------- 账户 / 分类 ---------- */
  function accounts() { return state.accounts.filter(a => !a.archived).sort((x, y) => (x.sort_order - y.sort_order) || (x.id - y.id)) }
  function allAccounts() { return state.accounts }
  function accountName(id) {
    const a = state.accounts.find(x => x.id === id)
    return a ? a.name : '已删除'
  }
  function category(id) { return state.categories.find(x => x.id === id) || null }
  function categoryName(id) {
    const c = category(id)
    if (!c) return '未分类'
    if (c.parent_id) {
      const p = category(c.parent_id)
      return p ? p.name + ' · ' + c.name : c.name
    }
    return c.name
  }
  function rootCategories(kind) { return state.categories.filter(c => c.kind === kind && !c.parent_id).sort((x, y) => x.sort_order - y.sort_order) }
  function childCategories(pid) { return state.categories.filter(c => c.parent_id === pid) }

  async function addAccount(a) {
    a.created_at = F.iso(new Date())
    a.id = await idb.add('accounts', a)
    state.accounts.push(a)
    return a
  }
  async function updateAccount(id, patch) {
    const a = state.accounts.find(x => x.id === id)
    if (a) { Object.assign(a, patch); await idb.put('accounts', a) }
  }
  async function deleteAccount(id) {
    await idb.del('accounts', id)
    state.accounts = state.accounts.filter(x => x.id !== id)
  }

  async function addCategory(c) {
    c.created_at = F.iso(new Date())
    c.id = await idb.add('categories', c)
    state.categories.push(c)
    return c
  }
  async function deleteCategory(id) {
    await idb.del('categories', id)
    state.categories = state.categories.filter(x => x.id !== id)
  }

  /* ---------- 交易 ---------- */
  /* 关键词命中：备注 / 分类名 / 账户名 / 金额（P1-4）。
     语义要和云端 buildTxnQuery 保持一致，否则同一句话在游客与登录态搜出不同结果。 */
  function kwHit(t, keyword) {
    const kw = String(keyword || '').trim()
    if (!kw) return true
    const low = kw.toLowerCase()
    if (String(t.note || '').toLowerCase().indexOf(low) >= 0) return true
    const cat = state.categories.find(c => c.id === t.category_id)
    if (cat && String(cat.name || '').toLowerCase().indexOf(low) >= 0) return true
    const accs = state.accounts.filter(a => a.id === t.account_id || a.id === t.to_account_id)
    if (accs.some(a => String(a.name || '').toLowerCase().indexOf(low) >= 0)) return true
    const amt = Number(kw.replace(/[¥￥,，\s]/g, ''))
    if (isFinite(amt) && amt > 0 && Math.abs(Number(t.amount) - amt) < 0.005) return true
    return false
  }

  async function listTransactions(opt) {
    const o = opt || {}
    let rows = await allTxns()
    const from = o.from ? new Date(o.from).getTime() : -Infinity
    const to = o.to ? new Date(o.to).getTime() : Infinity
    rows = rows.filter(t => {
      if (t.deleted_at) {
        if (o.includeDeleted !== 'deleted' && o.includeDeleted !== true) return false
      } else if (o.includeDeleted === 'deleted') {
        return false
      }
      const ts = new Date(t.occurred_at).getTime()
      if (ts < from || ts >= to) return false
      if (state.bookId != null && !o.ignoreBook && t.book_id !== state.bookId) return false
      if (o.type && t.txn_type !== o.type) return false
      if (o.reimbursable && !t.reimbursable) return false
      if (o.accountId && t.account_id !== o.accountId && t.to_account_id !== o.accountId) return false
      if (o.categoryId && t.category_id !== o.categoryId) return false
      if (o.keyword && !kwHit(t, o.keyword)) return false
      if (o.tag && (t.tags || []).indexOf(o.tag) < 0) return false
      if (o.minAmount != null && o.minAmount !== '' && Number(t.amount) < Number(o.minAmount)) return false
      if (o.maxAmount != null && o.maxAmount !== '' && Number(t.amount) > Number(o.maxAmount)) return false
      return true
    })
    /* 排序键只解析一次：原来比较函数里每次 new Date()，3000 笔要解析近 7 万次 */
    const keyed = rows.map(t => [new Date(t.occurred_at).getTime(), t])
    keyed.sort((a, b) => (b[0] - a[0]) || (b[1].id - a[1].id))
    rows = keyed.map(x => x[1])
    const total = rows.length
    const limit = o.limit || 200
    const offset = o.offset || 0
    return { rows: rows.slice(offset, offset + limit), total }
  }

  /* 聚合专用：不排序、不切片，直接拿原始行（月度/分类汇总只需要逐行累加） */
  async function rawRows() {
    const all = await allTxns()
    return all.filter(t => !t.deleted_at && (state.bookId == null || t.book_id === state.bookId))
  }

  async function getTransaction(id) { return idb.get('transactions', id) }

  async function addTransaction(t) {
    t.created_at = F.iso(new Date())
    t.updated_at = t.created_at
    t.reimbursable = !!t.reimbursable
    t.tags = t.tags || []
    if (t.book_id == null) t.book_id = currentBookId()
    t.id = await idb.add('transactions', t)
    invalidateTxnCache()
    return t
  }

  async function updateTransaction(id, patch) {
    const t = await idb.get('transactions', id)
    if (!t) return null
    Object.assign(t, patch, { updated_at: F.iso(new Date()) })
    await idb.put('transactions', t)
    invalidateTxnCache()
    return t
  }

  async function deleteTransaction(id) {
    /* 软删除：仅标记 deleted_at，附件保留，可进回收站恢复 */
    const t = await idb.get('transactions', id)
    if (t) { t.deleted_at = F.iso(new Date()); t.updated_at = t.deleted_at; await idb.put('transactions', t) }
    invalidateTxnCache()
    return true
  }

  /* 回收站：恢复 / 彻底删除 */
  async function restoreTransaction(id) {
    const t = await idb.get('transactions', id)
    if (t) { t.deleted_at = null; await idb.put('transactions', t) }
    invalidateTxnCache()
    return true
  }
  async function purgeTransaction(id) {
    const meta = await attMeta()
    const atts = meta.filter(a => a.transaction_id === id)
    for (const a of atts) await idb.del('attachments', a.id)
    await idb.del('transactions', id)
    invalidateTxnCache()
    invalidateAttCache()
    return true
  }

  /* ---------- 记账模板 ---------- */
  async function listTemplates() {
    const all = await idb.all('templates')
    return all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
  async function addTemplate(t) {
    const row = {
      name: t.name, txn_type: t.txn_type, amount: t.amount != null ? t.amount : null,
      account_id: t.account_id || null, to_account_id: t.to_account_id || null,
      category_id: t.category_id || null, note: t.note || '', tags: t.tags || [],
      book_id: t.book_id || null, created_at: F.iso(new Date()),
    }
    row.id = await idb.add('templates', row)
    return row
  }
  async function updateTemplate(id, patch) {
    const r = await idb.get('templates', id)
    if (r) { Object.assign(r, patch); await idb.put('templates', r) }
  }
  async function deleteTemplate(id) { await idb.del('templates', id) }

  /* ---------- 附件（Blob 存本机） ----------
     元数据常驻内存缓存，Blob 按需取：旧实现每次列表/统计都 getAll('attachments')，
     几百 MB 照片整个读进内存只为拿 file_name/size_bytes。这里只在会话首次读全表，
     之后增删时同步维护缓存；图片真正要显示时才按 id 取 Blob（见 imageUrl）。 */
  let attCache = null
  function invalidateAttCache() { attCache = null }
  async function attMeta() {
    if (attCache) return attCache
    const all = await idb.all('attachments')
    attCache = all.map(a => ({
      id: a.id, transaction_id: a.transaction_id, file_name: a.file_name || '',
      size_bytes: Number(a.size_bytes) || 0, content_type: a.content_type || '', created_at: a.created_at || '',
    }))
    return attCache
  }

  async function listAttachments(txnIds) {
    if (!txnIds || !txnIds.length) return {}
    const meta = await attMeta()
    const map = {}
    meta.forEach(a => {
      if (txnIds.indexOf(a.transaction_id) < 0) return
      ;(map[a.transaction_id] = map[a.transaction_id] || []).push(a)
    })
    Object.keys(map).forEach(k => map[k].sort((x, y) => x.id - y.id))
    return map
  }

  async function addAttachments(txnId, files) {
    const out = []
    for (const f of files) {
      const row = {
        transaction_id: txnId,
        blob: f.blob,
        file_name: f.name || '',
        size_bytes: f.size || (f.blob ? f.blob.size : 0),
        content_type: f.type || (f.blob ? f.blob.type : 'image/jpeg'),
        created_at: F.iso(new Date()),
      }
      row.id = await idb.add('attachments', row)
      out.push(row)
      invalidateAttCache()
    }
    return out
  }

  async function removeAttachment(id) {
    await idb.del('attachments', id)
    invalidateAttCache()
  }

  async function uploadImage(file) {
    const blob = await window.Store.compressImage(file)
    return { blob, size: blob.size, name: file.name || 'photo.jpg', type: blob.type || 'image/jpeg' }
  }

  /* 文件柜（v1.15）：不挂账的文档用 transaction_id = null 存同一张表，不改表结构。
     返回元数据行（不含 Blob），预览走 imageUrl 懒取。 */
  async function listAllAttachments() {
    const meta = await attMeta()
    return meta.slice().sort((x, y) => x.id - y.id)
  }

  /* 通用文件上传：图片压成 JPEG，PDF/文档按原样存 */
  async function uploadFile(file) {
    if (/^image\//.test(file.type || '')) return uploadImage(file)
    return { blob: file, size: file.size, name: file.name || 'file', type: file.type || 'application/octet-stream' }
  }

  const urlCache = new Map()
  async function imageUrl(att) {
    if (!att) return ''
    if (att.blob) {
      let url = urlCache.get(att.id)
      if (!url) { url = URL.createObjectURL(att.blob); urlCache.set(att.id, url) }
      return url
    }
    /* 元数据行（listAttachments 现在只回元数据）：按 id 懒取 Blob 再生成地址。
       urlCache 按附件 id 缓存，重复渲染不会生成新地址，也不会泄漏。 */
    let url = urlCache.get(att.id)
    if (url) return url
    const row = await idb.get('attachments', att.id)
    if (row && row.blob) { url = URL.createObjectURL(row.blob); urlCache.set(att.id, url) }
    return url || ''
  }

  /* ---------- 统计（本地聚合，返回与云端 RPC 同形） ---------- */
  /* 多币种：交易金额以「所属账户的币种」记录，跨账户汇总前先折算到基准币种 */
  function curMap() {
    const m = {}
    allAccounts().forEach(a => { m[a.id] = a.currency || 'CNY' })
    return m
  }
  function baseCents(cents, accId, map) {
    const code = (map || curMap())[accId] || 'CNY'
    return F.toBase(cents, code)
  }
  async function monthlySummary(from, to) {
    const rows = await rawRows()
    const f = from ? new Date(from).getTime() : -Infinity
    const t2 = to ? new Date(to).getTime() : Infinity
    const map = curMap()
    const byMonth = {}
    rows.forEach(t => {
      const ts = new Date(t.occurred_at).getTime()
      if (ts < f || ts >= t2) return
      const key = F.monthKey(new Date(t.occurred_at))
      byMonth[key] = byMonth[key] || { month_key: key, income: 0, expense: 0, txn_count: 0 }
      const amt = baseCents(F.toCents(t.amount), t.account_id, map) / 100
      if (t.txn_type === 'income') byMonth[key].income += amt
      else if (t.txn_type === 'expense') byMonth[key].expense += amt
      byMonth[key].txn_count++
    })
    return Object.values(byMonth).sort((a, b) => a.month_key < b.month_key ? -1 : 1)
  }

  async function categorySummary(from, to, kind) {
    const rows = await rawRows()
    const f = from ? new Date(from).getTime() : -Infinity
    const t2 = to ? new Date(to).getTime() : Infinity
    const map = curMap()
    const byCat = {}
    rows.forEach(t => {
      if (t.txn_type !== kind) return
      const ts = new Date(t.occurred_at).getTime()
      if (ts < f || ts >= t2) return
      const key = t.category_id || 0
      byCat[key] = byCat[key] || { category_id: t.category_id, total: 0, txn_count: 0 }
      byCat[key].total += baseCents(F.toCents(t.amount), t.account_id, map) / 100
      byCat[key].txn_count++
    })
    return Object.values(byCat).sort((a, b) => b.total - a.total)
  }

  /* ---------- 预算 ---------- */
  function budgetOf(monthKey, categoryId) {
    const list = state.budgets.filter(x => x.month_key === monthKey && (x.category_id || 0) === (categoryId || 0) &&
      (state.bookId == null || (x.book_id || defaultBookId()) === state.bookId))
    if (!list.length) return null
    return list.reduce((s, b) => s + Number(b.amount), 0)
  }
  async function setBudget(monthKey, categoryId, amount) {
    const bookId = currentBookId()
    const existing = state.budgets.find(x =>
      x.month_key === monthKey && (x.category_id || 0) === (categoryId || 0) &&
      (x.book_id || 0) === (bookId || 0))
    if (existing) {
      const updated = Object.assign({}, existing, { amount })
      await idb.put('budgets', updated)
      Object.assign(existing, updated)
    } else {
      const row = { month_key: monthKey, category_id: categoryId || null, amount, book_id: bookId, created_at: F.iso(new Date()) }
      row.id = await idb.add('budgets', row)
      state.budgets.push(row)
    }
  }

  async function accountBalances() {
    const rows = (await allTxns()).filter(t => !t.deleted_at)
    const delta = {}
    const add = (id, v) => { if (id != null) delta[id] = (delta[id] || 0) + v }
    rows.forEach(t => {
      const cents = F.toCents(t.amount)
      if (t.txn_type === 'income') add(t.account_id, cents)
      else if (t.txn_type === 'expense') add(t.account_id, -cents)
      else if (t.txn_type === 'transfer') { add(t.account_id, -cents); add(t.to_account_id, cents) }
    })
    return allAccounts().map(a => ({ account: a, balance: F.toCents(a.initial_balance) + (delta[a.id] || 0) }))
  }

  async function storageUsage() {
    /* count() 只数条数不取值；大小从元数据缓存累加。
       旧实现 getAll 会把全部照片 Blob 读进内存，只为累加 size_bytes。 */
    const n = await idb.count('attachments')
    const meta = await attMeta()
    let total = 0
    meta.forEach(r => { total += Number(r.size_bytes) || 0 })
    return { count: n, bytes: total }
  }

  /* ---------- 周期记账 ---------- */
  async function listRecurring() {
    const all = await idb.all('recurring')
    if (state.bookId == null) return all
    return all.filter(r => r.book_id === state.bookId)
  }
  async function addRecurring(rule) {
    rule.created_at = F.iso(new Date())
    if (rule.book_id == null) rule.book_id = currentBookId()
    rule.id = await idb.add('recurring', rule)
    return rule
  }
  async function updateRecurring(id, patch) {
    const r = await idb.get('recurring', id)
    if (r) { Object.assign(r, patch); await idb.put('recurring', r) }
    return r
  }
  async function deleteRecurring(id) { await idb.del('recurring', id) }

  /* 待补记清单（只读预演，不写库）：供启动时先弹确认再决定补不补 */
  async function pendingRecurring(nowDate) {
    const rules = await listRecurring()
    const today = F.dstr(nowDate || new Date())
    const out = []
    for (const r of rules) {
      if (!r.active) continue
      const startDay = String(r.start_date).slice(0, 10)
      let cursor = F.nextDue(r.last_run_date || null, startDay, r.freq)
      const dates = []
      let guard = 0
      while (cursor && cursor <= today && guard < 24) {
        if (cursor >= startDay) dates.push(cursor)
        cursor = F.nextDue(cursor, startDay, r.freq)
        guard++
      }
      if (dates.length) out.push({ id: r.id, note: r.note || '', amount: Number(r.amount), txn_type: r.txn_type, dates: dates })
    }
    return out
  }

  /* 周期补记的防重标记：`_op:rec:<规则id>:<日期>`。同一天补的账永远带同一个标记，
     补记中断后再跑（或游客数据迁移到一半重试）都能据此跳过已落库的日期，
     不会出现同一笔补两次。 */
  function recOpTag(ruleId, day) { return '_op:rec:' + ruleId + ':' + day }

  async function applyRecurring(nowDate) {
    const rules = await listRecurring()
    let generated = 0
    const today = F.dstr(nowDate || new Date())
    /* 一次取全量做标记查重，避免循环里反复全表扫 */
    const allTagged = (await allTxns()).map(t => (Array.isArray(t.tags) ? t.tags : []))
    for (const r of rules) {
      if (!r.active) continue
      const startDay = String(r.start_date).slice(0, 10)
      let cursor = F.nextDue(r.last_run_date || null, startDay, r.freq)
      let guard = 0
      while (cursor && cursor <= today && guard < 24) {
        if (cursor >= startDay) {
          const opTag = recOpTag(r.id, cursor)
          const exists = allTagged.some(tags => tags.indexOf(opTag) >= 0)
          r.last_run_date = cursor
          if (exists) { cursor = F.nextDue(cursor, startDay, r.freq); guard++; continue }
          const d = parseDay(cursor)
          d.setHours(12, 0, 0, 0)
          /* auto 标记写在 tags 里（不改表结构），明细里显示「自动」并可批量撤销 */
          const tags = (Array.isArray(r.tags) ? r.tags.slice() : [])
          if (tags.indexOf('auto') < 0) tags.push('auto')
          tags.push(opTag)
          await addTransaction({
            txn_type: r.txn_type, amount: Number(r.amount), occurred_at: F.iso(d),
            account_id: r.account_id, to_account_id: r.to_account_id || null,
            category_id: r.category_id || null, note: r.note || '', tags: tags, reimbursable: !!r.reimbursable,
            book_id: r.book_id || currentBookId(),
          })
          allTagged.push(tags)
          generated++
          /* 每补一笔就推进水位并落盘：中断后已补的日期不会被重复补 */
          await idb.put('recurring', r)
        }
        cursor = F.nextDue(cursor, startDay, r.freq)
        guard++
      }
      if (r.last_run_date) await idb.put('recurring', r)
    }
    return generated
  }

  function parseDay(s) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
    return new Date(+m[1], +m[2] - 1, +m[3])
  }

  /* ---------- 导出 / 迁移 ---------- */
  async function exportAll() {
    const { rows } = await listTransactions({ limit: 100000 })
    const atts = await listAttachments(rows.map(r => r.id))
    return rows.map(r => {
      const c = r.category_id ? category(r.category_id) : null
      return {
        id: r.id, date: F.isoLocal(r.occurred_at), type: r.txn_type, amount: r.amount,
        book: r.book_id ? bookName(r.book_id) : '',
        account: r.account_id ? accountName(r.account_id) : '',
        toAccount: r.to_account_id ? accountName(r.to_account_id) : '',
        category: c ? (c.parent_id ? categoryName(c.parent_id) + '/' + c.name : c.name) : '',
        note: r.note || '',
        /* 内部幂等标记不导出：`_ord:<交易单号>` / `_op:…` 是内部字段，出现在 CSV 标签列会污染用户数据 */
        tags: (r.tags || []).filter(t => String(t).slice(0, 5) !== '_ord:' && String(t).slice(0, 4) !== '_op:').join(' '),
        reimbursable: r.reimbursable ? 1 : 0,
        images: (atts[r.id] || []).length,
      }
    })
  }

  /* 净资产月度序列（分） */
  async function netWorthSeries(months) {
    const n = months || 12
    const { rows } = await listTransactions({ limit: 100000, ignoreBook: true })
    const now = new Date()
    const map = curMap()
    const initial = allAccounts().reduce((s, a) => s + baseCents(F.toCents(a.initial_balance), a.id, map), 0)
    const byMonth = {}
    rows.forEach(t => {
      const key = F.monthKey(new Date(t.occurred_at))
      const c = baseCents(F.toCents(t.amount), t.account_id, map)
      if (!byMonth[key]) byMonth[key] = 0
      if (t.txn_type === 'income') byMonth[key] += c
      else if (t.txn_type === 'expense') byMonth[key] -= c
    })
    let cum = initial
    const firstD = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1)
    const firstKey = F.monthKey(firstD)
    Object.keys(byMonth).forEach(k => { if (k < firstKey) cum += byMonth[k] })
    const points = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      cum += byMonth[F.monthKey(d)] || 0
      points.push({ label: (d.getMonth() + 1) + '月', value: cum })
    }
    return points
  }

  async function dump() {
    return {
      accounts: await idb.all('accounts'),
      categories: await idb.all('categories'),
      transactions: await idb.all('transactions'),
      attachments: await idb.all('attachments'),
      budgets: await idb.all('budgets'),
      recurring: await idb.all('recurring'),
      books: await idb.all('books'),
      goals: await idb.all('goals'),
      templates: await idb.all('templates'),
    }
  }

  async function hasData() {
    /* 只看账目和分类会漏判「只建了账本/目标/预算还没记账」的新用户，
       迁移前判空时会把这些人误当成空账本 */
    const [t, c, bk, g, b] = await Promise.all([
      idb.all('transactions'), idb.all('categories'), idb.all('books'), idb.all('goals'), idb.all('budgets'),
    ])
    return !!(t && t.length) || !!(c && c.length) || !!(bk && bk.length > 1) ||
      !!(g && g.length) || !!(b && b.length)
  }

  async function wipe() {
    invalidateTxnCache()
    invalidateAttCache()
    urlCache.forEach(url => { try { URL.revokeObjectURL(url) } catch (e) { /* 忽略 */ } })
    urlCache.clear()
    return idb.destroy()
  }

  /* JSON 备份：图片 Blob 转 dataUrl 内联，单文件可携带全部数据 */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
  }
  async function backup() {
    const dumpData = await dump()
    for (const a of dumpData.attachments) {
      if (a.blob) {
        try { a.dataUrl = await blobToDataUrl(a.blob) } catch (e) { /* 跳过损坏图片 */ }
        delete a.blob
      }
    }
    return { app: 'ledger10', version: 2, exportedAt: F.iso(new Date()), data: dumpData }
  }

  /* JSON 恢复（P0 修复）：不再「先毁库再写回」。
     所有 store 的清空+写回放进同一个 IndexedDB 事务（idb.replaceAll），
     任一步失败整体回滚 —— 恢复前的本机数据原样保留，绝不出现半恢复状态。 */
  async function restore(payload) {
    const data = payload && payload.data ? payload.data : payload
    if (!data || !Array.isArray(data.transactions)) throw new Error('备份文件格式不正确')
    /* dataUrl → Blob 必须在事务外完成（事务内不能 await） */
    const atts = []
    for (const a of (data.attachments || [])) {
      if (a.dataUrl) {
        try { a.blob = await (await fetch(a.dataUrl)).blob() } catch (e) { a.blob = null }
        delete a.dataUrl
      }
      atts.push(a)
    }
    await idb.replaceAll({
      books: data.books,
      accounts: data.accounts,
      categories: data.categories,
      budgets: data.budgets,
      recurring: data.recurring,
      goals: data.goals,
      templates: data.templates,
      transactions: data.transactions,
      attachments: atts,
    })
    invalidateTxnCache()
    invalidateAttCache()
    urlCache.forEach(url => { try { URL.revokeObjectURL(url) } catch (e) { /* 忽略 */ } })
    urlCache.clear()
    await init()
    return { txns: (data.transactions || []).length }
  }

  return {
    state, init, seedPresets,
    accounts, allAccounts, accountName, categoryName, category, rootCategories, childCategories, listAllAttachments, uploadFile,
    addAccount, updateAccount, deleteAccount, addCategory, deleteCategory,
    listTransactions, getTransaction, addTransaction, updateTransaction, deleteTransaction,
    restoreTransaction, purgeTransaction, listTemplates, addTemplate, updateTemplate, deleteTemplate,
    listAttachments, addAttachments, removeAttachment, uploadImage, imageUrl,
    monthlySummary, categorySummary, budgetOf, setBudget,
    accountBalances, storageUsage, exportAll, netWorthSeries,
    listRecurring, addRecurring, updateRecurring, deleteRecurring, applyRecurring, pendingRecurring,
    books, activeBookId, currentBookId, defaultBookId, setActiveBook, bookName,
    addBook, renameBook, deleteBook, ensureDefaultBook,
    listGoals, addGoal, updateGoal, deleteGoal, goalDeposit,
    dump, hasData, wipe, backup, restore,
  }
})()
