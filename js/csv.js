/* CSV 数据归一化。语法解析由 PapaParse 负责，本模块只处理账单字段。 */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.LedgerCsv = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'

  function amountCents(value, allowNegative) {
    let text = String(value == null ? '' : value).trim().replace(/^[¥￥]\s*/, '')
    let negative = false
    if (allowNegative && /^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1) }
    if (allowNegative && /^-/.test(text)) { negative = true; text = text.slice(1) }
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null
    const parts = text.replace(/,/g, '').split('.')
    const cents = Number(parts[0] + (parts[1] || '').padEnd(2, '0'))
    if (!Number.isSafeInteger(cents) || cents <= 0) return null
    const amount = cents / 100
    if (Math.round(amount * 100) !== cents) return null
    return allowNegative && negative ? Math.abs(cents) : cents
  }

  function parseDate(value, fmt) {
    const text = String(value == null ? '' : value).trim()
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/.exec(text)
    if (!m) return null
    const y = +m[1], month = +m[2], day = +m[3]
    const hour = +(m[4] || 0), minute = +(m[5] || 0), second = +(m[6] || 0)
    if (y < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
    const calendar = new Date(0)
    calendar.setUTCFullYear(y, month - 1, day)
    calendar.setUTCHours(hour, minute, second, 0)
    if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
    let date
    if (m[8] || m[9]) {
      const offsetHour = +(m[10] || 0), offsetMinute = +(m[11] || 0)
      if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute)) return null
      const offset = (offsetHour * 60 + offsetMinute) * (m[9] === '-' ? -1 : 1)
      date = new Date(calendar.getTime() - offset * 60000)
    } else {
      date = new Date(0)
      date.setFullYear(y, month - 1, day)
      date.setHours(hour, minute, second, 0)
      if (date.getFullYear() !== y || date.getMonth() !== month - 1 || date.getDate() !== day ||
          date.getHours() !== hour || date.getMinutes() !== minute) return null
    }
    if (!Number.isFinite(date.getTime())) return null
    return fmt.iso(date)
  }

  function guessAccount(name) {
    if (/微信|零钱/.test(name)) return '微信'
    if (/支付宝|余额宝|花呗/.test(name)) return '支付宝'
    if (/银行|储蓄|信用|卡/.test(name)) return '银行卡'
    return '现金'
  }

  /* map：可选的手动列映射 { hi, date, amount, type, note, account, category, order }（列下标）。
     任意银行 / 平台的 CSV 只要表头对不上，就走这里（ezBookkeeping 的做法）。 */
  function parse(text, papa, fmt, map) {
    if (!papa || typeof papa.parse !== 'function') throw new Error('CSV 解析组件未加载，请刷新页面后重试')
    if (typeof text !== 'string') throw new Error('CSV 内容必须是文本')
    const parsed = papa.parse(text.replace(/^\uFEFF/, ''), {
      delimiter: ',', dynamicTyping: false, skipEmptyLines: 'greedy',
    })
    if (parsed.errors.length) {
      const first = parsed.errors[0]
      throw new Error('CSV 引号或分隔格式不完整，请检查文件（记录 ' + ((first.row || 0) + 1) + '）')
    }
    const data = parsed.data
    const clean = value => String(value == null ? '' : value).trim()
    let headerIndex, head, app, iDate, iType, iAmount, iAccount, iTo, iCategory, iNote, iPeer, iTags, ordCols
    if (map) {
      headerIndex = map.hi || 0
      head = (data[headerIndex] || []).map(clean)
      app = false
      iDate = map.date
      iAmount = map.amount
      iType = map.type != null && map.type >= 0 ? map.type : -1
      iNote = map.note != null ? map.note : -1
      iAccount = map.account != null ? map.account : -1
      iCategory = map.category != null ? map.category : -1
      iTo = -1; iPeer = -1; iTags = -1
      ordCols = map.order != null && map.order >= 0 ? [map.order] : []
      if (!(iDate >= 0) || !(iAmount >= 0)) throw new Error('手动映射缺少日期或金额列')
    } else {
      const appIndex = data.findIndex(row => ['日期', '类型', '金额'].every(name => row.map(clean).includes(name)))
      const extIndex = data.findIndex(row => row.map(clean).includes('交易时间'))
      headerIndex = appIndex >= 0 ? appIndex : extIndex
      if (headerIndex < 0) {
        const e = new Error('未识别的 CSV（需含 日期/类型/金额，或微信/支付宝账单列）')
        e.code = 'NEED_MAP'
        throw e
      }
      head = data[headerIndex].map(clean)
      app = appIndex >= 0
      const col = names => { for (const name of names) { const i = head.indexOf(name); if (i >= 0) return i } return -1 }
      iDate = col(app ? ['日期'] : ['交易时间'])
      iType = col(app ? ['类型'] : ['收/支', '收支'])
      iAmount = col(app ? ['金额'] : ['金额(元)', '金额（元）', '金额'])
      if ([iDate, iType, iAmount].some(i => i < 0)) {
        const e = new Error('账单缺少必要列（日期/类型/金额或交易时间/收支/金额）')
        e.code = 'NEED_MAP'
        throw e
      }
      if ([iDate, iType, iAmount].some(i => head.indexOf(head[i]) !== head.lastIndexOf(head[i]))) {
        throw new Error('必要列重名，无法确定账目字段，请检查 CSV 表头')
      }
      iAccount = col(app ? ['账户'] : ['收/付款方式', '支付方式'])
      iTo = col(['目标账户']), iCategory = col(app ? ['分类'] : ['交易分类'])
      iNote = col(app ? ['备注'] : ['商品', '商品说明', '备注'])
      iPeer = col(['交易对方']), iTags = col(['标签'])
      /* 交易单号：微信/支付宝账单都有，是真正的「这一笔」主键。
         同一份账单导入两次要得到同样的结果，靠日期+金额+备注做不到（同一天两杯同价咖啡会误判）。 */
      ordCols = ['交易单号', '交易订单号', '商户单号', '订单号', '单号']
        .map(name => head.indexOf(name)).filter(i => i >= 0)
    }
    const types = { 支出: 'expense', 收入: 'income', 转账: 'transfer' }
    if (!app) { types.转出 = 'expense'; types.转入 = 'income'; delete types.转账 }
    const rows = [], skippedRows = [], reasons = {}, seen = new Set()
    let sameFileDuplicates = 0
    let withOrder = 0
    function skip(record, reason) {
      skippedRows.push({ record, reason })
      reasons[reason] = (reasons[reason] || 0) + 1
    }
    for (let i = headerIndex + 1; i < data.length; i++) {
      const cols = data[i]
      /* 手动映射可能没有「收支」列：没有就按支出处理，用户可在预览里改 */
      const typeName = iType >= 0 ? clean(cols[iType]) : '支出'
      const type = Object.prototype.hasOwnProperty.call(types, typeName) ? types[typeName] : null
      if (!type) { skip(i + 1, '非收支记录或类型无法识别'); continue }
      const cents = amountCents(cols[iAmount], !app)
      if (cents == null) { skip(i + 1, '金额无效、超出安全范围或超过两位小数'); continue }
      const occurred = parseDate(cols[iDate], fmt)
      if (!occurred) { skip(i + 1, '日期无效'); continue }
      const note = app ? clean(cols[iNote]) : [cols[iNote], cols[iPeer]].map(clean).filter(Boolean).join(' · ')
      let orderNo = ''
      for (const idx of ordCols) { const v = clean(cols[idx]); if (v) { orderNo = v; break } }
      const row = {
        type, amount: cents / 100, cents, occurred, orderNo,
        accountName: (app || map) ? clean(cols[iAccount]) : guessAccount(clean(cols[iAccount])),
        toAccountName: type === 'transfer' ? clean(cols[iTo]) : null,
        categoryName: clean(cols[iCategory]), note,
        tags: app ? clean(cols[iTags]).split(/\s+/).filter(Boolean) : [],
        categoryId: null, skipCat: false,
      }
      /* 文件内去重也优先用单号：同一个单号出现两次才是真重复，
         没单号的旧格式才退回「日期+类型+金额+备注」 */
      const key = orderNo
        ? 'ord|' + orderNo
        : type + '|' + cents + '|' + fmt.isoDay(occurred) + '|' + note
      if (seen.has(key)) sameFileDuplicates++
      seen.add(key)
      if (orderNo) withOrder++
      rows.push(row)
    }
    return {
      format: app ? 'app' : 'ext',
      source: map ? 'custom' : app ? 'app' : head.includes('商品说明') || head.includes('交易分类') ? 'alipay' : 'wechat',
      rows,
      report: { records: data.length - headerIndex - 1, skipped: skippedRows.length, reasons, skippedRows, sameFileDuplicates, withOrder, mapped: !!map },
    }
  }

  /* ============================================================
   * UI 接入层（v1.9.4 从 js/ui.js 迁入：CSV 导入/导出不占首屏）
   * 依赖：window.DB / window.Fmt / window.UI / window.Smart（可选）
   * ============================================================ */
  const CATMAP_KEY = 'ledger10_catmap'
  const S = () => window.DB
  const F = () => window.Fmt
  const U = () => window.UI

  function importCatMap() {
    try { return JSON.parse(localStorage.getItem(CATMAP_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function saveImportCatMap(map) {
    try { localStorage.setItem(CATMAP_KEY, JSON.stringify(map)) } catch (e) { /* 忽略 */ }
  }
  const ACCMAP_KEY = 'ledger10_import_accounts_v1'
  function importIdentity() {
    const db = S(), state = db.state || {}
    const id = db.mode === 'cloud' ? state.uid : state.sourceId
    return id ? JSON.stringify([db.mode, String(id)]) : ''
  }
  function importAccountMaps() {
    try { return JSON.parse(localStorage.getItem(ACCMAP_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function mappedAccount(id) {
    const a = S().allAccounts().find(x => String(x.id) === String(id))
    if (!a) throw new Error('映射的账户已不存在，请重新选择')
    return a.id
  }
  function applyRulesToImport(payload) {
    if (!window.Smart) return payload
    try { window.Smart.applyRules(payload, { fillOnly: true }) } catch (e) { /* 忽略 */ }
    return payload
  }
  /* 按名称查已有分类（不创建）：用于导入预览判断「这个分类账本里有没有」 */
  function findCategoryByName(name, kind) {
    if (!name) return null
    const parts = String(name).split(/[\/·]/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return null
    const cats = S().state.categories
    const parent = cats.find(x => x.kind === kind && !x.parent_id && x.name === parts[0])
    if (!parent) return null
    if (parts.length < 2) return parent.id
    const child = cats.find(x => x.kind === kind && x.parent_id === parent.id && x.name === parts[1])
    return child ? child.id : null
  }
  /* 按名称找/建账户与分类（两种格式共用） */
  const findOrCreateAccount = async (name) => {
    if (!name) return null
    let a = S().allAccounts().find(x => x.name === name)
    if (a) return a.id
    a = await S().addAccount({ name, kind: 'cash', icon: '💰', color: '#2f6bff', initial_balance: 0, sort_order: 90 })
    return a.id
  }
  const findOrCreateCategory = async (path, kind) => {
    if (!path) return null
    const parts = path.split(/[\/·]/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return null
    let parent = S().state.categories.find(x => x.kind === kind && !x.parent_id && x.name === parts[0])
    if (!parent) {
      parent = await S().addCategory({ name: parts[0], kind, icon: '📦', color: '#8a93a6', sort_order: 90 })
    }
    if (parts.length < 2) return parent.id
    let child = S().state.categories.find(x => x.kind === kind && x.parent_id === parent.id && x.name === parts[1])
    if (!child) {
      child = await S().addCategory({ name: parts[1], kind, parent_id: parent.id, icon: parent.icon || '📦', color: parent.color || '#8a93a6', sort_order: 91 })
    }
    return child.id
  }

  /* ---------- 导入：解析（不落库） ---------- */
  function parseCsvText(text, map) {
    if (!window.LedgerCsv) throw new Error('CSV 解析组件未加载，请刷新页面后重试')
    return window.LedgerCsv.parse(text, window.Papa, F(), map)
  }

  /* ---------- 任意 CSV 的列映射（ezBookkeeping 式） ----------
     只认微信/支付宝的话，用户换一家银行就导不进来。这里把表头交给用户自己对，
     映射结果按「表头签名」记住，同一个来源下次自动套用。 */
  const CSVMAP_KEY = 'ledger10_csvmap'
  function csvMaps() {
    try { return JSON.parse(localStorage.getItem(CSVMAP_KEY) || '{}') || {} } catch (e) { return {} }
  }
  function headerSig(head) { return head.join('|').slice(0, 160) }
  /* 表头探测：微信/支付宝账单前面有几行说明，取第一行有 ≥2 个非空单元格的 */
  function peekHeader(text, papa) {
    const parsed = papa.parse(text.replace(/^\uFEFF/, ''), { delimiter: ',', dynamicTyping: false, skipEmptyLines: 'greedy' })
    const data = parsed.data || []
    for (let i = 0; i < Math.min(data.length, 30); i++) {
      const row = (data[i] || []).map(c => String(c == null ? '' : c).trim())
      if (row.filter(Boolean).length >= 2) return { hi: i, head: row, sample: data.slice(i + 1, i + 3) }
    }
    return null
  }
  const CM_GUESS = [
    ['date', ['交易时间', '日期', '记账日期', '交易日期', '时间']],
    ['amount', ['金额(元)', '金额（元）', '金额', '发生额', '交易金额', '收支金额']],
    ['type', ['收/支', '收支', '类型', '交易类型', '借贷标志']],
    ['note', ['商品', '商品说明', '备注', '摘要', '交易说明', '用途']],
    ['category', ['交易分类', '分类', '类别']],
    ['account', ['收/付款方式', '支付方式', '账户', '卡号', '付款方式']],
    ['order', ['交易单号', '交易订单号', '商户单号', '订单号', '单号']],
  ]
  function guessMap(head) {
    const m = { hi: 0 }
    CM_GUESS.forEach(pair => {
      for (const name of pair[1]) { const i = head.indexOf(name); if (i >= 0) { m[pair[0]] = i; return } }
    })
    return m
  }
  function openColumnMap(text, fileName, reason) {
    if (!window.Papa) { U().toast('CSV 组件未加载，请刷新后重试'); return }
    const info = peekHeader(text, window.Papa)
    if (!info) { U().toast('没找到表头行，请检查文件'); return }
    const esc = F().escapeHtml
    const g = guessMap(info.head)
    const sel = (key, label, hint, optional) => {
      const opts = info.head.map((h, i) =>
        '<option value="' + i + '"' + (g[key] === i ? ' selected' : '') + '>' + esc(h || ('第 ' + (i + 1) + ' 列')) + '</option>').join('')
      return '<div class="field"><label>' + label + (hint ? ' <span class="tiny muted">' + hint + '</span>' : '') + '</label>' +
        '<select class="select" data-cm="' + key + '">' +
        (optional ? '<option value="-1">没有这一列</option>' : '') + opts + '</select></div>'
    }
    const sample = (info.sample || []).map(row =>
      '<div class="tiny muted ellipsis">' + esc((row || []).slice(0, 6).join(' | ')) + '</div>').join('')
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">对上列就能导入</span><button id="cmClose" class="btn sm line">关闭</button></div>' +
      '<p class="small muted">' + esc(fileName || '账单文件') + ' 的表头和内置格式不一样' + (reason ? '（' + esc(reason) + '）' : '') +
      '。选一下每列对应什么，下次同结构文件会自动套用。</p>' +
      '<div class="card" style="padding:10px 12px">' + (sample || '<div class="small muted">（没有数据行）</div>') + '</div>' +
      sel('date', '日期列', '必填') +
      sel('amount', '金额列', '必填') +
      sel('type', '收支类型列', '没有就按支出', true) +
      sel('note', '备注列', '', true) +
      sel('category', '分类列', '', true) +
      sel('account', '账户列', '', true) +
      sel('order', '交易单号列', '用于去重', true) +
      '<div class="err" id="cmErr"></div>' +
      '<button class="btn block" id="cmGo">按这个映射导入</button>'
    )
    document.getElementById('cmClose').addEventListener('click', U().closeSheet)
    document.getElementById('cmGo').addEventListener('click', () => {
      const err = document.getElementById('cmErr')
      const map = { hi: info.hi }
      document.querySelectorAll('#sheet [data-cm]').forEach(s => { map[s.getAttribute('data-cm')] = Number(s.value) })
      if (!(map.date >= 0) || !(map.amount >= 0)) { err.textContent = '日期和金额是必填的'; return }
      if (map.date === map.amount) { err.textContent = '日期和金额不能是同一列'; return }
      let parsed
      try { parsed = parseCsvText(text, map) } catch (e) { err.textContent = '解析失败：' + (e.message || ''); return }
      if (!parsed.rows.length) {
        err.textContent = '这个映射没解析出有效账目：' + Object.keys(parsed.report.reasons).map(k => k + ' ' + parsed.report.reasons[k] + ' 条').join('；')
        return
      }
      try { const m = csvMaps(); m[headerSig(info.head)] = map; localStorage.setItem(CSVMAP_KEY, JSON.stringify(m)) } catch (e) { /* 忽略 */ }
      openImportPreview(parsed, fileName)
    })
  }

  /* ---------- 导入：落库 ---------- */
  /* 成功行与正在保存的行按对象追踪：重试只处理未成功项，双击共用同一次写入。 */
  const importedRows = new WeakMap()
  async function commitRows(rows, options) {
    const opts = options || {}
    const mode = S().mode
    const bookId = S().currentBookId()
    const active = () => S().mode === mode && S().currentBookId() === bookId && (!opts.isActive || opts.isActive())
    /* 这批新落库的账目 id：导入完成后登记进「待确认」队列，
       让用户能像 Copilot 的 Transactions to review 那样过一眼。 */
    const newIds = []
    const summary = () => {
      let ok = 0, pending = 0
      rows.forEach(row => {
        const state = importedRows.get(row)
        if (state && state.done) { ok++; if (state.pending) pending++ }
      })
      return { ok, pending, remaining: rows.length - ok, stopped: !active() }
    }
    for (const r of rows) {
      if (!active()) break
      let state = importedRows.get(r)
      if (state && state.done) continue
      if (!state) {
        state = { done: false, pending: false, promise: null, attempted: false,
          opId: 'csv-' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)) }
        importedRows.set(r, state)
      }
      if (!state.promise) {
        state.promise = (async () => {
          const cents = window.LedgerCsv.amountCents(String(r.amount), false)
          if (!['expense', 'income', 'transfer'].includes(r.type) || cents == null || !window.LedgerCsv.parseDate(r.occurred, F())) {
            throw new Error('账目金额、日期或类型无效，请检查文件后重新导入')
          }
          /* 云端响应丢失时也用现有操作标记核实，查重失败不会再次提交。 */
          const tracked = mode === 'cloud' && typeof S().hasOp === 'function' && typeof S().opTag === 'function'
          if (tracked && state.attempted && await S().hasOp('transactions', state.opId)) { state.done = true; return }
          if (!active()) return
          const accountId = r.accountId != null ? mappedAccount(r.accountId) : await findOrCreateAccount(r.accountName || '')
          if (!active()) return
          let categoryId = r.categoryId || null
          if (!categoryId && !r.skipCat && r.categoryName) categoryId = await findOrCreateCategory(r.categoryName, r.type)
          if (!categoryId && !r.skipCat && !r.categoryName && r.type === 'income') categoryId = await findOrCreateCategory('其他', 'income')
          if (!active()) return
          /* 转账行缺「转入账户」时明确报错，绝不静默找/建一个「现金」来凑数 ——
             静默猜账户会直接改动账户余额，用户还以为导入是准的 */
          if (r.type === 'transfer' && !r.toAccountName) {
            throw new Error('转账行缺少「转入账户」，请在列映射里指定转入账户列后重新导入')
          }
          const toAccountId = r.type === 'transfer'
            ? (r.toAccountId != null ? mappedAccount(r.toAccountId) : await findOrCreateAccount(r.toAccountName)) : null
          if (!active()) return
          const payload = {
            txn_type: r.type, amount: cents / 100, occurred_at: r.occurred,
            account_id: accountId, to_account_id: toAccountId,
            category_id: r.type === 'transfer' ? null : categoryId,
            note: r.note, tags: (r.tags || []).slice(), reimbursable: false,
            book_id: bookId,
          }
          applyRulesToImport(payload)
          state.pending = r.type !== 'transfer' && !payload.category_id
          /* 交易单号盖进 tags（不改表结构），下次导入同一个单号就能认出来。
             读回时 store.cleanTags 会把它挪到 _ord 字段，不出现在标签栏/导出里。 */
          if (r.orderNo) payload.tags = (payload.tags || []).concat(ORD_TAG + r.orderNo)
          if (tracked) payload.tags = (payload.tags || []).concat(S().opTag(state.opId))
          state.attempted = true
          const created = await S().addTransaction(payload)
          if (created && created.id != null) newIds.push(created.id)
          state.done = true
        })()
      }
      try {
        await state.promise
      } catch (error) {
        const failure = new Error(error.message || '保存失败，请重试')
        failure.importResult = summary()
        throw failure
      } finally { state.promise = null }
    }
    if (newIds.length && window.Lazy) {
      try { await window.Lazy.need('review').then(m => m && m.add(newIds)) } catch (e) { /* 忽略 */ }
    }
    return summary()
  }

  /* 兼容旧调用（测试/脚本）：解析后直接落库，返回成功笔数 */
  async function importCsvText(text) {
    const parsed = parseCsvText(text)
    const res = await commitRows(parsed.rows)
    return res.ok
  }

  /* 重复检测：优先按交易单号（真正的幂等主键），无单号时退回
     「同类型 + 同金额 + 同一天 + 同备注」的模糊匹配。
     返回 { keys, ords }：keys 是模糊键，ords 是已入账的单号。 */
  const ORD_TAG = '_ord:'
  function orderOf(t) {
    if (t && t._ord) return String(t._ord)
    const tags = t && t.tags
    if (!Array.isArray(tags)) return ''
    for (let i = 0; i < tags.length; i++) {
      const s = String(tags[i] || '')
      if (s.slice(0, ORD_TAG.length) === ORD_TAG) return s.slice(ORD_TAG.length)
    }
    return ''
  }
  async function detectDuplicates(rows, targetBook) {
    const days = rows.map(r => F().isoDay(r.occurred)).sort()
    const keys = new Set()
    const ords = new Set()
    if (!days.length) return { keys, ords }
    const fromDate = new Date(days[0] + 'T00:00:00')
    const toDate = new Date(days[days.length - 1] + 'T00:00:00')
    toDate.setDate(toDate.getDate() + 1)
    const from = F().iso(fromDate), to = F().iso(toDate)
    let offset = 0
    for (;;) {
      const res = await S().listTransactions({ from, to, limit: 1000, offset })
      if (!res || !Array.isArray(res.rows)) throw new Error('无法完整读取已有账目，请重试')
      res.rows.forEach(t => {
        if (String(t.book_id || S().defaultBookId()) !== String(targetBook)) return
        const ord = orderOf(t)
        if (ord) ords.add(ord)
        keys.add(t.txn_type + '|' + F().toCents(t.amount) + '|' + F().isoDay(t.occurred_at) + '|' + (t.note || ''))
      })
      offset += res.rows.length
      if (Number.isFinite(res.total)) {
        if (offset >= res.total) break
        if (!res.rows.length) throw new Error('已有账目读取不完整，请重试')
      } else if (res.rows.length < 1000) break
      if (offset >= 200000) throw new Error('待核对账目过多，请缩小账单日期范围后导入')
    }
    return { keys, ords }
  }

  /* ---------- 导入预览与分类映射 ---------- */
  /* 面板生命周期用「我们的按钮还在不在 + 面板开着」判定，与 ai.js 同一套防串台写法 */
  async function openImportPreview(parsed, fileName) {
    const rows = parsed.rows
    if (!rows.length) { U().toast('没有可导入的有效账目，请检查解析报告'); return }
    const scopeMode = S().mode, scopeBook = S().currentBookId(), scopeIdentity = importIdentity()
    const loadingActive = () => {
      const s = document.getElementById('sheet')
      return !!document.getElementById('impClose') && !!s &&
        s.getAttribute('aria-hidden') !== 'true' && !s.hasAttribute('inert') &&
        S().mode === scopeMode && S().currentBookId() === scopeBook && importIdentity() === scopeIdentity
    }
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">检查导入账单</span><button id="impClose" class="btn sm line">关闭</button></div>' +
      '<p class="small muted">正在核对已有账目，完成前不会写入。</p><div id="impErr" class="err" role="alert"></div>' +
      '<button id="impRetryCheck" class="btn line block" hidden>重试重复检查</button>')
    document.getElementById('impClose').addEventListener('click', U().closeSheet)
    document.getElementById('impRetryCheck').addEventListener('click', () => { if (loadingActive()) openImportPreview(parsed, fileName) })
    let dupSet
    try { dupSet = await detectDuplicates(rows, scopeBook) } catch (error) {      if (loadingActive()) {
        document.getElementById('impErr').textContent = '重复检查失败，已停止导入：' + (error.message || '请重试')
        document.getElementById('impRetryCheck').hidden = false
      }
      return
    }
    if (!loadingActive()) return
    const esc = F().escapeHtml
    const cnt = { expense: 0, income: 0, transfer: 0 }
    rows.forEach(r => { cnt[r.type] = (cnt[r.type] || 0) + 1 })

    let dupCount = 0
    let ordHit = 0
    rows.forEach(r => {
      const k = r.type + '|' + F().toCents(r.amount) + '|' + F().isoDay(r.occurred) + '|' + (r.note || '')
      /* 有单号就只认单号：同一天两杯同价咖啡不会被误杀，
         备注被改过的同一笔也仍然认得出 */
      if (r.orderNo) {
        r.dup = dupSet.ords.has(r.orderNo)
        if (r.dup) ordHit++
      } else {
        r.dup = dupSet.keys.has(k)
      }
      r.uncertain = !!(r.dup && !r.orderNo)
      if (r.dup) dupCount++
    })

    /* 未识别分类 → 先套用上次记住的映射，再套用「分类纠正记忆」，剩下的一次性让用户手动指定 */
    const savedMap = importCatMap()
    const autoMapped = []
    const memMapped = []
    const unknownMap = {}
    rows.forEach(r => {
      if (r.type === 'transfer' || !r.categoryName) return
      if (findCategoryByName(r.categoryName, r.type)) return
      const mk = r.type + '|' + r.categoryName
      const remembered = Number(savedMap[mk])
      if (remembered > 0 && S().category(remembered)) {
        r.categoryId = remembered
        if (autoMapped.indexOf(r.categoryName) < 0) autoMapped.push(r.categoryName)
        return
      }
      /* 这条备注以前被用户手动改到过某个分类 → 直接沿用 */
      if (window.Smart && r.note) {
        const fix = window.Smart.suggestCategoryFix(r.note, r.type)
        if (fix && S().category(fix)) {
          r.categoryId = fix
          if (memMapped.indexOf(r.categoryName) < 0) memMapped.push(r.categoryName)
          return
        }
      }
      unknownMap[mk] = { kind: r.type, name: r.categoryName }
    })
    const unknownList = Object.keys(unknownMap).map(k => unknownMap[k])

    const mapRows = unknownList.map(u => {
      const opts = S().rootCategories(u.kind).map(c =>
        '<option value="' + c.id + '">' + esc(c.icon || '') + ' ' + esc(c.name) + '</option>').join('')
      return '<div class="row" style="margin-bottom:8px;gap:8px">' +
        '<span class="grow ellipsis small">' + ic('alert') + ' ' + esc(u.name) +
        ' <span class="muted">(' + (u.kind === 'income' ? '收入' : '支出') + ')</span></span>' +
        '<select class="select" style="height:38px;width:152px;flex:none" data-map="' + esc(u.kind + '|' + u.name) + '">' +
        '<option value="">自动创建同名分类</option>' + opts +
        '<option value="0">不指定（走规则）</option></select></div>'
    }).join('')

    const accountNames = Array.from(new Set(rows.flatMap(r => [r.accountName, r.toAccountName]).filter(Boolean)))
    const savedAccounts = scopeIdentity ? (importAccountMaps()[scopeIdentity] || {}) : {}
    const accountRows = accountNames.map((name, i) => {
      const saved = Object.prototype.hasOwnProperty.call(savedAccounts, name) ? savedAccounts[name] : null
      const options = S().allAccounts().map(a => '<option value="' + esc(String(a.id)) + '"' +
        (saved != null && String(saved) === String(a.id) ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('')
      return '<label class="row small" style="gap:8px;margin-bottom:8px"><span class="grow">' + esc(name) +
        '</span><select class="select" data-account-map="' + i + '"><option value="">按名称匹配或创建</option>' + options + '</select></label>'
    }).join('')
    const preview = rows.slice(0, 20).map(r => {
      const color = r.type === 'income' ? 'var(--income)' : r.type === 'transfer' ? 'var(--transfer)' : 'var(--expense)'
      const sign = r.type === 'income' ? '+' : r.type === 'transfer' ? '⇄' : '-'
      return '<div class="list-item" style="padding:9px 12px">' +
        '<div class="grow"><div class="small ellipsis">' + esc(r.note || r.categoryName || '（无备注）') + '</div>' +
        '<div class="tiny muted">' + r.occurred.slice(0, 10) + ' · ' + esc(r.accountName || '—') + ' · ' + esc(r.categoryName || '未分类') + '</div></div>' +
        (r.dup ? '<span class="pill pill-exp">' + (r.uncertain ? '疑似重复' : '单号重复') + '</span>' : '') +
        '<span class="num small" style="color:' + color + '">' + sign + F().money(F().toCents(r.amount)) + '</span>' +
        '</div>'
    }).join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">导入预览</span><button id="impClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:10px">' + esc(fileName || '账单文件') + ' · 共解析 ' + rows.length +
      ' 笔：支出 ' + cnt.expense + ' · 收入 ' + cnt.income + (cnt.transfer ? ' · 转账 ' + cnt.transfer : '') +
      (dupCount ? ' · <b style="color:var(--warn)">确定重复 ' + ordHit + ' 笔；疑似重复 ' + (dupCount - ordHit) + ' 笔（默认跳过）</b>' : '') + '</div>' +
      /* 幂等说明：让用户知道「再导一次不会多」是有依据的，而不是靠运气 */
      (parsed.report && parsed.report.withOrder
        ? '<div class="small muted" style="margin:-4px 0 8px">其中 ' + parsed.report.withOrder +
          ' 笔带交易单号，按单号核对' + (ordHit ? '（已跳过 ' + ordHit + ' 笔之前导过的）' : '') + '；其余按日期+金额+备注核对。</div>'
        : '') +
      (parsed.report && parsed.report.skipped
        ? '<div class="card small">已跳过 ' + parsed.report.skipped + ' 条：' +
          esc(Object.keys(parsed.report.reasons).map(reason => reason + ' ' + parsed.report.reasons[reason] + ' 条').join('；')) + '</div>' : '') +
      (parsed.report && parsed.report.sameFileDuplicates
        ? '<div class="card small" style="color:var(--warn)">同文件内有 ' + parsed.report.sameFileDuplicates +
        ' 笔与其他记录的日期、类型、金额、备注相同。请核对原账单；这些记录仍会保留导入。</div>' : '') +
      (dupCount > ordHit ? '<div class="card"><b>疑似重复：逐笔决定是否导入</b><div class="small muted">没有交易单号，只能按日期、金额和备注推测；相同消费也可能是真实的不同账目。</div>' +
        rows.map((r, i) => r.uncertain ? '<label class="list-item"><input type="checkbox" data-import-uncertain="' + i + '"><span class="grow small">' +
          esc(r.occurred.slice(0, 10)) + ' · ' + esc(r.note || '无备注') + ' · ' + F().money(F().toCents(r.amount)) + ' · 仍要导入</span></label>' : '').join('') + '</div>' : '') +
      '<p class="small muted">目标账本：<b>' + esc(S().bookName(scopeBook) || '默认账本') + '</b>。CSV 中的账本列仅供参考，本次全部写入此账本。</p>' +
      '<p class="small muted">导入中关闭面板会停止后续记录；正在保存的一笔可能完成。已成功记录不会在本面板重试时重复写入。</p>' +
      (autoMapped.length
        ? '<div class="card"><div class="small muted">已按上次记住的映射自动归类 ' + autoMapped.length + ' 个分类：' +
          esc(autoMapped.slice(0, 8).join('、')) + (autoMapped.length > 8 ? ' 等' : '') + '</div></div>'
        : '') +
      (memMapped.length
        ? '<div class="card"><div class="small muted">有 ' + memMapped.length + ' 个分类按你以前纠正过的习惯直接归好了：' +
          esc(memMapped.slice(0, 8).join('、')) + (memMapped.length > 8 ? ' 等' : '') + '</div></div>'
        : '') +
      (unknownList.length
        ? '<div class="card"><div class="between" style="margin-bottom:8px"><b>分类映射</b>' +
          '<span class="tiny muted">' + unknownList.length + ' 个未识别</span></div>' +
          '<div class="small muted" style="margin-bottom:8px">这些分类账本里还没有，选一个已有分类即可归类。</div>' + mapRows + '</div>'
        : '<div class="card"><div class="small muted">分类都能对上，无需映射。</div></div>') +
      (accountRows ? '<div class="card"><b>账户映射</b><p class="small muted">选择已有账户可避免为支付方式创建新账户；映射仅在当前账号或本机账本记住。</p>' + accountRows + '</div>' : '') +
      '<div class="card" style="padding:0">' +
      '<div class="list-item" style="background:var(--bg)"><div class="grow small muted">前 ' + Math.min(20, rows.length) + ' 笔预览</div></div>' +
      preview + '</div>' +
      '<div class="err" id="impErr"></div>' +
      '<div class="sheet-foot"><button class="btn block" id="impRun">确认导入 ' + (rows.length - dupCount) + ' 笔</button></div>'
    )

    const isActive = () => {
      const s = document.getElementById('sheet')
      return !!document.getElementById('impRun') && !!s &&
        s.getAttribute('aria-hidden') !== 'true' && !s.hasAttribute('inert') &&
        S().mode === scopeMode && S().currentBookId() === scopeBook && importIdentity() === scopeIdentity
    }
    const runButton = document.getElementById('impRun'), closeButton = document.getElementById('impClose'), errorBox = document.getElementById('impErr')
    let running = false
    if (rows.length === dupCount) runButton.disabled = true
    document.querySelectorAll('#sheet [data-import-uncertain]').forEach(box => {
      box.addEventListener('change', () => {
        const row = rows[Number(box.getAttribute('data-import-uncertain'))]
        row.dup = !box.checked
        dupCount = rows.filter(r => r.dup).length
        runButton.disabled = rows.length === dupCount
        runButton.textContent = '确认导入 ' + (rows.length - dupCount) + ' 笔'
      })
    })
    closeButton.addEventListener('click', U().closeSheet)
    runButton.addEventListener('click', async () => {
      if (running || runButton.disabled || !isActive()) return
      running = true
      runButton.disabled = true
      document.querySelectorAll('#sheet [data-import-uncertain]').forEach(box => { box.disabled = true })
      runButton.textContent = '导入中…'
      errorBox.textContent = ''
      try {
        const selectedAccounts = Object.create(null)
        document.querySelectorAll('#sheet [data-account-map]').forEach(sel => {
          const name = accountNames[Number(sel.getAttribute('data-account-map'))]
          if (sel.value) selectedAccounts[name] = mappedAccount(sel.value)
        })
        rows.forEach(r => {
          r.accountId = selectedAccounts[r.accountName] ?? null
          r.toAccountId = selectedAccounts[r.toAccountName] ?? null
        })
        if (scopeIdentity) {
          const all = importAccountMaps()
          const remembered = Object.assign(Object.create(null), all[scopeIdentity] || {})
          accountNames.forEach(name => { delete remembered[name] })
          all[scopeIdentity] = Object.assign(remembered, selectedAccounts)
          try { localStorage.setItem(ACCMAP_KEY, JSON.stringify(all)) } catch (e) { /* 映射未保存不影响本次导入 */ }
        }
        /* 应用用户选择的分类映射，并把选择记住，下次导入自动套用 */
        const learned = importCatMap()
        const userMapped = {}
        document.querySelectorAll('#sheet [data-map]').forEach(sel => {
          const v = sel.value
          if (v === '') return
          const parts = sel.getAttribute('data-map').split('|')
          const kind = parts[0]
          const name = parts.slice(1).join('|')
          const cid = Number(v)
          if (cid > 0) { learned[kind + '|' + name] = cid; userMapped[kind + '|' + name] = cid }
          rows.forEach(r => {
            if (r.type !== kind || r.categoryName !== name) return
            if (cid > 0) r.categoryId = cid
            else r.skipCat = true
          })
        })
        saveImportCatMap(learned)
        /* 顺手把「备注 → 分类」写进纠正记忆：下次同类消费（哪怕账单格式变了）也能自动归好 */
        if (window.Smart) {
          let learnedCount = 0
          rows.forEach(r => {
            if (r.dup || r.type === 'transfer' || !r.note || !r.categoryId) return
            if (!userMapped[r.type + '|' + r.categoryName]) return
            if (window.Smart.learnCategoryFix(r.note, r.categoryId, { kind: r.type })) learnedCount++
          })
          if (learnedCount) U().toast('已记住 ' + learnedCount + ' 条分类习惯')
        }
        const list = rows.filter(r => !r.dup)
        const res = await commitRows(list, { isActive })
        if (window.Smart) window.Smart.invalidateNoteCache()
        Promise.resolve(window.App.refresh()).catch(() => {})
        if (!isActive() || res.stopped) return
        showImportResult(res, dupCount, rows.length, list, autoMapped)
      } catch (error) {
        if (!isActive()) return
        const progress = error.importResult || { ok: 0, remaining: rows.filter(r => !r.dup).length }
        errorBox.textContent = '已成功 ' + progress.ok + ' 笔，剩余 ' + progress.remaining +
          ' 笔未完成：' + (error.message || '请重试') + '。重试只处理未成功记录。'
        runButton.disabled = false
        runButton.textContent = '重试剩余 ' + progress.remaining + ' 笔'
      } finally { running = false }
    })
  }

  /* ---------- 导入完成报告（替代原来一行 toast，给出可核对的明细） ---------- */
  function showImportResult(res, dupCount, parsedTotal, list, autoMapped) {
    const esc = F().escapeHtml
    const byAcc = {}
    list.forEach(r => {
      const k = r.accountName || '未指定账户'
      byAcc[k] = (byAcc[k] || 0) + 1
    })
    const accRows = Object.keys(byAcc).sort((a, b) => byAcc[b] - byAcc[a])
      .map(k => '<div class="kv"><span>' + esc(k) + '</span><b class="num">' + byAcc[k] + ' 笔</b></div>').join('')

    const stats = [
      ['成功导入', res.ok, 'var(--income)'],
      ['跳过重复', dupCount, 'var(--warn)'],
      ['待确认分类', res.pending, 'var(--sub)'],
    ].map(([k, v, c]) =>
      '<div style="flex:1;min-width:0;background:var(--bg);border-radius:12px;padding:10px 12px">' +
      '<div class="small muted">' + k + '</div>' +
      '<div class="num" style="font-size:19px;font-weight:700;color:' + c + '">' + v + '</div></div>').join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">导入完成</span><button id="irClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="text-align:center">' +
      '<div style="font-size:38px">' + ic('check') + '</div>' +
      '<div style="font-weight:700;margin-top:2px">共解析 ' + parsedTotal + ' 笔账单</div></div>' +
      '<div class="row" style="gap:8px">' + stats + '</div>' +
      (accRows
        ? '<div class="card"><div class="between" style="margin-bottom:6px"><b>按账户分布</b>' +
          '<span class="tiny muted">已按支付方式自动匹配</span></div>' + accRows + '</div>'
        : '') +
      (autoMapped.length
        ? '<div class="card"><div class="small muted">其中 ' + autoMapped.length +
          ' 个分类沿用了你上次的映射：' + esc(autoMapped.join('、')) + '</div></div>'
        : '') +
      (res.pending
        ? '<div class="card"><div class="small muted">有 ' + res.pending +
          ' 笔没能自动匹配分类，已记入"未分类"，可到明细里逐笔补选。</div></div>'
        : '') +
      '<div class="sheet-foot">' +
      '<button class="btn block" id="irDone">查看明细</button>' +
      '<button class="btn line block" id="irAgain" style="margin-top:8px">继续导入其他账单</button>' +
      '</div>'
    )
    document.getElementById('irClose').addEventListener('click', U().closeSheet)
    document.getElementById('irDone').addEventListener('click', () => { U().closeSheet(); window.App.setTab('home') })
    document.getElementById('irAgain').addEventListener('click', () => { U().closeSheet(); importCsv() })
  }

  /* ---------- 导出（PapaParse 负责公式安全转义与 CRLF） ---------- */
  async function exportCsv() {
    try {
      const rows = await S().exportAll()
      if (!rows.length) { U().toast('还没有可导出的记录'); return }
      const head = ['日期', '类型', '金额', '账本', '账户', '目标账户', '分类', '备注', '标签', '报销', '图片数']
      if (!window.Papa) throw new Error('CSV 组件未加载，请刷新后重试')
      const data = rows.map(r => [
        r.date, window.TXN_TYPE_LABEL[r.type] || r.type, r.amount, r.book, r.account, r.toAccount,
        r.category, r.note, r.tags, r.reimbursable ? '是' : '', r.images,
      ].map(v => v == null ? '' : String(v)))
      const csv = window.Papa.unparse({ fields: head, data }, { escapeFormulae: true, newline: '\r\n' })
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = '拾光记账-' + F().dstr(new Date()) + '.csv'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 3000)
      U().toast('已导出 ' + rows.length + ' 笔；公式开头文本已加防护撇号，回导会保留。保留精确原文请使用 JSON 备份。')
    } catch (e) { U().toast('导出失败：' + (e.message || '')) }
  }

  /* ---------- 导入入口：选文件 → 解析 → 预览 ---------- */
  function importCsv() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,text/csv'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]
      input.remove()
      if (!file) return
      let text = ''
      try {
        text = await file.text()
        /* 之前对过的表头 → 自动套用，不用再点一遍 */
        let saved = null
        try {
          const info = window.Papa ? peekHeader(text, window.Papa) : null
          if (info) saved = csvMaps()[headerSig(info.head)] || null
        } catch (e) { saved = null }
        const parsed = parseCsvText(text, saved)
        if (!parsed.rows.length) {
          U().toast('没有有效账目；' + Object.keys(parsed.report.reasons).map(reason => reason + ' ' + parsed.report.reasons[reason] + ' 条').join('；'))
          return
        }
        await openImportPreview(parsed, file.name)
      } catch (e) {
        /* 表头对不上不是错误，是一次「让用户自己指路」的机会 */
        if (e && e.code === 'NEED_MAP') { openColumnMap(text, file.name, e.message); return }
        U().toast('导入失败：' + (e.message || ''))
      }
    })
    input.click()
  }

  return {
    parse, amountCents, parseDate,
    importCsv, exportCsv, parseCsvText, importCsvText, openColumnMap, peekHeader,
    commitRows, openImportPreview, detectDuplicates,
  }
})
