/* 运行环境探测与小程序桥接
   ------------------------------------------------------------------
   为什么需要它：
   同一个页面要同时跑在「普通浏览器 / 微信内置浏览器 / 微信小程序 web-view / PWA」
   四种容器里，各容器的能力差别很大：
     · 小程序 web-view 里没有地址栏，OAuth 跳转会被拦截 → 微信登录必须换路子
     · 小程序 web-view 里 PWA 安装没有意义 → 要隐藏安装入口
     · 小程序的分享要经 wx.miniProgram.postMessage 回传，不能直接调 JS-SDK
     · 小程序的导航栏标题由原生控制，页面内改了没用 → 要调 setNavigationBarTitle
   所以这里做统一探测 + 桥接，其余模块只问 Env 要结论，不各自嗅探 UA。

   注意：wx.miniProgram.* 依赖微信 JS-SDK，而 JS-SDK 是外部 CDN 资源。
   这里按需注入（只在微信内才加载），加载失败不影响页面其它功能。 */
(function () {
  'use strict'

  var JSSDK_URL = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
  var jssdkPromise = null

  function ua() {
    try { return navigator.userAgent || '' } catch (e) { return '' }
  }

  /* 是否在微信里（含公众号、聊天窗口、小程序 web-view） */
  function isWechat() {
    return /MicroMessenger/i.test(ua())
  }

  /* 是否在小程序的 web-view 里
     两个判据都看：JSSDK 注入的全局变量最准，UA 里的 miniProgram 作为兜底
     （部分安卓机型 / 旧版客户端不写 UA） */
  function isMiniProgram() {
    try {
      if (window.__wxjs_environment === 'miniProgram') return true
    } catch (e) { /* 忽略 */ }
    return /miniProgram/i.test(ua())
  }

  function isIOS() {
    var s = ua()
    return /iPhone|iPad|iPod/i.test(s) ||
      (/Macintosh/i.test(s) && 'ontouchend' in document) /* iPadOS 13+ 伪装成 Mac */
  }

  function isAndroid() { return /Android/i.test(ua()) }

  function isTouch() {
    try { return ('ontouchstart' in window) || navigator.maxTouchPoints > 0 } catch (e) { return false }
  }

  /* 已作为独立应用运行（PWA 装到桌面 / iOS 添加到主屏幕） */
  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true
    } catch (e) { return false }
  }

  /* 按需注入微信 JS-SDK，只在微信环境下才发生 */
  function ensureJssdk() {
    if (jssdkPromise) return jssdkPromise
    jssdkPromise = new Promise(function (resolve) {
      if (!isWechat()) { resolve(null); return }
      if (window.wx && window.wx.miniProgram) { resolve(window.wx); return }
      var done = false
      function finish() { if (!done) { done = true; resolve(window.wx || null) } }
      var s = document.createElement('script')
      s.src = JSSDK_URL
      s.async = true
      s.onload = finish
      s.onerror = finish
      /* CDN 不可达时别把调用方吊死 */
      setTimeout(finish, 3000)
      document.head.appendChild(s)
    })
    return jssdkPromise
  }

  /* 异步复核：JSSDK 的 getEnv 比 UA 更权威，用来纠正误判 */
  function detect() {
    if (!isWechat()) return Promise.resolve(false)
    return ensureJssdk().then(function (wx) {
      if (!wx || !wx.miniProgram || !wx.miniProgram.getEnv) return isMiniProgram()
      return new Promise(function (resolve) {
        var settled = false
        function done(v) { if (!settled) { settled = true; resolve(v) } }
        try {
          wx.miniProgram.getEnv(function (res) {
            var inMp = !!(res && res.miniprogram)
            if (inMp) window.__wxjs_environment = 'miniProgram'
            done(inMp)
          })
        } catch (e) { done(isMiniProgram()) }
        setTimeout(function () { done(isMiniProgram()) }, 1500)
      })
    })
  }

  /* 把数据回传给小程序宿主页（宿主用 <web-view bindmessage> 接收）
     注意：微信只在「页面被分享 / 后退 / 组件销毁」这几个时机才投递消息，
     不能当作实时的双向通道用 */
  function postMessage(data) {
    if (!isMiniProgram()) return false
    return ensureJssdk().then(function (wx) {
      try {
        if (wx && wx.miniProgram && wx.miniProgram.postMessage) {
          wx.miniProgram.postMessage({ data: data })
          return true
        }
      } catch (e) { /* 忽略 */ }
      return false
    })
  }

  /* 原生导航栏标题（web-view 里页面自身的标题是无效的） */
  function setNavigationBarTitle(title) {
    if (!isMiniProgram()) return false
    ensureJssdk().then(function (wx) {
      try {
        if (wx && wx.miniProgram && wx.miniProgram.setNavigationBarTitle) {
          wx.miniProgram.setNavigationBarTitle({ title: String(title || '') })
        }
      } catch (e) { /* 忽略 */ }
    })
    return true
  }

  /* 关闭当前 web-view 页（相当于小程序的原生返回） */
  function navigateBack(delta) {
    if (!isMiniProgram()) return false
    ensureJssdk().then(function (wx) {
      try {
        if (wx && wx.miniProgram && wx.miniProgram.navigateBack) {
          wx.miniProgram.navigateBack({ delta: delta || 1 })
        }
      } catch (e) { /* 忽略 */ }
    })
    return true
  }

  /* 跳转到小程序内的原生页面（用于承接 H5 做不到的事，如微信登录） */
  function navigateTo(url) {
    if (!isMiniProgram()) return false
    ensureJssdk().then(function (wx) {
      try {
        if (wx && wx.miniProgram && wx.miniProgram.navigateTo) {
          wx.miniProgram.navigateTo({ url: url })
        }
      } catch (e) { /* 忽略 */ }
    })
    return true
  }

  /* 当前容器的一句话描述，用于「关于」页展示与问题排查 */
  function containerName() {
    if (isMiniProgram()) return '微信小程序'
    if (isWechat()) return '微信内置浏览器'
    if (isStandalone()) return '已安装的应用'
    return '浏览器'
  }

  window.Env = {
    isWechat: isWechat,
    isMiniProgram: isMiniProgram,
    isIOS: isIOS,
    isAndroid: isAndroid,
    isTouch: isTouch,
    isStandalone: isStandalone,
    containerName: containerName,
    detect: detect,
    ensureJssdk: ensureJssdk,
    postMessage: postMessage,
    setNavigationBarTitle: setNavigationBarTitle,
    navigateBack: navigateBack,
    navigateTo: navigateTo,
  }
})()
