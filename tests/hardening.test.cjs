/* 本轮加固项的回归测试（A1-A4 / B3 / B4 / C5）
 * ------------------------------------------------------------------
 * 这些断言对应「优化清单」里的验收标准。写法沿用其它测试：
 * jsdom + 直接把源码 eval 进 window，不引入构建依赖。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..')
const src = file => fs.readFileSync(path.join(root, file), 'utf8')
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
/* 去掉注释再做源码断言：注释里提到 Function( 不该算违规 */
const stripComments = code => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function loadUi(html) {
  const dom = new JSDOM(html || '<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', {
    url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true,
  })
  const w = dom.window
  w.eval(src('js/format.js'))
  w.TXN_TYPE_LABEL = { income: '收入', expense: '支出', transfer: '转账' }
  w.Lazy = { need: async () => null }
  w.DB = {
    mode: 'guest', state: { categories: [], sourceId: 'test-source' },
    accounts: () => [], allAccounts: () => [], category: () => null,
    rootCategories: () => [], childCategories: () => [], categoryName: () => '', accountName: () => '',
    budgetOf: () => null, listTemplates: async () => [],
  }
  w.App = { state: { attachments: {} }, refresh: async () => {} }
  w.eval(src('js/ui.js'))
  return { dom, w }
}

/* ---------- B4：表达式金额解析器（替换 Function 求值） ---------- */
test('amount expressions evaluate without Function() and reject malformed input', () => {
  const { dom, w } = loadUi()
  try {
    const ev = w.UI.evalAmount
    assert.equal(ev('12'), 12)
    assert.equal(ev('1+2*3'), 7)
    assert.equal(ev('(1+2)*3'), 9)
    assert.equal(ev('10÷4'), 2.5)            /* 自研键盘的除号 */
    assert.equal(ev('6×7'), 42)              /* 自研键盘的乘号 */
    assert.equal(ev('10−3'), 7)              /* U+2212 减号 */
    assert.equal(ev('0.1+0.2'), 0.3)         /* 两位小数四舍五入 */
    assert.equal(ev('-5+8'), 3)              /* 一元负号 */
    assert.equal(ev('  2 * ( 3 + 4 ) '), 14) /* 任意空白 */
    for (const bad of ['', '   ', '1+', 'abc', '1/0', '(1+2', '1+2)(', '1..2', '12元', '1e5', '0x10', '1+*2']) {
      assert.ok(Number.isNaN(ev(bad)), '应当判为非法表达式：' + JSON.stringify(bad))
    }
    /* 源码里不允许再出现 Function 求值（严格 CSP 下会被拦） */
    assert.equal(/Function\s*\(/.test(stripComments(src('js/ui.js'))), false)
  } finally { dom.window.close() }
})

/* ---------- B5：确认弹层（有容器走弹层，无容器退回原生 confirm） ---------- */
test('confirm sheet resolves false on cancel, true on confirm, and falls back without a container', async () => {
  const { dom, w } = loadUi()
  try {
    let p = w.UI.confirmSheet({ title: '删除', body: '确定删除？' })
    await nextTurn()
    assert.equal(w.document.querySelector('#confirmDialog').getAttribute('aria-modal'), 'true')
    w.document.querySelector('#cfNo').click()
    assert.equal(await p, false)

    p = w.UI.confirmSheet({ title: '删除', body: '确定删除？', okText: '删除' })
    await nextTurn()
    assert.equal(w.document.querySelector('#cfYes').textContent, '删除')
    w.document.querySelector('#cfYes').click()
    assert.equal(await p, true)

    /* 关闭按钮等同取消 */
    p = w.UI.confirmSheet('随便问一句')
    await nextTurn()
    w.document.querySelector('#cfClose').click()
    assert.equal(await p, false)
  } finally { dom.window.close() }

  /* 没有 #sheet 容器（单测/极早调用）：退回原生 confirm，调用方逻辑不中断 */
  const bare = new JSDOM('<body></body>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const bw = bare.window
  bw.eval(src('js/format.js'))
  bw.TXN_TYPE_LABEL = {}
  bw.Lazy = { need: async () => null }
  bw.DB = { mode: 'guest', state: { categories: [] } }
  bw.App = { state: { attachments: {} } }
  bw.eval(src('js/ui.js'))
  bw.confirm = () => false
  assert.equal(await bw.UI.confirmSheet('确定？'), false)
  bw.confirm = () => true
  assert.equal(await bw.UI.confirmSheet('确定？'), true)
  bare.window.close()
})

/* ---------- A1：本机存储持久化 ---------- */
test('guest entry requests persistent storage and reports its state', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  try {
    const w = dom.window
    w.eval(src('js/format.js'))
    let asked = 0
    Object.defineProperty(w.navigator, 'storage', {
      value: { persisted: async () => false, persist: async () => { asked++; return true } },
      configurable: true,
    })
    w.GuestStore = { init: async () => true }
    w.Store = { init: async () => true }
    w.eval(src('js/db.js'))
    await w.DB.useGuest()
    await nextTurn(); await nextTurn()
    assert.equal(asked, 1, '游客模式应向浏览器申请持久化存储')
    assert.equal(w.DB.persistState(), true)
  } finally { dom.window.close() }

  /* 浏览器不支持 persist() 时要给出 false，而不是抛错 */
  const dom2 = new JSDOM('<body></body>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  try {
    const w = dom2.window
    w.eval(src('js/format.js'))
    Object.defineProperty(w.navigator, 'storage', { value: {}, configurable: true })
    w.GuestStore = { init: async () => true }
    w.Store = { init: async () => true }
    w.eval(src('js/db.js'))
    await w.DB.useGuest()
    await nextTurn()
    assert.equal(w.DB.persistState(), false)
  } finally { dom2.window.close() }
})

/* ---------- A2：十万条以上必须报错而不是静默截断 ---------- */
test('stores refuse to silently truncate full reads above the row cap', () => {
  for (const file of ['js/store.js', 'js/guest-store.js']) {
    const code = src(file)
    assert.match(code, /const ROW_CAP = 100000/, file + ' 应保留统一的行数上限常量')
    assert.match(code, /code = 'TOO_MANY_ROWS'/, file + ' 应抛出可识别的截断错误')
    assert.match(code, /(limit|want) >= ROW_CAP/, file + ' 上限判断')
  }
  /* 云端用分页变量 want 判断，游客用入参 limit 判断 */
  assert.match(src('js/store.js'), /want >= ROW_CAP/)
  assert.match(src('js/guest-store.js'), /limit >= ROW_CAP/)
  /* 导出入口要把内部错误翻译成用户能照做的提示 */
  assert.match(src('js/store.js'), /按年份分批导出/)
  assert.match(src('js/guest-store.js'), /按年份分批导出/)
})

/* ---------- A3：本机覆盖层随备份走，且绝不带上 PIN / 分享密钥 ---------- */
test('local overlays are included in JSON backup but secrets are never exported', async () => {
  const { dom, w } = loadUi()
  try {
    w.localStorage.setItem('ledger10_reimb_v2:' + encodeURIComponent('["guest","test-source"]'), JSON.stringify({ 1: { status: 'pending' } }))
    w.localStorage.setItem('ledger10_goallink', JSON.stringify({ 1: { accountId: 2 } }))
    w.localStorage.setItem('ledger10_fx', JSON.stringify({ USD: 7 }))
    w.localStorage.setItem('ledger10_lock', JSON.stringify({ pin: 'hash' }))
    w.localStorage.setItem('ledger10_shares', JSON.stringify([{ sid: 'secret' }]))
    w.localStorage.setItem('ledger10_sync2:out:guest', JSON.stringify([{ op: 1 }]))
    w.localStorage.setItem('ledger10_theme', 'dark')

    const box = w.UI.collectOverlays()
    assert.ok(Object.keys(box).some(k => k.indexOf('ledger10_reimb_v2:') === 0), '报销进度应随备份')
    assert.equal(Object.prototype.hasOwnProperty.call(box, 'ledger10_goallink'), false, '旧全局目标联动归属不明，不自动导出')
    assert.ok(box.__ledger10_overlay.omitted.some(x => x.name === '目标账户联动'))
    for (const secret of ['ledger10_lock', 'ledger10_shares', 'ledger10_sync2:out:guest', 'ledger10_theme']) {
      assert.equal(Object.prototype.hasOwnProperty.call(box, secret), false, '不得导出：' + secret)
    }

    /* 恢复：只写回白名单内的键 */
    w.localStorage.clear()
    const n = w.UI.applyOverlays(Object.assign({}, box, { ledger10_lock: '{"pin":"evil"}', unknown: 'x' }))
    assert.ok(n >= 2)
    assert.equal(w.localStorage.getItem('ledger10_lock'), null, '恢复时不得写入 PIN')
    assert.equal(w.localStorage.getItem('unknown'), null)
    assert.ok(w.localStorage.getItem('ledger10_fx'))
    assert.equal(w.localStorage.getItem('ledger10_goallink'), null)
  } finally { dom.window.close() }
})

/* ---------- A4 / C5：清单与空态入口 ---------- */
test('installed app may rotate on tablets and the empty ledger still offers quick entry', () => {
  const manifest = JSON.parse(src('manifest.json'))
  assert.notEqual(manifest.orientation, 'portrait', '平板横屏布局需要可旋转')

  const product = src('js/product.js')
  assert.match(product, /ledgerEmpty\(\)\) \{\s*\n\s*let quickOnEmpty/, '空账本也要给快捷入口')
})

/* ---------- B3：批量编辑必须复用既有写路径（带同步与幂等），不另造接口 ---------- */
test('batch editing reuses the synced write methods and reports partial failures', () => {
  const code = src('js/ui.js')
  assert.match(code, /async function batchUpdate/)
  assert.match(code, /await S\.updateTransaction\(ids\[i\]/, '批量改分类/账户应走 updateTransaction')
  assert.match(code, /await S\.deleteTransaction\(id\)/, '批量删除应走 deleteTransaction')
  assert.match(code, /failed\.length/, '部分失败要汇报，不能静默丢弃')
  assert.match(code, /id="batchBar"|el\.id = 'batchBar'/, '需要底部批量操作条')
  /* 多选态下行首要有勾选位，并且仍然可点（键盘可达） */
  assert.match(code, /pick-box/)
})

/* ---------- B5：全仓库不再直接调用原生 confirm ---------- */
test('no module calls the native confirm directly any more', () => {
  /* format.js 里的那一处是 confirmSheet 的兜底实现本身，允许存在 */
  const files = fs.readdirSync(path.join(root, 'js'))
    .filter(f => f.endsWith('.js') && f !== 'ui.js' && f !== 'format.js')
  for (const f of files) {
    const code = src(path.join('js', f))
    const hits = (code.match(/(?<![.\w])confirm\(/g) || []).length
    assert.equal(hits, 0, f + ' 仍在直接调用 confirm()')
  }
  /* ui.js 允许保留两处，都有明确理由：
     1) confirmSheet 在没有 #sheet 容器时的兜底（单测/极早调用）；
     2) 编辑器未保存改动的同步守卫 —— 全应用只有一层 #sheet，异步弹层会把编辑器
        DOM 顶掉，「继续编辑」回到空表单。见 js/ui.js 里 mayLeaveEditor 的注释。 */
  const ui = src('js/ui.js')
  const hits = (ui.match(/(?<![.\w])confirm\(/g) || []).length
  assert.equal(hits, 2, 'ui.js 里原生 confirm 只应保留兜底与编辑器守卫，实际 ' + hits + ' 处')
})

/* ---------- A3 中期：本机覆盖层镜像进 IndexedDB ---------- */
const { IDBFactory } = require('fake-indexeddb')

function loadOverlay() {
  const dom = new JSDOM('<!doctype html><div id="sheet"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  w.indexedDB = new IDBFactory()
  w.eval(src('js/idb.js'))
  w.eval(src('js/overlay.js'))
  return { dom, w }
}

test('overlay writes are mirrored to IndexedDB and come back after localStorage is wiped', async () => {
  const { dom, w } = loadOverlay()
  try {
    assert.equal(w.Overlay.install(), true)
    w.localStorage.setItem('ledger10_reimb_v2:guest:a1', '{"tx1":"done"}')
    w.localStorage.setItem('ledger10_fx', '{"USD":7.1}')
    w.localStorage.setItem('ledger10_lock', 'PIN-SHOULD-NOT-BE-COPIED')
    w.localStorage.setItem('ledger10_sync2:out:guest', '[{"op":1}]')
    await w.Overlay.flush()
    const rows = await w.Idb.all('overlays')
    const keys = rows.map(r => r.id).sort()
    /* 该镜像的两个键都在 */
    assert.deepEqual(keys, ['ledger10_fx', 'ledger10_reimb_v2:guest:a1'])
    /* 凭据与上传队列绝不复制第二份 */
    assert.equal(keys.some(k => k.indexOf('ledger10_lock') === 0), false)
    assert.equal(keys.some(k => k.indexOf('ledger10_sync2') === 0), false)

    /* 模拟浏览器把 localStorage 清掉：IDB 还在 → 启动时应当自己长回来 */
    w.localStorage.clear()
    const r = await w.Overlay.restore()
    assert.ok(r.restored >= 2, '应至少恢复 2 个键，实际 ' + JSON.stringify(r))
    assert.equal(w.localStorage.getItem('ledger10_reimb_v2:guest:a1'), '{"tx1":"done"}')
    assert.equal(w.localStorage.getItem('ledger10_fx'), '{"USD":7.1}')
  } finally { dom.window.close() }
})

test('overlay seeds existing localStorage keys into IndexedDB on first run after upgrade', async () => {
  const { dom, w } = loadOverlay()
  try {
    /* 升级前的老用户：只有 localStorage，没有 overlays 表内容 */
    w.localStorage.setItem('ledger10_goallink', '{"g1":3}')
    const r = await w.Overlay.restore()
    assert.ok(r.seeded >= 1, '应把已有键补种进 IDB')
    const rows = await w.Idb.all('overlays')
    assert.equal(rows.some(x => x.id === 'ledger10_goallink'), true)
    /* 不认识的键不镜像（白名单外的一律跳过） */
    w.localStorage.setItem('some_other_app_key', 'x')
    await w.Overlay.restore()
    const rows2 = await w.Idb.all('overlays')
    assert.equal(rows2.some(x => x.id === 'some_other_app_key'), false)
    assert.equal(w.Overlay.mirrored('some_other_app_key'), false)
  } finally { dom.window.close() }
})

/* ---------- D4：在线汇率（显式触发、失败不动已有数据） ---------- */
test('fetchRates inverts the public API rates and applyRates persists them', async () => {
  const dom = new JSDOM('<!doctype html>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  try {
    w.eval(src('js/format.js'))
    const F = w.Fmt
    w.fetch = async () => ({
      ok: true,
      json: async () => ({ result: 'success', rates: { CNY: 1, USD: 0.14, JPY: 20 }, time_last_update_unix: 1700000000 }),
    })
    const pack = await F.fetchRates()
    assert.equal(pack.rates.CNY, 1)
    /* 接口给 1 CNY = 0.14 USD → 本应用存 1 USD = 7.142857 CNY */
    assert.equal(pack.rates.USD, 7.142857)
    assert.equal(pack.rates.JPY, 0.05)
    F.applyRates(pack)
    assert.equal(F.rateOf('USD'), 7.142857)
    assert.ok(F.fxUpdatedAt(), '应记录联机更新时间')
    /* 10 美元 = 71.43 元（分） */
    assert.equal(F.toBase(1000, 'USD'), 7143)

    /* 网络挂掉：只报错，已有汇率原样保留 */
    w.fetch = async () => { throw new Error('offline') }
    await assert.rejects(() => F.fetchRates(), /网络不可用/)
    assert.equal(F.rateOf('USD'), 7.142857)
    /* 接口返回异常结构也要报错，不能把 undefined 写进汇率 */
    w.fetch = async () => ({ ok: true, json: async () => ({ result: 'error' }) })
    await assert.rejects(() => F.fetchRates(), /不可用/)
  } finally { dom.window.close() }
})

/* ---------- D4：汇率面板的按钮真的能跑通（含失败路径） ----------
   这条是为一个真实 bug 补的：第一版 handler 里调了不存在的 openFxSheet()，
   静态检查与既有测试都发现不了，只有点一次才会看到 "openFxSheet is not defined"。 */
test('fx panel pulls live rates and keeps manual ones when the network fails', async () => {
  const dom = new JSDOM('<!doctype html><div id="sheet"></div><div id="toast"></div>', { url: 'https://ledger.test', runScripts: 'outside-only' })
  const w = dom.window
  const tick = () => new Promise(resolve => setTimeout(resolve, 80))
  try {
    w.eval(src('js/format.js'))
    w.UI = {
      $: s => w.document.querySelector(s),
      $$: s => Array.from(w.document.querySelectorAll(s)),
      openSheet: html => { w.document.querySelector('#sheet').innerHTML = html },
      closeSheet: () => {},
      toast: m => { w.document.querySelector('#toast').textContent = String(m) },
      ic: () => '', confirmSheet: async () => true, animateFeedback: () => {}, lightbox: () => {},
    }
    w.App = { renderTab: () => {} }
    w.DB = { allAccounts: () => [], state: {} }
    w.eval(src('js/manage.js'))

    w.fetch = async () => ({ ok: true, json: async () => ({ result: 'success', rates: { CNY: 1, USD: 0.125 }, time_last_update_unix: 1700000000 }) })
    w.Manage.openFxSettings()
    assert.ok(w.document.querySelector('#fxFetch'), '汇率面板应有「从网络更新汇率」按钮')
    assert.match(w.document.querySelector('#fxAt').textContent, /手动汇率/)
    w.document.querySelector('#fxFetch').click()
    await tick()
    assert.equal(w.Fmt.rateOf('USD'), 8, '应写入 1/0.125 = 8')
    assert.ok(w.Fmt.fxUpdatedAt(), '应记录联机更新时间')
    assert.match(w.document.querySelector('#toast').textContent, /汇率/, '应给出成功提示而不是内部错误')

    /* 网络失败：只提示，已保存的汇率保持原值 */
    w.fetch = async () => { throw new Error('offline') }
    w.Manage.openFxSettings()
    w.document.querySelector('#fxFetch').click()
    await tick()
    assert.equal(w.Fmt.rateOf('USD'), 8)
    assert.match(w.document.querySelector('#toast').textContent, /网络不可用/)
    assert.equal(w.document.querySelector('#fxFetch').disabled, false, '失败后按钮要能再点')
  } finally { dom.window.close() }
})
