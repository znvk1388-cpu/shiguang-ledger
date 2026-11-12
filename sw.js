/* 拾光记账 · 离线缓存（仅缓存应用静态资源，云端数据请求直连） */
/* CACHE 由 `npm run stamp`（tools/sw-version.mjs）按全部静态资源的哈希自动写入。
   不要手改这一行：tests/sw-version.test.cjs 会校验它与当前文件内容一致，
   忘记重新盖章会直接测试失败 —— 手改版本号漏改导致线上跑旧资源的老问题就这么封住了。 */
const CACHE = 'ledger10-1a736f8e35d9'

/* 首屏必需：index.html 里 <script defer> 引的那些 + 样式 + 图标。
   串行安装时按这个顺序先装，中途断网也能离线启动。 */
const CORE_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css', './css/product.css', './assets/icons.svg', './icon-192.png', './icon-512.png',
  './js/vendor/workbuddy-cloud-sdk.js',
  './js/config.js', './js/env.js', './js/cloud.js', './js/format.js', './js/idb.js',
  './js/overlay.js', './js/store.js',
  './js/guest-store.js', './js/db.js', './js/sync.js', './js/lazy.js', './js/product.js',
  './js/ui.js', './js/app.js',
]

/* 懒加载模块：不在首屏 <script> 里，但必须预缓存 —— 用户点开统计图表 / 报表中心 /
   共享中心 / 加密备份 / 同步面板 / AI 记账 / AI 问账 / 规则引擎时从缓存命中，
   无等待感，且断网也能用。 */
const CORE_LAZY = [
  './js/wealth.js', './js/charts.js', './js/insight.js', './js/share.js', './js/vault.js',
  './js/sync-sheet.js', './js/migrate.js', './js/ai.js', './js/ask.js', './js/smart.js',
  './js/reimb.js', './js/review.js', './js/files.js', './js/legal.js', './js/demo.js',
  './js/manage.js', './js/vendor/papaparse.min.js', './js/csv.js',
]

const CORE = CORE_SHELL.concat(CORE_LAZY)
const APP_ROOT = new URL('./', self.location.href).pathname
const APP_INDEX = new URL('./index.html', self.location.href).pathname
const STATIC_URLS = new Set(CORE.map(u => new URL(u, self.location.href).href))

/* 新版本先进入 waiting，由页面上的「立即更新」提示决定何时切换，
   避免用户正开着旧页面时资源被悄悄换掉 */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    /* 并发 5 路预缓存（B6）：原来 40+ 个文件串行 cache.add，弱网下安装要等很久，
       这段时间用户既拿不到离线能力、也可能直接关掉页面。
       并发 5 明显缩短安装时间，又不至于把首屏带宽抢光。
       任何必需资源失败仍然让整个安装失败 —— 浏览器继续保留旧 worker 与旧缓存，
       不把不完整的新版本标为已就绪；旧缓存清理只发生在完整安装后的 activate。 */
    const CONCURRENCY = 5
    for (let i = 0; i < CORE.length; i += CONCURRENCY) {
      await Promise.all(CORE.slice(i, i + CONCURRENCY).map(u => cache.add(new Request(u, { cache: 'reload' }))))
    }
  })())
})

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('ledger10-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
))

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.indexOf('/.cloud/') === 0) return

  /* 页面和脚本使用同一个已激活版本，不能先下载新首页却仍加载旧脚本。
     查询参数仍由页面处理；其它路径的文档/下载不应被替换成应用首页。 */
  if (req.mode === 'navigate') {
    if (url.pathname !== APP_ROOT && url.pathname !== APP_INDEX) return
    e.respondWith(
      caches.open(CACHE).then(async cache =>
        await cache.match('./index.html') || await cache.match('./') || fetch(req))
    )
    return
  }

  /* 只缓存明确列出的应用文件，云端接口和其它同源数据不进入离线缓存。
     命中时不后台刷新：新资源应由新 worker 完整安装后切换，不能改写旧版本。 */
  if (!STATIC_URLS.has(url.href)) return
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res && res.status === 200 && res.type === 'basic') {
        try { await cache.put(req, res.clone()) } catch (e) { /* 空间不足时仍可使用网络响应 */ }
      }
      return res
    })
  )
})


