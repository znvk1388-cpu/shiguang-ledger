/* ============================================================
 * 按需加载器（js/lazy.js）
 * ------------------------------------------------------------
 * 目的：把「首屏不一定用得上」的脚本从关键路径上摘下来，
 *      首屏解析完并完成第一次绘制后，再利用空闲时间预取。
 *
 * 规则（很重要，改动时别破坏）：
 *  1) 使用方一律通过 `Lazy.need('insight')` / `Lazy.need('share')`
 *     拿到 promise 之后再调用，禁止直接假设 window.Insight 已存在；
 *  2) 失败会清掉缓存，允许下一次点击重试；
 *  3) 命中 Service Worker 预缓存时，动态插入的 <script> 会从缓存
 *     命中，几乎零延迟 —— 所以懒加载不会让「第一次点统计」变卡。
 * ============================================================ */
;(function () {
  const SRC = {
    smart: 'js/smart.js',
    charts: 'js/charts.js',
    insight: 'js/insight.js',
    share: 'js/share.js',
    vault: 'js/vault.js',
    syncui: 'js/sync-sheet.js',
    wealth: 'js/wealth.js',
    migrate: 'js/migrate.js',
    ai: 'js/ai.js',
    ask: 'js/ask.js',
    reimb: 'js/reimb.js',
    review: 'js/review.js',
    files: 'js/files.js',
    legal: 'js/legal.js',
    demo: 'js/demo.js',
    manage: 'js/manage.js',
    papaparse: 'js/vendor/papaparse.min.js',
    csv: 'js/csv.js',
  }
  const GLOBAL = {
    smart: 'Smart',
    charts: 'Charts',
    insight: 'Insight',
    share: 'Share',
    vault: 'Vault',
    syncui: 'SyncSheet',
    wealth: 'Wealth',
    migrate: 'Migrate',
    ai: 'AI',
    ask: 'Ask',
    reimb: 'Reimb',
    review: 'Review',
    files: 'Files',
    legal: 'Legal',
    demo: 'Demo',
    manage: 'Manage',
    papaparse: 'Papa',
    csv: 'LedgerCsv',
  }
  const cache = {}

  function nameOf(src) {
    for (const k in SRC) if (SRC[k] === src) return k
    return ''
  }

  function load(src) {
    if (cache[src]) return cache[src]
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = false
      /* 打标记，方便在 DevTools / 自动化测试里区分「首屏脚本」与「懒加载脚本」 */
      s.setAttribute('data-lazy', nameOf(src))
      s.onload = () => resolve(true)
      s.onerror = () => reject(new Error('无法加载 ' + src))
      document.head.appendChild(s)
    })
    cache[src] = p
    p.catch(() => { delete cache[src] })
    return p
  }

  function need(name) {
    const g = GLOBAL[name]
    const src = SRC[name]
    if (!src) return Promise.resolve(null)
    if (window[g]) return Promise.resolve(window[g])
    return load(src).then(() => window[g] || null).catch(() => null)
  }

  function preload() {
    const go = () => {
      Object.keys(SRC).forEach(k => { if (PRELOAD_SKIP.indexOf(k) < 0) need(k) })
    }
    try {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 3000 })
      else setTimeout(go, 900)
    } catch (e) { setTimeout(go, 900) }
  }

  /* CSV 组合加载：papaparse 必须先于 csv.js 就绪。导入/导出按钮点击时才调用。 */
  function csv() {
    return need('papaparse').then(() => need('csv'))
  }

  /* 空闲预取时跳过 CSV 组合：只有点导入/导出才需要，预取了就白占一次下载 */
  const PRELOAD_SKIP = ['papaparse', 'csv']

  function loaded(name) { return !!(GLOBAL[name] && window[GLOBAL[name]]) }

  window.Lazy = { need: need, preload: preload, load: load, loaded: loaded, csv: csv }
})()
