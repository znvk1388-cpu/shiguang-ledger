/* ============================================================
 * 游客数据迁移（js/migrate.js · window.Migrate）· 懒加载
 * ------------------------------------------------------------
 * 只在「登录时发现本机有游客数据」这一条路径上用到，不属于首屏关键路径，
 * 所以整体放在懒加载模块里（js/lazy.js 的 SRC.migrate）。
 *
 * 设计要点（对应线上云同步的三条硬要求）：
 *   1) 可续传：进度写进 localStorage 日志（ledger10_migrate_journal），
 *      中途失败再次执行只补没做完的部分，不会把已迁移的账目再复制一遍。
 *   2) 幂等：每笔账目/周期规则盖 `_op:mig-<本机id>` 行内标记，重试前先查标记；
 *      查不到标记时按名字判重的实体（账户/分类/账本/目标/模板）走同名判定。
 *   3) 不静默清除：本机 IndexedDB 是这份数据的唯一副本，**迁移成功也不自动清空**。
 *      清理改为用户在「数据与同步」里显式操作，且在此之前本机副本一直留着。
 * ============================================================ */
window.Migrate = (function () {
  const JKEY = 'ledger10_migrate_journal'
  const OP = '_op:'

  function journal() {
    try {
      const v = JSON.parse(localStorage.getItem(JKEY) || 'null')
      return v && typeof v === 'object' ? v : {}
    } catch (e) { return {} }
  }
  function saveJournal(j) {
    try { localStorage.setItem(JKEY, JSON.stringify(j)); return true } catch (e) { return false }
  }
  function resetJournal() { try { localStorage.removeItem(JKEY) } catch (e) { /* 忽略 */ } }

  /* 行内幂等标记：每笔来源账目一个稳定 ID */
  function migOp(guestId) { return 'mig-' + guestId }

  /* 数据源指纹：账目条数 + 首末 id。换一份不同的备份重导时据此清空旧进度，
     避免同数字 id 被上一份备份的 journal 误判「已迁移」而静默跳过（P1 修复） */
  function dumpSig(dump) {
    const txns = (dump && dump.transactions) || []
    const s = txns.length + ':' + (txns.length ? txns[0].id : '') + ':' + (txns.length ? txns[txns.length - 1].id : '')
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return String(h >>> 0)
  }

  async function findByOp(op) {
    const db = window.Cloud.cloud.database
    const r = await db.from('transactions').select('id').contains('tags', [OP + op]).limit(1)
    if (r.error) throw r.error
    return (r.data && r.data[0] && r.data[0].id) || null
  }
  async function findRuleByOp(op) {
    const db = window.Cloud.cloud.database
    const r = await db.from('recurring_rules').select('id').contains('tags', [OP + op]).limit(1)
    if (r.error) throw r.error
    return (r.data && r.data[0] && r.data[0].id) || null
  }

  /* 把一份本机 dump 导入云端；可重复执行，已导入的会被跳过 */
  async function importDumpToCloud(dump, onProgress) {
    const say = onProgress || function () {}
    const cloud = window.Store
    const j = journal()
    /* 数据源变了（换一份备份重导）→ 旧进度作废；同一份数据 → 保留进度支持断点续传 */
    const sig = dumpSig(dump)
    if (j.srcSig && j.srcSig !== sig) { j.txnMap = {}; j.imgMap = {}; j.ruleMap = {} }
    j.srcSig = sig
    j.txnMap = j.txnMap || {}
    j.imgMap = j.imgMap || {}
    j.ruleMap = j.ruleMap || {}

    if (!cloud.state.categories.length || !cloud.state.accounts.length) await cloud.seedPresets()
    await cloud.ensureDefaultBook()

    /* 账本 */
    const bookMap = {}
    for (const b of (dump.books || [])) {
      const existing = cloud.state.books.find(x => x.name === b.name)
      if (existing) { bookMap[b.id] = existing.id; continue }
      say('迁移账本…')
      const row = await cloud.addBook({ name: b.name, icon: b.icon || '📒', sort_order: b.sort_order || 0 })
      bookMap[b.id] = row.id
    }
    const mapBook = (id) => bookMap[id] || cloud.currentBookId()

    /* 账户 */
    const accMap = {}
    for (const a of (dump.accounts || [])) {
      const existing = cloud.allAccounts().find(x => x.name === a.name)
      if (existing) { accMap[a.id] = existing.id; continue }
      say('迁移账户…')
      const row = await cloud.addAccount({
        name: a.name, kind: a.kind || 'cash', icon: a.icon || '💰', color: a.color || '#2f6bff',
        initial_balance: Number(a.initial_balance) || 0, currency: a.currency || 'CNY', sort_order: a.sort_order || 0,
      })
      accMap[a.id] = row.id
    }

    /* 分类：先父后子 */
    const catMap = {}
    const cats = dump.categories || []
    const parents = cats.filter(c => !c.parent_id)
    const children = cats.filter(c => c.parent_id)
    for (const c of parents) {
      const existing = cloud.state.categories.find(x => x.kind === c.kind && !x.parent_id && x.name === c.name)
      if (existing) { catMap[c.id] = existing.id; continue }
      say('迁移分类…')
      const row = await cloud.addCategory({
        name: c.name, kind: c.kind, parent_id: null, icon: c.icon || '📦', color: c.color || '#8a93a6', sort_order: c.sort_order || 0,
      })
      catMap[c.id] = row.id
    }
    for (const c of children) {
      const pid = catMap[c.parent_id]
      if (!pid) continue
      const existing = cloud.state.categories.find(x => x.kind === c.kind && x.parent_id === pid && x.name === c.name)
      if (existing) { catMap[c.id] = existing.id; continue }
      const row = await cloud.addCategory({
        name: c.name, kind: c.kind, parent_id: pid, icon: c.icon || '📦', color: c.color || '#8a93a6', sort_order: c.sort_order || 0,
      })
      catMap[c.id] = row.id
    }

    /* 账目：日志 + 行内标记双重幂等 */
    const txnFail = []
    const all = dump.transactions || []
    let done = 0
    for (const t of all) {
      done++
      if (done % 5 === 0) say('迁移账目 ' + done + '/' + all.length + '…')
      if (j.txnMap[t.id]) continue
      let found = null
      try { found = await findByOp(migOp(t.id)) } catch (e) { found = null }
      if (found) { j.txnMap[t.id] = found; saveJournal(j); continue }
      try {
        const row = await cloud.addTransaction({
          txn_type: t.txn_type, amount: Number(t.amount), occurred_at: t.occurred_at,
          account_id: accMap[t.account_id] || null, to_account_id: accMap[t.to_account_id] || null,
          category_id: catMap[t.category_id] || null, note: t.note || '',
          tags: (t.tags || []).concat([OP + migOp(t.id)]),
          reimbursable: !!t.reimbursable, book_id: mapBook(t.book_id),
        })
        j.txnMap[t.id] = row.id
        if (done % 10 === 0) saveJournal(j)
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
      if (j.imgMap[a.id]) { imgOk++; continue }
      if (!a.blob) { imgFail.push({ id: a.id, msg: '本机图片数据缺失' }); continue }
      try {
        say('上传凭证图片…')
        const up = await cloud.uploadImageBlob(a.blob, a.file_name)
        const rows = await cloud.addAttachments(newTxnId, [up])
        j.imgMap[a.id] = (rows && rows[0] && rows[0].id) || up.path
        imgOk++
        saveJournal(j)
      } catch (e) {
        imgFail.push({ id: a.id, msg: (e && e.message) || '上传失败' })
      }
    }
    saveJournal(j)

    /* 预算（按 月+分类+账本 天然幂等） */
    for (const b of (dump.budgets || [])) {
      const bookId = mapBook(b.book_id)
      cloud.setActiveBook(bookId)
      await cloud.setBudget(b.month_key, catMap[b.category_id] || null, Number(b.amount))
    }
    cloud.setActiveBook(null)

    /* 周期规则：行内标记幂等 */
    const ruleFail = []
    for (const r of (dump.recurring || [])) {
      if (j.ruleMap[r.id]) continue
      let found = null
      try { found = await findRuleByOp(migOp(r.id)) } catch (e) { found = null }
      if (found) { j.ruleMap[r.id] = found; saveJournal(j); continue }
      try {
        const row = await cloud.addRecurring({
          txn_type: r.txn_type, amount: Number(r.amount),
          account_id: accMap[r.account_id] || null, to_account_id: accMap[r.to_account_id] || null,
          category_id: catMap[r.category_id] || null, note: r.note || '',
          tags: (r.tags || []).concat([OP + migOp(r.id)]),
          freq: r.freq, start_date: String(r.start_date).slice(0, 10),
          last_run_date: r.last_run_date ? String(r.last_run_date).slice(0, 10) : null,
          active: r.active !== false, book_id: mapBook(r.book_id),
        })
        j.ruleMap[r.id] = row.id
      } catch (e) {
        ruleFail.push({ id: r.id, msg: (e && e.message) || '写入失败' })
      }
    }

    /* 攒钱目标（同名幂等） */
    for (const g of (dump.goals || [])) {
      if (cloud.listGoals().some(x => x.name === g.name)) continue
      await cloud.addGoal({
        name: g.name, icon: g.icon || '🎯', target_amount: Number(g.target_amount),
        saved_amount: Number(g.saved_amount) || 0, deadline: g.deadline || null,
        done: !!g.done, book_id: mapBook(g.book_id),
      })
    }

    /* 记账模板（同名幂等）—— 旧版迁移漏掉了这一类 */
    let tplOk = 0
    if (cloud.addTemplate) {
      const exist = await cloud.listTemplates().catch(() => [])
      for (const t of (dump.templates || [])) {
        if ((exist || []).some(x => x.name === t.name)) continue
        try {
          await cloud.addTemplate({
            name: t.name, txn_type: t.txn_type, amount: t.amount,
            account_id: accMap[t.account_id] || null, to_account_id: accMap[t.to_account_id] || null,
            category_id: catMap[t.category_id] || null, note: t.note || '', tags: t.tags || [],
            book_id: mapBook(t.book_id),
          })
          tplOk++
        } catch (e) { /* 模板失败不阻断整体迁移 */ }
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
      txnMap: j.txnMap,
      imgMap: j.imgMap,
    }
  }

  /* 完整核验：条数 + 关联关系，任一项不通过就不算迁移完成 */
  function verify(dump, res) {
    const problems = []
    const txns = dump.transactions || []
    const atts = dump.attachments || []
    const missingTxn = txns.filter(t => !res.txnMap[t.id]).length
    if (missingTxn) problems.push(missingTxn + ' 笔账目未迁移成功')
    const missingImg = atts.filter(a => !res.imgMap[a.id]).length
    if (missingImg) problems.push(missingImg + ' 张凭证未上传成功')
    const orphan = atts.filter(a => res.imgMap[a.id] && !res.txnMap[a.transaction_id]).length
    if (orphan) problems.push(orphan + ' 张凭证的关联账目缺失')
    return { ok: problems.length === 0, problems: problems }
  }

  /* 游客 → 云端。未通过完整核验时**不动本机数据**。 */
  async function migrateGuestToCloud(session, onProgress) {
    const say = onProgress || function () {}
    const dump = await window.GuestStore.dump()
    await window.DB.useCloud(session)
    const res = await importDumpToCloud(dump, say)
    const v = verify(dump, res)

    const j = journal()
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
