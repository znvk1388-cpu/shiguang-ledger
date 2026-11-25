/* 本机自动快照（v1.22.0）
 * ==========================================================================
 * 解决的问题：误删一笔、手滑批量改错分类、恢复了一份旧备份——在此之前，
 * 本机模式没有任何「后悔药」，只能靠用户自己记得导出备份。
 *
 * 做法：游客模式（数据只在本机）下，每天首次打开 App 时自动把账本核心表
 * （账本/账户/分类/账目/预算/周期/目标/模板）原样存进一个**独立的**
 * IndexedDB（ledger10-snapshots），保留最近 14 份，可随时一键回滚。
 *
 * 刻意的边界：
 *   - 不存凭证图片：图片体积大，14 份快照会把存储撑爆；回滚时图片表原样保留。
 *   - 云端模式不启用：数据的主副本在云端，本机快照没有意义（那里走加密备份）。
 *   - 回滚前自动再留一份「回滚前」快照：选错版本也能回到当前状态。
 *   - 回滚复用 GuestStore.restoreCore：与 JSON 恢复同一套「原子替换 + 缓存失效」。
 *   - 任何失败都静默降级——快照是保险，不能反过来妨碍记账。
 */
window.Snapshot = (function () {
  'use strict'
  const DB_NAME = 'ledger10-snapshots'
  const STORE = 'snapshots'
  const VERSION = 1
  const KEEP = 14
  const DAY_KEY = 'ledger10_snap_day'
  const CORE = ['books', 'accounts', 'categories', 'budgets', 'recurring', 'goals', 'templates', 'transactions']

  let dbPromise = null

  function open() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('本机存储不可用')); return }
      let req
      try { req = indexedDB.open(DB_NAME, VERSION) } catch (e) { reject(e); return }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => { db.close(); dbPromise = null }
        resolve(db)
      }
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('快照库打开失败')) }
      req.onblocked = () => { dbPromise = null; reject(new Error('快照库被其他标签页占用')) }
    })
    dbPromise.catch(() => { dbPromise = null })
    return dbPromise
  }

  /* 只有事务真正 complete 才算写入成功（配额不足时请求可能成功但事务回滚） */
  function run(mode, op) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = op(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req ? req.result : undefined)
      tx.onabort = () => reject(tx.error || new Error('快照库写入未提交'))
      tx.onerror = () => reject(tx.error || new Error('快照库读写失败'))
    }))
  }

  const pad = n => String(n).padStart(2, '0')
  function dayKey(d) {
    d = d || new Date()
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function guestMode() {
    return !!(window.DB && window.DB.mode === 'guest' && window.GuestStore && typeof window.GuestStore.dump === 'function')
  }

  /* reason: auto（每日自动）| manual（用户手动）| pre-restore（回滚前自动留底） */
  async function capture(reason) {
    if (!guestMode()) return { ok: false, reason: 'mode' }
    let dump
    try { dump = await window.GuestStore.dump() } catch (e) { return { ok: false, reason: 'read' } }
    const map = {}
    CORE.forEach(t => { map[t] = Array.isArray(dump[t]) ? dump[t] : [] })
    if (!map.transactions.length) return { ok: false, reason: 'empty' }
    const now = new Date()
    /* 连续手动留存也不会撞 ID（毫秒内多次捕获在自动化测试里真实发生过） */
    const row = { id: 's' + now.getTime() + '-' + Math.random().toString(36).slice(2, 6), day: dayKey(now), at: now.toISOString(), reason: reason || 'auto', count: map.transactions.length, map: map }
    try { await run('readwrite', os => os.put(row)) } catch (e) { return { ok: false, reason: 'write' } }
    try { await prune() } catch (e) { /* 清理旧快照失败不影响本次 */ }
    return { ok: true, id: row.id, count: row.count }
  }

  async function rows() {
    const all = await run('readonly', os => os.getAll())
    return (all || []).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  async function prune() {
    const all = await rows()
    const stale = all.slice(KEEP)
    for (const r of stale) await run('readwrite', os => os.delete(r.id))
    return stale.length
  }

  /* 列表只回元信息，不把整份账本数据读进内存 */
  async function list() {
    return (await rows()).map(r => ({ id: r.id, day: r.day, at: r.at, reason: r.reason, count: r.count }))
  }

  async function get(id) { return run('readonly', os => os.get(id)) }

  async function remove(id) {
    await run('readwrite', os => os.delete(id))
    return true
  }

  async function restore(id, options) {
    if (!guestMode()) throw new Error('仅本机模式可从快照回滚')
    const row = await get(id)
    if (!row || !row.map) throw new Error('这份快照已不存在')
    /* 回滚前先把「现在」留一份：选错版本还能回到当前状态 */
    await capture('pre-restore')
    return window.GuestStore.restoreCore(row.map, options)
  }

  /* 每天首次进入主界面时调用：当天已留过就不再重复 */
  function maybeDaily() {
    if (!guestMode()) return Promise.resolve(null)
    const today = dayKey()
    try { if (localStorage.getItem(DAY_KEY) === today) return Promise.resolve(null) } catch (e) { /* 读不到就每天尝试一次 */ }
    return list().then(rows => {
      if (rows.some(r => r.day === today)) { markDay(today); return null }
      return capture('auto').then(res => { if (res.ok) markDay(today); return res })
    }).catch(() => null)
  }
  function markDay(today) { try { localStorage.setItem(DAY_KEY, today) } catch (e) { /* 忽略 */ } }

  /* 测试与「关于」页用：清空快照库（不碰主账本） */
  async function wipe() {
    await run('readwrite', os => os.clear())
    return true
  }

  return { capture: capture, list: list, get: get, remove: remove, restore: restore, maybeDaily: maybeDaily, prune: prune, wipe: wipe, dayKey: dayKey, KEEP: KEEP, CORE: CORE }
})()
