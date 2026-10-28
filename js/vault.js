/* ============================================================
 * 端到端加密云备份（js/vault.js · window.Vault）
 * ------------------------------------------------------------
 * 这是什么、不是什么（很重要，UI 里也如实写清楚）：
 *   ✔ 是：把整本账（账本 / 账户 / 分类 / 账目 / 目标 / 预算）打包成 JSON，
 *        用你设的口令派生密钥加密（PBKDF2-SHA256 20 万轮 → AES-GCM-256），
 *        密文上传到 users/<uid>/ledger10/vault/ 这个「只有你自己能读」的路径。
 *        服务端、运维、云厂商拿到的都只是密文，没有口令解不开。
 *   ✘ 不是：日常的云端同步仍然是明文字段（表结构由平台托管，字段不可加密，
 *        服务端的聚合 RPC 也要读明文）。所以准确说法是
 *        「备份层端到端加密」，而不是「全库端到端加密」。
 *
 * 口令策略：口令**不落盘、不上传**，只在使用时现算密钥。
 *          忘了口令 = 备份无法恢复（但本机数据不受影响）。
 * ============================================================ */
window.Vault = (function () {
  const F = window.Fmt
  const S = () => window.DB
  const U = () => window.UI

  const META_KEY = 'ledger10_vault'
  const DIR = 'ledger10/vault'
  const ITER = 200000
  const MIN_PASS = 8

  /* 口令提示绝不能和口令本身一样 —— 提示是明文存的（信封 + 本机各一份），等于直接泄密 */
  function hintLeak(pass, hint) {
    const h = String(hint || '').trim()
    return h.length > 0 && h === String(pass || '')
  }
  const MAX_BACKUPS = 20

  /* ---------------- 基础工具 ---------------- */
  function readJson(key, fb) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fb : v } catch (e) { return fb }
  }
  function writeJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true } catch (e) { return false }
  }
  function cryptoOk() {
    return !!(window.crypto && window.crypto.subtle && window.TextEncoder && window.TextDecoder)
  }
  function b64url(buf) {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function unb64url(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/')
    const pad = s + '='.repeat((4 - (s.length % 4)) % 4)
    const bin = atob(pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function randB64(n) {
    const a = new Uint8Array(n)
    crypto.getRandomValues(a)
    return b64url(a)
  }
  function tsName(d) {
    const t = d || new Date()
    return String(t.getFullYear()) + String(F.pad2(t.getMonth() + 1)) + String(F.pad2(t.getDate())) +
      '-' + String(F.pad2(t.getHours())) + String(F.pad2(t.getMinutes())) + String(F.pad2(t.getSeconds()))
  }
  function prettyName(name) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(name || ''))
    if (!m) return String(name || '')
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6]
  }
  function kb(bytes) {
    const n = Number(bytes) || 0
    return n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  /* ---------------- 密钥派生 ---------------- */
  async function deriveKey(pass, saltB64) {
    const enc = new TextEncoder()
    const base = await crypto.subtle.importKey('raw', enc.encode(String(pass)), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64url(saltB64), iterations: ITER, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  /* 信封：明文部分只放算法参数与时间，账目内容全在 d 里 */
  async function encryptSnapshot(snap, pass, hint) {
    const salt = randB64(16)
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const key = await deriveKey(pass, salt)
    const plain = new TextEncoder().encode(JSON.stringify(snap))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plain)
    return JSON.stringify({
      v: 1,
      app: 'ledger10',
      alg: 'A256GCM',
      kdf: 'PBKDF2-SHA256',
      iter: ITER,
      salt: salt,
      iv: b64url(iv),
      d: b64url(ct),
      at: new Date().toISOString(),
      hint: hint || '',
    })
  }

  async function decryptSnapshot(text, pass) {
    let box
    try { box = JSON.parse(text) } catch (e) { throw new Error('备份文件已损坏') }
    if (!box || !box.salt || !box.iv || !box.d) throw new Error('这不是本应用的加密备份')
    const key = await deriveKey(pass, box.salt)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(box.iv) }, key, unb64url(box.d))
    return { snap: JSON.parse(new TextDecoder().decode(plain)), at: box.at || '', hint: box.hint || '' }
  }

  /* ---------------- 会话与存储 ---------------- */
  async function session() {
    if (!window.Cloud || !window.Cloud.getSession) return null
    try { return await window.Cloud.getSession() } catch (e) { return null }
  }
  function storage() {
    if (!window.Cloud || !window.Cloud.cloud || !window.Cloud.cloud.storage) return null
    return window.Cloud.cloud.storage
  }
  function dirPath(uid) { return storage().userPath(uid, DIR) }
  function filePath(uid, name) { return storage().userPath(uid, DIR + '/' + name) }

  /* ---------------- 本地元信息（不含口令） ---------------- */
  function meta() { return readJson(META_KEY, {}) || {} }
  function saveMeta(m) { return writeJson(META_KEY, m || {}) }
  function status() {
    const m = meta()
    return { on: !!m.on, hint: m.hint || '', at: m.at || '', path: m.path || '', bytes: m.bytes || 0, count: m.count || 0 }
  }

  /* ---------------- 备份 / 恢复 ---------------- */
  async function backup(pass, opts) {
    const o = opts || {}
    /* 先做本地前置校验（口令长度、加密环境），再检查登录与存储，
       这样用户即使没登录也能立刻看到「口令太短」这类提示 */
    if (!cryptoOk()) return { error: '当前环境不支持加密（请用 https 打开）' }
    if (String(pass || '').length < MIN_PASS) return { error: '口令至少 ' + MIN_PASS + ' 位' }
    if (hintLeak(pass, o.hint)) return { error: '口令提示不能和口令一样（提示是明文保存的），请换一句不含口令的提示' }
    const sess = await session()
    if (!sess || !sess.user || !sess.user.id) return { error: '需要先登录才能把备份放到云端（游客数据只在本机）' }
    const st = storage()
    if (!st) return { error: '云存储不可用，请检查网络' }

    const Share = await window.Lazy.need('share')
    if (!Share || !Share.buildSnapshot) return { error: '数据导出模块未就绪，请稍后重试' }

    U().toast('正在打包账目…')
    let snap
    try { snap = await Share.buildSnapshot('端到端加密备份', 'all') } catch (e) { return { error: '打包失败：' + ((e && e.message) || '') } }
    if (!snap.transactions.length && !snap.accounts.length) return { error: '还没有可备份的数据，先记几笔' }

    let payload
    try { payload = await encryptSnapshot(snap, pass, o.hint || '') } catch (e) { return { error: '加密失败：' + ((e && e.message) || '') } }
    if (payload.length > 12 * 1024 * 1024) return { error: '数据太多（' + snap.transactions.length + ' 笔），单份备份上限约 12MB' }

    const name = tsName() + '.json'
    const path = filePath(sess.user.id, name)
    U().toast('正在上传加密备份…')
    try {
      const up = await st.upload(path, new Blob([payload], { type: 'application/json' }), { contentType: 'application/json', upsert: true })
      if (up && up.error) return { error: (up.error.message || '上传失败') }
    } catch (e) { return { error: (e && e.message) || '上传失败，请检查网络' } }

    const m = meta()
    m.on = true
    m.hint = o.hint != null ? String(o.hint).slice(0, 30) : (m.hint || '')
    m.at = new Date().toISOString()
    m.path = path
    m.name = name
    m.bytes = payload.length
    m.count = snap.transactions.length
    saveMeta(m)

    /* 顺手清理超出上限的旧备份，避免占满空间 */
    try { await prune(sess.user.id, MAX_BACKUPS) } catch (e) { /* 忽略 */ }

    return { ok: true, name: name, path: path, bytes: payload.length, count: snap.transactions.length }
  }

  async function listBackups() {
    const sess = await session()
    if (!sess || !sess.user) return { error: '需要先登录' }
    const st = storage()
    if (!st) return { error: '云存储不可用' }
    let rows = []
    try {
      const res = await st.list(dirPath(sess.user.id), { limit: 200 })
      if (res && res.error) return { error: (res.error.message || '读取备份列表失败') }
      rows = (res && res.data) || []
    } catch (e) { return { error: (e && e.message) || '读取备份列表失败' } }
    const list = rows
      .map(r => {
        const nm = r.name || (r.path || '').split('/').pop()
        return { name: nm, path: filePath(sess.user.id, nm), bytes: (r.metadata && (r.metadata.size || r.metadata.contentLength)) || r.size || 0, updated: (r.updated_at || r.created_at || '') }
      })
      .filter(x => /\.json$/i.test(x.name))
      .sort((a, b) => String(b.name).localeCompare(String(a.name)))
    return { ok: true, list: list }
  }

  async function prune(uid, keep) {
    const st = storage()
    if (!st) return
    const res = await st.list(dirPath(uid), { limit: 200 })
    if (!res || res.error || !res.data) return
    const names = res.data.map(r => r.name || (r.path || '').split('/').pop())
      .filter(n => /\.json$/i.test(n))
      .sort((a, b) => String(b).localeCompare(String(a)))
    const drop = names.slice(keep)
    if (drop.length) await st.remove(drop.map(n => filePath(uid, n)))
  }

  async function remove(name) {
    const sess = await session()
    if (!sess || !sess.user) return { error: '需要先登录' }
    const st = storage()
    if (!st) return { error: '云存储不可用' }
    try {
      const r = await st.remove([filePath(sess.user.id, name)])
      if (r && r.error) return { error: (r.error.message || '删除失败') }
    } catch (e) { return { error: (e && e.message) || '删除失败' } }
    const m = meta()
    if (m.name === name) { m.path = ''; m.name = ''; m.bytes = 0; m.count = 0; saveMeta(m) }
    return { ok: true }
  }

  /* ---------------- 导出到本机 / 从本机恢复 ----------------
     与「加密备份到云端」的区别：这一路**完全不经过服务器，也不需要登录**，
     打包 → 加密 → 直接生成文件下载到用户设备，用户可以自己丢进网盘或移动硬盘。
     这是整套数据安全策略的最后一道保险：即使平台停止服务，文件仍在用户手里。
     加密格式与云端备份完全一致（同一个 encryptSnapshot），两份备份可互相恢复。 */

  /* 触发浏览器下载；返回是否成功发起 */
  function downloadBlob(text, filename) {
    try {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* 忽略 */ } }, 3000)
      return true
    } catch (e) { return false }
  }

  /**
   * 导出加密备份到本机文件
   * @param {string} pass  口令（≥ MIN_PASS 位）
   * @param {object} [opts] { hint?: string, scope?: 'all' }
   * @returns {Promise<{ok:true,name:string,bytes:number,count:number}|{error:string}>}
   */
  async function exportLocal(pass, opts) {
    const o = opts || {}
    if (!cryptoOk()) return { error: '当前环境不支持加密（请用 https 打开）' }
    if (String(pass || '').length < MIN_PASS) return { error: '口令至少 ' + MIN_PASS + ' 位' }
    if (hintLeak(pass, o.hint)) return { error: '口令提示不能和口令一样（提示是明文保存的），请换一句不含口令的提示' }

    const Share = await window.Lazy.need('share')
    if (!Share || !Share.buildSnapshot) return { error: '数据导出模块未就绪，请稍后重试' }

    if (U() && U().toast) U().toast('正在打包账目…')
    let snap
    try { snap = await Share.buildSnapshot('本机加密备份', o.scope || 'all') }
    catch (e) { return { error: '打包失败：' + ((e && e.message) || '') } }
    if (!snap.transactions.length && !snap.accounts.length) return { error: '还没有可备份的数据，先记几笔' }

    let payload
    try { payload = await encryptSnapshot(snap, pass, o.hint || '') }
    catch (e) { return { error: '加密失败：' + ((e && e.message) || '') } }

    const name = '拾光记账-加密备份-' + tsName(new Date()) + '.sgvault.json'
    if (!downloadBlob(payload, name)) return { error: '保存到本机失败（浏览器可能拦截了下载）' }

    /* 记录「上次本机备份时间」，供「我的」页备份状态卡使用 */
    const m = meta()
    m.localAt = new Date().toISOString()
    m.localName = name
    m.localBytes = payload.length
    m.localCount = snap.transactions.length
    m.localHint = o.hint != null ? String(o.hint).slice(0, 30) : (m.localHint || '')
    saveMeta(m)

    return { ok: true, name: name, bytes: payload.length, count: snap.transactions.length }
  }

  /**
   * 从本机加密文件恢复（合并语义，不覆盖现有数据）
   * @param {File} file
   * @param {string} pass
   * @returns {Promise<{ok:true,stats:object,at:string}|{error:string}>}
   */
  async function restoreLocal(file, pass) {
    if (!cryptoOk()) return { error: '当前环境不支持解密（请用 https 打开）' }
    if (!file) return { error: '请选择备份文件' }
    /* 恢复路径不校验口令长度：老备份可能是 6~7 位口令创建的，能解密就行 */
    if (!String(pass || '')) return { error: '请输入备份口令' }

    let text = ''
    try { text = await file.text() }
    catch (e) { return { error: '读取文件失败' } }

    let got
    try { got = await decryptSnapshot(text, pass) }
    catch (e) { return { error: '口令不对，或这份备份已损坏' } }

    const Share = await window.Lazy.need('share')
    if (!Share || !Share.mergeSnapshot) return { error: '合并模块未就绪，请稍后重试' }

    if (U() && U().toast) U().toast('正在合并回本机…')
    try {
      const stats = await Share.mergeSnapshot(got.snap, '本机文件恢复', 'vault-local', '')
      return { ok: true, stats: stats, at: got.at }
    } catch (e) { return { error: '合并失败：' + ((e && e.message) || '') } }
  }

  /* 上次本机备份信息（给状态卡用） */
  function lastLocalBackup() {
    const m = meta()
    return { at: m.localAt || '', name: m.localName || '', bytes: m.localBytes || 0, count: m.localCount || 0 }
  }

  /* 下载 + 解密，只做校验用（恢复流程复用同一份结果） */
  async function open(name, pass) {
    const sess = await session()
    if (!sess || !sess.user) return { error: '需要先登录' }
    if (!cryptoOk()) return { error: '当前环境不支持解密（请用 https 打开）' }
    const st = storage()
    if (!st) return { error: '云存储不可用' }
    let text = ''
    try {
      const res = await st.download(filePath(sess.user.id, name))
      if (res && res.error) return { error: '没找到这份备份，可能已被删除' }
      text = await res.data.text()
    } catch (e) { return { error: (e && e.message) || '下载失败，请检查网络' } }
    try {
      const got = await decryptSnapshot(text, pass)
      return { ok: true, snap: got.snap, at: got.at, hint: got.hint }
    } catch (e) {
      return { error: '口令不对，或这份备份已损坏' }
    }
  }

  async function restore(name, pass) {
    const got = await open(name, pass)
    if (got.error) return got
    const Share = await window.Lazy.need('share')
    if (!Share || !Share.mergeSnapshot) return { error: '合并模块未就绪，请稍后重试' }
    U().toast('正在合并回本机…')
    try {
      const stats = await Share.mergeSnapshot(got.snap, '云端恢复', 'vault', '')
      return { ok: true, stats: stats, at: got.at }
    } catch (e) { return { error: '合并失败：' + ((e && e.message) || '') } }
  }

  /* ---------------- 数据安全状态卡 ----------------
     放在这里（懒加载模块）而不是 ui.js，是为了不占首屏体积。
     按「登录态 × 距上次备份天数」分级给建议，语气克制、不吓唬用户。 */
  function statusCardHtml() {
    const isGuest = window.DB.mode === 'guest'
    const lastAt = lastLocalBackup().at
    const d = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86400000) : null
    const ago = d == null ? '' : (d === 0 ? '今天' : d + ' 天前')

    /* [色调, 标题, 说明, 主按钮] */
    let v
    if (d == null) {
      v = isGuest
        ? ['warn', '' + ic('alert') + ' 你的数据只在这台设备上', '换手机、清浏览器数据都会丢。登录账号可跨设备同步，或先导出一份加密备份。', '导出一份备份']
        : ['warn', '' + ic('database') + ' 还没做过本机备份', '备份文件存在你自己手里，是最后的保险。', '导出一份备份']
    } else if (d > 90) {
      v = ['danger', '' + ic('alert') + ' 已 ' + d + ' 天没备份了', '云端数据若遇平台停服将无法取回，强烈建议立刻导出一份存好。', '立即导出']
    } else if (d > 30) {
      v = ['warn', '' + ic('alert') + ' 已 ' + d + ' 天没备份了', '建议导出一份加密备份，存到网盘或电脑。', '立即导出']
    } else if (isGuest) {
      v = ['ok', '' + ic('check') + ' 本机备份已完成', '上次备份' + (d === 0 ? '就在今天' : '在 ' + ago) + '。登录账号后还能跨设备同步。', '再导出一份']
    } else {
      v = ['ok', '' + ic('check') + ' 数据已同步云端', '上次本机备份 ' + ago + '。', '再导出一份']
    }

    /* 底色 / 文字色一律走 CSS 变量（P2-2）：写死浅色底 + 深色字时，
       深色主题下标题会继承浅色文字叠在浅底上，实测对比度只有 1.13:1 */
    return '<div class="card callout callout--' + v[0] + '">' +
      '<div class="between" style="margin-bottom:4px"><span class="callout-title">' + v[1] + '</span>' +
      (d != null ? '<span class="tiny muted">' + esc(ago) + '</span>' : '') + '</div>' +
      '<p class="small" style="margin:0 0 10px">' + esc(v[2]) + '</p>' +
      '<div class="row" style="gap:8px"><button class="btn grow" id="bkLocal">' + esc(v[3]) + '</button>' +
      (isGuest ? '<button class="btn line grow" id="bkLogin">' + ic('cloud') + ' 登录账号</button>' : '') +
      '</div></div>'
  }

  /* 当前访问地址展示（放懒加载里省首屏体积）。selector 指向容器元素。 */
  function addrHtml(selector) {
    const box = typeof selector === 'string' ? document.querySelector(selector) : selector
    if (!box) return
    const url = location.origin + location.pathname
    box.innerHTML =
      '<div class="small muted" style="margin-top:8px">当前访问地址（建议存为书签）：<br>' +
      '<b style="word-break:break-all">' + esc(url) + '</b></div>' +
      '<button class="btn line block" id="abCopy" style="margin-top:8px">复制地址</button>'
    const cp = box.querySelector('#abCopy')
    if (cp) cp.addEventListener('click', () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => U().toast('地址已复制'), () => U().toast(url))
        } else { U().toast(url) }
      } catch (e) { U().toast(url) }
    })
  }

  /* ---------------- 界面 ---------------- */
  let loggedIn = false

  async function openCenter() {
    const U2 = U()
    if (!U2 || !U2.openSheet) return
    const sess = await session()
    loggedIn = !!(sess && sess.user && sess.user.id)
    renderCenter()
  }

  function renderCenter(msg, tone) {
    const U2 = U()
    const st = status()
    const sessOn = loggedIn

    const banner = msg ? '<div class="small" style="margin:8px 0;color:' + (tone === 'err' ? 'var(--expense)' : 'var(--income)') + '">' + esc(msg) + '</div>' : ''

    const head = '<div class="sheet-head"><span class="sheet-title">加密备份到云端</span><button id="vtClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin:4px 0 10px">' +
      '把整本账打包后用你的口令加密，密文存在只有你能读的云端路径。' +
      '<b>服务端拿到的只是密文</b>，没有口令解不开；口令不落盘、不上传，<b>忘了就恢复不了</b>。' +
      '注意：日常的云端同步仍是明文字段，这里是「备份层端到端加密」。' +
      '</div>' + banner

    if (!sessOn) {
      U2.openSheet(head +
        '<div class="card"><div class="small muted">游客模式下数据只存在本机，无法上传加密备份。登录后即可开启。</div></div>')
      bindCenter()
      return
    }

    const body = st.on
      ? '<div class="card">' +
          '<div class="row" style="justify-content:space-between;align-items:center">' +
            '<div><div style="font-weight:600">已开启</div>' +
            '<div class="small muted">最近备份 ' + (st.at ? esc(F.dstr(new Date(st.at))) : '—') +
            ' · ' + (st.count ? st.count + ' 笔' : '—') + ' · ' + kb(st.bytes) + '</div></div>' +
            '<span class="chip on">' + ic('lock') + ' 加密</span>' +
          '</div>' +
          (st.hint ? '<div class="small muted" style="margin-top:6px">口令提示：' + esc(st.hint) + '</div>' : '') +
        '</div>' +
        '<div class="field"><label for="vtPass">口令（用于本次备份 / 恢复）</label>' +
        '<input id="vtPass" class="input" type="password" placeholder="至少 ' + MIN_PASS + ' 位，别用生日" autocomplete="off"></div>' +
        '<button class="btn block" id="vtGo">立即备份到云端</button>' +
        '<div class="row" style="margin-top:8px">' +
          '<button class="btn line grow" id="vtList">刷新备份列表</button>' +
          '<button class="btn line grow" id="vtOff">关闭加密备份</button>' +
        '</div>' +
        '<div id="vtListBox" style="margin-top:10px"></div>'
      : '<div class="card">' +
          '<div class="small muted">还没有开启。设置一个口令后，会立刻生成第一份加密备份。</div>' +
        '</div>' +
        '<div class="field"><label for="vtPass">设置口令（至少 ' + MIN_PASS + ' 位）</label>' +
        '<input id="vtPass" class="input" type="password" placeholder="例如：一句只有你记得的话" autocomplete="new-password"></div>' +
        '<div class="field"><label for="vtHint">口令提示（可选，会明文存云端，别写口令本身）</label>' +
        '<input id="vtHint" class="input" type="text" maxlength="30" placeholder="例如：老家门牌号 + 生日"></div>' +
        '<button class="btn block" id="vtGo">开启并立即备份</button>'

    U2.openSheet(head + body)
    bindCenter()
  }

  function bindCenter() {
    const $ = s => document.querySelector(s)
    const close = $('#vtClose'); if (close) close.addEventListener('click', () => U().closeSheet())
    const go = $('#vtGo')
    if (go) go.addEventListener('click', async () => {
      const pass = ($('#vtPass') || {}).value || ''
      const hintEl = $('#vtHint')
      if (String(pass).length < MIN_PASS) { renderCenter('口令至少 ' + MIN_PASS + ' 位', 'err'); return }
      go.disabled = true
      const r = await backup(pass, { hint: hintEl ? hintEl.value : undefined })
      if (r.error) { renderCenter(r.error, 'err'); return }
      renderCenter('备份完成：' + r.count + ' 笔 · ' + kb(r.bytes), 'ok')
    })
    const off = $('#vtOff')
    if (off) off.addEventListener('click', () => {
      const m = meta()
      m.on = false
      saveMeta(m)
      renderCenter('已关闭自动备份入口。云端已有的密文备份仍然保留，可随时重新开启。', 'ok')
    })
    const ls = $('#vtList')
    if (ls) ls.addEventListener('click', async () => {
      const box = $('#vtListBox')
      if (box) box.innerHTML = '<div class="small muted">读取中…</div>'
      const r = await listBackups()
      if (r.error) { if (box) box.innerHTML = '<div class="small" style="color:var(--expense)">' + esc(r.error) + '</div>'; return }
      if (!r.list.length) { if (box) box.innerHTML = '<div class="small muted">云端还没有备份。</div>'; return }
      if (box) {
        box.innerHTML = r.list.map(x =>
          '<div class="list-item" data-vtname="' + esc(x.name) + '">' +
            '<div class="ico">' + ic('database') + '</div>' +
            '<div class="grow"><div>' + esc(prettyName(x.name)) + '</div>' +
            '<div class="small muted">' + kb(x.bytes) + '</div></div>' +
            '<button class="btn sm line" data-vtrestore="' + esc(x.name) + '">恢复</button>' +
            '<button class="btn sm line" data-vtdel="' + esc(x.name) + '" style="margin-left:6px">删除</button>' +
          '</div>').join('')
        box.querySelectorAll('[data-vtrestore]').forEach(b => b.addEventListener('click', async () => {
          const name = b.getAttribute('data-vtrestore')
          const pass = ($('#vtPass') || {}).value || ''
          /* 恢复不校验长度：老备份可能是 6~7 位口令创建的，能解密就行 */
          if (!String(pass)) { renderCenter('请先在上面的输入框里填口令，再点恢复', 'err'); return }
          const rr = await restore(name, pass)
          if (rr.error) { renderCenter(rr.error, 'err'); return }
          const s = rr.stats || {}
          /* 恢复走的是同一条合并链路：失败项不会被算成「已存在」，要如实告诉用户 */
          renderCenter(s.failed
            ? '已恢复 ' + s.transactions + ' 笔账目、' + s.accounts + ' 个账户；有 ' + s.failed +
              ' 笔写入失败（未被当成重复，重新恢复一次即可补回），重复跳过 ' + s.skipped + ' 笔'
            : '已恢复：' + s.transactions + ' 笔账目、' + s.accounts + ' 个账户（重复的已自动跳过 ' + s.skipped + ' 笔）',
            s.failed ? 'err' : 'ok')
        }))
        box.querySelectorAll('[data-vtdel]').forEach(b => b.addEventListener('click', async () => {
          const name = b.getAttribute('data-vtdel')
          const r2 = await remove(name)
          if (r2.error) { renderCenter(r2.error, 'err'); return }
          renderCenter('已删除 ' + prettyName(name), 'ok')
        }))
      }
    })
  }

  /* ---------------- 本机加密备份界面 ---------------- */

  /* File input 在重绘后会被浏览器清空；仅在当前面板会话内保留 File，
     允许改口令或重试失败项，不保存口令，也不把文件写进本机存储。 */
  let localRestoreFile = null

  function openLocalSheet() {
    localRestoreFile = null
    renderLocal()
  }

  function renderLocal(msg, tone) {
    const U2 = U()
    if (!U2 || !U2.openSheet) return
    const last = lastLocalBackup()
    const banner = msg
      ? '<div class="small" style="margin:8px 0;color:' + (tone === 'err' ? 'var(--expense)' : 'var(--income)') + '">' + esc(msg) + '</div>'
      : ''

    const head =
      '<div class="sheet-head"><span class="sheet-title">导出加密文件到本机</span>' +
      '<button id="vlClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin:4px 0 10px">' +
      '把整本账打包加密后保存成一个文件，你可以放进手机「文件」、电脑桌面，或上传到自己的网盘。' +
      '<b>全程不经过服务器，也不需要登录</b>，口令只有你知道。' +
      '</div>' + banner

    const body =
      /* 已有备份记录 */
      (last.at
        ? '<div class="card"><div class="row" style="justify-content:space-between;align-items:center">' +
            '<div><div style="font-weight:600">上次本机备份</div>' +
            '<div class="small muted">' + esc(F.dstr(new Date(last.at))) +
            ' · ' + (last.count ? last.count + ' 笔' : '—') + ' · ' + kb(last.bytes) + '</div></div>' +
            '<span class="chip on">' + ic('database') + ' 已导出</span>' +
          '</div></div>'
        : '<div class="card"><div class="small muted">还没有导出过。建议每 1–3 个月导出一份，存到自己手里最踏实。</div></div>') +

      /* 导出区 */
      '<div class="field"><label for="vlPass">备份口令（至少 ' + MIN_PASS + ' 位）</label>' +
      '<input id="vlPass" class="input" type="password" placeholder="例如：一句只有你记得的话" autocomplete="new-password"></div>' +
      '<div class="field"><label for="vlPass2">再输一次</label>' +
      '<input id="vlPass2" class="input" type="password" placeholder="两次要一致" autocomplete="new-password"></div>' +
      '<div class="field"><label for="vlHint">文件备注（可选，明文，写在文件里帮你分辨）</label>' +
      '<input id="vlHint" class="input" type="text" maxlength="30" placeholder="例如：2026-10 换手机前"></div>' +
      '<button class="btn block" id="vlGo">' + ic('database') + ' 导出一份加密备份文件</button>' +

      '<div class="card" style="border-left:3px solid var(--warn,#d98600);margin-top:10px">' +
      '<div class="small"><b>口令不落盘、不上传，忘了就恢复不了。</b>' +
      '建议写进你的密码管理器，或记在只有你能看到的地方。</div></div>' +

      /* 恢复区 */
      '<div style="margin-top:16px"><div style="font-weight:600;margin-bottom:6px">恢复</div>' +
      '<div class="small muted" style="margin-bottom:8px">' +
      '选择之前导出的 <b>.sgvault.json</b> 文件，输入当时的口令即可还原。' +
      '恢复是<b>合并</b>：已有的数据不会被清掉，重复的账目会自动跳过。' +
      '</div>' +
      '<input type="file" id="vlFile" accept=".json,.sgvault.json,application/json" style="display:none">' +
      '<button class="btn line block" id="vlPick">' + ic('folder') + ' 选择备份文件并恢复</button>' +
      '<div class="field" id="vlRestoreBox" style="display:' + (localRestoreFile ? '' : 'none') + ';margin-top:8px">' +
      '<label for="vlRPass">该备份的口令</label>' +
      '<input id="vlRPass" class="input" type="password" placeholder="输入恢复口令" autocomplete="off"></div>' +
      '<button class="btn block" id="vlRestore" style="display:' + (localRestoreFile ? '' : 'none') + ';margin-top:8px">确认恢复</button>' +
      '</div>' +

      /* 网盘指引 */
      '<div class="card" style="margin-top:12px">' +
      '<div class="small"><b>下载后怎么存更保险？</b><br>' +
      '· iPhone：文件 App → 长按 → 存储到「iCloud 云盘」<br>' +
      '· Android：下载目录 → 上传到百度网盘 / 阿里云盘<br>' +
      '· 电脑：拖进 OneDrive / 坚果云 / 微信文件传输助手<br>' +
      '<span class="muted">我们不接入网盘账号（避免多一份隐私风险），文件在你自己手里最安全。</span>' +
      '</div></div>'

    U2.openSheet(head + body)
    bindLocal()
  }

  function bindLocal() {
    const $ = s => document.querySelector(s)
    const close = $('#vlClose'); if (close) close.addEventListener('click', () => { localRestoreFile = null; U().closeSheet() })

    /* 导出 */
    const go = $('#vlGo')
    if (go) go.addEventListener('click', async () => {
      const p1 = ($('#vlPass') || {}).value || ''
      const p2 = ($('#vlPass2') || {}).value || ''
      if (String(p1).length < MIN_PASS) { renderLocal('口令至少 ' + MIN_PASS + ' 位', 'err'); return }
      if (p1 !== p2) { renderLocal('两次输入的口令不一致', 'err'); return }
      go.disabled = true
      const r = await exportLocal(p1, { hint: ($('#vlHint') || {}).value || '' })
      if (r.error) { renderLocal(r.error, 'err'); return }
      renderLocal('已导出：' + r.count + ' 笔 · ' + kb(r.bytes) + '。请确认文件已保存，建议再传到网盘。', 'ok')
    })

    /* 恢复：选文件 → 显示口令框 → 确认 */
    const file = $('#vlFile')
    const pick = $('#vlPick')
    if (pick && file) {
      pick.addEventListener('click', () => file.click())
      file.addEventListener('change', () => {
        const picked = (file.files && file.files[0]) || null
        if (!picked) return
        localRestoreFile = picked
        renderLocal('已选择：' + picked.name + '（' + kb(picked.size) + '），输入口令后点「确认恢复」', 'ok')
      })
    }
    const restoreBtn = $('#vlRestore')
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      const f = (document.querySelector('#vlFile') || {}).files
      const file0 = (f && f[0]) || localRestoreFile
      const pass = ($('#vlRPass') || {}).value || ''
      if (!file0) { renderLocal('请先选择备份文件', 'err'); return }
      /* 恢复不校验长度：老备份可能是 6~7 位口令创建的，能解密就行 */
      if (!String(pass)) { renderLocal('请输入该备份的口令', 'err'); return }
      if (!confirm('会把备份内容合并进当前数据（重复的自动跳过），确定继续？')) return
      restoreBtn.disabled = true
      let r
      try { r = await restoreLocal(file0, pass) }
      catch (e) { renderLocal((e && e.message) || '恢复失败，请重试', 'err'); return }
      if (r.error) { renderLocal(r.error, 'err'); return }
      const s = r.stats || {}
      if (window.App && window.App.refresh) { try { await window.App.refresh() } catch (e) { /* 忽略 */ } }
      renderLocal(s.failed
        ? '恢复完成：' + (s.transactions || 0) + ' 笔账目、' + (s.accounts || 0) + ' 个账户；有 ' + s.failed +
          ' 笔写入失败（不会被当成重复），再恢复一次即可补回' +
          (s.skipped ? '，重复已跳过 ' + s.skipped + ' 笔' : '')
        : '恢复完成：' + (s.transactions || 0) + ' 笔账目、' + (s.accounts || 0) + ' 个账户' +
          (s.skipped ? '（重复已跳过 ' + s.skipped + ' 笔）' : ''), s.failed ? 'err' : 'ok')
    })
  }

  /* ---------------- 账号与同步（聚合面板）----------------
     把散在「我的」里的 5 个数据入口收拢成一页，并显示账号状态与备份新鲜度。
     「数据在哪儿」这个问题在这里一次性讲清，用户不必逐条翻列表。
     具体操作全部复用已有模块（vault / share / sync / ui 的导出函数）。 */
  function syncHubRow(id, ico, title, sub, badge) {
    return '<div class="list-item" id="' + id + '"><div class="ico">' + ico + '</div>' +
      '<div class="grow"><div>' + esc(title) + '</div>' +
      (sub ? '<div class="small muted">' + esc(sub) + '</div>' : '') + '</div>' +
      (badge ? '<span class="tag">' + esc(badge) + '</span>' : '') + '<span class="muted">›</span></div>'
  }

  function openSyncHub() {
    const isGuest = window.DB.mode === 'guest'
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">账号与同步</span><button id="shClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:' + (isGuest ? '#fffbe8' : '#f0fbf3') + ';border:1px solid ' + (isGuest ? '#f0d9a8' : '#bfe3c9') + '">' +
      '<div class="between"><b>' + (isGuest ? '' + ic('smartphone') + ' 数据只在这台设备上' : '' + ic('cloud') + ' 数据已绑定账号') + '</b></div>' +
      '<p class="small" style="margin:6px 0 0;color:' + (isGuest ? '#8a6d1f' : '#1a7f37') + '">' +
      (isGuest
        ? '换手机、清浏览器数据都会丢。登录账号即可跨设备同步，或先导出一份加密备份兜底。'
        : '数据绑的是账号而不是链接 —— 换设备、换地址，登录同一账号即可自动恢复。') +
      '</p>' +
      (isGuest ? '<button class="btn block" id="shLogin" style="margin-top:10px">登录 / 注册账号</button>' : '') +
      '</div>' +
      '<div class="card" style="padding:0">' +
      syncHubRow('shLocal', '' + ic('database') + '', '导出加密文件到本机', '存到手机 / 电脑 / 网盘，最后的保险', '推荐') +
      syncHubRow('shVault', '' + ic('lock') + '', '加密备份到云端', '口令加密后上传，服务端只存密文', '') +
      syncHubRow('shJson', '' + ic('database') + '', 'JSON 备份 / 恢复', '可读文本，便于迁移到别的工具', '') +
      syncHubRow('shCsv', '' + ic('upload') + '', '导出 CSV 明细', 'Excel 可打开的表格', '') +
      syncHubRow('shSync', '' + ic('refresh') + '', '同步状态与冲突', '连接状态 · 待上传 · 冲突检查', '') +
      '</div>' +
      '<div id="shStatus"></div>' +
      /* 访问入口能力边界说明：用户最容易困惑的地方，一次讲清 */
      '<div class="card"><div class="help-sec"><h4>访问入口说明</h4>' +
      '<p class="muted"><b>平台地址</b>：支持登录、账号隔离、跨设备同步、AI 记账、共享账本 —— 日常就用它。' +
      '开发者每次更新发布后地址可能变化，请把地址加入书签，登录同一账号即可看到全部数据。</p>' +
      '<p class="muted"><b>自建空间</b>（离线备用入口）：把本安装包放到自己的服务器 / 网盘静态空间，' +
      '打开后游客模式与全部本地功能照常可用（记账、统计、预算、报表、加密导出），' +
      '但登录、云同步、AI 记账依赖平台后端，自建环境下不可用 —— 这是设计取舍，不是故障。</p>' +
      '<p class="muted">两个入口各管一段：<b>平台地址管同步，自建空间管离线</b>。真正的保命手段是「导出加密文件到本机」，' +
      '文件在你自己手里，谁也拿不走。</p></div><div id="shAddr"></div></div>' +
      '<p class="hint">真正的保命手段是导出一份加密文件，存到网盘或电脑。</p>'
    )
    const c = document.getElementById('shClose')
    if (c) c.addEventListener('click', U().closeSheet)
    const lg = document.getElementById('shLogin')
    if (lg) lg.addEventListener('click', () => { U().closeSheet(); window.App.backToAuth() })
    const v = document.getElementById('shVault')
    if (v) v.addEventListener('click', () => { U().closeSheet(); openCenter() })
    const l = document.getElementById('shLocal')
    if (l) l.addEventListener('click', () => { U().closeSheet(); openLocalSheet() })
    const j = document.getElementById('shJson')
    if (j) j.addEventListener('click', () => { U().closeSheet(); U().openBackupSheet() })
    const cs = document.getElementById('shCsv')
    if (cs) cs.addEventListener('click', () => { U().closeSheet(); if (U().exportCsv) U().exportCsv() })
    const sy = document.getElementById('shSync')
    if (sy) sy.addEventListener('click', () => { U().closeSheet(); if (window.Sync) window.Sync.openCenter() })
    const box = document.getElementById('shStatus')
    if (box) box.innerHTML = statusCardHtml()
    addrHtml('#shAddr')
    const b = document.getElementById('bkLocal')
    if (b) b.addEventListener('click', () => { U().closeSheet(); openLocalSheet() })
    const bl = document.getElementById('bkLogin')
    if (bl) bl.addEventListener('click', () => { U().closeSheet(); window.App.backToAuth() })
  }


  /* 「我的 → 新手指引」里可随时手动回看（不看存储键） */
  function replayOnboard() {
    const isGuest = window.DB.mode === 'guest'
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">数据是怎么保管的</span><button id="roClose" class="btn sm line">关闭</button></div>' +
      '<div class="card"><div class="help-sec">' +
      '<h4>① 数据默认存在本机</h4>' +
      '<p class="muted">未登录时，账目保存在这台设备的浏览器里。换手机、清理浏览器数据会丢失。</p>' +
      '<h4>② 登录账号可跨设备同步</h4>' +
      '<p class="muted">用手机号或邮箱登录后，数据归到你的账号名下。换设备、换链接，登录同一账号就能自动拉回全部账目 —— 数据绑的是账号，不是某一条链接。</p>' +
      '<h4>③ 导出加密文件是最后的保险</h4>' +
      '<p class="muted">把账目打包加密成一个 .sgvault.json 文件，存到手机、电脑或网盘。' +
      '只有知道口令的人能解开，平台与开发者都读不了。即便平台停止服务也能取回。</p>' +
      '<h4>④ 提醒</h4>' +
      '<p class="muted">云同步依赖平台后端持续运行；若平台停服，云端数据将无法取回。' +
      '建议每 1~2 个月导出一次加密备份，养成习惯就不怕。</p>' +
      '</div></div>' +
      '<div class="card" style="padding:0">' +
      syncHubRow('roBackup', '' + ic('database') + '', '导出一份加密备份', '立即体验一次', '推荐') +
      '</div>' +
      '<button class="btn block" id="roClose2" style="margin-top:10px">知道了</button>'
    )
    const c1 = document.getElementById('roClose'); if (c1) c1.addEventListener('click', U().closeSheet)
    const c2 = document.getElementById('roClose2'); if (c2) c2.addEventListener('click', U().closeSheet)
    const b = document.getElementById('roBackup')
    if (b) b.addEventListener('click', () => { U().closeSheet(); openLocalSheet() })
  }

  return {
    cryptoOk, deriveKey, encryptSnapshot, decryptSnapshot,
    status, backup, listBackups, open, restore, remove,
    exportLocal, restoreLocal, lastLocalBackup, statusCardHtml, addrHtml,
    openCenter, openLocalSheet, openSyncHub, replayOnboard, MIN_PASS, ITER,
  }
})()

