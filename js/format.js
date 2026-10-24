/* 金额与日期工具：金额一律以「分」为整数参与运算，避免浮点误差 */
window.Fmt = (function () {
  function toCents(v) {
    if (v === null || v === undefined || v === '') return 0
    return Math.round(Number(v) * 100)
  }
  function yuan(cents) {
    const neg = cents < 0
    const a = Math.abs(cents)
    const s = (a / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return (neg ? '-' : '') + s
  }
  function money(cents, withSign) {
    const n = Number(cents) || 0
    const neg = n < 0
    const s = yuan(Math.abs(n))
    if (withSign) return (neg ? '-' : '+') + '¥' + s
    /* 负数的负号必须放在 ¥ 前面（-¥1,234.00），
       否则拼出来是 ¥-1,234.00，读起来像「¥ 减 1234」 */
    return (neg ? '-' : '') + '¥' + s
  }
  /* 非人民币币种：把符号换成对应币种符号，负号同样在最前面 */
  function moneySym(cents, sym) {
    const n = Number(cents) || 0
    return (n < 0 ? '-' : '') + (sym || '¥') + yuan(Math.abs(n))
  }
  function pad2(n) { return String(n).padStart(2, '0') }

  /* Date -> 'YYYY-MM-DD'（本地时区） */
  function dstr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }
  /* Date -> 'YYYY-MM-DD HH:mm' */
  function dtstr(d) { return dstr(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
  /* Date -> 'YYYY-MM-DDTHH:mm' 用于 datetime-local */
  function localInput(d) { return dstr(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
  function parseInput(s) {
    if (!s) return new Date()
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s)
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0)
    const d = new Date(s)
    return isNaN(d) ? new Date() : d
  }
  /* ISO 字符串 -> Date */
  function parseIso(s) {
    if (!s) return new Date()
    return new Date(s.replace(' ', 'T').replace(/(\+\d{2})$/, '$1:00'))
  }
  /* ISO -> 本地 'YYYY-MM-DD HH:mm' */
  function isoLocal(s) { return dtstr(parseIso(s)) }
  function isoDay(s) { return dstr(parseIso(s)) }

  function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) }
  /* ISO 时间戳 -> 本地月份键。
     不要用 slice(0,7)：云端 timestamptz 读回来是 UTC，'2026-09-30T23:00:00+00:00'
     在 UTC+8 其实已是 10 月 1 日，直接切字符串会记到 9 月。 */
  function monthOf(s) { return monthKey(parseIso(s)) }
  function monthStart(y, m) { return new Date(y, m - 1, 1, 0, 0, 0, 0) }
  function monthEnd(y, m) { return new Date(y, m, 1, 0, 0, 0, 0) }

  /* 给服务端用的 UTC ISO（带时区偏移） */
  function iso(d) {
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    return t.toISOString().slice(0, 19) + offsetStr(d)
  }
  function offsetStr(d) {
    const off = -d.getTimezoneOffset()
    const sign = off >= 0 ? '+' : '-'
    const a = Math.abs(off)
    return sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60)
  }

  function humanDay(isoStr) {
    const d = parseIso(isoStr)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const that = new Date(d); that.setHours(0, 0, 0, 0)
    const diff = Math.round((today - that) / 86400000)
    if (diff === 0) return '今天'
    if (diff === 1) return '昨天'
    if (diff === 2) return '前天'
    if (diff === -1) return '明天'
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    return (d.getFullYear() !== today.getFullYear() ? d.getFullYear() + '年' : '') +
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd
  }

  function bytes(n) {
    if (!n) return '0 B'
    const u = ['B', 'KB', 'MB', 'GB']
    let i = 0; let v = n
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
  }

  /* ---------- 多币种：汇率与折算 ----------
     rate[cur] = 1 单位该币种折合多少人民币（CNY 恒为 1）。
     折算到基准币种：cents * rate[from] / rate[base]。
     汇率表只存本机（不上传），用户可在「汇率设置」里维护。 */
  const BASE_KEY = 'ledger10_base'
  const FX_KEY = 'ledger10_fx'
  const CURRENCIES = [
    { code: 'CNY', name: '人民币', sym: '¥' },
    { code: 'USD', name: '美元', sym: '$' },
    { code: 'HKD', name: '港币', sym: 'HK$' },
    { code: 'EUR', name: '欧元', sym: '€' },
    { code: 'JPY', name: '日元', sym: 'JP¥' },
    { code: 'GBP', name: '英镑', sym: '£' },
    { code: 'AUD', name: '澳元', sym: 'A$' },
    { code: 'CAD', name: '加元', sym: 'C$' },
    { code: 'SGD', name: '新加坡元', sym: 'S$' },
    { code: 'KRW', name: '韩元', sym: '₩' },
    { code: 'TWD', name: '新台币', sym: 'NT$' },
  ]
  /* 默认汇率仅作初始值，用户应自行按实际汇率维护 */
  const FX_DEFAULT = {
    CNY: 1, USD: 7.20, HKD: 0.92, EUR: 7.80, JPY: 0.048,
    GBP: 9.10, AUD: 4.70, CAD: 5.20, SGD: 5.40, KRW: 0.0052, TWD: 0.22,
  }

  /* 汇率与基准币种读得很频繁（每笔账目折算都要读一次），
     而 localStorage 读取 + JSON.parse 是同步开销，几千笔就是上百毫秒。
     这里做进程内缓存，任何写入立即失效。 */
  let _baseCache = null
  let _fxCache = null

  function baseCurrency() {
    if (_baseCache) return _baseCache
    try { _baseCache = localStorage.getItem(BASE_KEY) || 'CNY' } catch (e) { _baseCache = 'CNY' }
    return _baseCache
  }
  function setBaseCurrency(code) {
    _baseCache = code || 'CNY'
    try { localStorage.setItem(BASE_KEY, _baseCache) } catch (e) { /* 忽略 */ }
  }
  function fxRates() {
    if (_fxCache) return _fxCache
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem(FX_KEY) || '{}') || {} } catch (e) { saved = {} }
    _fxCache = Object.assign({}, FX_DEFAULT, saved)
    return _fxCache
  }
  function setFxRate(code, rate) {
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem(FX_KEY) || '{}') || {} } catch (e) { saved = {} }
    const v = Number(rate)
    if (!isFinite(v) || v <= 0) delete saved[code]
    else saved[code] = v
    try { localStorage.setItem(FX_KEY, JSON.stringify(saved)) } catch (e) { /* 忽略 */ }
    _fxCache = null
  }
  function resetFxRates() {
    try { localStorage.removeItem(FX_KEY) } catch (e) { /* 忽略 */ }
    _fxCache = null
  }
  function rateOf(code) {
    const r = fxRates()
    const v = Number(r[code || 'CNY'])
    return isFinite(v) && v > 0 ? v : 1
  }
  function currencySym(code) {
    const c = CURRENCIES.find(x => x.code === code)
    return c ? c.sym : (code || '¥')
  }
  /* 把「某币种的分」折算成「基准币种的分」 */
  function toBase(cents, code) {
    const from = code || baseCurrency()
    const base = baseCurrency()
    if (from === base) return Math.round(Number(cents) || 0)
    return Math.round((Number(cents) || 0) * rateOf(from) / rateOf(base))
  }
  /* 是否真的存在「非基准币种」的账户 —— 用于决定是否启用折算与汇率入口。
     传入账户列表；不传则视为没有外币账户（保持旧行为，零开销）。 */
  function hasForeign(accounts) {
    if (!accounts || !accounts.length) return false
    const base = baseCurrency()
    return accounts.some(a => (a && a.currency ? a.currency : 'CNY') !== base)
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
  }

  /* 隐私模式：SVG 图表里的金额不会走 .num 的 CSS 遮罩，这里统一在渲染层判断 */
  function privacy() {
    try { return localStorage.getItem('ledger10_privacy') === '1' } catch (e) { return false }
  }
  /* 金额文本：隐私模式下用 **** 代替，用于图表/提示等非 .num 场景 */
  function moneyText(cents) { return privacy() ? '****' : yuan(cents) }
  /* 大额紧凑写法：日历格子等窄空间用，如 8.2k / 1.2万 */
  function compactYuan(cents) {
    const v = Math.abs(cents) / 100
    if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万'
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k'
    return v.toFixed(v < 100 ? 2 : 0)
  }

  /* ---------- 周期规则日期推进 ----------
     月度/年度一律**锚定 start_date 的日号**，不用 setMonth(+1)：
     后者在 1 月 31 日会滚到 3 月 3 日。锚定后该月没有这一天时取当月最后一天，
     且下个月重新按原始日号推进（1/31 → 2/28 → 3/31，不永久漂移）。 */
  function ymdLocal(s) {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''))
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date()
  }
  function anchoredMonth(y, mi, day) {
    const last = new Date(y, mi + 1, 0).getDate()
    return new Date(y, mi, Math.min(day, last))
  }
  function nextDue(afterDate, startDate, freq) {
    const start = ymdLocal(startDate)
    if (!afterDate) return dstr(start)
    const base = ymdLocal(afterDate)
    if (freq === 'daily') return dstr(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1))
    if (freq === 'weekly') return dstr(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7))
    if (freq === 'monthly') return dstr(anchoredMonth(base.getFullYear(), base.getMonth() + 1, start.getDate()))
    if (freq === 'yearly') return dstr(anchoredMonth(base.getFullYear() + 1, start.getMonth(), start.getDate()))
    return dstr(base)
  }

  return { toCents, yuan, money, moneySym, pad2, dstr, dtstr, localInput, parseInput, parseIso, isoLocal, isoDay, monthKey, monthOf, monthStart, monthEnd, iso, humanDay, bytes, escapeHtml, privacy, moneyText, compactYuan, nextDue, ymdLocal,
    CURRENCIES, FX_DEFAULT, baseCurrency, setBaseCurrency, fxRates, setFxRate, resetFxRates, rateOf, currencySym, toBase, hasForeign }
})()
