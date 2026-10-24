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
   因为是加密的，即使别人能列出 shared 目录，也只能看到密文。
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
    return c.parent_id ? (S().categoryName(c.parent_id) + '/' + c.name) : c.name
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
    const goals = onlyBook
      ? S().listGoals().filter(g => String(g.book_id || '') === String(bookId))
      : S().listGoals()
    let budgets = S().state.budgets || []
    if (onlyBook) {
      if (!o.includeBudgets) budgets = []
      else budgets = budgets.filter(b => b.category_id == null || used[String(b.category_id)])
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
    const goals = onlyBook
      ? S().listGoals().filter(g => String(g.book_id || '') === String(bookId))
      : S().listGoals()
    /* 预算没有 book_id：只发用户勾选的，且分类预算限本月历里出现过的分类 */
    let budgets = (S().state.budgets || [])
    if (onlyBook) {
      if (!o.includeBudgets) budgets = []
      else {
        const usedCat = {}
        keep.forEach(t => { if (t.category_id != null) usedCat[String(t.category_id)] = 1 })
        budgets = budgets.filter(b => b.category_id == null || usedCat[String(b.category_id)])
      }
    }
    return {
      v: 1,
      at: new Date().toISOString(),
      label: label || '共享账本',
      scope: scope || 'all',
      /* 给解密方一个明示：这份快照含不含余额，别让「0 元」被误读成真没钱 */
      balances: withBal,
      books: books.map(b => ({ name: b.name, icon: b.icon || '📒' })),
      accounts: accs.map(a => ({
        name: a.name, kind: a.kind, icon: a.icon || '💰', color: a.color || '#2f6bff',
        currency: a.currency || 'CNY', initial_balance: withBal ? (Number(a.initial_balance) || 0) : 0,
      })),
      categories: (S().state.categories || []).map(c => ({
        kind: c.kind, name: c.name, icon: c.icon || '', color: c.color || '',
        parent: c.parent_id ? S().categoryName(c.parent_id) : null,
      })),
      transactions: keep.map(t => ({
        date: F.isoLocal(t.occurred_at).slice(0, 16),
        type: t.txn_type,
        amount: Number(t.amount) || 0,
        book: t.book_id ? S().bookName(t.book_id) : '',
        account: t.account_id ? S().accountName(t.account_id) : '',
        toAccount: t.to_account_id ? S().accountName(t.to_account_id) : '',
        category: categoryPath(t.category_id),
        note: t.note || '',
        tags: (t.tags || []).slice(0, 8),
        reimbursable: !!t.reimbursable,
      })),
      goals: goals.map(g => ({
        name: g.name, icon: g.icon || '🎯', target_amount: Number(g.target_amount) || 0,
        saved_amount: Number(g.saved_amount) || 0, deadline: g.deadline || null, done: !!g.done,
      })),
      budgets: budgets.map(b => ({
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
  function fpOf(t) {
    return [t.date, t.type, t.amount, t.account, t.toAccount, t.category, t.note].join('|')
  }
  function seenSet() {
    const arr = readJson(SEEN_KEY, [])
    return new Set(Array.isArray(arr) ? arr : [])
  }
  function saveSeen(set) {
    const arr = Array.from(set)
    writeJson(SEEN_KEY, arr.slice(Math.max(0, arr.length - SEEN_MAX)))
  }

  /* 稳定操作 ID：同一份快照的同一笔账目，无论重试多少次、换设备、清缓存，
     都算出同一个 ID。写进 tags 的 `_op:` 里（用户不可见，cleanTags 会摘掉），
     比只存本机的 seen 集合多一道跨设备防线。 */
  function batchIdOf(snap, sid) {
    const raw = String(sid || 'snap') + '|' + String(snap.at || '') + '|' + String((snap.transactions || []).length)
    let h = 5381
    for (let i = 0; i < raw.length; i++) { h = ((h << 5) + h + raw.charCodeAt(i)) & 0x7fffffff }
    return 'sh' + h.toString(36)
  }

  /* 合并一份快照。返回的 stats 里：
       added     真正写成功的笔数（旧字段 transactions 与它相同，兼容老界面）
       dup       确定重复（本机指纹命中，或同一份快照已经落过库）
       invalid   格式不合法 / 找不到账户，压根没尝试写
       failed    写了但失败的笔数 —— 这些**没有**计入去重集合，重试还能补回来
       failedItems  失败明细（指纹 + 备注 + 原因），供界面展示与重试 */
  async function mergeSnapshot(snap, label, sid, uid, opts) {
    const DB = S()
    const stats = {
      book: '', accounts: 0, categories: 0,
      added: 0, transactions: 0, dup: 0, invalid: 0, failed: 0, skipped: 0,
      goals: 0, budgets: 0, batchId: '', failedItems: [],
    }

    /* 1) 账本 */
    const bookName = (label || snap.label || '共享账本').slice(0, 20)
    let book = DB.books().find(b => b.name === bookName)
    if (!book) {
      book = await DB.addBook({ name: bookName, icon: '👨‍👩‍👧', sort_order: 90 })
    }
    stats.book = bookName
    const bookId = book ? book.id : DB.defaultBookId()

    /* 2) 账户（按名称对齐） */
    const accMap = {}
    for (const a of snap.accounts || []) {
      const hit = DB.allAccounts().find(x => x.name === a.name)
      if (hit) { accMap[a.name] = hit.id; continue }
      const made = await DB.addAccount({
        name: a.name, kind: a.kind || 'cash', icon: a.icon || '💰', color: a.color || '#2f6bff',
        currency: a.currency || 'CNY', initial_balance: a.initial_balance || 0, sort_order: 95,
      })
      if (made) { accMap[a.name] = made.id; stats.accounts++ }
    }

    /* 3) 分类（先建父级，再建子级；按 类型+父级+名称 对齐） */
    const catMap = {}
    const byName = (kind, name, parent) => (DB.state.categories || []).find(c =>
      c.kind === kind && c.name === name && ((c.parent_id || 0) === (parent || 0)))
    const parents = (snap.categories || []).filter(c => !c.parent)
    const children = (snap.categories || []).filter(c => c.parent)
    for (const c of parents) {
      const hit = byName(c.kind, c.name, null)
      if (hit) { catMap[c.kind + '|' + c.name] = hit.id; continue }
      try {
        const made = await DB.addCategory({ kind: c.kind, name: c.name, icon: c.icon || '📦', color: c.color || '#8a93a6', parent_id: null })
        if (made) { catMap[c.kind + '|' + c.name] = made.id; stats.categories++ }
      } catch (e) { /* 单个失败不阻断 */ }
    }
    for (const c of children) {
      const pid = catMap[c.kind + '|' + c.parent]
      if (!pid) continue
      const hit = byName(c.kind, c.name, pid)
      if (hit) { catMap[c.kind + '|' + c.name] = hit.id; continue }
      try {
        const made = await DB.addCategory({ kind: c.kind, name: c.name, icon: c.icon || '', color: c.color || '#8a93a6', parent_id: pid })
        if (made) { catMap[c.kind + '|' + c.name] = made.id; stats.categories++ }
      } catch (e) { /* 忽略 */ }
    }
    const catOf = path => {
      if (!path) return null
      const parts = String(path).split('/')
      if (parts.length >= 2) {
        return catMap['expense|' + path] || catMap['income|' + path] ||
          catMap['expense|' + parts[parts.length - 1]] || catMap['income|' + parts[parts.length - 1]] || null
      }
      return catMap['expense|' + path] || catMap['income|' + path] || null
    }

    /* 4) 账目（指纹去重） */
    const seen = seenSet()
    const batchId = batchIdOf(snap, sid)
    stats.batchId = batchId
    const batch = []
    for (const t of snap.transactions || []) {
      const fp = fpOf(t)
      /* 只重试失败项时，别的行直接放过（它们上次已经处理过，不该重复计数） */
      if (opts && opts.onlyFp && opts.onlyFp.indexOf(fp) < 0) continue
      if (seen.has(fp)) { stats.dup++; continue }
      const kind = t.type === 'income' ? 'income' : 'expense'
      let catId = catOf(t.category)
      if (!catId) {
        const fallback = (DB.state.categories || []).find(c => c.kind === kind && !c.parent_id && c.name === '其他')
        catId = fallback ? fallback.id : null
      }
      const accId = accMap[t.account] || (DB.accounts()[0] ? DB.accounts()[0].id : null)
      if (!accId) { stats.invalid++; continue }
      const toId = t.type === 'transfer' ? (accMap[t.toAccount] || null) : null
      if (t.type === 'transfer' && (!toId || toId === accId)) { stats.invalid++; continue }
      /* 跨设备防线：同一份快照的同一笔，别的地方已经落过库了。
         ⚠️ 只有云端后端认 `_op:` 标记（hasOp 真实生效）；游客侧没有跨设备一说，
         硬写标记只会污染本机标签栏，所以游客模式不加。 */
      const opId = batchId + ':' + fp
      if (DB.mode === 'cloud' && DB.hasOp) {
        try {
          if (await DB.hasOp('transactions', opId)) { stats.dup++; seen.add(fp); continue }
        } catch (e) { /* 查不动就按新账目写，交给下面的 try 兜底 */ }
      }
      const row = {
        txn_type: t.type,
        amount: t.amount,
        occurred_at: F.iso(F.parseInput(t.date)),
        account_id: accId,
        to_account_id: toId,
        category_id: t.type === 'transfer' ? null : catId,
        note: t.note || '',
        tags: DB.mode === 'cloud' && DB.opTag ? (t.tags || []).concat([DB.opTag(opId)]) : (t.tags || []),
        reimbursable: !!t.reimbursable,
        book_id: bookId,
      }
      batch.push({ row: row, fp: fp, note: t.note || '', amount: t.amount, date: t.date })
    }
    for (const item of batch) {
      try {
        await DB.addTransaction(item.row)
        stats.added++
        /* 只有真正落库了才记住这个指纹：失败的留着，重试时还能再试 */
        seen.add(item.fp)
      } catch (e) {
        stats.failed++
        stats.failedItems.push({
          fp: item.fp, note: item.note || '', amount: item.amount, date: item.date || '',
          err: (e && e.message) || String(e),
        })
      }
    }
    /* seen 里现在只有「确实在库里」的指纹，写回本机是安全的 */
    saveSeen(seen)
    /* 老界面/老测试读的 transactions = 真正写成功的笔数 */
    stats.transactions = stats.added
    /* 老界面/老测试读的 skipped = 重复 + 不合法 + 失败 */
    stats.skipped = stats.dup + stats.invalid + stats.failed

    /* 5) 攒钱目标（按名称对齐） */
    for (const g of snap.goals || []) {
      const hit = DB.listGoals().find(x => x.name === g.name)
      if (hit) continue
      try {
        await DB.addGoal({
          name: g.name, icon: g.icon || '🎯', target_amount: g.target_amount || 0,
          saved_amount: g.saved_amount || 0, deadline: g.deadline || null, done: !!g.done,
          book_id: bookId,
        })
        stats.goals++
      } catch (e) { /* 忽略 */ }
    }

    /* 6) 预算（按月 + 分类对齐） */
    for (const b of snap.budgets || []) {
      if (!b.month_key || !b.amount) continue
      const catId = b.category ? catOf(b.category) : null
      try {
        if (DB.budgetOf(b.month_key, catId) == null) {
          await DB.setBudget(b.month_key, catId, b.amount)
          stats.budgets++
        }
      } catch (e) { /* 忽略 */ }
    }

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
    html += '<div class="hint">共享内容不含图片凭证；金额按「分」原样传递，账户币种一并带过来。</div>'

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
      '<div class="small muted" style="margin-bottom:10px">把家人给你的共享码粘贴到下面。加入后账目会合并到一个独立账本里，' +
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
      (stats.invalid ? '<div class="kv"><span>不合规（缺账户/转账目标）</span><b class="num">' + stats.invalid + ' 笔</b></div>' : '') +
      (stats.failed ? '<div class="kv"><span style="color:var(--expense)">写入失败</span>' +
        '<b class="num" style="color:var(--expense)">' + stats.failed + ' 笔</b></div>' : '') +
      '<div class="kv"><span>新建账户</span><b class="num">' + stats.accounts + ' 个</b></div>' +
      '<div class="kv"><span>新建分类</span><b class="num">' + stats.categories + ' 个</b></div>' +
      (stats.goals ? '<div class="kv"><span>新建攒钱目标</span><b class="num">' + stats.goals + ' 个</b></div>' : '') +
      (stats.budgets ? '<div class="kv"><span>同步预算</span><b class="num">' + stats.budgets + ' 条</b></div>' : '') +
      '</div>'
    if (stats.failed && stats.failedItems && stats.failedItems.length) {
      h += '<div class="card"><div class="small" style="color:var(--expense);font-weight:600">' +
        '下面 ' + stats.failedItems.length + ' 笔没有写入，也没有被算成「已存在」，重试即可补回：</div>' +
        stats.failedItems.slice(0, 5).map(f =>
          '<div class="small muted" style="margin-top:4px">· ' + esc(f.date || '') + ' ' +
          esc(f.note || '(无备注)') + ' —— ' + esc(f.err || '未知原因') + '</div>').join('') +
        (stats.failedItems.length > 5 ? '<div class="small muted">…等共 ' + stats.failedItems.length + ' 笔</div>' : '') +
        '</div>'
    }
    h += '<div class="small muted">账目已归到账本「' + esc(stats.book) + '」，在顶部账本切换里可以单独查看。' +
      '同一份快照重复导入不会产生重复账目。</div>' +
      (stats.noBalances ? '<div class="small muted" style="margin-top:4px">这份共享没有包含账户余额，' +
        '导入的账户余额按 0 起算，以你自己这边的实际金额为准。</div>' : '') +
      (stats.failed ? '<button class="btn block" id="jrRetry" style="margin-top:12px">重试剩余 ' + stats.failed + ' 笔</button>' : '') +
      '<button class="btn block" id="jrGo" style="margin-top:12px">去看这个账本</button>'
    return h
  }

  function showJoinReport(stats) {
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + (stats.failed ? '部分账目未写入' : '已加入共享账本') +
      '</span><button id="jrClose" class="btn sm line">关闭</button></div>' + joinReportHtml(stats)
    )
    document.getElementById('jrClose').addEventListener('click', U().closeSheet)
    document.getElementById('jrGo').addEventListener('click', async () => {
      U().closeSheet()
      const b = S().books().find(x => x.name === stats.book)
      if (b) { S().setActiveBook(b.id); window.App.setTab('home') }
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
