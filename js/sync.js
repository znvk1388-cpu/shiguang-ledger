/* ============================================================
 * 同步状态、待上传队列与冲突处理（js/sync.js · window.Sync）
 * ------------------------------------------------------------
 * 同步模型：登录态是「在线优先」，每次写入直接打云端。
 * 真正要兜住的是四件事：
 *   1) 断网时写入失败 —— 失败的写操作进「待上传队列」，联网后可重试；
 *   2) 响应丢失 —— 请求其实落库了但响应没回来，重试不能变成两条。
 *      做法：写入前给这一笔盖一个稳定的客户端操作 ID（`_op:<id>` 写进 tags），
 *      重试前先按该 ID 查一次，查到就判定「已写入」并出队。
 *      不用「同日期+金额+账户+备注」判重 —— 那会把真实的同额消费误吞。
 *   3) 多设备不一致 —— 回到前台/联网恢复时对齐云端（见「自动拉取」段）。
 *   4) 串账号 —— 队列与水位一律按「数据所有者」命名空间隔离：
 *      `guest` 是本机游客账本，`u:<uid>` 是某个登录账号。
 *      旧版无主的全局队列绝不自动认领（见「旧队列」段）。
 * 面板 UI 在 js/sync-sheet.js（懒加载）。
 * ============================================================ */
window.Sync = (function () {
  const F = window.Fmt
  const U = () => window.UI

  /* 命名空间：所有队列/水位键都带所有者后缀 */
  const NS = 'ledger10_sync2'
  const LEGACY_OUT = 'ledger10_outbox'      /* v1.7.0 及以前的全局键，无主 */
  const LEGACY_MARK = 'ledger10_sync_mark'
  const OUT_MAX = 500                        /* 硬上限：到顶后拒绝入队并明确告知，绝不静默丢弃 */

  const OP_TAG = '_op:'

  /* 运行时状态（集中声明，避免 TDZ 陷阱） */
  let retrying = false       /* 重试进行中：抑制写钩子再次入队 */
  let lastPull = 0
  let lastWriteAt = 0
  let lastError = ''
  let pullTimer = null
  let pulling = false

  const WRITES = [
    'addTransaction', 'updateTransaction', 'deleteTransaction', 'restoreTransaction', 'purgeTransaction',
    'addAccount', 'updateAccount', 'deleteAccount', 'addCategory', 'deleteCategory',
    'addBook', 'renameBook', 'deleteBook',
    'setBudget', 'addGoal', 'updateGoal', 'deleteGoal', 'goalDeposit',
    'addRecurring', 'updateRecurring', 'deleteRecurring',
    'addTemplate', 'updateTemplate', 'deleteTemplate',
    'addAttachments', 'removeAttachment',
  ]
  /* 这些操作重放时会新建记录，需要幂等保护 */
  const CREATES = { addTransaction: 1, addAccount: 1, addCategory: 1, addBook: 1, addGoal: 1, addRecurring: 1, addTemplate: 1, addAttachments: 1 }
  /* 删除类操作：重放时如果行已经不在了，说明目的早已达成，按成功出队处理 */
  const DELETES = { deleteTransaction: 1, purgeTransaction: 1, deleteAccount: 1, deleteCategory: 1, deleteBook: 1, deleteGoal: 1, deleteRecurring: 1, deleteTemplate: 1, removeAttachment: 1 }
  /* 只有带 tags 的表能盖行内操作标记；其余命名实体用同名判定 */
  const STAMPED = { addTransaction: 'transactions', addRecurring: 'recurring_rules' }

  const LABEL = {
    addTransaction: '新增账目', updateTransaction: '修改账目', deleteTransaction: '删除账目',
    restoreTransaction: '恢复账目', purgeTransaction: '彻底删除账目',
    addAccount: '新增账户', updateAccount: '修改账户', deleteAccount: '删除账户',
    addCategory: '新增分类', deleteCategory: '删除分类',
    addBook: '新增账本', renameBook: '重命名账本', deleteBook: '删除账本',
    setBudget: '设置预算', addGoal: '新增目标', updateGoal: '修改目标', deleteGoal: '删除目标', goalDeposit: '目标存入',
    addRecurring: '新增周期规则', updateRecurring: '修改周期规则', deleteRecurring: '删除周期规则',
    addTemplate: '新增模板', updateTemplate: '修改模板', deleteTemplate: '删除模板',
    addAttachments: '上传凭证', removeAttachment: '删除凭证',
  }

  /* ---------------- 小工具 ---------------- */
  function readJson(key, fb) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fb : v } catch (e) { return fb }
  }
  function writeJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true } catch (e) { return false }
  }
  function online() {
    try { return navigator.onLine !== false } catch (e) { return true }
  }
  function isNetworkError(e) {
    /* 冲突和本地确定性校验失败都不是网络问题。
       必须放在最前面：某些环境下 navigator.onLine 会误报 false，
       若走到最后那行 `!online()` 就会把冲突当成网络失败塞进待上传队列。 */
    if (e && ['CONFLICT', 'CROSS_CURRENCY_TRANSFER', 'TRANSFER_ACCOUNT_REQUIRED', 'REPLAY_CONTEXT_REQUIRED'].indexOf(e.code) >= 0) return false
    const m = String((e && (e.message || e.error_description || e.details || e)) || '')
    if (/Failed to fetch|NetworkError|network|fetch failed|ERR_|ECONN|timeout|timed out|aborted|offline/i.test(m)) return true
    return !online()
  }
  function newId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) { /* 忽略 */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }

  /* ---------------- 数据所有者 ----------------
     '' 表示「当前没有可归属的身份」（云端模式但拿不到 uid）——这时一律不写队列，
     宁可让调用方报错，也不要把操作落到一个不属于任何账号的桶里。 */
  function owner() {
    const DB = window.DB
    if (!DB) return ''
    if (DB.mode !== 'cloud') return 'guest'
    const uid = DB.state && DB.state.uid
    return uid ? 'u:' + uid : ''
  }
  function outKey(o) { return NS + ':out:' + o }
  function markKey(o) { return NS + ':mark:' + o }

  /* ---------------- 待上传队列 ---------------- */
  function outbox(o) {
    const own = o || owner()
    if (!own) return []
    const v = readJson(outKey(own), [])
    return Array.isArray(v) ? v : []
  }
  function saveOutbox(own, list) { return writeJson(outKey(own), list || []) }
  function outboxCount(o) { return outbox(o).length }

  /* 入队。返回 null 表示没能入队（没有身份 / 队列已满），调用方必须如实告知用户。
     args 做一次深拷贝：调用方（尤其是批量脚本）之后继续改同一个对象，
     不应污染已经入队的载荷。 */
  function enqueue(method, args, err, opId) {
    const own = owner()
    if (!own) return null
    const list = outbox(own)
    if (list.length >= OUT_MAX) return null
    let snap = args
    try { snap = JSON.parse(JSON.stringify(args || [])) } catch (e) { snap = (args || []).slice() }
    const item = {
      id: newId(),
      opId: opId || newId(),
      owner: own,
      method: method,
      args: snap,
      at: new Date().toISOString(),
      tries: 0,
      state: 'pending',
      msg: String((err && (err.message || err)) || '网络异常').slice(0, 160),
    }
    list.push(item)
    return saveOutbox(own, list) ? item : null
  }

  function drop(id) {
    const own = owner()
    if (!own) return
    saveOutbox(own, outbox(own).filter(x => x.id !== id))
  }
  function clearOutbox() {
    const own = owner()
    if (own) saveOutbox(own, [])
  }

  /* 重试失败只更新这一条的状态，不再入队 —— 避免「越重试越多」 */
  function failItem(own, id, e) {
    const list = outbox(own)
    const it = list.find(x => x.id === id)
    if (!it) return
    it.tries = (it.tries || 0) + 1
    it.lastTryAt = new Date().toISOString()
    /* 冲突不是「网络失败」—— 再重试一百次也不会成功，必须由人决定保留哪一版 */
    it.state = (e && e.code === 'CONFLICT') ? 'conflict'
      : (e && e.code === 'REPLAY_CONTEXT_REQUIRED') ? 'review' : 'failed'
    it.msg = String((e && (e.message || e)) || '网络异常').slice(0, 160)
    saveOutbox(own, list)
  }

  /* ---------------- 幂等：稳定操作 ID ---------------- */
  /* 发请求前把 `_op:<opId>` 盖进参数，「请求落库但响应丢了」的重试据此认出已写入。
     ⚠️ 只盖云端模式：游客模式没有待上传队列也没有第二台设备，盖了只会把内部
     标记写进本机标签栏（游客侧读回来不摘标记）。 */
  function stampOp(name, args, opId) {
    if (!STAMPED[name]) return
    if (window.DB && window.DB.mode !== 'cloud') return
    const a = args && args[0]
    if (!a || typeof a !== 'object') return
    const t = Array.isArray(a.tags) ? a.tags.slice() : []
    let savedId = ''
    for (let i = 0; i < t.length; i++) {
      if (typeof t[i] === 'string' && t[i].slice(0, OP_TAG.length) === OP_TAG) {
        savedId = t[i].slice(OP_TAG.length)
        break
      }
    }
    if (!savedId) t.push(OP_TAG + opId)
    /* 不污染调用方的对象：编辑器还会用原 payload 创建周期规则，
       那是另一次操作，不应继承首笔交易的操作 ID。 */
    args[0] = Object.assign({}, a, { tags: t })
    return savedId || opId
  }

  function freezeWriteContext(name, args, DB) {
    if (DB.mode !== 'cloud') return
    if (name === 'setBudget' && args[3] == null) args[3] = DB.currentBookId()
    if (name === 'goalDeposit' && args[2] == null) {
      const g = (DB.state.goals || []).find(x => x.id === args[0])
      if (g) args[2] = Number(g.saved_amount)
    }
  }

  function replayContextError(item) {
    const a = item.args || []
    let message = ''
    if (item.method === 'setBudget' && a[3] == null) {
      message = '这条旧预算没有记录原账本，无法安全重试。请回到原账本核对预算，必要时重新设置，再丢弃这条旧记录'
    }
    if (item.method === 'goalDeposit' && a[2] == null) {
      message = '这条旧目标操作没有记录原余额，无法安全重试。请先刷新核对目标余额，必要时重新操作，再丢弃这条旧记录'
    }
    if (!message) return null
    const e = new Error(message)
    e.code = 'REPLAY_CONTEXT_REQUIRED'
    return e
  }

  /* 这个操作是不是已经落库了。无法查询时必须停止重试，不能假定未写入。 */
  async function alreadySaved(item) {
    const DB = window.DB
    const table = STAMPED[item.method]
    if (item.opId && table && DB.hasOp) {
      return await DB.hasOp(table, item.opId)
    }
    /* 命名实体（账户/分类/账本/目标）：同名 + 创建时间晚于入队时刻才算已写入。
       只按同名判重会把「用户合法创建的第二个同名账户」误吞 —— 重试之前
       队列里这条操作明明失败过，此时却多了一个同名老记录，必须排除。 */
    const a = item.args || []
    const x = a[0] || {}
    const afterEnqueue = function (z) {
      if (!z || !z.created_at || !item.at) return true   /* 没有时间戳可比，退回旧行为 */
      return String(z.created_at) >= String(item.at)
    }
    try {
      if (item.method === 'addAccount') return DB.allAccounts().some(z => z.name === x.name && afterEnqueue(z))
      if (item.method === 'addCategory') return (DB.state.categories || []).some(z => z.name === x.name && z.kind === x.kind && afterEnqueue(z))
      if (item.method === 'addBook') return DB.books().some(z => z.name === x.name && afterEnqueue(z))
      if (item.method === 'addGoal') return DB.listGoals().some(z => z.name === x.name && afterEnqueue(z))
      if (item.method === 'addAttachments') {
        /* attachments 表没有 tags 列，按 storage_path 判重（重传同一路径只会有一条） */
        const paths = (a[1] || []).map(f => f && f.path).filter(Boolean)
        if (!paths.length) return false
        const db2 = window.Cloud && window.Cloud.cloud && window.Cloud.cloud.database
        if (!db2) throw new Error('无法连接云端查重')
        const r = await db2.from('attachments').select('id').in('storage_path', paths).limit(1)
        if (r.error) throw r.error
        return !!(r.data && r.data.length)
      }
    } catch (e) { throw e }
    return false
  }

  /* ---------------- 重试 ---------------- */
  async function retryOne(id) {
    const own = owner()
    if (!own) return { error: '当前没有登录身份，无法重试' }
    const item = outbox(own).find(x => x.id === id)
    if (!item) return { error: '这条记录已经不在队列里了' }
    /* 身份核对：绝不能把 A 账号的操作重放到 B 账号或游客账本 */
    if (item.owner && item.owner !== own) return { error: '这条待上传属于另一个账号，不能在当前账号重放' }
    const DB = window.DB
    if (!DB || typeof DB[item.method] !== 'function') return { error: '当前版本不支持重试「' + (LABEL[item.method] || item.method) + '」' }
    if (DB.mode !== 'cloud') return { error: '当前不是登录模式，无法上传到云端' }
    const contextError = replayContextError(item)
    if (contextError) {
      failItem(own, id, contextError)
      return { error: contextError.message }
    }

    if (CREATES[item.method]) {
      let dup
      try { dup = await alreadySaved(item) } catch (e) {
        failItem(own, id, e)
        return { error: '无法完成查重，请检查网络并核对云端后再重试' }
      }
      if (owner() !== own) return { error: '账号已切换，请回到原账号核对待上传操作' }
      if (dup) { drop(id); return { ok: true, skipped: true, label: LABEL[item.method] || item.method } }
    }
    if (owner() !== own) return { error: '账号已切换，请回到原账号核对待上传操作' }
    retrying = true
    try {
      await DB[item.method].apply(DB, item.args || [])
      if (owner() !== own) {
        const e = new Error('重试期间账号已切换，结果待核对；请回到原账号检查云端后再处理')
        e.code = 'REPLAY_CONTEXT_REQUIRED'
        failItem(own, id, e)
        return { error: e.message }
      }
      drop(id)
      markWrite()
      return { ok: true, label: LABEL[item.method] || item.method }
    } catch (e) {
      if (owner() !== own) {
        const uncertain = new Error('重试期间账号已切换，结果待核对；请回到原账号检查云端后再处理')
        uncertain.code = 'REPLAY_CONTEXT_REQUIRED'
        failItem(own, id, uncertain)
        return { error: uncertain.message }
      }
      failItem(own, id, e)
      /* 删除类操作重放时「行已经不在」= 目的早已达成（上次其实删成了），
         按成功出队，而不是永远挂着一条重试不动的失败项 */
      if (e && e.code === 'RLS_NO_ROWS' && DELETES[item.method]) {
        drop(id)
        return { ok: true, skipped: true, label: LABEL[item.method] || item.method }
      }
      if (e && e.code === 'CONFLICT') {
        return { conflict: true, error: item.method === 'goalDeposit' ? e.message
          : '这条在云端已被其他设备改过，重试不会生效，需要你选择保留哪一版' }
      }
      return { error: '重试仍然失败：' + ((e && e.message) || '网络异常') }
    } finally { retrying = false }
  }

  async function retryAll() {
    const own = owner()
    if (!own) return { ok: 0, skipped: 0, fail: 0, left: 0, error: '当前没有登录身份' }
    const list = outbox(own).slice()
    let ok = 0, skipped = 0, fail = 0, conflict = 0
    for (const it of list) {
      /* 「待核对」与「已冲突」都不参与批量重试：
         前者来自旧版无主队列，必须人工核对；后者再试也不会成功，得由人决定保留哪一版 */
      if (it.state === 'review') { fail++; continue }
      if (it.state === 'conflict') { conflict++; continue }
      if (it.owner && it.owner !== owner()) { fail++; continue }
      const r = await retryOne(it.id)
      if (r.conflict) { conflict++; continue }
      if (r.error) { fail++; continue }
      if (r.skipped) skipped++; else ok++
    }
    return { ok: ok, skipped: skipped, fail: fail, conflict: conflict, left: outboxCount() }
  }

  /* ---------------- 旧版无主队列 ----------------
     v1.7.0 及以前把队列存在全局键里，没有所属账号。
     这些条目可能是任何账号（甚至已登出的账号）留下的，绝不自动认领 ——
     只保留、只展示，由用户核对后显式「认领到当前账号」或丢弃。 */
  function legacyOutbox() {
    const v = readJson(LEGACY_OUT, [])
    return Array.isArray(v) ? v : []
  }
  function legacyCount() { return legacyOutbox().length }
  function dropLegacy(id) { writeJson(LEGACY_OUT, legacyOutbox().filter(x => x.id !== id)) }
  function clearLegacy() {
    try { localStorage.removeItem(LEGACY_OUT) } catch (e) { /* 忽略 */ }
  }
  function adoptLegacy() {
    const own = owner()
    /* 旧队列里存的是「登录状态下没传上去的写操作」，只能由登录账号认领：
       在游客账本里认领只会把它们放进 guest 桶，之后既重试不了、登录后又看不见，
       等于把用户的数据悄悄弄丢。所以这里明确拒绝，并告诉用户先登录。 */
    if (!own || own === 'guest') return { error: '请先登录账号再认领：旧队列里是登录状态下的待上传操作' }
    const old = legacyOutbox()
    if (!old.length) return { ok: true, moved: 0 }
    const list = outbox(own)
    if (list.length + old.length > OUT_MAX) return { error: '当前账号的待上传队列空间不足，请先处理已有条目' }
    for (const it of old) {
      list.push({
        id: newId(),
        opId: newId(),
        owner: own,
        method: it.method,
        args: it.args || [],
        at: it.at || new Date().toISOString(),
        tries: 0,
        state: 'review',
        msg: '来自旧版本队列（无账号标记），请核对后再逐条重试',
      })
    }
    if (!saveOutbox(own, list)) return { error: '本机存储写入失败，未认领' }
    clearLegacy()
    return { ok: true, moved: old.length }
  }

  /* ---------------- 水位标记（同样按账号隔离） ---------------- */
  function mark() {
    const own = owner()
    if (!own) return {}
    return readJson(markKey(own), {}) || {}
  }
  function saveMark(m) {
    const own = owner()
    if (!own) return false
    return writeJson(markKey(own), m || {})
  }
  function markWrite() {
    const m = mark()
    m.localAt = new Date().toISOString()
    m.localWrites = (m.localWrites || 0) + 1
    saveMark(m)
    lastWriteAt = Date.now()
  }
  /* 只有「数据真的拉下来并应用成功」之后才允许调用 */
  function markPull(cloudAt, cloudCount, cloudSig) {
    const m = mark()
    m.checkedAt = new Date().toISOString()
    m.cloudAt = cloudAt || ''
    m.cloudCount = cloudCount || 0
    if (cloudSig != null) m.cloudSig = cloudSig
    saveMark(m)
  }

  /* ---------------- 安装写操作钩子 ---------------- */
  function install() {
    const DB = window.DB
    if (!DB) return
    WRITES.forEach(name => {
      const orig = DB[name]
      if (typeof orig !== 'function') return
      if (orig.__syncWrapped) return          /* 已经包过，别重复包（会套娃） */
      const wrapped = function () {
        const args = [].slice.call(arguments)
        freezeWriteContext(name, args, DB)
        /* 先盖操作 ID，再发请求 —— 否则响应丢失时无从判定是否已写入 */
        let opId = newId()
        if (CREATES[name]) opId = stampOp(name, args, opId) || opId
        let p
        try { p = orig.apply(DB, args) } catch (e) { p = Promise.reject(e) }
        if (!p || typeof p.then !== 'function') return p
        return p.then(
          r => { if (DB.mode === 'cloud') markWrite(); return r },
          e => {
            /* 冲突是服务端明确答复的结果，不是网络问题 —— 绝不入队，
               否则会被当成「待上传」反复重放。原样抛给界面去弹对比。 */
            if (e && e.code === 'CONFLICT') throw e
            /* 只处理云端模式下的网络类失败；逻辑错误原样抛出，不污染队列。
               retrying 期间不再入队 —— 重试失败由 failItem 更新原条目。 */
            if (DB.mode === 'cloud' && !retrying && isNetworkError(e)) {
              const it = enqueue(name, args, e, opId)
              const err = new Error(it
                ? '网络异常，暂未确认云端是否保存。已放进「待上传」，联网后可在 我的 → 数据与同步 里核对并重试'
                : '网络异常，暂未确认云端是否保存，且本机待上传队列已满（上限 ' + OUT_MAX + ' 条），请先到 我的 → 数据与同步 处理')
              err.__queued = !!it
              err.cause = e
              throw err
            }
            throw e
          }
        )
      }
      wrapped.__syncWrapped = true
      wrapped.__syncName = name
      DB[name] = wrapped
    })
  }

  /* ---------------- 状态检查 ---------------- */
  async function inspect() {
    const DB = window.DB
    const own = owner()
    const mode = DB && DB.mode === 'cloud' ? 'cloud' : 'guest'
    const out = {
      mode: mode, owner: own, online: online(),
      outbox: outboxCount(), at: new Date().toISOString(),
      legacy: legacyCount(), lastError: lastError || '',
    }
    try { out.localTxns = (await DB.listTransactions({ limit: 1, ignoreBook: true })).total || 0 } catch (e) { out.localTxns = -1 }
    out.accounts = (DB.allAccounts ? DB.allAccounts().length : 0)
    out.books = (DB.books ? DB.books().length : 0)

    if (mode === 'cloud') {
      try {
        const db = window.Cloud.cloud.database
        /* 与本机计数同口径：都不含回收站行，否则 diff 永远偏差、误导用户「云端多 N 笔」 */
        const cnt = await db.from('transactions').select('id', { count: 'exact' }).is('deleted_at', null).limit(1)
        out.cloudTxns = cnt.count || 0
        const last = await db.from('transactions').select('updated_at').order('updated_at', { ascending: false }).limit(1)
        out.cloudAt = (last.data && last.data[0] && last.data[0].updated_at) || ''
      } catch (e) { out.cloudError = (e && e.message) || '读取云端失败' }
      const m = mark()
      out.lastPullAt = m.cloudAt || ''
      out.localAt = m.localAt || ''
      out.behind = !!(out.cloudAt && out.lastPullAt && out.cloudAt > out.lastPullAt)
      out.diff = (out.cloudTxns != null && out.localTxns >= 0) ? (out.cloudTxns - out.localTxns) : null
    }
    return out
  }

  /* ---------------- 自动拉取（多设备一致性） ----------------
     只探 transactions 是不够的：另一台设备只改了预算/账户/分类时，
     账目水位根本不动，这台就永远看不到。所以指纹要覆盖所有会被同步的表。
     做法：5 张「小表」直接整表取回（个人账本量级很小）算指纹，
     账目只取「按 updated_at 倒序的前 20 条 + 总数」——足以捕捉新增、
     软删除和近期修改，又不用把整本账拉回来。指纹变了才真正重拉并重绘。 */
  const FP_TABLES = ['accounts', 'categories', 'budgets', 'books', 'savings_goals']
  const PULL_GAP = 8000       /* 两次自动拉取最短间隔 */
  const WRITE_GUARD = 12000   /* 本机写入后多久内不自动拉取 */
  const POLL_MS = 45000       /* 可见期间轮询间隔 */

  function h32(s) {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  async function fingerprint() {
    const db = window.Cloud && window.Cloud.cloud && window.Cloud.cloud.database
    if (!db) return null
    const res = await Promise.all(FP_TABLES.map(t => db.from(t).select('*')))
    const parts = []
    for (let i = 0; i < res.length; i++) {
      if (res[i].error) return null
      const rows = res[i].data || []
      parts.push(FP_TABLES[i] + '.' + rows.length + '.' + h32(JSON.stringify(rows)))
    }
    const t = await db.from('transactions').select('id,updated_at', { count: 'exact' })
      .order('updated_at', { ascending: false }).limit(20)
    if (t.error) return null
    const rows = t.data || []
    parts.push('txn.' + (t.count || 0) + '.' + h32(rows.map(x => x.id + ':' + x.updated_at).join(',')))
    return { sig: parts.join('|'), at: (rows[0] && rows[0].updated_at) || '', count: t.count || 0 }
  }

  /* 错误必须向上抛：拉取失败却写水位、还提示成功，是比不同步更糟的事 */
  async function reloadAll() {
    const DB = window.DB
    if (!DB) throw new Error('数据层未就绪')
    if (DB.mode !== 'cloud') throw new Error('当前不是登录模式')
    await DB.init(DB.state.uid)
    if (window.App && window.App.refresh) await window.App.refresh()
  }

  /* force=true 时不看指纹直接重拉（供面板「以云端为准」用） */
  async function autoPull(reason, force) {
    if (pulling) return { skipped: 'busy' }
    if (!window.DB || window.DB.mode !== 'cloud') return { skipped: 'guest' }
    if (!online()) return { skipped: 'offline' }
    /* 正在编辑弹层时不重绘，避免把用户填了一半的表单刷掉 */
    if (!force && document.body && document.body.classList.contains('sheet-open')) return { skipped: 'editing' }
    const now = Date.now()
    if (!force && now - lastPull < PULL_GAP) return { skipped: 'throttled' }
    if (!force && now - lastWriteAt < WRITE_GUARD) return { skipped: 'just-wrote' }
    pulling = true
    lastPull = Date.now()
    try {
      const fp = await fingerprint()
      if (!fp) { lastError = '无法读取云端状态（网络或权限问题）'; return { error: lastError } }
      const m = mark()
      /* 旧版水位没有指纹 → 当作「变了」，强制对齐一次，之后就有指纹可比 */
      if (!force && m.cloudSig && m.cloudSig === fp.sig) return { ok: true, changed: false }
      await reloadAll()                       /* 失败会抛出，下面不会执行 */
      markPull(fp.at, fp.count, fp.sig)       /* 只有真的拉下来并应用成功才写水位 */
      lastError = ''
      const pend = outboxCount()
      if (reason !== 'poll' && reason !== 'boot' && U() && U().toast) {
        U().toast(pend ? '已从云端同步；本机还有 ' + pend + ' 条待上传' : '已从云端同步最新数据')
      }
      return { ok: true, changed: true, pending: pend }
    } catch (e) {
      lastError = (e && e.message) || '同步失败'
      if (reason !== 'poll' && reason !== 'boot' && U() && U().toast) U().toast('同步失败：' + lastError)
      return { error: lastError }
    } finally { pulling = false }
  }

  /* 装上「回到前台就对齐云端」的四重监听 + 可见期轮询 */
  function startAuto() {
    if (pullTimer) return
    const kick = () => { if (!document.hidden) autoPull('visible').catch(() => {}) }
    try {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) kick() })
      window.addEventListener('focus', kick)
      window.addEventListener('pageshow', e => { if (e.persisted) kick() })
      window.addEventListener('online', kick)
    } catch (e) { /* 忽略 */ }
    pullTimer = setInterval(() => { if (!document.hidden) autoPull('poll').catch(() => {}) }, POLL_MS)
    setTimeout(() => autoPull('boot').catch(() => {}), 1800)
  }
  function stopAuto() { if (pullTimer) { clearInterval(pullTimer); pullTimer = null } }

  /* ---------------- 界面 ---------------- */
  function openCenter() {
    return window.Lazy.need('syncui').then(m => (m && m.open ? m.open() : null))
  }

  function boot() {
    install()
    try {
      /* 恢复联网：自动拉取由 startAuto 的 online 监听负责（会走 autoPull），
         这里只提醒「有待上传」，重放仍由用户确认 —— 绝不静默重放写操作 */
      window.addEventListener('online', () => {
        const n = outboxCount()
        if (n > 0 && U() && U().toast) {
          U().toast('已恢复联网，还有 ' + n + ' 条待上传，可到 我的 → 数据与同步 重试')
        }
      })
    } catch (e) { /* 忽略 */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  return {
    install, outbox, outboxCount, enqueue, drop, clearOutbox,
    retryOne, retryAll, inspect, mark, markPull, markWrite,
    isNetworkError, openCenter, WRITES, LABEL,
    autoPull, startAuto, stopAuto, fingerprint, reloadAll,
    owner, OUT_MAX, OP_TAG,
    legacyOutbox, legacyCount, dropLegacy, clearLegacy, adoptLegacy,
  }
})()


