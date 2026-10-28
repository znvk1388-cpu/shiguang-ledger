/* ============================================================
 * 游客数据迁移（js/migrate.js · window.Migrate）· 懒加载
 * ------------------------------------------------------------
 * 只在「登录时发现本机有游客数据」这一条路径上用到，不属于首屏关键路径，
 * 所以整体放在懒加载模块里（js/lazy.js 的 SRC.migrate）。
 *
 * 设计要点（对应线上云同步的三条硬要求）：
 *   1) 可续传：进度写进 localStorage 日志（ledger10_migrate_journal），
 *      中途失败再次执行只补没做完的部分，不会把已迁移的账目再复制一遍。
 *   2) 幂等：标记同时包含来源库身份和本机 id，迁移日志按目标账号隔离；
 *      查不到标记时按名字判重的实体（账户/分类/账本/目标/模板）走同名判定。
 *   3) 不静默清除：本机 IndexedDB 是这份数据的唯一副本，**迁移成功也不自动清空**。
 *      清理改为用户在「数据与同步」里显式操作，且在此之前本机副本一直留着。
 * ============================================================ */
window.Migrate = (function () {
  const JKEY = 'ledger10_migrate_journal'
  const OP = '_op:'

  function readJournal(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null')
      return v && typeof v === 'object' ? v : {}
    } catch (e) { return {} }
  }
  function targetUid() { return String((window.Store.state || {}).uid || '') }
  function journalKey(uid, source) { return JKEY + ':' + encodeURIComponent(uid) + ':' + encodeURIComponent(source) }
  function journal(uid, source) {
    if (uid && source) return readJournal(journalKey(uid, source))
    const last = readJournal(JKEY)
    if (!last.targetUid || last.targetUid !== targetUid() || !last.sourceId) return {}
    return readJournal(journalKey(last.targetUid, last.sourceId))
  }
  function saveJournal(j) {
    if (!j.targetUid || !j.sourceId) return false
    try {
      localStorage.setItem(journalKey(j.targetUid, j.sourceId), JSON.stringify(j))
      localStorage.setItem(JKEY, JSON.stringify({ targetUid: j.targetUid, sourceId: j.sourceId }))
      return true
    } catch (e) { return false }
  }
  function resetJournal() {
    const j = journal()
    try {
      if (j.targetUid && j.sourceId) localStorage.removeItem(journalKey(j.targetUid, j.sourceId))
      localStorage.removeItem(JKEY)
    } catch (e) { /* 忽略 */ }
  }

  /* 行内幂等标记：每笔来源账目一个稳定 ID */
  function migOp(source, guestId) { return 'mig-' + source + ':' + guestId }

  function legacyDumpSig(dump) {
    const txns = (dump && dump.transactions) || []
    const s = txns.length + ':' + (txns.length ? txns[0].id : '') + ':' + (txns.length ? txns[txns.length - 1].id : '')
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return String(h >>> 0)
  }

  /* 新备份携带 IndexedDB 中持久化的来源库 UUID。旧 JSON 没有身份时，以完整
     内容（而非条数/首末 id）生成稳定指纹；内容不同的旧备份视为不同来源。 */
  function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
    if (value && typeof value === 'object') {
      if (typeof Blob !== 'undefined' && value instanceof Blob) return JSON.stringify({ size: value.size, type: value.type })
      return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}'
    }
    return JSON.stringify(value)
  }
  function fingerprint(text) {
    let a = 0x811c9dc5, b = 0x9e3779b9
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619)
      b = Math.imul(b ^ text.charCodeAt(i), 2246822519)
    }
    return (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16) + '-' + text.length
  }
  async function sourceIdentity(dump) {
    if (typeof dump.sourceId === 'string' && dump.sourceId.trim() && dump.sourceId.length <= 160) return dump.sourceId
    const content = { ...dump }
    delete content.exportedAt
    delete content.sourceId
    const text = stableJson(content)
    if (window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined') {
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return 'legacy-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    }
    return 'legacy-' + fingerprint(text)
  }

  async function findByOp(op) {
    const db = window.Cloud.cloud.database
    const r = await db.from('transactions').select('*').contains('tags', [OP + op]).limit(1)
    if (r.error) throw r.error
    return (r.data && r.data[0]) || null
  }
  async function findRuleByOp(op) {
    const db = window.Cloud.cloud.database
    const r = await db.from('recurring_rules').select('*').contains('tags', [OP + op]).limit(1)
    if (r.error) throw r.error
    return (r.data && r.data[0]) || null
  }

  function samePayload(row, payload, rule) {
    const fields = ['txn_type', 'amount', 'account_id', 'to_account_id', 'category_id', 'note', 'book_id', 'reimbursable']
    if (rule) fields.push('freq', 'start_date', 'last_run_date', 'active')
    else fields.push('occurred_at')
    return fields.every(k => {
      if (k === 'occurred_at') return new Date(row[k]).getTime() === new Date(payload[k]).getTime()
      if (k === 'amount') return Number(row[k]) === Number(payload[k])
      if (k === 'note') return String(row[k] || '') === String(payload[k] || '')
      if (k === 'reimbursable') return !!row[k] === !!payload[k]
      if (k === 'active') return (row[k] !== false) === (payload[k] !== false)
      const left = String(row[k] == null ? '' : row[k])
      const right = String(payload[k] == null ? '' : payload[k])
      return k.indexOf('date') >= 0 ? left.slice(0, 10) === right.slice(0, 10) : left === right
    })
  }
  function idMap(value) { return Object.assign(Object.create(null), value && typeof value === 'object' ? value : {}) }

  /* 把一份本机 dump 导入云端；可重复执行，已导入的会被跳过 */
  async function importDumpToCloud(dump, onProgress) {
    const say = onProgress || function () {}
    const cloud = window.Store
    if (!dump || !Array.isArray(dump.transactions)) throw new Error('备份文件格式不正确')
    const uid = targetUid()
    if (!uid || uid === 'guest') throw new Error('请先登录目标账号，再迁移数据')
    const source = await sourceIdentity(dump)
    const j = journal(uid, source)
    j.targetUid = uid
    j.sourceId = source
    /* 老版日志既没有账号也没有来源身份，不能直接信任。只在旧指纹相符、
       当前账号实际存在旧标记且字段逐项相同后，才接续旧迁移。 */
    const legacy = readJournal(JKEY + ':legacy')
    const unscoped = readJournal(JKEY)
    if (!unscoped.targetUid && unscoped.srcSig && !legacy.srcSig) {
      try { localStorage.setItem(JKEY + ':legacy', JSON.stringify(unscoped)) } catch (e) { /* 仍可在本轮验证 */ }
    }
    const old = legacy.srcSig ? legacy : unscoped
    const adoptLegacy = !old.targetUid && old.srcSig === legacyDumpSig(dump)
    const checkTarget = () => {
      if (targetUid() !== uid) throw new Error('迁移期间账号发生变化，请回到原账号后重试；本机数据未清除')
    }
    checkTarget()
    /* 每轮重建确认过的映射；本地日志不是云端记录存在的证明。 */
    const previousImages = idMap(j.imgMap)
    const previousUploads = idMap(j.imgUploads)
    j.txnMap = idMap()
    j.ruleMap = idMap()
    j.imgMap = idMap()
    j.imgUploads = previousUploads

    if (!cloud.state.categories.length || !cloud.state.accounts.length) await cloud.seedPresets()
    await cloud.ensureDefaultBook()

    /* 账本 */
    const bookMap = idMap()
    const usedBooks = new Set()
    j.bookMap = idMap(j.bookMap)
    for (const b of (dump.books || [])) {
      checkTarget()
      const existing = cloud.state.books.find(x => String(x.id) === String(j.bookMap[b.id]) && !usedBooks.has(x.id)) ||
        cloud.state.books.find(x => x.name === b.name && !usedBooks.has(x.id))
      if (existing) {
        bookMap[b.id] = existing.id
        j.bookMap[b.id] = existing.id
        usedBooks.add(existing.id)
        continue
      }
      say('迁移账本…')
      const row = await cloud.addBook({ name: b.name, icon: b.icon || '📒', sort_order: b.sort_order || 0 })
      bookMap[b.id] = row.id
      j.bookMap[b.id] = row.id
      usedBooks.add(row.id)
      saveJournal(j)
    }
    const mapBook = (id) => bookMap[id] || cloud.currentBookId()

    /* 账户 */
    const accMap = idMap()
    const usedAccounts = new Set()
    j.accMap = idMap(j.accMap)
    for (const a of (dump.accounts || [])) {
      checkTarget()
      const existing = cloud.allAccounts().find(x => String(x.id) === String(j.accMap[a.id]) &&
        (x.currency || 'CNY') === (a.currency || 'CNY') && !usedAccounts.has(x.id)) ||
        cloud.allAccounts().find(x => x.name === a.name && (x.currency || 'CNY') === (a.currency || 'CNY') &&
          (x.kind || 'cash') === (a.kind || 'cash') && Number(x.initial_balance || 0) === Number(a.initial_balance || 0) && !usedAccounts.has(x.id))
      if (existing) {
        accMap[a.id] = existing.id
        j.accMap[a.id] = existing.id
        usedAccounts.add(existing.id)
        continue
      }
      say('迁移账户…')
      const row = await cloud.addAccount({
        name: a.name, kind: a.kind || 'cash', icon: a.icon || '💰', color: a.color || '#2f6bff',
        initial_balance: Number(a.initial_balance) || 0, currency: a.currency || 'CNY', sort_order: a.sort_order || 0,
      })
      accMap[a.id] = row.id
      j.accMap[a.id] = row.id
      usedAccounts.add(row.id)
      saveJournal(j)
    }

    /* 分类：先父后子 */
    const catMap = idMap()
    const usedCategories = new Set()
    j.catMap = idMap(j.catMap)
    const cats = dump.categories || []
    const parents = cats.filter(c => !c.parent_id)
    const children = cats.filter(c => c.parent_id)
    for (const c of parents) {
      checkTarget()
      const existing = cloud.state.categories.find(x => String(x.id) === String(j.catMap[c.id]) && !usedCategories.has(x.id)) ||
        cloud.state.categories.find(x => x.kind === c.kind && !x.parent_id && x.name === c.name && !usedCategories.has(x.id))
      if (existing) { catMap[c.id] = existing.id; j.catMap[c.id] = existing.id; usedCategories.add(existing.id); continue }
      say('迁移分类…')
      const row = await cloud.addCategory({
        name: c.name, kind: c.kind, parent_id: null, icon: c.icon || '📦', color: c.color || '#8a93a6', sort_order: c.sort_order || 0,
      })
      catMap[c.id] = row.id
      j.catMap[c.id] = row.id
      usedCategories.add(row.id)
      saveJournal(j)
    }
    for (const c of children) {
      checkTarget()
      const pid = catMap[c.parent_id]
      if (!pid) continue
      const existing = cloud.state.categories.find(x => String(x.id) === String(j.catMap[c.id]) && !usedCategories.has(x.id)) ||
        cloud.state.categories.find(x => x.kind === c.kind && x.parent_id === pid && x.name === c.name && !usedCategories.has(x.id))
      if (existing) { catMap[c.id] = existing.id; j.catMap[c.id] = existing.id; usedCategories.add(existing.id); continue }
      const row = await cloud.addCategory({
        name: c.name, kind: c.kind, parent_id: pid, icon: c.icon || '📦', color: c.color || '#8a93a6', sort_order: c.sort_order || 0,
      })
      catMap[c.id] = row.id
      j.catMap[c.id] = row.id
      usedCategories.add(row.id)
      saveJournal(j)
    }

    /* 账目：日志 + 行内标记双重幂等 */
    const txnFail = []
    const all = dump.transactions || []
    let done = 0
    for (const t of all) {
      done++
      if (done % 5 === 0) say('迁移账目 ' + done + '/' + all.length + '…')
      const payload = {
        txn_type: t.txn_type, amount: Number(t.amount), occurred_at: t.occurred_at,
        account_id: accMap[t.account_id] || null, to_account_id: accMap[t.to_account_id] || null,
        category_id: catMap[t.category_id] || null, note: t.note || '',
        tags: (t.tags || []).filter(tag => String(tag).slice(0, OP.length) !== OP).concat([OP + migOp(source, t.id)]),
        reimbursable: !!t.reimbursable, book_id: mapBook(t.book_id),
        deleted_at: t.deleted_at || null,
      }
      try {
        checkTarget()
        let found = await findByOp(migOp(source, t.id))
        if (!found && adoptLegacy && old.txnMap && old.txnMap[t.id]) {
          const candidate = await findByOp('mig-' + t.id)
          if (candidate && String(candidate.id) === String(old.txnMap[t.id]) && samePayload(candidate, payload, false)) {
            /* 为已验证的旧记录补上来源标记，之后不再依赖旧日志。 */
            await cloud.updateTransaction(candidate.id, { tags: (candidate.tags || []).concat([OP + migOp(source, t.id)]) }, candidate.updated_at)
            found = candidate
          }
        }
        checkTarget()
        if (found) { j.txnMap[t.id] = found.id; saveJournal(j); continue }
        const row = await cloud.addTransaction(payload)
        if (!row || !row.id) throw new Error('云端未返回已保存账目')
        j.txnMap[t.id] = row.id
        saveJournal(j)
      } catch (e) {
        txnFail.push({ id: t.id, msg: (e && e.message) || '写入失败' })
      }
    }
    saveJournal(j)

    /* 凭证图片：按本机附件 id 记录已上传结果，重试不会重复上传 */
    const imgFail = []
    let imgOk = 0
    for (const a of (dump.attachments || [])) {
      const newTxnId = j.txnMap[a.transaction_id]
      if (!newTxnId) { imgFail.push({ id: a.id, msg: '所属账目尚未迁移成功' }); continue }
      try {
        checkTarget()
        const legacyImage = adoptLegacy && old.txnMap && String(old.txnMap[a.transaction_id]) === String(newTxnId) && old.imgMap
          ? old.imgMap[a.id] : null
        const previous = previousImages[a.id] || legacyImage
        const pending = j.imgUploads[a.id]
        if (previous || pending) {
          let query = window.Cloud.cloud.database.from('attachments').select('id,transaction_id').eq('transaction_id', newTxnId)
          query = pending ? query.eq('storage_path', pending.path) :
            (typeof previous === 'string' && !/^\d+$/.test(previous) ? query.eq('storage_path', previous) : query.eq('id', previous))
          const result = await query.limit(1)
          if (result.error) throw result.error
          if (result.data && result.data[0]) {
            j.imgMap[a.id] = result.data[0].id
            imgOk++
            saveJournal(j)
            continue
          }
          delete j.imgMap[a.id]
        }
        let blob = a.blob
        if (!blob && a.dataUrl) blob = await (await fetch(a.dataUrl)).blob()
        if (!blob && !pending) throw new Error('本机图片数据缺失')
        say('上传凭证图片…')
        const up = pending || await cloud.uploadImageBlob(blob, a.file_name)
        checkTarget()
        j.imgUploads[a.id] = up
        saveJournal(j)
        const rows = await cloud.addAttachments(newTxnId, [up])
        if (!rows || !rows[0] || !rows[0].id) throw new Error('云端未返回已保存凭证')
        j.imgMap[a.id] = rows[0].id
        imgOk++
        saveJournal(j)
      } catch (e) {
        imgFail.push({ id: a.id, msg: (e && e.message) || '上传失败' })
      }
    }
    saveJournal(j)

    /* 预算（按 月+分类+账本 天然幂等） */
    for (const b of (dump.budgets || [])) {
      checkTarget()
      const bookId = mapBook(b.book_id)
      await cloud.setBudget(b.month_key, catMap[b.category_id] || null, Number(b.amount), bookId)
    }

    /* 周期规则：行内标记幂等 */
    const ruleFail = []
    for (const r of (dump.recurring || [])) {
      const payload = {
        txn_type: r.txn_type, amount: Number(r.amount),
        account_id: accMap[r.account_id] || null, to_account_id: accMap[r.to_account_id] || null,
        category_id: catMap[r.category_id] || null, note: r.note || '',
        tags: (r.tags || []).filter(tag => String(tag).slice(0, OP.length) !== OP).concat([OP + migOp(source, r.id)]),
        freq: r.freq, start_date: String(r.start_date).slice(0, 10),
        last_run_date: r.last_run_date ? String(r.last_run_date).slice(0, 10) : null,
        active: r.active !== false, book_id: mapBook(r.book_id),
      }
      try {
        checkTarget()
        let found = await findRuleByOp(migOp(source, r.id))
        if (!found && adoptLegacy && old.ruleMap && old.ruleMap[r.id]) {
          const candidate = await findRuleByOp('mig-' + r.id)
          if (candidate && String(candidate.id) === String(old.ruleMap[r.id]) && samePayload(candidate, payload, true)) {
            await cloud.updateRecurring(candidate.id, { tags: (candidate.tags || []).concat([OP + migOp(source, r.id)]) })
            found = candidate
          }
        }
        checkTarget()
        if (found) { j.ruleMap[r.id] = found.id; saveJournal(j); continue }
        const row = await cloud.addRecurring(payload)
        if (!row || !row.id) throw new Error('云端未返回已保存周期规则')
        j.ruleMap[r.id] = row.id
      } catch (e) {
        ruleFail.push({ id: r.id, msg: (e && e.message) || '写入失败' })
      }
    }

    /* 攒钱目标（同名幂等） */
    const usedGoals = new Set()
    j.goalMap = idMap(j.goalMap)
    for (const g of (dump.goals || [])) {
      checkTarget()
      const existing = (cloud.state.goals || []).find(x => String(x.id) === String(j.goalMap[g.id]) && !usedGoals.has(x.id)) ||
        (cloud.state.goals || []).find(x => x.name === g.name && String(x.book_id) === String(mapBook(g.book_id)) &&
          Number(x.target_amount) === Number(g.target_amount) && Number(x.saved_amount || 0) === Number(g.saved_amount || 0) && !usedGoals.has(x.id))
      if (existing) { j.goalMap[g.id] = existing.id; usedGoals.add(existing.id); continue }
      const made = await cloud.addGoal({
        name: g.name, icon: g.icon || '🎯', target_amount: Number(g.target_amount),
        saved_amount: Number(g.saved_amount) || 0, deadline: g.deadline || null,
        done: !!g.done, book_id: mapBook(g.book_id),
      })
      if (!made || !made.id) throw new Error('云端未返回已保存目标')
      j.goalMap[g.id] = made.id
      usedGoals.add(made.id)
      saveJournal(j)
    }

    /* 记账模板（同名幂等）—— 旧版迁移漏掉了这一类 */
    let tplOk = 0
    const tplFail = []
    if (cloud.addTemplate) {
      const exist = await cloud.listTemplates()
      const usedTemplates = new Set()
      j.tplMap = idMap(j.tplMap)
      for (const t of (dump.templates || [])) {
        checkTarget()
        const existing = (exist || []).find(x => String(x.id) === String(j.tplMap[t.id]) && !usedTemplates.has(x.id)) ||
          (exist || []).find(x => x.name === t.name && String(x.book_id || '') === String(mapBook(t.book_id)) &&
            x.txn_type === t.txn_type && Number(x.amount || 0) === Number(t.amount || 0) &&
            String(x.account_id || '') === String(accMap[t.account_id] || '') && !usedTemplates.has(x.id))
        if (existing) { j.tplMap[t.id] = existing.id; usedTemplates.add(existing.id); continue }
        try {
          const made = await cloud.addTemplate({
            name: t.name, txn_type: t.txn_type, amount: t.amount,
            account_id: accMap[t.account_id] || null, to_account_id: accMap[t.to_account_id] || null,
            category_id: catMap[t.category_id] || null, note: t.note || '', tags: t.tags || [],
            book_id: mapBook(t.book_id),
          })
          if (!made || !made.id) throw new Error('云端未返回已保存模板')
          j.tplMap[t.id] = made.id
          usedTemplates.add(made.id)
          tplOk++
        } catch (e) { tplFail.push({ id: t.id, msg: (e && e.message) || '模板写入失败' }) }
      }
    }
    saveJournal(j)

    return {
      txns: Object.keys(j.txnMap).length,
      images: imgOk,
      templates: tplOk,
      txnFail: txnFail,
      imgFail: imgFail,
      ruleFail: ruleFail,
      tplFail: tplFail,
      txnMap: j.txnMap,
      imgMap: j.imgMap,
      ruleMap: j.ruleMap,
      targetUid: uid, sourceId: source,
    }
  }

  /* 完整核验：条数 + 关联关系，任一项不通过就不算迁移完成 */
  function verify(dump, res) {
    const problems = []
    if (!res.targetUid || res.targetUid !== targetUid()) problems.push('目标账号发生变化，迁移结果未确认')
    const txns = dump.transactions || []
    const atts = dump.attachments || []
    const missingTxn = txns.filter(t => !res.txnMap[t.id]).length
    if (missingTxn) problems.push(missingTxn + ' 笔账目未迁移成功')
    const missingImg = atts.filter(a => !res.imgMap[a.id]).length
    if (missingImg) problems.push(missingImg + ' 张凭证未上传成功')
    const orphan = atts.filter(a => res.imgMap[a.id] && !res.txnMap[a.transaction_id]).length
    if (orphan) problems.push(orphan + ' 张凭证的关联账目缺失')
    const missingRule = (dump.recurring || []).filter(r => !(res.ruleMap || {})[r.id]).length
    if (missingRule) problems.push(missingRule + ' 条周期规则未迁移成功')
    if (res.tplFail && res.tplFail.length) problems.push(res.tplFail.length + ' 个模板未迁移成功')
    return { ok: problems.length === 0, problems: problems }
  }

  /* 游客 → 云端。未通过完整核验时**不动本机数据**。 */
  async function migrateGuestToCloud(session, onProgress) {
    const say = onProgress || function () {}
    const dump = await window.GuestStore.dump()
    await window.DB.useCloud(session)
    const res = await importDumpToCloud(dump, say)
    const v = verify(dump, res)

    const j = journal(res.targetUid, res.sourceId)
    j.done = v.ok
    j.doneAt = v.ok ? new Date().toISOString() : ''
    j.lastTryAt = new Date().toISOString()
    j.problems = v.problems
    j.counts = { txns: (dump.transactions || []).length, images: (dump.attachments || []).length }
    saveJournal(j)

    /* 关键修复：不再自动 GuestStore.wipe()。
       本机 IndexedDB 是这份数据的唯一副本，未完整核验前清除等于不可逆丢数据。 */
    return {
      txns: res.txns, images: res.images, templates: res.templates,
      complete: v.ok, problems: v.problems, wiped: false,
    }
  }

  /* 用户在面板里显式清理本机游客数据（唯一会真正删数据的入口） */
  async function cleanGuestData() {
    await window.GuestStore.wipe()
    const j = journal()
    j.cleanedAt = new Date().toISOString()
    saveJournal(j)
    return true
  }

  function status() {
    const j = journal()
    return {
      done: !!j.done,
      doneAt: j.doneAt || '',
      lastTryAt: j.lastTryAt || '',
      problems: j.problems || [],
      cleanedAt: j.cleanedAt || '',
      txns: (j.counts && j.counts.txns) || 0,
      images: (j.counts && j.counts.images) || 0,
    }
  }

  return {
    importDumpToCloud, migrateGuestToCloud, verify, status,
    cleanGuestData, resetJournal, journal,
  }
})()

