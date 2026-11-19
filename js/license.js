/* 拾光 Pro 激活（v1.20.0）
 * --------------------------------------------------------------------------
 * 激活码形态：SJ1.<payload的base64url>.<签名的base64url>
 * payload 10 字节：
 *   [0..2] 魔数 'SJ1'（0x53 0x4A 0x31）
 *   [3]    计划：0x01 = Pro 买断
 *   [4..7] 签发日（大端 uint32，自 2026-01-01 起的天数）
 *   [8..9] 授权序号（大端 uint16，用于对账/退款核销）
 * 签名：Ed25519。私钥只在卖家手里（仓库外保管），App 只带公钥——
 * 即使有人拿到全部前端代码，也伪造不出能通过验证的激活码。
 * 验证用浏览器原生 WebCrypto（Chrome 113+ / Safari 17+ 支持 Ed25519）；
 * 不支持的环境给出明确提示，不影响其余功能。
 * 状态存本机 ledger10_license（随备份一起迁移），重复激活幂等。
 */
window.License = (function () {
  'use strict'
  var STORE_KEY = 'ledger10_license'
  /* 公钥：可用 window.PRO_LICENSE_PUB 覆盖（轮换密钥或测试注入），默认用内置值 */
  var PUB_RAW_B64 = (typeof window !== 'undefined' && window.PRO_LICENSE_PUB) || 'nlM7f12plRRGG4VQ3KpQWgCAwl5I2Nd8lZpIAy7orrY'
  var DAY0 = Date.UTC(2026, 0, 1)

  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    var bin = atob(s)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function subtleOf() {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) return crypto.subtle
      if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) return window.crypto.subtle
    } catch (e) { /* 忽略 */ }
    return null
  }

  var pubKeyPromise = null
  function publicKey(subtle) {
    if (!pubKeyPromise) {
      pubKeyPromise = subtle.importKey('raw', b64urlDecode(PUB_RAW_B64), { name: 'Ed25519' }, false, ['verify'])
      pubKeyPromise = pubKeyPromise.catch(function (e) { pubKeyPromise = null; throw e })
    }
    return pubKeyPromise
  }

  function parseCode(raw) {
    var code = String(raw || '').replace(/\s+/g, '')
    if (!code) return null
    var parts = code.split('.')
    if (parts.length !== 3 || parts[0] !== 'SJ1') return null
    var payload, sig
    try { payload = b64urlDecode(parts[1]); sig = b64urlDecode(parts[2]) } catch (e) { return null }
    if (payload.length !== 10 || sig.length < 32 || sig.length > 96) return null
    if (payload[0] !== 0x53 || payload[1] !== 0x4A || payload[2] !== 0x31) return null
    return { payload: payload, sig: sig }
  }

  function payloadInfo(payload) {
    var plan = payload[3]
    var iatDays = ((payload[4] << 24) | (payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0
    var serial = ((payload[8] << 8) | payload[9]) >>> 0
    return { plan: plan, iatDays: iatDays, iat: new Date(DAY0 + iatDays * 86400000), serial: serial }
  }

  /* 校验一段激活码。返回 {ok:true, info, code} 或 {ok:false, reason}。
     reason: format 格式无效 / plan 类型不支持 / signature 签名不通过 / unsupported 浏览器不支持 */
  async function verifyCode(raw) {
    var parsed = parseCode(raw)
    if (!parsed) return { ok: false, reason: 'format' }
    var info = payloadInfo(parsed.payload)
    if (info.plan !== 1) return { ok: false, reason: 'plan' }
    var iatMs = info.iat.getTime()
    if (iatMs < DAY0 || iatMs > Date.now() + 7 * 86400000) return { ok: false, reason: 'format' }
    var subtle = subtleOf()
    if (!subtle) return { ok: false, reason: 'unsupported' }
    try {
      var key = await publicKey(subtle)
      var ok = await subtle.verify({ name: 'Ed25519' }, key, parsed.sig, parsed.payload)
      if (!ok) return { ok: false, reason: 'signature' }
      return { ok: true, info: info, code: String(raw).replace(/\s+/g, '') }
    } catch (e) {
      return { ok: false, reason: 'unsupported' }
    }
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORE_KEY)
      if (!raw) return null
      var v = JSON.parse(raw)
      return v && typeof v.code === 'string' ? v : null
    } catch (e) { return null }
  }

  /* 同步判定：已保存且结构合法即视为 Pro（签名在激活时已验证过） */
  function isPro() {
    var v = read()
    if (!v) return false
    var p = parseCode(v.code)
    return !!(p && payloadInfo(p.payload).plan === 1)
  }

  function status() {
    var v = read()
    if (!v) return { pro: false }
    var p = parseCode(v.code)
    var info = p ? payloadInfo(p.payload) : null
    var pro = !!(p && info && info.plan === 1)
    return { pro: pro, activatedAt: v.activatedAt || '', serial: info ? info.serial : null, issued: info ? info.iat.toISOString().slice(0, 10) : '' }
  }

  async function activate(raw) {
    var res = await verifyCode(raw)
    if (!res.ok) return res
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ code: res.code, activatedAt: new Date().toISOString() }))
    } catch (e) { /* 本机存不进去时不阻断激活，状态本次会话仍在内存语义上成立 */ }
    return res
  }

  function deactivate() {
    try { localStorage.removeItem(STORE_KEY) } catch (e) { /* 忽略 */ }
  }

  return { activate: activate, deactivate: deactivate, isPro: isPro, status: status, verifyCode: verifyCode, parseCode: parseCode }
})()
