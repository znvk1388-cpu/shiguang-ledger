/* 本机覆盖层持久化（A3 中期）
   ------------------------------------------------------------------
   报销进度、对账标记、目标联动、预算结转、汇率、常用筛选、规则、纠正记忆……
   这些是「不跟着云端走」的本机数据，一直只存在 localStorage 里。三个问题：

   1) 容量小（多数浏览器 5MB），账本大了以后写入会开始抛 QuotaExceededError；
   2) 浏览器在存储压力下可以单独回收 localStorage，用户的报销进度会凭空消失；
   3) navigator.storage.persist() 保护的是 IndexedDB 与 Cache，不含 localStorage。

   所以这里给 localStorage 加一层「写穿镜像」：任何被镜像的键写入时同时落一份到
   IndexedDB 的 overlays 表；启动时把 IDB 里有、localStorage 里没有的键补回去。
   读路径一行都没改（渲染仍然是同步读 localStorage），风险只在写入侧；
   换来的是 localStorage 被清空但 IDB 还在时，数据能自己长回来。

   刻意不镜像的东西（见 DENY）：应用锁 PIN、加密备份的口令校验、分享码密钥、
   上传队列。这些要么是凭据（不该有第二份副本），要么必须严格单调（镜像会让
   队列在「清空后再恢复」时复活已完成的写操作）。
*/
window.Overlay = (function () {
  const STORE = 'overlays'
  /* 需要长期保存的本机数据（前缀匹配） */
  const ALLOW = [
    'ledger10_reimb',          /* 报销进度（含 :mode:owner 命名空间） */
    'ledger10_goallink',       /* 攒钱目标 ↔ 账户联动 */
    'ledger10_goalauto',
    'ledger10_rollover',       /* 预算结转配置 */
    'ledger10_autobudget',
    'ledger10_reconcile_marks_v1',
    'ledger10_recon_log',
    'ledger10_debt_meta',
    'ledger10_debt_rate',
    'ledger10_card_meta',
    'ledger10_fx',             /* 汇率与基准币种：丢了所有外币金额都会算错 */
    'ledger10_base',
    'ledger10_catuse',         /* 分类使用频率、上次选择 */
    'ledger10_lastpick',
    'ledger10_catfix',         /* AI 分类纠正记忆 */
    'ledger10_catmap',
    'ledger10_saved_filters_v1',
    'ledger10_csvmap',
    'ledger10_import_accounts_v1',
    'ledger10_joins',
    'ledger10_rules',          /* 自动分类规则 */
    'ledger10_rules_seeded',
    'ledger10_share_seen',     /* 共享快照去重指纹 */
    'ledger10_snapshot_entities',
    'ledger10_theme',
    'ledger10_ui',
    'ledger10_privacy',
    'ledger10_privacy_ok',
    'ledger10_home_quick',
    'ledger10_home_',
    'ledger10_mode',
    'ledger10_reminder',
    'ledger10_remind_dismiss',
    'ledger10_aiquota',
    'ledger10_bk1',            /* 上次备份时间：丢了会一直催备份，也可能反过来不再提醒 */
    'ledger10_bk_nudge',
  ]
  /* 永不镜像：凭据与必须单调的队列 */
  const DENY = [
    'ledger10_lock',           /* 应用锁 PIN 与失败计数 */
    'ledger10_vault',          /* 加密备份的校验头 */
    'ledger10_shares',         /* 分享码里的 secret */
    'ledger10_outbox',         /* 旧版上传队列 */
    'ledger10_pending',        /* 待上传标记 */
    'ledger10_sync2',          /* 现行上传队列 */
    'ledger10_sync_mark',
    'ledger10_draft',          /* 编辑器草稿：转瞬即逝，不值得为它写盘 */
    'ledger10_migrate_journal',
  ]
  /* 单值上限：镜像只为容错，不是给缓存当仓库 */
  const MAX_VALUE = 256 * 1024

  let installed = false
  let chain = Promise.resolve()
  let lastError = null

  function available() {
    return typeof indexedDB !== 'undefined' && window.Idb && typeof window.Idb.put === 'function'
  }

  function mirrored(key) {
    if (typeof key !== 'string' || !key) return false
    for (const d of DENY) if (key.indexOf(d) === 0) return false
    for (const a of ALLOW) if (key.indexOf(a) === 0) return true
    return false
  }

  /* 所有写盘串成一条链：避免同一个键的 put/delete 乱序落地 */
  function enqueue(fn) {
    chain = chain.then(fn).catch(e => { lastError = e })
    return chain
  }

  function put(key, value) {
    if (!mirrored(key) || !available()) return Promise.resolve(false)
    const v = String(value)
    if (v.length > MAX_VALUE) return Promise.resolve(false)
    return enqueue(() => window.Idb.put(STORE, { id: key, v: v })).then(() => true, () => false)
  }

  function drop(key) {
    if (!mirrored(key) || !available()) return Promise.resolve(false)
    return enqueue(() => window.Idb.del(STORE, key)).then(() => true, () => false)
  }

  /* 写穿钩子：只在 localStorage（不是 sessionStorage/其他 Storage 实例）上生效。
     只监听这一个入口 —— 全仓库的覆盖层写入都走 localStorage.setItem，
     所以不需要改任何业务代码；万一哪天有人用别的写法，最坏退化成「没镜像」，
     也就是回到改造前的行为，不会引入新的错误。 */
  function install() {
    if (installed) return false
    installed = true
    try {
      const proto = window.Storage && window.Storage.prototype
      if (!proto || proto.__ledger10OverlayHooked) return false
      const rawSet = proto.setItem
      const rawRemove = proto.removeItem
      if (typeof rawSet !== 'function') return false
      proto.__ledger10OverlayHooked = true
      proto.setItem = function (k, v) {
        const out = rawSet.apply(this, arguments)
        try { if (this === window.localStorage) put(String(k), v) } catch (e) { /* 忽略 */ }
        return out
      }
      proto.removeItem = function (k) {
        const out = rawRemove.apply(this, arguments)
        try { if (this === window.localStorage) drop(String(k)) } catch (e) { /* 忽略 */ }
        return out
      }
      return true
    } catch (e) {
      lastError = e
      return false
    }
  }

  /* 启动时对齐：两个方向都补，任何一边有新数据都不会丢。
     - IDB 有、localStorage 没有 → 写回 localStorage（被清空后的自动恢复）
     - localStorage 有、IDB 没有 → 写进 IDB（升级当次给老用户补种子） */
  async function restore() {
    if (!available()) return { restored: 0, seeded: 0 }
    let rows = []
    try { rows = await window.Idb.all(STORE) } catch (e) { return { restored: 0, seeded: 0, error: String(e && e.message) } }
    const inIdb = new Set()
    let restored = 0
    for (const row of rows) {
      if (!row || typeof row.v !== 'string' || !mirrored(row.id)) continue
      inIdb.add(row.id)
      try {
        if (window.localStorage.getItem(row.id) == null) {
          window.localStorage.setItem(row.id, row.v)
          restored++
        }
      } catch (e) { /* 容量满：让业务自己报错，别把启动流程卡死 */ }
    }
    let seeded = 0
    try {
      const ls = window.localStorage
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i)
        if (!k || inIdb.has(k) || !mirrored(k)) continue
        const v = ls.getItem(k)
        if (typeof v === 'string' && v.length <= MAX_VALUE) { put(k, v); seeded++ }
      }
    } catch (e) { /* 忽略 */ }
    await flush()
    return { restored, seeded }
  }

  function flush() { return chain }

  /* 备份/诊断用：当前镜像了多少个键、最近一次错误 */
  async function stats() {
    if (!available()) return { available: false, keys: 0 }
    try {
      const rows = await window.Idb.all(STORE)
      return { available: true, keys: rows.length, error: lastError ? String(lastError.message || lastError) : '' }
    } catch (e) {
      return { available: false, keys: 0, error: String(e && e.message) }
    }
  }

  return { install, restore, flush, stats, mirrored, STORE, ALLOW, DENY }
})()
