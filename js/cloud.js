/* 云服务客户端：全应用唯一实例，Auth / Database / Storage 共用 */
window.Cloud = (function () {
  const cfg = window.PUBLIC_CONFIG

  /* CDN SDK 加载失败（离线/网络阻断）时降级为空壳，游客模式不受影响 */
  if (typeof WorkBuddyCloud === 'undefined') {
    const offlineError = () => ({ error: { message: '云服务离线，请检查网络后刷新' } })
    return {
      cloud: null, offline: true,
      getSession: async () => null,
      sendPhoneCode: async () => offlineError(),
      verifyPhoneCode: async () => offlineError(),
      sendEmailCode: async () => offlineError(),
      verifyEmailCode: async () => offlineError(),
      signInWithPassword: async () => offlineError(),
      wechatLogin: async () => offlineError(),
      handleWechatCallback: async () => ({ none: true }),
      signOut: async () => ({}),
      onAuthChange: () => ({}),
      signedUrl: async () => '',
      userPath: (uid, rel) => rel,
      listModels: async () => [],
      chat: async () => { throw new Error('云服务离线，AI 功能需要联网后使用') },
    }
  }

  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
    publishableKey: cfg.publishableKey,
  })

  /* ---- 会话 ---- */
  async function getSession() {
    const { data, error } = await cloud.auth.getSession()
    if (error) return null
    return data || null
  }

  let pendingOtp = null

  async function sendPhoneCode(phone) {
    if (!/^1\d{10}$/.test(phone)) return { error: { message: '请输入正确的 11 位手机号' } }
    const sent = await cloud.auth.sendOtp({ phone })
    if (sent.error) return { error: sent.error }
    pendingOtp = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    return { ok: true }
  }

  async function verifyPhoneCode(phone, token) {
    if (!pendingOtp || pendingOtp.phone !== phone) {
      return { error: { message: '请先获取当前手机号的验证码' } }
    }
    const done = await cloud.auth.verifyOtp({
      phone: pendingOtp.phone,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token,
    })
    if (done.error) return { error: done.error }
    pendingOtp = null
    return { session: done.data }
  }

  async function sendEmailCode(email) {
    if (!/^\S+@\S+\.\S+$/.test(email)) return { error: { message: '请输入正确的邮箱地址' } }
    const sent = await cloud.auth.sendOtp({ email })
    if (sent.error) return { error: sent.error }
    pendingOtp = { email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    return { ok: true }
  }

  async function verifyEmailCode(email, token, password) {
    if (!pendingOtp || pendingOtp.email !== email) {
      return { error: { message: '请先获取当前邮箱的验证码' } }
    }
    const done = await cloud.auth.verifyOtp({
      email: pendingOtp.email,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token,
      password: pendingOtp.isExistingUser ? undefined : password,
    })
    if (done.error) return { error: done.error }
    pendingOtp = null
    return { session: done.data }
  }

  async function signInWithPassword(email, password) {
    const { data, error } = await cloud.auth.signInWithPassword({ email, password })
    return error ? { error } : { session: data }
  }

  async function wechatLogin() {
    const { data, error } = await cloud.auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo: location.origin,
    })
    if (error) return { error }
    location.assign(data.url)
    return { redirected: true }
  }

  async function handleWechatCallback() {
    const { data, error } = await cloud.auth.handleWechatWebCallback()
    if (error) return { error }
    if (data) {
      history.replaceState(null, '', location.pathname)
      return { session: data }
    }
    return { none: true }
  }

  function signOut() {
    return cloud.auth.signOut()
  }

  function onAuthChange(cb) {
    return cloud.auth.onAuthStateChange(cb)
  }

  /* ---- 存储：签名 URL 缓存（默认有效期 3600s，提前 5 分钟失效） ---- */
  const urlCache = new Map()
  async function signedUrl(path) {
    const hit = urlCache.get(path)
    if (hit && hit.expire > Date.now()) return hit.url
    const { data, error } = await cloud.storage.createSignedUrl(path, 3600)
    if (error || !data) return ''
    const url = data.signedUrl || data.url || ''
    urlCache.set(path, { url, expire: Date.now() + 3300 * 1000 })
    return url
  }

  function userPath(uid, rel) {
    return cloud.storage.userPath(uid, rel)
  }

  /* ---- 大模型（免密钥）：SDK 只支持流式，这里聚合成一次性文本 ---- */
  async function listModels() {
    if (!cloud.llm) return []
    try {
      const models = await cloud.llm.models.list()
      return Array.isArray(models) ? models.filter(m => m.disabled !== true) : []
    } catch (e) { return [] }
  }

  /* opts: { model, needVision, json:false } */
  async function chat(messages, opts) {
    if (!cloud.llm) throw new Error('当前环境未开通 AI 能力')
    const o = opts || {}
    const models = await listModels()
    if (!models.length) throw new Error('当前没有可用的大模型')
    let model = o.model ? models.find(m => m.id === o.model) : null
    if (!model && o.needVision) model = models.find(m => m.capabilities && m.capabilities.supportsImages)
    if (!model) model = models[0]

    const body = { model: model.id, messages, stream: true }
    if (o.json !== false) body.response_format = { type: 'json_object' }
    if (o.temperature != null) body.temperature = o.temperature

    let out = ''
    for await (const chunk of cloud.llm.chat.completions.create(body)) {
      const choice = chunk && chunk.choices && chunk.choices[0]
      const delta = choice && choice.delta
        if (delta && typeof delta.content === 'string') {
          out += delta.content
          /* 可选流式回调（delta, 累计）；回调异常不影响最终结果 */
          if (typeof o.onDelta === 'function') {
            try { o.onDelta(delta.content, out) } catch (e) { /* 忽略渲染层异常 */ }
          }
        }
    }
    return out
  }

  return {
    cloud,
    getSession, sendPhoneCode, verifyPhoneCode, sendEmailCode, verifyEmailCode,
    signInWithPassword, wechatLogin, handleWechatCallback, signOut, onAuthChange,
    signedUrl, userPath,
    listModels, chat,
  }
})()
