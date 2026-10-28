/* 数据层：所有云端读写集中在这里，UI 只跟 Store 打交道 */
window.Store = (function () {
  const db = () => window.Cloud.cloud.database

  const state = {
    uid: null,
    accounts: [],
    categories: [],
    budgets: [],
    books: [],
    goals: [],
    bookId: null,   /* null = 全部账本 */
    ready: false,
  }

  function unwrap(res) {
    if (res.error) throw res.error
    return res.data
  }

  /* PostgREST 对单次响应有条数上限，`.limit(100000)` 并不等于「取全部」。
     这个常量是我们自己发请求时的分页步长；即使服务端上限比它小，
     fetchAll 也会按「实际返回条数」推进游标，不会漏行。 */
  const PAGE = 1000

  /* 幂等标记：写在 tags 数组里的 `_op:<操作ID>`。
     服务端没有开放改表（无 DDL 工具），所以用行内标记实现
     「同一操作重复提交只落一条」，并且只对带 tags 的表生效。 */
  const OP_TAG = '_op:'
  function opTag(id) { return OP_TAG + id }
  /* 导入幂等标记：`_ord:<交易单号>`。读回时挪到 r._ord，既不打扰用户，
     又让「同一份账单导两次」有据可查（csv.js 的重复检测读这个字段）。 */
  const ORD_TAG = '_ord:'

  /* 读回来的行要把内部标记摘掉，别让它出现在标签栏、导出 CSV 或筛选里 */
  function cleanTags(rows) {
    if (!rows) return rows
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r && Array.isArray(r.tags)) {
        let has = false
        for (let j = 0; j < r.tags.length; j++) {
          const t = r.tags[j]
          if (typeof t === 'string' && (t.slice(0, OP_TAG.length) === OP_TAG || t.slice(0, ORD_TAG.length) === ORD_TAG)) { has = true; break }
        }
        if (has) {
          r.tags = r.tags.filter(t => {
            if (typeof t !== 'string') return true
            if (t.slice(0, ORD_TAG.length) === ORD_TAG) {
              if (!r._ord) r._ord = t.slice(ORD_TAG.length)
              return false
            }
            return t.slice(0, OP_TAG.length) !== OP_TAG
          })
        }
      }
    }
    return rows
  }

  /* 写操作被 RLS 拦下时返回的是空数组而不是 error —— 必须当成失败抛出去，
     否则界面会显示「已保存」而云端其实一行都没动。 */
  function mustAffect(rows, what) {
    if (Array.isArray(rows) && rows.length) return rows
    const e = new Error('云端没有接受这次修改（' + what + '）：记录可能已不存在，或不属于当前账号')
    e.code = 'RLS_NO_ROWS'
    throw e
  }

  async function init(uid) {
    state.uid = uid
    await Promise.all([loadAccounts(), loadCategories(), loadBudgets(), loadBooks(), loadGoals()])
    await ensureDefaultBook()
    state.ready = true
  }

  /* ---------- 多账本 ---------- */
  async function loadBooks() {
    const rows = unwrap(await db().from('books').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true }))
    state.books = rows || []
    return state.books
  }
  async function ensureDefaultBook() {
    if (state.books.length) return state.books[0]
    const rows = unwrap(await db().from('books').insert({ name: '日常账本', icon: '📒', sort_order: 0 }).select())
    await loadBooks()
    return rows && rows[0]
  }
  function books() { return state.books }
  function activeBookId() { return state.bookId }
  function defaultBookId() { return state.books.length ? state.books[0].id : null }
  function currentBookId() { return state.bookId || defaultBookId() }
  function setActiveBook(id) { state.bookId = id || null }
  function bookName(id) {
    const b = state.books.find(x => x.id === id)
    return b ? b.name : ''
  }
  async function addBook(b) {
    const rows = unwrap(await db().from('books').insert(b).select())
    await loadBooks()
    return rows[0]
  }
  async function renameBook(id, patch) {
    mustAffect(unwrap(await db().from('books').update(patch).eq('id', id).select()), '重命名账本')
    await loadBooks()
  }
  /* 删除账本：其下账目/预算/周期/目标转移到剩余的第一个账本。
     P0 修复：旧实现四个 update 不做任何校验，RLS 拦下时返回空数组被静默吞掉，
     随后账本删除成功 → 子行 book_id 悬空，数据在任何账本视图里永久不可见。
     现在搬移后逐表复核「旧账本名下无残留」，有残留即中止删除让用户重试。
     （注意不能直接用 mustAffect 判断 update：目标账本下本来就没有该类数据时，
     返回空数组是合法结果。） */
  async function deleteBook(id) {
    if (state.books.length <= 1) throw new Error('至少保留一个账本')
    const target = state.books.find(b => b.id !== id)
    if (!target) throw new Error('至少保留一个账本')
    const TABLES = ['transactions', 'budgets', 'recurring_rules', 'savings_goals']
    for (const t of TABLES) {
      const res = await db().from(t).update({ book_id: target.id }).eq('book_id', id).select()
      if (res.error) throw res.error
    }
    for (const t of TABLES) {
      const probe = await db().from(t).select('id').eq('book_id', id).limit(1)
      if (probe.error) throw probe.error
      if (probe.data && probe.data.length) {
        throw new Error('账本下还有数据未能转移到「' + (bookName(target.id) || '默认账本') + '」，已中止删除，请重试')
      }
    }
    mustAffect(unwrap(await db().from('books').delete().eq('id', id).select()), '删除账本')
    if (state.bookId === id) state.bookId = null
    await Promise.all([loadBooks(), loadBudgets(), loadGoals()])
  }

  /* ---------- 攒钱目标 ---------- */
  async function loadGoals() {
    const rows = unwrap(await db().from('savings_goals').select('*').order('id', { ascending: true }))
    state.goals = rows || []
    return state.goals
  }
  function listGoals() {
    if (state.bookId == null) return state.goals
    return state.goals.filter(g => g.book_id === state.bookId)
  }
  async function addGoal(g) {
    g.book_id = g.book_id || currentBookId()
    const rows = unwrap(await db().from('savings_goals').insert(g).select())
    await loadGoals()
    return rows[0]
  }
  async function updateGoal(id, patch) {
    mustAffect(unwrap(await db().from('savings_goals').update(patch).eq('id', id).select()), '修改目标')
    await loadGoals()
  }
  async function deleteGoal(id) {
    mustAffect(unwrap(await db().from('savings_goals').delete().eq('id', id).select()), '删除目标')
    await loadGoals()
  }
  /* 存入/取出：delta 为元，可正可负。
     用调用时的余额快照做条件更新。金额相同并不能证明是同一操作：两台设备
     可能恰好各存入相同金额，因此 0 行受影响时一律要求核对，不能误报成功。
     服务端暂没有操作 ID 去重能力，响应丢失后也保守提示「可能已生效」。 */
  async function goalDeposit(id, delta, baseSaved) {
    const g = state.goals.find(x => x.id === id)
    if (!g) throw new Error('目标不存在')
    const base = baseSaved != null ? Number(baseSaved) : Number(g.saved_amount)
    const next = Math.max(0, base + Number(delta))
    const patch = { saved_amount: next, done: next >= Number(g.target_amount) }
    const res = await db().from('savings_goals').update(patch).eq('id', id).eq('saved_amount', base).select()
    if (res.error) throw res.error
    if (res.data && res.data.length) { await loadGoals(); return next }
    const e = new Error('目标余额已变化，本次操作可能已经生效。请先刷新核对余额，再决定是否重新操作')
    e.code = 'CONFLICT'
    throw e
  }

  async function loadAccounts() {
    const rows = unwrap(await db().from('accounts').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true }))
    state.accounts = rows || []
    return state.accounts
  }

  async function loadCategories() {
    const rows = unwrap(await db().from('categories').select('*').order('sort_order', { ascending: true }).order('id', { ascending: true }))
    state.categories = rows || []
    return state.categories
  }

  async function loadBudgets() {
    const rows = unwrap(await db().from('budgets').select('*'))
    state.budgets = rows || []
    return state.budgets
  }

  /* 首次使用：一键写入预设账户 + 两级分类 */
  async function seedPresets() {
    const accRows = window.PRESET_ACCOUNTS.map((a, i) => ({
      name: a.name, kind: a.kind, icon: a.icon, color: a.color, sort_order: i,
    }))
    const inserted = unwrap(await db().from('accounts').insert(accRows).select())
    const accId = {}
    ;(inserted || []).forEach(r => { accId[r.name] = r.id })

    const catRows = []
    let order = 0
    for (const kind of ['expense', 'income']) {
      window.PRESET_CATEGORIES[kind].forEach(p => {
        catRows.push({ name: p.name, kind, icon: p.icon, color: p.color, sort_order: order++ })
      })
    }
    const cats = unwrap(await db().from('categories').insert(catRows).select())
    const parentId = {}
    ;(cats || []).forEach(r => { parentId[r.kind + ':' + r.name] = r.id })

    const childRows = []
    for (const kind of ['expense', 'income']) {
      window.PRESET_CATEGORIES[kind].forEach(p => {
        ;(p.children || []).forEach(c => {
          childRows.push({ name: c, kind, parent_id: parentId[kind + ':' + p.name], icon: p.icon, color: p.color, sort_order: order++ })
        })
      })
    }
    if (childRows.length) await db().from('categories').insert(childRows)

    await Promise.all([loadAccounts(), loadCategories()])
    return true
  }

  /* ---------- 账户 / 分类 ---------- */
  function accounts() { return state.accounts.filter(a => !a.archived) }
  function allAccounts() { return state.accounts }
  function accountName(id) {
    const a = state.accounts.find(x => x.id === id)
    return a ? a.name : '已删除'
  }
  function categoryName(id) {
    const c = state.categories.find(x => x.id === id)
    if (!c) return '未分类'
    if (c.parent_id) {
      const p = state.categories.find(x => x.id === c.parent_id)
      return p ? p.name + ' · ' + c.name : c.name
    }
    return c.name
  }
  function category(id) { return state.categories.find(x => x.id === id) || null }
  function rootCategories(kind) {
    return state.categories.filter(c => c.kind === kind && !c.parent_id)
  }
  function childCategories(parentId) {
    return state.categories.filter(c => c.parent_id === parentId)
  }

  async function addAccount(a) {
    const rows = unwrap(await db().from('accounts').insert(a).select())
    await loadAccounts()
    return rows[0]
  }
  async function updateAccount(id, patch) {
    mustAffect(unwrap(await db().from('accounts').update(patch).eq('id', id).select()), '修改账户')
    await loadAccounts()
  }
  async function deleteAccount(id) {
    mustAffect(unwrap(await db().from('accounts').delete().eq('id', id).select()), '删除账户')
    await loadAccounts()
  }

  async function addCategory(c) {
    const rows = unwrap(await db().from('categories').insert(c).select())
    await loadCategories()
    return rows[0]
  }
  async function deleteCategory(id) {
    mustAffect(unwrap(await db().from('categories').delete().eq('id', id).select()), '删除分类')
    await loadCategories()
  }

  /* ---------- 交易 ---------- */
  function buildTxnQuery(o, count) {
    let q = db().from('transactions').select('*', count ? { count: 'exact' } : undefined)
    if (state.bookId != null && !o.ignoreBook) q = q.eq('book_id', state.bookId)
    if (o.from) q = q.gte('occurred_at', o.from)
    if (o.to) q = q.lt('occurred_at', o.to)
    if (o.type) q = q.eq('txn_type', o.type)
    if (o.reimbursable) q = q.eq('reimbursable', true)
    if (o.accountId) q = q.or('account_id.eq.' + o.accountId + ',to_account_id.eq.' + o.accountId)
    if (o.categoryId) q = q.eq('category_id', o.categoryId)
    /* 搜索不能只搜备注（P1-4）：实测搜「餐饮」「现金」「35」都是 0 条，
       而这三样恰恰是用户最常用的检索维度。这里把关键词同时映射到
       分类 id / 账户 id / 金额（服务端列上没有可搜索的名称，只能先本地解析成 id）。 */
    if (o.keyword) {
      const kw = String(o.keyword).trim()
      if (kw) {
        const safe = kw.replace(/[%,()]/g, '')
        const parts = ['note.ilike.%' + safe + '%']
        const low = kw.toLowerCase()
        const cids = state.categories.filter(c => String(c.name || '').toLowerCase().indexOf(low) >= 0).map(c => c.id)
        if (cids.length) parts.push('category_id.in.(' + cids.join(',') + ')')
        const aids = state.accounts.filter(a => String(a.name || '').toLowerCase().indexOf(low) >= 0).map(a => a.id)
        if (aids.length) parts.push('account_id.in.(' + aids.join(',') + ')')
        const amt = Number(kw.replace(/[¥￥,，\s]/g, ''))
        if (isFinite(amt) && amt > 0) parts.push('amount.eq.' + amt)
        q = q.or(parts.join(','))
      }
    }
    if (o.tag) q = q.contains('tags', [o.tag])
    if (o.minAmount != null && o.minAmount !== '') q = q.gte('amount', o.minAmount)
    if (o.maxAmount != null && o.maxAmount !== '') q = q.lte('amount', o.maxAmount)
    if (o.includeDeleted === 'deleted') q = q.not('deleted_at', 'is', null)
    else if (!o.includeDeleted) q = q.is('deleted_at', null)
    return q.order('occurred_at', { ascending: false }).order('id', { ascending: false })
  }

  async function listPage(o, limit, offset) {
    const q = buildTxnQuery(o, true).range(offset, offset + limit - 1)
    const res = await q
    if (res.error) throw res.error
    return { rows: cleanTags(res.data || []), total: res.count || 0 }
  }

  /* 大结果集分页拉全量：避免只拿到服务端单页上限就当成「全部」，
     从而让统计、导出、余额在账目多的时候静默漏算。 */
  async function listTransactions(opt) {
    const o = opt || {}
    const want = o.limit || 200
    const start = o.offset || 0
    if (want <= PAGE) return listPage(o, want, start)

    const rows = []
    let total = 0
    let from = start
    while (rows.length < want) {
      const r = await listPage(o, PAGE, from)
      total = r.total
      const got = r.rows.length
      for (let i = 0; i < got; i++) rows.push(r.rows[i])
      if (!got || got < PAGE) break          /* 服务端给了不满一页 → 到底了 */
      from += got                            /* 按实际返回条数推进，不受服务端上限影响 */
      if (total && from >= total) break
    }
    return { rows: rows.slice(0, want), total: total || rows.length }
  }

  /* 幂等查重：这个操作 ID 是不是已经落库了（响应丢失的重试场景）。
     直接查原始行，绕过 cleanTags，否则标记会被摘掉就查不到了。 */
  async function hasOp(table, opId) {
    const res = await db().from(table).select('id').contains('tags', [opTag(opId)]).limit(1)
    if (res.error) throw res.error
    return !!(res.data && res.data.length)
  }

  /* 不声明 range 的查询会被服务端按默认条数上限截断（不是「全部」）。
     凡是需要完整结果集的地方都走这里，逐页取到不足一页为止。 */
  async function fetchAllRows(makeQuery, chunk) {
    const step = chunk || PAGE
    const out = []
    let from = 0
    for (;;) {
      const res = await makeQuery().range(from, from + step - 1)
      if (res.error) throw res.error
      const rows = res.data || []
      for (let i = 0; i < rows.length; i++) out.push(rows[i])
      if (rows.length < step) break
      from += rows.length
      if (out.length >= 200000) break      /* 防御性上限，避免异常数据把页面拖死 */
    }
    return out
  }

  async function getTransaction(id) {
    const res = await db().from('transactions').select('*').eq('id', id).maybeSingle()
    if (res.error) throw res.error
    return res.data
  }

  /* 交易只有一个 amount，无法同时表达不同币种的转出、转入金额。
     所有写入入口共用此校验，导入和模板等路径也不能绕过。 */
  function assertTransferCurrency(t) {
    if (!t || t.txn_type !== 'transfer') return
    const account = id => id == null ? null : state.accounts.find(a => a.id != null && String(a.id) === String(id))
    const from = account(t.account_id)
    const to = account(t.to_account_id)
    if (!from || !to) {
      const e = new Error('转账账户不存在，请刷新后重新选择账户')
      e.code = 'TRANSFER_ACCOUNT_REQUIRED'
      throw e
    }
    if (String(from.currency || 'CNY').toUpperCase() !== String(to.currency || 'CNY').toUpperCase()) {
      const e = new Error('暂不支持跨币种转账，请选择同币种账户')
      e.code = 'CROSS_CURRENCY_TRANSFER'
      throw e
    }
  }

  async function addTransaction(t) {
    assertTransferCurrency(t)
    if (t.book_id == null) t.book_id = currentBookId()
    const rows = unwrap(await db().from('transactions').insert(t).select())
    return rows[0]
  }

  /* 乐观锁：调用方可以传「我读到这条时的 updated_at」。
     服务端没开放改表（加不了 version 列），但每行本来就有 updated_at，
     把它当版本号用即可：条件不匹配 → 0 行受影响 → 说明别的设备先改过了。
     这时必须区分两种情况，否则用户看到的提示会是错的：
       · 记录还在、只是版本变了 → 冲突（CONFLICT），让用户选怎么处理
       · 记录压根不在 / 不属于我 → RLS_NO_ROWS（沿用 mustAffect 的提示） */
  async function updateTransaction(id, patch, expectUpdatedAt) {
    /* 局部 patch 也必须校验完整交易，不能只改一个账户来绕过币种约束。 */
    if (patch.txn_type == null || (patch.txn_type === 'transfer' &&
        (patch.account_id == null || patch.to_account_id == null))) {
      const current = await getTransaction(id)
      if (current) assertTransferCurrency(Object.assign({}, current, patch))
    } else {
      assertTransferCurrency(patch)
    }
    let q = db().from('transactions').update(patch).eq('id', id)
    if (expectUpdatedAt) q = q.eq('updated_at', expectUpdatedAt)
    const rows = unwrap(await q.select())
    if (!expectUpdatedAt) return mustAffect(rows, '修改账目')[0]
    if (rows && rows.length) return rows[0]
    const cur = await db().from('transactions').select('id,updated_at,amount,note,deleted_at').eq('id', id).maybeSingle()
    const row = cur && cur.data
    if (row) {
      const e = new Error('这条记录已被其他设备修改过')
      e.code = 'CONFLICT'
      e.server = row
      throw e
    }
    return mustAffect(rows, '修改账目')[0]
  }

  async function deleteTransaction(id) {
    /* 软删除：仅标记 deleted_at，附件保留，可进回收站恢复 */
    mustAffect(unwrap(await db().from('transactions').update({ deleted_at: new Date().toISOString() }).eq('id', id).select()), '删除账目')
    return true
  }

  /* 回收站：恢复（清除删除标记） */
  async function restoreTransaction(id) {
    mustAffect(unwrap(await db().from('transactions').update({ deleted_at: null }).eq('id', id).select()), '恢复账目')
    return true
  }

  /* 回收站：彻底删除（移除附件 + 物理删除） */
  async function purgeTransaction(id) {
    const atts = unwrap(await db().from('attachments').select('storage_path').eq('transaction_id', id))
    const paths = (atts || []).map(a => a.storage_path).filter(Boolean)
    if (paths.length) {
      try { await window.Cloud.cloud.storage.remove(paths) } catch (e) { /* 文件已缺失不影响主流程 */ }
      await db().from('attachments').delete().eq('transaction_id', id)
    }
    mustAffect(unwrap(await db().from('transactions').delete().eq('id', id).select()), '彻底删除账目')
    return true
  }

  /* ---------- 记账模板 ---------- */
  async function listTemplates() {
    const res = await db().from('transaction_templates').select('*').order('created_at', { ascending: false })
    if (res.error) throw res.error
    return res.data || []
  }
  async function addTemplate(t) {
    const rows = unwrap(await db().from('transaction_templates').insert({
      name: t.name, txn_type: t.txn_type, amount: t.amount != null ? t.amount : null,
      account_id: t.account_id || null, to_account_id: t.to_account_id || null,
      category_id: t.category_id || null, note: t.note || '', tags: t.tags || [], book_id: t.book_id || null,
    }).select())
    return rows[0]
  }
  async function updateTemplate(id, patch) {
    mustAffect(unwrap(await db().from('transaction_templates').update(patch).eq('id', id).select()), '修改模板')
  }
  async function deleteTemplate(id) {
    mustAffect(unwrap(await db().from('transaction_templates').delete().eq('id', id).select()), '删除模板')
  }

  /* ---------- 附件 ---------- */
  async function listAttachments(txnIds) {
    if (!txnIds || !txnIds.length) return {}
    const map = {}
    /* 分片查询：一次 in() 塞太多 id 会超长，也会被服务端条数上限截断 */
    const CHUNK = 200
    for (let i = 0; i < txnIds.length; i += CHUNK) {
      const slice = txnIds.slice(i, i + CHUNK)
      const rows = await fetchAllRows(() =>
        db().from('attachments').select('*').in('transaction_id', slice).order('id', { ascending: true }))
      rows.forEach(a => {
        ;(map[a.transaction_id] = map[a.transaction_id] || []).push(a)
      })
    }
    return map
  }

  async function addAttachments(txnId, files) {
    const rows = files.map(f => ({
      transaction_id: txnId,
      storage_path: f.path,
      file_name: f.name,
      size_bytes: f.size,
      content_type: f.type,
    }))
    if (!rows.length) return []
    return unwrap(await db().from('attachments').insert(rows).select())
  }

  async function removeAttachment(id, path) {
    mustAffect(unwrap(await db().from('attachments').delete().eq('id', id).select()), '删除凭证')
    try { await window.Cloud.cloud.storage.remove([path]) } catch (e) { /* 忽略 */ }
  }

  /* 图片压缩 + 上传：最大边 1600px、JPEG 0.82，兼顾清晰度和 10 年的存储成本 */
  async function compressImage(file) {
    const bitmap = await createImageBitmap(file)
    const maxSide = 1600
    let w = bitmap.width
    let h = bitmap.height
    const scale = Math.min(1, maxSide / Math.max(w, h))
    w = Math.round(w * scale)
    h = Math.round(h * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82))
    if (bitmap.close) bitmap.close()
    return blob || file
  }

  async function uploadImage(file) {
    const blob = await compressImage(file)
    return uploadImageBlob(blob, file.name)
  }

  /* 直接上传已压缩的 Blob（游客数据迁移时用） */
  async function uploadImageBlob(blob, name) {
    const uid = state.uid
    const d = new Date()
    const dir = 'ledger/' + d.getFullYear() + '-' + window.Fmt.pad2(d.getMonth() + 1)
    const fileName = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) + '.jpg'
    const path = window.Cloud.userPath(uid, dir + '/' + fileName)
    const up = await window.Cloud.cloud.storage.upload(path, blob, { contentType: 'image/jpeg', upsert: false })
    if (up.error) throw up.error
    return { path, size: blob.size, name: name || fileName, type: 'image/jpeg' }
  }

  async function imageUrl(att) {
    return window.Cloud.signedUrl(att.storage_path)
  }

  /* 文件柜（v1.15）：不挂账的文档（保单/合同/保修卡）用 transaction_id = null 存同一张表，
     不改表结构；这里把全部附件一次列出来，供文件柜按年份/类型归档。 */
  async function listAllAttachments() {
    return fetchAllRows(() => db().from('attachments').select('*').order('id', { ascending: true }))
  }

  /* 通用文件上传：图片仍压成 JPEG，PDF/文档按原样存（凭证相册与文件柜共用） */
  async function uploadFile(file) {
    if (/^image\//.test(file.type || '')) return uploadImage(file)
    const d = new Date()
    const dir = 'ledger/' + d.getFullYear() + '-' + window.Fmt.pad2(d.getMonth() + 1)
    const ext = (String(file.name || '').match(/\.[a-zA-Z0-9]{1,5}$/) || ['.bin'])[0]
    const fileName = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) + ext
    const path = window.Cloud.userPath(state.uid, dir + '/' + fileName)
    const up = await window.Cloud.cloud.storage.upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (up.error) throw up.error
    return { path: path, size: file.size, name: file.name || fileName, type: file.type || 'application/octet-stream' }
  }

  /* ---------- 周期记账 ---------- */
  async function listRecurring() {
    let q = db().from('recurring_rules').select('*').order('id', { ascending: true })
    if (state.bookId != null) q = q.eq('book_id', state.bookId)
    const res = await q
    if (res.error) throw res.error
    return res.data || []
  }
  async function addRecurring(rule) {
    assertTransferCurrency(rule)
    if (rule.book_id == null) rule.book_id = currentBookId()
    const rows = unwrap(await db().from('recurring_rules').insert(rule).select())
    return rows[0]
  }
  async function updateRecurring(id, patch) {
    mustAffect(unwrap(await db().from('recurring_rules').update(patch).eq('id', id).select()), '修改周期规则')
  }
  async function deleteRecurring(id) {
    mustAffect(unwrap(await db().from('recurring_rules').delete().eq('id', id).select()), '删除周期规则')
  }

  function parseDay(s) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s).slice(0, 10))
    return new Date(+m[1], +m[2] - 1, +m[3])
  }

  /* 待补记清单（只读预演，不写库）：启动时先弹确认再决定补不补 */
  async function pendingRecurring(nowDate) {
    const rules = unwrap(await db().from('recurring_rules').select('*').eq('active', true))
    const today = window.Fmt.dstr(nowDate || new Date())
    const out = []
    for (const r of rules) {
      const startDay = String(r.start_date).slice(0, 10)
      let cursor = window.Fmt.nextDue(r.last_run_date, startDay, r.freq)
      const dates = []
      let guard = 0
      while (cursor && cursor <= today && guard < 24) {
        if (cursor >= startDay) dates.push(cursor)
        cursor = window.Fmt.nextDue(cursor, startDay, r.freq)
        guard++
      }
      if (dates.length) out.push({ id: r.id, note: r.note || '', amount: Number(r.amount), txn_type: r.txn_type, dates: dates })
    }
    return out
  }

  /* 周期补记标记（与游客侧同款）：`_op:rec:<规则id>:<日期>`。
     用于识别已经完成的补记和中断后的重跑；前端先查后写不能保证跨设备并发唯一，
     那需要服务端唯一约束或事务支持。 */
  function recOpTag(ruleId, day) { return OP_TAG + 'rec:' + ruleId + ':' + day }

  /* 打开应用时把到期的周期账目补记出来，每轮最多 24 条防误刷 */
  async function applyRecurring(nowDate) {
    const rules = unwrap(await db().from('recurring_rules').select('*').eq('active', true))
    const today = window.Fmt.dstr(nowDate || new Date())
    let generated = 0
    for (const r of rules) {
      assertTransferCurrency(r)
      const startDay = String(r.start_date).slice(0, 10)
      let cursor = window.Fmt.nextDue(r.last_run_date, startDay, r.freq)
      let guard = 0
      const inserts = []
      while (cursor && cursor <= today && guard < 24) {
        if (cursor >= startDay) {
          const d = parseDay(cursor)
          d.setHours(12, 0, 0, 0)
          /* auto 标记写在 tags 里（不改表结构），明细里显示「自动」并可批量撤销；
             `_op:rec:…` 是防重标记，读回时 cleanTags 会摘掉 */
          /* 规则创建的操作 ID 不是本期账目的身份，不能继承。
             交易单号同样只属于原始账目，不应复制到后续每一期。 */
          const tags = (Array.isArray(r.tags) ? r.tags : []).filter(t =>
            typeof t !== 'string' || (t.slice(0, OP_TAG.length) !== OP_TAG && t.slice(0, ORD_TAG.length) !== ORD_TAG))
          if (tags.indexOf('auto') < 0) tags.push('auto')
          tags.push(recOpTag(r.id, cursor))
          /* 幂等查重：另一台设备可能已经把这一天补过了 */
          const dup = await hasOp('transactions', 'rec:' + r.id + ':' + cursor)
          if (!dup) {
            inserts.push({
              txn_type: r.txn_type, amount: Number(r.amount), occurred_at: window.Fmt.iso(d),
              account_id: r.account_id, to_account_id: r.to_account_id, category_id: r.category_id,
              note: r.note || '', tags: tags, reimbursable: !!r.reimbursable,
              book_id: r.book_id || currentBookId(),
            })
          }
          r.last_run_date = cursor
        }
        cursor = window.Fmt.nextDue(cursor, startDay, r.freq)
        guard++
      }
      if (inserts.length) {
        const ins = await db().from('transactions').insert(inserts)
        if (ins.error) throw ins.error
      }
      if (r.last_run_date) {
        const up = await db().from('recurring_rules').update({ last_run_date: r.last_run_date }).eq('id', r.id)
        if (up.error) throw up.error
      }
      generated += inserts.length
    }
    return generated
  }

  /* ---------- 统计 ---------- */
  /* 多币种：交易金额以「所属账户的币种」记录，跨账户汇总前必须折算到基准币种。
     没有任何外币账户时走原生 RPC（零开销）；一旦出现外币账户则改用本地折算聚合。 */
  function curMap() {
    const m = {}
    allAccounts().forEach(a => { m[a.id] = a.currency || 'CNY' })
    return m
  }
  function baseCents(cents, accId, map) {
    const code = (map || curMap())[accId] || 'CNY'
    return window.Fmt.toBase(cents, code)
  }
  function hasForeignAcc() {
    return !!(window.Fmt.hasForeign && window.Fmt.hasForeign(allAccounts()))
  }
  async function monthlySummary(from, to) {
    if (hasForeignAcc()) return monthlySummaryLocal(from, to)
    const res = await db().rpc('ledger_monthly_summary', { p_from: from, p_to: to, p_book: state.bookId })
    if (res.error) throw res.error
    return res.data || []
  }
  async function monthlySummaryLocal(from, to) {
    const { rows } = await listTransactions({ from, to, limit: 100000 })
    const map = curMap()
    const byMonth = {}
    ;(rows || []).forEach(t => {
      const key = window.Fmt.monthOf(t.occurred_at)
      byMonth[key] = byMonth[key] || { month_key: key, income: 0, expense: 0, txn_count: 0 }
      const yuan = baseCents(window.Fmt.toCents(t.amount), t.account_id, map) / 100
      if (t.txn_type === 'income') byMonth[key].income += yuan
      else if (t.txn_type === 'expense') byMonth[key].expense += yuan
      byMonth[key].txn_count++
    })
    return Object.values(byMonth).sort((a, b) => a.month_key < b.month_key ? -1 : 1)
  }
  async function categorySummary(from, to, kind) {
    if (hasForeignAcc()) return categorySummaryLocal(from, to, kind)
    const res = await db().rpc('ledger_category_summary', { p_from: from, p_to: to, p_kind: kind, p_book: state.bookId })
    if (res.error) throw res.error
    return res.data || []
  }
  async function categorySummaryLocal(from, to, kind) {
    const { rows } = await listTransactions({ from, to, limit: 100000 })
    const map = curMap()
    const byCat = {}
    ;(rows || []).filter(t => t.txn_type === kind).forEach(t => {
      const key = t.category_id || 0
      byCat[key] = byCat[key] || { category_id: t.category_id, total: 0, txn_count: 0 }
      byCat[key].total += baseCents(window.Fmt.toCents(t.amount), t.account_id, map) / 100
      byCat[key].txn_count++
    })
    return Object.values(byCat).sort((a, b) => b.total - a.total)
  }

  /* ---------- 预算 ---------- */
  function budgetOf(monthKey, categoryId) {
    const list = state.budgets.filter(x => x.month_key === monthKey && (x.category_id || 0) === (categoryId || 0) &&
      (state.bookId == null || (x.book_id || defaultBookId()) === state.bookId))
    if (!list.length) return null
    /* 全部账本视图下合并各账本同月预算 */
    return list.reduce((s, b) => s + Number(b.amount), 0)
  }
  async function setBudget(monthKey, categoryId, amount, explicitBookId) {
    /* 第四参数由待上传队列冻结，重试时不能跟着当前选中的账本变化。 */
    const bookId = explicitBookId != null ? explicitBookId : currentBookId()
    const existing = state.budgets.find(x =>
      x.month_key === monthKey && (x.category_id || 0) === (categoryId || 0) &&
      (x.book_id || 0) === (bookId || 0))
    if (existing) {
      mustAffect(unwrap(await db().from('budgets').update({ amount }).eq('id', existing.id).select()), '修改预算')
    } else {
      unwrap(await db().from('budgets').insert({ month_key: monthKey, category_id: categoryId || null, amount, book_id: bookId }).select())
    }
    await loadBudgets()
  }

  /* 账户余额：期初 + 收入 - 支出 + 转入 - 转出，按分计算 */
  async function accountBalances() {
    const rows = await fetchAllRows(() =>
      db().from('transactions').select('txn_type, amount, account_id, to_account_id').is('deleted_at', null))
    const delta = {}
    const add = (id, v) => { if (id != null) delta[id] = (delta[id] || 0) + v }
    ;(rows || []).forEach(t => {
      const cents = window.Fmt.toCents(t.amount)
      if (t.txn_type === 'income') add(t.account_id, cents)
      else if (t.txn_type === 'expense') add(t.account_id, -cents)
      else if (t.txn_type === 'transfer') {
        add(t.account_id, -cents)
        add(t.to_account_id, cents)
      }
    })
    return allAccounts().map(a => ({
      account: a,
      balance: window.Fmt.toCents(a.initial_balance) + (delta[a.id] || 0),
    }))
  }

  /* 存储用量统计 */
  async function storageUsage() {
    const rows = await fetchAllRows(() => db().from('attachments').select('size_bytes'))
    let total = 0
    rows.forEach(r => { total += Number(r.size_bytes) || 0 })
    return { count: rows.length, bytes: total }
  }

  /* 导出全部（CSV 用） */
  async function exportAll() {
    const { rows } = await listTransactions({ limit: 100000 })
    const atts = await listAttachments(rows.map(r => r.id))
    return rows.map(r => {
      const c = r.category_id ? category(r.category_id) : null
      return {
        id: r.id,
        date: window.Fmt.isoLocal(r.occurred_at),
        type: r.txn_type,
        amount: r.amount,
        book: r.book_id ? bookName(r.book_id) : '',
        account: r.account_id ? accountName(r.account_id) : '',
        toAccount: r.to_account_id ? accountName(r.to_account_id) : '',
        category: c ? (c.parent_id ? categoryName(c.parent_id) + '/' + c.name : c.name) : '',
        note: r.note || '',
        tags: (r.tags || []).join(' '),
        reimbursable: r.reimbursable ? 1 : 0,
        images: (atts[r.id] || []).length,
      }
    })
  }

  /* 净资产月度序列：最近 n 个月每月末的所有账户合计（分），供趋势图用 */
  async function netWorthSeries(months) {
    const n = months || 12
    const rows = await fetchAllRows(() =>
      db().from('transactions').select('txn_type, amount, occurred_at, account_id').is('deleted_at', null))
    const now = new Date()
    const points = []
    const map = curMap()
    /* 期初余额同样按各自账户币种折算到基准币种后再相加 */
    const initial = allAccounts().reduce((s, a) => s + baseCents(window.Fmt.toCents(a.initial_balance), a.id, map), 0)
    /* 每月累计增量（基准币种「分」） */
    const byMonth = {}
    ;(rows || []).forEach(t => {
      const key = window.Fmt.monthOf(t.occurred_at)
      const c = baseCents(window.Fmt.toCents(t.amount), t.account_id, map)
      if (!byMonth[key]) byMonth[key] = 0
      if (t.txn_type === 'income') byMonth[key] += c
      else if (t.txn_type === 'expense') byMonth[key] -= c
    })
    let cum = initial
    /* 先累加 n 个月之前的所有历史 */
    const firstKey = (function () {
      const d = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1)
      return window.Fmt.monthKey(d)
    })()
    Object.keys(byMonth).forEach(k => { if (k < firstKey) cum += byMonth[k] })
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = window.Fmt.monthKey(d)
      cum += byMonth[key] || 0
      points.push({ label: (d.getMonth() + 1) + '月', value: cum })
    }
    return points
  }

  return {
    state, init, seedPresets,
    accounts, allAccounts, accountName, categoryName, category, rootCategories, childCategories,
    addAccount, updateAccount, deleteAccount, addCategory, deleteCategory,
    listTransactions, getTransaction, addTransaction, updateTransaction, deleteTransaction,
    restoreTransaction, purgeTransaction, listTemplates, addTemplate, updateTemplate, deleteTemplate,
    listAttachments, addAttachments, removeAttachment, uploadImage, uploadImageBlob, imageUrl, compressImage,
    monthlySummary, categorySummary,
    budgetOf, setBudget, accountBalances, storageUsage, exportAll, netWorthSeries,
    listRecurring, addRecurring, updateRecurring, deleteRecurring, applyRecurring, pendingRecurring,
    loadAccounts, loadCategories, loadBudgets,
    books, activeBookId, currentBookId, defaultBookId, setActiveBook, bookName,
    addBook, renameBook, deleteBook, ensureDefaultBook,
    listGoals, addGoal, updateGoal, deleteGoal, goalDeposit,
    /* 幂等与分页（js/sync.js、js/migrate.js 用） */
    hasOp, opTag, OP_TAG, cleanTags, fetchAllRows, PAGE, listAllAttachments, uploadFile,
  }
})()

