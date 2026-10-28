/* 共享账本（家庭共账）
   ---------------------------------------------------------------
   为什么是「发布 / 订阅」而不是双向实时协作：
   - 后端只开放了 accounts / categories / transactions / budgets / books /
     savings_goals / recurring_rules 这几张表，没有成员表，也拿不到建表与
     行级权限的能力，所以无法在数据库层做「一本账多人写」。
   - 存储层有一条跨用户只读通道：shared/<ownerUid>/...（所有登录用户可读，
     仅 owner 可写/删）。
   因此这里的做法是：
   - 账本主把自己的账本导出成一份 JSON 快照，用共享码派生的 AES-GCM 密钥
     加密后放到 shared/<ownerUid>/ledger10/<sid>.json；
   - 家人凭共享码下载、解密、按「账本 + 分类 + 账户」名称对齐后合并进自己
     的账目（按指纹去重，可反复刷新）。
   SG1 的文件名包含密钥派生所需的 sid；共享目录的列举/读取权限仍需服务端验证。
   后续协议应将对象标识与仅随共享码传递的随机 secret 分离。
   只有登录用户能用；游客模式给出「需先登录」提示。
   --------------------------------------------------------------- */
window.Share = (function () {
  const F = window.Fmt
  const S = () => window.DB
  const U = () => window.UI

  const MINE_KEY = 'ledger10_shares'       /* 我发布出去的共享 */
  const JOIN_KEY = 'ledger10_joins'        /* 我加入的共享 */
  const SEEN_KEY = 'ledger10_share_seen'   /* 已合并过的交易指纹，防重复导入 */
  const SEEN_MAX = 8000
  const REL_DIR = 'ledger10'
  const CODE_VER = 'SG1'
  const ITER = 150000

  /* ---------------- 小工具 ---------------- */
  function readJson(key, fb) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null')
      return v == null ? fb : v
    } catch (e) { return fb }
  }
  function writeJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true } catch (e) { return false }
  }
  function b64url(bytes) {
    let s = ''
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function unb64url(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/')
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
    const bin = atob(s + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789'  /* 去掉易混字符 */
  function randStr(n) {
    const a = new Uint8Array(n)
    crypto.getRandomValues(a)
    let s = ''
    for (let i = 0; i < n; i++) s += ALPHA[a[i] % ALPHA.length]
    return s
  }
  function cryptoOk() {
    return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues)
  }

  /* ---------------- 共享码 ---------------- */
  /* 格式：SG1-<ownerUid>-<sid>。ownerUid 决定存储路径，sid 既是文件名也是密钥来源。 */
  function buildCode(uid, sid) { return CODE_VER + '-' + uid + '-' + sid }
  function parseCode(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, '')
    if (!s) return null
    const m = /^SG1-(.+)-([a-z0-9]{8,32})$/i.exec(s)
    if (!m) return null
    return { uid: m[1], sid: m[2].toLowerCase() }
  }
  function fmtCode(code) {
    const p = parseCode(code)
    if (!p) return code
    return CODE_VER + ' · ' + p.uid + ' · ' + p.sid
  }

  /* ---------------- 加解密 ---------------- */
  function deriveKey(sid) {
    const enc = new TextEncoder()
    return crypto.subtle.importKey('raw', enc.encode('ledger10|' + sid), 'PBKDF2', false, ['deriveKey'])
      .then(base => crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('share:' + sid), iterations: ITER, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
  }
  async function encryptJson(obj, sid) {
    const key = await deriveKey(sid)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new TextEncoder().encode(JSON.stringify(obj))
    const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data)
    return JSON.stringify({ v: 1, iv: b64url(iv), d: b64url(new Uint8Array(buf)) })
  }
  async function decryptJson(text, sid) {
    const box = JSON.parse(text)
    if (!box || !box.iv || !box.d) throw new Error('数据格式不正确')
    const key = await deriveKey(sid)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64url(box.iv) }, key, unb64url(box.d))
    return JSON.parse(new TextDecoder().decode(plain))
  }

  /* ---------------- 会话与路径 ---------------- */
  async function session() {
    if (!window.Cloud || !window.Cloud.getSession) return null
    try { return await window.Cloud.getSession() } catch (e) { return null }
  }
  function storage() {
    if (!window.Cloud || !window.Cloud.cloud || !window.Cloud.cloud.storage) return null
    return window.Cloud.cloud.storage
  }
  function sharePath(uid, sid) {
    return storage().sharedPath(uid, REL_DIR + '/' + sid + '.json')
  }

  /* ---------------- 快照 ---------------- */
  function categoryPath(id) {
    const c = S().category(id)
    if (!c) return ''
    const parts = [c.name]
    const seen = new Set([String(c.id)])
    let parentId = c.parent_id
    while (parentId != null && !seen.has(String(parentId))) {
      seen.add(String(parentId))
      const parent = S().category(parentId)
      if (!parent) break
      parts.unshift(parent.name)
      parentId = parent.parent_id
    }
    return parts.join('/')
  }
  /* 共享前预览：按当前选项算出「到底会发出去什么」，让用户在点上传前看清清单 */
  async function previewCounts(scope, opts) {
    const o = opts || {}
    const onlyBook = scope === 'book' && S().state.bookId != null
    const bookId = S().state.bookId
    const rows = (await S().listTransactions({ limit: 100000, ignoreBook: true })).rows || []
    const keep = onlyBook ? rows.filter(t => String(t.book_id) === String(bookId)) : rows
    const used = {}
    keep.forEach(t => {
      if (t.account_id != null) used[String(t.account_id)] = 1
      if (t.to_account_id != null) used[String(t.to_account_id)] = 1
    })
    const all = S().allAccounts()
    const allGoals = S().state.goals || S().listGoals()
    const goals = onlyBook
      ? allGoals.filter(g => String(g.book_id || '') === String(bookId))
      : allGoals
    let budgets = S().state.budgets || []
    if (onlyBook) {
      if (!o.includeBudgets) budgets = []
      else {
        const usedCat = new Set(keep.map(t => String(t.category_id)))
        budgets = budgets.filter(b => String(b.book_id || S().defaultBookId()) === String(bookId) &&
          (b.category_id == null || usedCat.has(String(b.category_id))))
      }
    }
    return {
      transactions: keep.length,
      accounts: onlyBook ? all.filter(a => used[String(a.id)]).length : all.length,
      balances: onlyBook ? !!o.includeBalances : true,
      books: onlyBook && !o.includeOtherBooks ? 1 : S().books().length,
      goals: goals.length,
      budgets: budgets.length,
      categories: (S().state.categories || []).length,
    }
  }

  async function buildSnapshot(label, scope, opts) {
    const o = opts || {}
    const onlyBook = scope === 'book' && S().state.bookId != null
    const bookId = S().state.bookId
    const rows = (await S().listTransactions({ limit: 100000, ignoreBook: true })).rows || []
    const keep = onlyBook ? rows.filter(t => String(t.book_id) === String(bookId)) : rows
    /* 账户按账本投影：只发这个账本的流水真正用到的账户 */
    let accs = S().allAccounts()
    if (onlyBook) {
      const used = {}
      keep.forEach(t => {
        if (t.account_id != null) used[String(t.account_id)] = 1
        if (t.to_account_id != null) used[String(t.to_account_id)] = 1
      })
      accs = accs.filter(a => used[String(a.id)])
    }
    /* 余额是跨账本的敏感信息：共享时默认不发，除非用户单独勾选 */
    const withBal = onlyBook ? !!o.includeBalances : true
    /* 账本名称：默认只发当前账本这一个名字，别的账本叫什么不透露 */
    const books = onlyBook && !o.includeOtherBooks
      ? S().books().filter(b => String(b.id) === String(bookId))
      : S().books()
    /* 目标按账本归属过滤 */
    const allGoals = S().state.goals || S().listGoals()
    const goals = onlyBook
      ? allGoals.filter(g => String(g.book_id || '') === String(bookId))
      : allGoals
    /* 预算按原账本投影，分类预算限当前流水出现过的分类。 */
    let budgets = (S().state.budgets || [])
    if (onlyBook) {
      if (!o.includeBudgets) budgets = []
      else {
        const usedCat = {}
        keep.forEach(t => { if (t.category_id != null) usedCat[String(t.category_id)] = 1 })
        budgets = budgets.filter(b => String(b.book_id || S().defaultBookId()) === String(bookId) &&
          (b.category_id == null || usedCat[String(b.category_id)]))
      }
    }
    const sourceId = S().mode === 'cloud' && S().state.uid
      ? 'cloud:' + S().state.uid
      : 'guest:' + (S().state.sourceId || (window.GuestStore && window.GuestStore.sourceId ? await window.GuestStore.sourceId() : 'legacy'))
    return {
      v: 2,
      sourceId: sourceId,
      at: new Date().toISOString(),
      label: label || '共享账本',
      scope: scope || 'all',
      /* 给解密方一个明示：这份快照含不含余额，别让「0 元」被误读成真没钱 */
      balances: withBal,
      books: books.map(b => ({ id: b.id, name: b.name, icon: b.icon || '📒' })),
      accounts: accs.map(a => ({
        id: a.id,
        name: a.name, kind: a.kind, icon: a.icon || '💰', color: a.color || '#2f6bff',
        currency: a.currency || 'CNY', initial_balance: withBal ? (Number(a.initial_balance) || 0) : 0,
      })),
      categories: (S().state.categories || []).map(c => ({
        id: c.id, parent_id: c.parent_id || null,
        kind: c.kind, name: c.name, icon: c.icon || '', color: c.color || '',
        parent: c.parent_id ? S().categoryName(c.parent_id) : null,
      })),
      transactions: keep.map(t => ({
        id: t.id, book_id: t.book_id || S().defaultBookId(),
        account_id: t.account_id, to_account_id: t.to_account_id || null, category_id: t.category_id || null,
        date: F.isoLocal(t.occurred_at).slice(0, 16),
        type: t.txn_type,
        amount: Number(t.amount) || 0,
        book: t.book_id ? S().bookName(t.book_id) : '',
        account: t.account_id ? S().accountName(t.account_id) : '',
        currency: (accs.find(a => String(a.id) === String(t.account_id)) || {}).currency || 'CNY',
        toAccount: t.to_account_id ? S().accountName(t.to_account_id) : '',
        toCurrency: t.to_account_id ? ((accs.find(a => String(a.id) === String(t.to_account_id)) || {}).currency || 'CNY') : null,
        category: categoryPath(t.category_id),
        note: t.note || '',
        tags: (t.tags || []).slice(0, 8),
        reimbursable: !!t.reimbursable,
      })),
      goals: goals.map(g => ({
        id: g.id, book_id: g.book_id || S().defaultBookId(), book: S().bookName(g.book_id || S().defaultBookId()),
        name: g.name, icon: g.icon || '🎯', target_amount: Number(g.target_amount) || 0,
        saved_amount: Number(g.saved_amount) || 0, deadline: g.deadline || null, done: !!g.done,
      })),
      budgets: budgets.map(b => ({
        book_id: b.book_id || S().defaultBookId(), book: S().bookName(b.book_id || S().defaultBookId()),
        category_id: b.category_id || null, category_kind: b.category_id ? (S().category(b.category_id) || {}).kind : null,
        month_key: b.month_key,
        category: b.category_id ? categoryPath(b.category_id) : '',
        amount: Number(b.amount) || 0,
      })),
      counts: {
        transactions: keep.length, accounts: accs.length,
        categories: (S().state.categories || []).length,
        books: books.length, goals: goals.length, budgets: budgets.length,
      },
    }
  }

  /* ---------------- 我发布的 ---------------- */
  function myShares() { return readJson(MINE_KEY, []) || [] }
  function saveMyShares(list) { return writeJson(MINE_KEY, (list || []).slice(0, 30)) }
  function joinedShares() { return readJson(JOIN_KEY, []) || [] }
  function saveJoined(list) { return writeJson(JOIN_KEY, (list || []).slice(0, 30)) }

  async function publish(opts) {
    const o = opts || {}
    const sess = await session()
    if (!sess || !sess.user || !sess.user.id) return { error: '需要先登录才能共享（游客模式的数据只在本机）' }
    if (!cryptoOk()) return { error: '当前环境不支持加密（请用 https 打开）' }
    const st = storage()
    if (!st) return { error: '云存储不可用，请检查网络' }

    const sid = o.sid || randStr(12)
    const label = (o.label || '共享账本').slice(0, 20)
    U().toast('正在生成加密快照…')
    let snap
    try { snap = await buildSnapshot(label, o.scope || 'all', o.include) } catch (e) { return { error: '生成快照失败：' + (e.message || '') } }
    if (!snap.transactions.length) return { error: '当前范围里还没有账目，先记几笔再共享' }

    let payload
    try { payload = await encryptJson(snap, sid) } catch (e) { return { error: '加密失败：' + (e.message || '') } }
    if (payload.length > 12 * 1024 * 1024) return { error: '账目太多（' + snap.transactions.length + ' 笔），单次共享上限约 12MB' }

    const path = sharePath(sess.user.id, sid)
    try {
      const up = await st.upload(path, new Blob([payload], { type: 'application/json' }), { contentType: 'application/json', upsert: true })
      if (up && up.error) return { error: up.error.message || '上传失败' }
    } catch (e) { return { error: (e && e.message) || '上传失败，请检查网络' } }

    const code = buildCode(sess.user.id, sid)
    const list = myShares().filter(x => x.sid !== sid)
    list.unshift({
      sid: sid, code: code, label: label, scope: o.scope || 'all',
      /* 记住这次的勾选，「更新」时用同一套设置，不会悄悄改变发出去的内容 */
      inc: o.include || null,
      at: new Date().toISOString(), count: snap.transactions.length, bytes: payload.length,
    })
    saveMyShares(list)
    return { ok: true, code: code, sid: sid, count: snap.transactions.length, bytes: payload.length }
  }

  async function revoke(sid) {
    const sess = await session()
    if (!sess || !sess.user) return { error: '需要先登录' }
    const st = storage()
    if (!st) return { error: '云存储不可用' }
    try {
      const r = await st.remove([sharePath(sess.user.id, sid)])
      if (r && r.error) return { error: r.error.message || '删除失败' }
    } catch (e) { return { error: (e && e.message) || '删除失败' } }
    saveMyShares(myShares().filter(x => x.sid !== sid))
    return { ok: true }
  }

  /* ---------------- 拉取 ---------------- */
  async function fetchSnapshot(code) {
    const p = parseCode(code)
    if (!p) return { error: '共享码格式不对，请重新复制粘贴' }
    const sess = await session()
    if (!sess || !sess.user) return { error: '需要先登录才能加入共享账本' }
    if (!cryptoOk()) return { error: '当前环境不支持解密（请用 https 打开）' }
    const st = storage()
    if (!st) return { error: '云存储不可用，请检查网络' }
    let text = ''
    try {
      const res = await st.download(sharePath(p.uid, p.sid))
      if (res && res.error) return { error: '没找到这份共享账本，可能已被撤回' }
      const blob = res.data
      text = await blob.text()
    } catch (e) { return { error: (e && e.message) || '下载失败，请检查网络' } }
    try {
      const snap = await decryptJson(text, p.sid)
      return { ok: true, snap: snap, sid: p.sid, uid: p.uid }
    } catch (e) {
      return { error: '解密失败：共享码可能被改动过，请让账本主重新发一次' }
    }
  }

  /* ---------------- 合并 ---------------- */
  /* 去重按目标账号隔离；新快照使用来源库 + 来源交易 ID，不把同内容的两笔吞掉。 */
  async function digestId(value) {
    if (window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
      return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
    }
    /* 非安全上下文只用于兼容已有明文快照；保留完整身份，避免弱哈希碰撞。 */
    return encodeURIComponent(value)
  }
  function targetIdentity() {
    return S().mode === 'cloud' ? 'cloud:' + S().state.uid : 'guest:' + (S().state.sourceId || 'legacy')
  }
  function seenSet(target) {
    const arr = readJson(SEEN_KEY + ':v2:' + encodeURIComponent(target || targetIdentity()), [])
    return new Set(Array.isArray(arr) ? arr : [])
  }
  function saveSeen(set, target) {
    const arr = Array.from(set)
    writeJson(SEEN_KEY + ':v2:' + encodeURIComponent(target || targetIdentity()), arr.slice(Math.max(0, arr.length - SEEN_MAX)))
  }
  async function sourceIdentity(snap, sid, uid) {
    if (snap.sourceId) return String(snap.sourceId)
    /* 旧备份缺来源库 ID；同一文件两种恢复入口仍使用相同身份。 */
    if (sid === 'vault' || sid === 'vault-local') return 'backup:' + await digestId(JSON.stringify(snap))
    return 'share:' + String(uid || '') + ':' + String(sid || '')
  }
  function legacyFingerprint(t) {
    return JSON.stringify([t.book || '', t.date, t.type, t.amount, t.account, t.currency || '',
      t.toAccount || '', t.toCurrency || '', t.category || '', t.note || ''])
  }

  /* 已部署 v1 写入的标记仍可查验；仅云端实际命中才采信，绝不信任跨账号旧缓存。 */
  function legacyOperation(snap, sid, t) {
    const raw = String(sid || 'snap') + '|' + String(snap.at || '') + '|' + String((snap.transactions || []).length)
    let h = 5381
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) & 0x7fffffff
    return 'sh' + h.toString(36) + ':' + [t.date, t.type, t.amount, t.account, t.toAccount, t.category, t.note].join('|')
  }

  /* 合并一份快照。返回的 stats 里：
       added     真正写成功的笔数（旧字段 transactions 与它相同，兼容老界面）
       dup       确定重复（本机指纹命中，或同一份快照已经落过库）
       invalid   格式不合法 / 找不到账户，压根没尝试写
       failed    写了但失败的笔数 —— 这些**没有**计入去重集合，重试还能补回来
       failedItems  失败明细（指纹 + 备注 + 原因），供界面展示与重试 */
  async function mergeSnapshot(snap, label, sid, uid, opts) {
    const DB = S()
    const target = { mode: DB.mode, uid: DB.state.uid, sourceId: DB.state.sourceId, identity: targetIdentity() }
    const assertTarget = () => {
      if (S() !== DB || DB.mode !== target.mode || DB.state.uid !== target.uid ||
          (target.mode === 'guest' && DB.state.sourceId !== target.sourceId)) {
        const error = new Error('恢复期间账号或本机账本已切换，已停止后续写入，请切回原账号后重试')
        error.code = 'TARGET_CHANGED'
        throw error
      }
    }
    const checked = async operation => {
      assertTarget()
      const result = await operation()
      assertTarget()
      return result
    }
    const stats = {
      book: '', accounts: 0, categories: 0,
      added: 0, transactions: 0, dup: 0, invalid: 0, failed: 0, skipped: 0,
      goals: 0, budgets: 0, batchId: '', failedItems: [], invalidItems: [], bookIds: [], bookNames: [],
    }
    const source = await checked(() => sourceIdentity(snap, sid, uid))
    const batchId = 'sh2-' + await checked(() => digestId(source))
    stats.batchId = batchId
    const entityKey = 'ledger10_snapshot_entities:v2:' + encodeURIComponent(target.identity) + ':' + batchId
    const entities = readJson(entityKey, {}) || {}
    const savedBooks = new Map(Array.isArray(entities.books) ? entities.books : [])
    const savedAccounts = new Map(Array.isArray(entities.accounts) ? entities.accounts : [])
    const savedGoals = new Map(Array.isArray(entities.goals) ? entities.goals : [])
    const savedTransactions = new Map(Array.isArray(entities.transactions) ? entities.transactions : [])
    const saveEntities = () => {
      assertTarget()
      writeJson(entityKey, { books: Array.from(savedBooks), accounts: Array.from(savedAccounts), goals: Array.from(savedGoals), transactions: Array.from(savedTransactions) })
    }

    /* 1) 保留来源账本；label 只是本次恢复/加入的显示名称。旧快照无归属时才用恢复账本。 */
    const bookName = (label || snap.label || '共享账本').slice(0, 20)
    stats.book = bookName
    const bookMap = new Map()
    const booksByName = new Map()
    const usedBooks = new Set()
    const rememberName = (map, name, id) => {
      if (!map.has(name)) map.set(name, id)
      else if (map.get(name) !== id) map.set(name, null) /* 同名歧义不能猜 */
    }
    for (const b of snap.books || []) {
      const mapped = b.id != null ? savedBooks.get(String(b.id)) : null
      let book = mapped != null ? DB.books().find(x => x.id === mapped && !usedBooks.has(x.id)) : null
      if (!book) book = DB.books().find(x => x.name === b.name && !usedBooks.has(x.id))
      if (!book) book = await checked(() => DB.addBook({ name: b.name, icon: b.icon || '📒', sort_order: 90 }))
      if (!book) throw new Error('恢复账本失败，请重试')
      usedBooks.add(book.id)
      if (b.id != null) {
        bookMap.set(String(b.id), book.id)
        savedBooks.set(String(b.id), book.id)
        saveEntities()
      }
      rememberName(booksByName, b.name, book.id)
    }
    /* v1 交易保留了 book 名称，即使 books 列表不完整也可恢复。 */
    for (const item of [].concat(snap.transactions || [], snap.goals || [], snap.budgets || [])) {
      if (!item.book || booksByName.has(item.book)) continue
      let book = DB.books().find(x => x.name === item.book)
      if (!book) book = await checked(() => DB.addBook({ name: item.book, icon: '📒', sort_order: 90 }))
      if (!book) throw new Error('恢复账本失败，请重试')
      booksByName.set(item.book, book.id)
    }
    let fallbackBookId = null
    const bookOf = async item => {
      if (item.book_id != null && bookMap.has(String(item.book_id))) return bookMap.get(String(item.book_id))
      if (item.book && booksByName.get(item.book)) return booksByName.get(item.book)
      if (item.book || item.book_id != null) return null
      const unique = Array.from(new Set(Array.from(booksByName.values()).filter(id => id != null)))
      if (unique.length === 1) return unique[0]
      if (!fallbackBookId) {
        let book = DB.books().find(b => b.name === bookName)
        if (!book) book = await checked(() => DB.addBook({ name: bookName, icon: '📒', sort_order: 90 }))
        fallbackBookId = book ? book.id : DB.defaultBookId()
      }
      return fallbackBookId
    }

    /* 2) 新快照按 ID 映射；旧快照只在名称/币种不歧义时对齐。 */
    const accMap = new Map()
    const accNames = new Map()
    const accNamesCurrency = new Map()
    const usedAccounts = new Set()
    for (const a of snap.accounts || []) {
      const currency = a.currency || 'CNY'
      const mapped = a.id != null ? savedAccounts.get(String(a.id)) : null
      let made = mapped != null ? DB.allAccounts().find(x => x.id === mapped && (x.currency || 'CNY') === currency && !usedAccounts.has(x.id)) : null
      if (!made) made = DB.allAccounts().find(x => x.name === a.name && (x.currency || 'CNY') === currency &&
        (x.kind || 'cash') === (a.kind || 'cash') && (Number(x.initial_balance) || 0) === (Number(a.initial_balance) || 0) && !usedAccounts.has(x.id))
      if (!made) {
        made = await checked(() => DB.addAccount({
          name: a.name, kind: a.kind || 'cash', icon: a.icon || '💰', color: a.color || '#2f6bff',
          currency: currency, initial_balance: a.initial_balance || 0, sort_order: 95,
        }))
        if (made) stats.accounts++
      }
      if (!made) continue
      usedAccounts.add(made.id)
      if (a.id != null) {
        accMap.set(String(a.id), made.id)
        savedAccounts.set(String(a.id), made.id)
        saveEntities()
      }
      rememberName(accNames, a.name, made.id)
      rememberName(accNamesCurrency, JSON.stringify([a.name, currency]), made.id)
    }
    const accountOf = (id, name, currency) => {
      if (id != null) return accMap.get(String(id)) || null
      return currency ? accNamesCurrency.get(JSON.stringify([name, currency])) || null : accNames.get(name) || null
    }

    /* 3) 分类完整路径与类型共同定位，新快照优先稳定 ID。 */
    const catMap = new Map()
    const catPaths = new Map()
    const sourcePaths = new Map()
    const keyOf = (kind, path) => JSON.stringify([kind, path])
    const byName = (kind, name, parent) => (DB.state.categories || []).find(c =>
      c.kind === kind && c.name === name && String(c.parent_id || '') === String(parent || ''))
    let pending = (snap.categories || []).slice()
    while (pending.length) {
      const remaining = []
      let progressed = false
      for (const c of pending) {
        let pid = null
        let parentPath = ''
        if (c.parent_id != null) {
          pid = catMap.get(String(c.parent_id))
          parentPath = sourcePaths.get(String(c.parent_id))
          if (!pid || !parentPath) { remaining.push(c); continue }
        } else if (c.parent) {
          pid = catPaths.get(keyOf(c.kind, c.parent))
          parentPath = c.parent
          if (!pid) { remaining.push(c); continue }
        }
        let made = byName(c.kind, c.name, pid)
        if (!made) {
          made = await checked(() => DB.addCategory({ kind: c.kind, name: c.name, icon: c.icon || '📦', color: c.color || '#8a93a6', parent_id: pid }))
          if (made) stats.categories++
        }
        if (!made) throw new Error('恢复分类失败，请重试')
        const path = parentPath ? parentPath + '/' + c.name : c.name
        if (c.id != null) {
          catMap.set(String(c.id), made.id)
          sourcePaths.set(String(c.id), path)
        }
        rememberName(catPaths, keyOf(c.kind, path), made.id)
        progressed = true
      }
      if (!progressed) throw new Error('备份分类的父级关系不完整，未继续恢复账目')
      pending = remaining
    }
    const catOf = (id, path, kind) => {
      if (id != null) return catMap.get(String(id)) || null
      return path && kind ? catPaths.get(keyOf(kind, path)) || null : null
    }

    /* 4) 交易身份按来源库/记录定位，旧快照按同内容出现次数区分合法重复行。 */
    const seen = seenSet(target.identity)
    const occurrences = new Map()
    const sourceIds = new Set()
    const invalid = (t, fp, message) => {
      stats.invalid++
      stats.invalidItems.push({ fp: fp, note: t.note || '', amount: t.amount, date: t.date || '', err: message })
    }
    for (const t of snap.transactions || []) {
      assertTarget()
      const content = legacyFingerprint(t)
      const occurrence = occurrences.get(content) || 0
      occurrences.set(content, occurrence + 1)
      const identity = t.id != null ? 'id:' + t.id : 'row:' + content + ':' + occurrence
      const fp = batchId + ':' + await checked(() => digestId(identity))
      if (opts && opts.onlyFp && opts.onlyFp.indexOf(fp) < 0) continue
      if (t.id != null && sourceIds.has(String(t.id))) { invalid(t, fp, '备份内交易 ID 重复'); continue }
      if (t.id != null) sourceIds.add(String(t.id))
      const kind = t.type === 'income' ? 'income' : 'expense'
      let catId = catOf(t.category_id, t.category, kind)
      if (t.type !== 'transfer' && !catId) {
        if (t.category_id != null || t.category) { invalid(t, fp, '原分类不存在或名称有歧义，请检查备份分类关系'); continue }
        const fallback = (DB.state.categories || []).find(c => c.kind === kind && !c.parent_id && c.name === '其他')
        catId = fallback ? fallback.id : null
      }
      const accId = accountOf(t.account_id, t.account, t.currency)
      const toId = t.type === 'transfer' ? accountOf(t.to_account_id, t.toAccount, t.toCurrency) : null
      const bookId = await checked(() => bookOf(t))
      const hasAccountRef = t.account_id != null || !!t.account
      if ((!accId && hasAccountRef) || !bookId || (t.type === 'transfer' && (!accId || !toId || toId === accId))) {
        invalid(t, fp, !bookId ? '原账本不存在或名称有歧义' : '原账户/转账目标不存在、币种或名称有歧义')
        continue
      }
      try {
        if (DB.mode === 'cloud' && DB.hasOp) {
          /* 云端必须真实查到记录才算重复；缓存不能证明当前账号仍持有它。 */
          let found = await checked(() => DB.hasOp('transactions', fp))
          if (!found) found = await checked(() => DB.hasOp('transactions', legacyOperation(snap, sid, t)))
          if (!found && (sid === 'vault' || sid === 'vault-local')) {
            found = await checked(() => DB.hasOp('transactions', legacyOperation(snap, sid === 'vault' ? 'vault-local' : 'vault', t)))
          }
          if (found) { stats.dup++; seen.add(fp); continue }
        } else {
          const previousId = savedTransactions.get(fp)
          const existing = previousId != null ? await checked(() => DB.getTransaction(previousId)) : null
          /* 回收站仍保留原记录，尊重用户软删除；物理删除后允许从备份补回。 */
          if (existing) {
            savedTransactions.set(fp, existing.id)
            saveEntities()
            stats.dup++; seen.add(fp); continue
          }
          savedTransactions.delete(fp)
          seen.delete(fp)
        }
        const tags = (Array.isArray(t.tags) ? t.tags : []).filter(tag => typeof tag !== 'string' || tag.slice(0, 4) !== '_op:')
        const row = {
          txn_type: t.type, amount: t.amount, occurred_at: F.iso(F.parseInput(t.date)),
          account_id: accId, to_account_id: toId, category_id: t.type === 'transfer' ? null : catId,
          note: t.note || '', tags: DB.mode === 'cloud' && DB.opTag ? tags.concat([DB.opTag(fp)]) : tags,
          reimbursable: !!t.reimbursable, book_id: bookId,
        }
        const made = await checked(() => DB.addTransaction(row))
        if (made && made.id != null) { savedTransactions.set(fp, made.id); saveEntities() }
        stats.added++
        seen.add(fp)
      } catch (e) {
        assertTarget()
        stats.failed++
        stats.failedItems.push({ fp: fp, note: t.note || '', amount: t.amount, date: t.date || '', err: (e && e.message) || String(e) })
      }
    }
    assertTarget()
    saveSeen(seen, target.identity)
    stats.transactions = stats.added
    stats.skipped = stats.dup + stats.invalid + stats.failed

    /* 5) 独立目标按来源 ID 一一映射，不能吞掉同账本的两个同名目标。 */
    const usedGoals = new Set()
    for (const g of snap.goals || []) {
      const bookId = await checked(() => bookOf(g))
      if (!bookId) continue
      const allGoals = DB.state.goals || DB.listGoals()
      const mapped = g.id != null ? savedGoals.get(String(g.id)) : null
      let made = mapped != null ? allGoals.find(x => x.id === mapped && !usedGoals.has(x.id)) : null
      if (!made) made = allGoals.find(x => !usedGoals.has(x.id) && x.name === g.name &&
        String(x.book_id || DB.defaultBookId()) === String(bookId) &&
        Number(x.target_amount) === Number(g.target_amount) && (Number(x.saved_amount) || 0) === (Number(g.saved_amount) || 0))
      if (!made) {
        made = await checked(() => DB.addGoal({
          name: g.name, icon: g.icon || '🎯', target_amount: g.target_amount || 0,
          saved_amount: g.saved_amount || 0, deadline: g.deadline || null, done: !!g.done, book_id: bookId,
        }))
        if (!made) throw new Error('恢复攒钱目标失败，请重试')
        stats.goals++
      }
      usedGoals.add(made.id)
      if (g.id != null) { savedGoals.set(String(g.id), made.id); saveEntities() }
    }

    /* 6) 预算对齐 月 + 分类 + 账本，恢复后还原用户原来的视图。 */
    const previousBook = DB.activeBookId()
    try {
      for (const b of snap.budgets || []) {
        if (!b.month_key || !b.amount) continue
        const bookId = await checked(() => bookOf(b))
        if (!bookId) continue
        const catId = b.category_id != null || b.category ? catOf(b.category_id, b.category, b.category_kind || 'expense') : null
        if ((b.category_id != null || b.category) && !catId) continue
        assertTarget()
        DB.setActiveBook(bookId)
        if (DB.budgetOf(b.month_key, catId) == null) {
          await checked(() => DB.setBudget(b.month_key, catId, b.amount, bookId))
          stats.budgets++
        }
      }
    } finally {
      if (S() === DB && DB.mode === target.mode && DB.state.uid === target.uid &&
          (target.mode !== 'guest' || DB.state.sourceId === target.sourceId)) DB.setActiveBook(previousBook)
    }
    assertTarget()
    stats.bookIds = Array.from(new Set(Array.from(bookMap.values()).concat(Array.from(booksByName.values()), fallbackBookId).filter(id => id != null)))
    stats.bookNames = stats.bookIds.map(id => (DB.books().find(b => b.id === id) || {}).name || '账本')

    /* 记录到「我加入的」 */
    const joins = joinedShares().filter(x => x.sid !== sid)
    joins.unshift({
      sid: sid, code: buildCode(uid, sid), label: bookName,
      at: new Date().toISOString(), lastAt: new Date().toISOString(),
      count: (snap.transactions || []).length,
    })
    saveJoined(joins)
    return stats
  }

  /* ---------------- 界面 ---------------- */
  function openShareCenter() {
    const mine = myShares()
    const joins = joinedShares()
    const ok = cryptoOk()
    let html = '<div class="sheet-head"><span class="sheet-title">共享账本</span><button id="shClose" class="btn sm line">关闭</button></div>'
    html += '<div class="card"><div class="small muted">把账本加密后发给家人，对方凭共享码加入就能看到你的账目。' +
      '数据以密文存放，只有拿到共享码的人才能解开。</div>' +
      '<div class="small muted" style="margin-top:6px">当前为<b>单向共享</b>：你发布、对方订阅并随时刷新；' +
      '对方的新账目不会自动回到你这边。</div></div>'

    if (!ok) {
      html += '<div class="card"><div class="small" style="color:var(--expense)">当前环境不支持加密（需要 https 或 localhost），无法使用共享账本。</div></div>'
    }

    html += '<div class="divider">我发布的（' + mine.length + '）</div>'
    if (!mine.length) {
      html += '<div class="card"><div class="small muted">还没有发布过共享账本。</div></div>'
    } else {
      html += '<div class="card" style="padding:0">' + mine.map(s =>
        '<div class="list-item" style="align-items:flex-start">' +
        '<div class="grow" style="min-width:0"><div style="font-weight:600">' + F.escapeHtml(s.label) + '</div>' +
        '<div class="small muted">' + (s.count || 0) + ' 笔 · ' + F.isoDay(s.at).slice(0, 10) + ' 发布 · ' + F.bytes(s.bytes || 0) + '</div>' +
        '<div class="tiny" style="word-break:break-all;color:var(--brand);margin-top:2px">' + F.escapeHtml(fmtCode(s.code)) + '</div></div>' +
        '<div style="display:flex;flex-direction:column;gap:4px;flex:none">' +
        '<button class="btn sm line" data-shcopy="' + s.sid + '">复制码</button>' +
        '<button class="btn sm line" data-shlink="' + s.sid + '">复制链接</button>' +
        '<button class="btn sm ghost" data-shupd="' + s.sid + '">更新</button>' +
        '<button class="btn sm danger" data-shrev="' + s.sid + '">撤回</button>' +
        '</div></div>').join('') + '</div>'
    }
    html += '<button class="btn line block" id="shPub" style="margin-bottom:12px">' + ic('upload') + ' 发布 / 更新共享账本</button>'

    html += '<div class="divider">我加入的（' + joins.length + '）</div>'
    if (!joins.length) {
      html += '<div class="card"><div class="small muted">还没有加入别人的共享账本。</div></div>'
    } else {
      html += '<div class="card" style="padding:0">' + joins.map(j =>
        '<div class="list-item" style="align-items:flex-start">' +
        '<div class="grow" style="min-width:0"><div style="font-weight:600">' + F.escapeHtml(j.label) + '</div>' +
        '<div class="small muted">上次刷新 ' + F.isoDay(j.lastAt || j.at).slice(0, 10) + '</div></div>' +
        '<div style="display:flex;flex-direction:column;gap:4px;flex:none">' +
        '<button class="btn sm line" data-shpull="' + F.escapeHtml(j.code) + '">刷新</button>' +
        '<button class="btn sm ghost" data-shleave="' + j.sid + '">移除</button>' +
        '</div></div>').join('') + '</div>'
    }
    html += '<button class="btn block" id="shJoin" style="margin-top:12px">' + ic('key') + ' 用共享码加入</button>'
    html += '<div class="hint">共享内容不含图片凭证；金额与原账户币种一并保留。</div>'

    U().openSheet(html)
    document.getElementById('shClose').addEventListener('click', U().closeSheet)
    document.getElementById('shPub').addEventListener('click', () => openPublishSheet())
    document.getElementById('shJoin').addEventListener('click', () => openJoinSheet())
    document.querySelectorAll('#sheet [data-shcopy]').forEach(b => b.addEventListener('click', () => {
      const s = myShares().find(x => x.sid === b.getAttribute('data-shcopy'))
      if (s) copyText(s.code, '共享码已复制，发给家人即可')
    }))
    document.querySelectorAll('#sheet [data-shlink]').forEach(b => b.addEventListener('click', () => {
      const s = myShares().find(x => x.sid === b.getAttribute('data-shlink'))
      if (!s) return
      const url = location.origin + location.pathname + '#sg=' + encodeURIComponent(s.code)
      copyText(url, '分享链接已复制')
    }))
    document.querySelectorAll('#sheet [data-shupd]').forEach(b => b.addEventListener('click', async () => {
      const s = myShares().find(x => x.sid === b.getAttribute('data-shupd'))
      if (!s) return
      b.disabled = true; b.textContent = '更新中…'
      const r = await publish({ sid: s.sid, label: s.label, scope: s.scope, include: s.inc || null })
      b.disabled = false; b.textContent = '更新'
      if (r.error) { U().toast(r.error); return }
      U().toast('已更新为最新 ' + r.count + ' 笔')
      openShareCenter()
    }))
    document.querySelectorAll('#sheet [data-shrev]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('撤回后，拿到共享码的人将无法再刷新。确定撤回？')) return
      const r = await revoke(b.getAttribute('data-shrev'))
      if (r.error) { U().toast(r.error); return }
      U().toast('已撤回')
      openShareCenter()
    }))
    document.querySelectorAll('#sheet [data-shpull]').forEach(b => b.addEventListener('click', () => {
      doJoin(b.getAttribute('data-shpull'), true)
    }))
    document.querySelectorAll('#sheet [data-shleave]').forEach(b => b.addEventListener('click', () => {
      const sid = b.getAttribute('data-shleave')
      saveJoined(joinedShares().filter(x => x.sid !== sid))
      U().toast('已移除（已导入的账目不受影响）')
      openShareCenter()
    }))
  }

  function copyText(text, okMsg) {
    const done = () => U().toast(okMsg)
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallback())
        return
      }
    } catch (e) { /* 走兜底 */ }
    fallback()
    function fallback() {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        done()
      } catch (e) { U().toast('复制失败，请手动长按选择') }
    }
  }

  function openPublishSheet() {
    const books = S().books()
    const cur = S().activeBookId()
    const curName = cur != null ? S().bookName(cur) : ''
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">发布共享账本</span><button id="pubClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>账本名称（对方会看到这个名字）</label>' +
      '<input id="pubLabel" class="input" maxlength="20" value="' + F.escapeHtml(curName || '家庭账本') + '"></div>' +
      '<div class="field"><label>共享范围</label>' +
      '<select id="pubScope" class="select">' +
      '<option value="all">全部账本的所有账目</option>' +
      (cur != null ? '<option value="book">仅当前账本（' + F.escapeHtml(curName) + '）</option>' : '') +
      '</select></div>' +
      /* 「仅当前账本」时，别的账本的名字、账户余额、预算、目标默认都不发，
         要发得用户自己勾 —— 共享范围必须和「仅当前账本」这句话一致。 */
      '<div id="pubOpts" hidden>' +
      '<div class="divider">这个范围里还有什么</div>' +
      '<label class="row small" style="gap:8px;align-items:center;cursor:pointer;min-height:44px">' +
      '<input type="checkbox" id="pubBal" style="width:20px;height:20px;flex:none"> 包含账户余额（默认不发）</label>' +
      '<label class="row small" style="gap:8px;align-items:center;cursor:pointer;min-height:44px">' +
      '<input type="checkbox" id="pubBud" style="width:20px;height:20px;flex:none"> 包含预算</label>' +
      '<label class="row small" style="gap:8px;align-items:center;cursor:pointer;min-height:44px">' +
      '<input type="checkbox" id="pubGoal" checked style="width:20px;height:20px;flex:none"> 包含攒钱目标</label>' +
      '<label class="row small" style="gap:8px;align-items:center;cursor:pointer;min-height:44px">' +
      '<input type="checkbox" id="pubOtherBook" style="width:20px;height:20px;flex:none"> 包含其他账本的名称</label>' +
      '<div class="card"><div class="small muted" id="pubPrev">正在估算…</div></div>' +
      '</div>' +
      '<div class="card"><div class="small muted">快照会先用共享码派生的密钥加密，再上传到云端共享区。' +
      '对方需要完整共享码才能解开，其他人只能看到密文。</div></div>' +
      '<div class="err" id="pubErr"></div>' +
      '<button class="btn block" id="pubGo">生成并上传</button>'
    )
    document.getElementById('pubClose').addEventListener('click', U().closeSheet)
    const scopeEl = document.getElementById('pubScope')
    const optsEl = document.getElementById('pubOpts')
    const prevEl = document.getElementById('pubPrev')
    const readOpts = () => ({
      includeBalances: !!document.getElementById('pubBal').checked,
      includeBudgets: !!document.getElementById('pubBud').checked,
      includeGoals: !!document.getElementById('pubGoal').checked,
      includeOtherBooks: !!document.getElementById('pubOtherBook').checked,
    })
    const refreshPreview = async () => {
      const onlyBook = scopeEl.value === 'book'
      optsEl.hidden = !onlyBook
      if (!onlyBook) return
      const c = await previewCounts('book', readOpts())
      prevEl.innerHTML = '将发出：<b>' + c.transactions + '</b> 笔账目、<b>' + c.accounts + '</b> 个账户' +
        (c.balances ? '（含余额）' : '（不含余额）') + '、<b>' + c.books + '</b> 个账本名称、<b>' +
        c.goals + '</b> 个目标、<b>' + c.budgets + '</b> 条预算、<b>' + c.categories + '</b> 个分类名。' +
        '其他账本的账目不会出现在这份快照里。'
    }
    scopeEl.addEventListener('change', refreshPreview)
    ;['pubBal', 'pubBud', 'pubGoal', 'pubOtherBook'].forEach(id => {
      document.getElementById(id).addEventListener('change', refreshPreview)
    })
    refreshPreview()
    document.getElementById('pubGo').addEventListener('click', async () => {
      const btn = document.getElementById('pubGo')
      const err = document.getElementById('pubErr')
      err.textContent = ''
      btn.disabled = true
      btn.textContent = '处理中…'
      const r = await publish({
        label: document.getElementById('pubLabel').value.trim() || '家庭账本',
        scope: scopeEl.value,
        include: scopeEl.value === 'book' ? readOpts() : null,
      })
      btn.disabled = false
      btn.textContent = '生成并上传'
      if (r.error) { err.textContent = r.error; return }
      U().openSheet(
        '<div class="sheet-head"><span class="sheet-title">共享已发布</span><button id="pdClose" class="btn sm line">关闭</button></div>' +
        '<div class="card" style="text-align:center"><div style="font-size:34px">' + ic('key') + '</div>' +
        '<div style="font-weight:700;margin-top:4px">把共享码发给家人</div>' +
        '<div class="small muted" style="margin-top:4px">已加密 ' + r.count + ' 笔账目（' + F.bytes(r.bytes) + '）</div></div>' +
        '<div class="card"><div class="small muted" style="margin-bottom:6px">共享码</div>' +
        '<div style="word-break:break-all;font-weight:600;color:var(--brand)">' + F.escapeHtml(r.code) + '</div></div>' +
        '<button class="btn block" id="pdCopy">复制共享码</button>' +
        '<button class="btn line block" id="pdLink" style="margin-top:8px">复制分享链接</button>' +
        '<div class="hint">对方在「共享账本 → 用共享码加入」粘贴即可。链接打开会自动跳到加入页。</div>'
      )
      document.getElementById('pdClose').addEventListener('click', () => { U().closeSheet(); openShareCenter() })
      document.getElementById('pdCopy').addEventListener('click', () => copyText(r.code, '共享码已复制'))
      document.getElementById('pdLink').addEventListener('click', () => {
        copyText(location.origin + location.pathname + '#sg=' + encodeURIComponent(r.code), '分享链接已复制')
      })
    })
  }

  function openJoinSheet(prefill) {
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">加入共享账本</span><button id="jnClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:10px">把家人给你的共享码粘贴到下面。加入后会保留来源账本归属，' +
      '可以随时回来「刷新」拉取最新。</div>' +
      '<div class="field"><label>共享码</label>' +
      '<textarea id="jnCode" class="textarea" rows="3" placeholder="SG1-xxxxxxxx-xxxxxxxxxxxx">' + F.escapeHtml(prefill || '') + '</textarea></div>' +
      '<div class="err" id="jnErr"></div>' +
      '<button class="btn block" id="jnGo">加入并导入</button>'
    )
    document.getElementById('jnClose').addEventListener('click', U().closeSheet)
    document.getElementById('jnGo').addEventListener('click', () => {
      doJoin(document.getElementById('jnCode').value.trim(), false)
    })
  }

  /* 加入/刷新共享账本的结果报告：把「新增 / 已存在 / 不合规 / 写入失败」分开数，
     失败的部分给一个「重试剩余 N 笔」——失败项没有计入去重集合，重试补得回来。 */
  let lastJoin = null
  function joinReportHtml(stats) {
    const esc = F.escapeHtml
    let h = '<div class="card" style="text-align:center"><div style="font-size:34px">' + ic('sparkles') + '</div>' +
      '<div style="font-weight:700;margin-top:4px">「' + esc(stats.book) + '」</div>' +
      '<div class="small muted" style="margin-top:4px">本次写入 ' + stats.added + ' 笔账目</div></div>' +
      '<div class="card">' +
      '<div class="kv"><span>新增账目</span><b class="num" style="color:var(--income)">' + stats.added + ' 笔</b></div>' +
      '<div class="kv"><span>跳过（已存在）</span><b class="num">' + stats.dup + ' 笔</b></div>' +
      (stats.invalid ? '<div class="kv"><span>未导入（关联关系需检查）</span><b class="num">' + stats.invalid + ' 笔</b></div>' : '') +
      (stats.failed ? '<div class="kv"><span style="color:var(--expense)">写入失败</span>' +
        '<b class="num" style="color:var(--expense)">' + stats.failed + ' 笔</b></div>' : '') +
      '<div class="kv"><span>新建账户</span><b class="num">' + stats.accounts + ' 个</b></div>' +
      '<div class="kv"><span>新建分类</span><b class="num">' + stats.categories + ' 个</b></div>' +
      (stats.goals ? '<div class="kv"><span>新建攒钱目标</span><b class="num">' + stats.goals + ' 个</b></div>' : '') +
      (stats.budgets ? '<div class="kv"><span>同步预算</span><b class="num">' + stats.budgets + ' 条</b></div>' : '') +
      '</div>'
    const issues = (stats.invalidItems || []).concat(stats.failedItems || [])
    if (issues.length) {
      h += '<div class="card"><div class="small" style="color:var(--expense);font-weight:600">' +
        '下面 ' + issues.length + ' 笔没有写入，也没有被算成「已存在」；请按原因修正或重试：</div>' +
        issues.slice(0, 5).map(f =>
          '<div class="small muted" style="margin-top:4px">· ' + esc(f.date || '') + ' ' +
          esc(f.note || '(无备注)') + ' —— ' + esc(f.err || '未知原因') + '</div>').join('') +
        (issues.length > 5 ? '<div class="small muted">…等共 ' + issues.length + ' 笔</div>' : '') +
        '</div>'
    }
    h += '<div class="small muted">账目保留在「' + esc((stats.bookNames || [stats.book]).join('、')) + '」，可在顶部切换账本查看。' +
      '同一份快照重复导入不会产生重复账目。</div>' +
      (stats.noBalances ? '<div class="small muted" style="margin-top:4px">这份共享没有包含账户余额，' +
        '导入的账户余额按 0 起算，以你自己这边的实际金额为准。</div>' : '') +
      (stats.failed ? '<button class="btn block" id="jrRetry" style="margin-top:12px">重试剩余 ' + stats.failed + ' 笔</button>' : '') +
      '<button class="btn block" id="jrGo" style="margin-top:12px">查看导入账目</button>'
    return h
  }

  function showJoinReport(stats) {
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (stats.failed || stats.invalid ? '部分账目未写入' : '已加入共享账本') +
      '</span><button id="jrClose" class="btn sm line">关闭</button></div>' + joinReportHtml(stats)
    )
    document.getElementById('jrClose').addEventListener('click', U().closeSheet)
    document.getElementById('jrGo').addEventListener('click', async () => {
      U().closeSheet()
      const ids = stats.bookIds || []
      S().setActiveBook(ids.length === 1 ? ids[0] : null)
      window.App.setTab('home')
    })
    const retry = document.getElementById('jrRetry')
    if (retry) {
      retry.addEventListener('click', async () => {
        if (!lastJoin) return
        retry.disabled = true
        retry.textContent = '重试中…'
        const fps = (lastJoin.failedItems || []).map(f => f.fp).filter(Boolean)
        let st2
        try {
          st2 = await mergeSnapshot(lastJoin.snap, lastJoin.label, lastJoin.sid, lastJoin.uid, { onlyFp: fps })
        } catch (e) {
          retry.disabled = false
          retry.textContent = '重试剩余 ' + stats.failed + ' 笔'
          U().toast('重试失败：' + ((e && e.message) || '请稍后再试'))
          return
        }
        lastJoin.failedItems = st2.failedItems || []
        if (window.App && window.App.refresh) window.App.refresh()
        U().toast(st2.failed ? '仍有 ' + st2.failed + ' 笔没写进去' : '补齐了，全部写入成功')
        showJoinReport(st2)
      })
    }
  }

  async function doJoin(code, silent) {
    const errEl = document.getElementById('jnErr')
    const setErr = m => { if (errEl) errEl.textContent = m; else U().toast(m) }
    const p = parseCode(code)
    if (!p) { setErr('共享码格式不对，请整段复制粘贴'); return }
    const btn = document.getElementById('jnGo')
    if (btn) { btn.disabled = true; btn.textContent = '获取中…' }
    U().toast('正在获取并解密…')
    const r = await fetchSnapshot(code)
    if (btn) { btn.disabled = false; btn.textContent = '加入并导入' }
    if (r.error) { setErr(r.error); return }
    const label = (r.snap.label || '共享账本')
    const btn2 = document.getElementById('jnGo')
    if (btn2) btn2.textContent = '导入中…'
    const n = (r.snap.transactions || []).length
    U().toast('正在导入 ' + n + ' 笔…')
    let stats
    try { stats = await mergeSnapshot(r.snap, label, r.sid, r.uid) } catch (e) { setErr('合并失败：' + (e.message || '')); return }
    if (r.snap && r.snap.balances === false) stats.noBalances = true
    if (window.App && window.App.refresh) window.App.refresh()
    lastJoin = { snap: r.snap, label: label, sid: r.sid, uid: r.uid, failedItems: stats.failedItems || [] }
    showJoinReport(stats)
    if (silent) U().toast('已刷新：新增 ' + stats.added + ' 笔' + (stats.failed ? '，' + stats.failed + ' 笔失败' : ''))
  }

  /* 打开应用时若 URL 带 #sg=xxx 则自动进入加入流程 */
  async function handleUrlHash() {
    const m = /[#&]sg=([^&]+)/.exec(location.hash || '')
    if (!m) return false
    let code = ''
    try { code = decodeURIComponent(m[1]) } catch (e) { code = m[1] }
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { /* 忽略 */ }
    if (!parseCode(code)) return false
    const sess = await session()
    if (!sess || !sess.user) {
      U().toast('请先登录，再用共享码加入家庭账本')
      return true
    }
    openJoinSheet(code)
    return true
  }

  return {
    cryptoOk, buildCode, parseCode, fmtCode,
    encryptJson, decryptJson,
    buildSnapshot, previewCounts,
    myShares, joinedShares, publish, revoke, fetchSnapshot, mergeSnapshot,
    openShareCenter, openPublishSheet, openJoinSheet, handleUrlHash,
  }
})()

