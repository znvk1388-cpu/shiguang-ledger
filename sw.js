/* 拾光记账 · 离线缓存（仅缓存应用静态资源，云端数据请求直连） */
const CACHE = 'ledger10-v41'

/* 首屏必需：index.html 里 <script defer> 引的那些 + 样式 + 图标。
   串行安装时按这个顺序先装，中途断网也能离线启动。 */
const CORE_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css', './css/product.css', './assets/icons.svg', './icon-192.png', './icon-512.png',
  './js/vendor/workbuddy-cloud-sdk.js',
  './js/config.js', './js/env.js', './js/cloud.js', './js/format.js', './js/idb.js', './js/store.js',
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

/* 新版本先进入 waiting，由页面上的「立即更新」提示决定何时切换，
   避免用户正开着旧页面时资源被悄悄换掉 */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    /* 逐个缓存，不用 addAll 一把梭。两个原因（都是 v1.16.0 线上实测踩到的）：
       1) addAll 是原子的：40+ 个文件里任意一个请求失败，整个 install 就失败、
          旧缓存还被删掉，SW 永远激活不了，离线能力全丢。逐个缓存时单个文件
          失败只跳过它，首用时会经下面的 fetch 处理器自动补进缓存。
       2) 平台不压缩传输、链路慢（10~50KB/s）：40 个文件并发突发会把页面自己的
          首屏脚本带宽抢干，实测 ui.js/app.js 被拖到 10s+、懒加载模块 30s+。
          串行下载总时长不变（瓶颈在链路），但页面请求能公平拿到带宽。 */
    for (const u of CORE) {
      try {
        await cache.add(new Request(u, { cache: 'reload' }))
      } catch (err) { /* 跳过，稍后首用补缓存 */ }
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

  /* 页面导航走「网络优先」，保证拿到最新入口；断网时回退到缓存首页 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
        }
        return res
      }).catch(() =>
        caches.match(req)
          .then(hit => hit || caches.match('./index.html'))
          .then(hit => hit || caches.match('./'))
      )
    )
    return
  }

  /* 静态资源走「缓存优先」，离线可用 */
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone())
          return res
        }).catch(() => hit)
        return hit || net
      })
    )
  )
})
