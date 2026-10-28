/* 法律文本与帮助页（懒加载模块）
 * ------------------------------------------------------------------
 * 隐私指引 / 用户协议 / 使用帮助 / 安装指引 / 关于，合计约 11KB 纯静态文案，
 * 只有极少数用户会打开。放在首屏会白占 gzip 预算（硬线 158720B），
 * 因此搬到懒加载模块；Service Worker 已预缓存，断网也能打开。
 * ------------------------------------------------------------------ */
;(function () {
  'use strict'
  const F = window.Fmt
  const U = window.UI
  const $ = U.$
  const esc = F.escapeHtml
  const openSheet = U.openSheet
  const closeSheet = U.closeSheet
  const toast = U.toast
  const replayOnboard = () => U.replayOnboard()
  const Lazy = window.Lazy

  function openHelp() {
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">新手指引 · 使用帮助</span><button id="hpClose" class="btn sm line">关闭</button></div>' +
      '<div class="card">' +
      '<div class="help-sec"><h4>① 记一笔</h4>' +
      '<p>点底部中间的 <b>＋</b>。金额框支持算式，输入 <span class="kbd">12+8.5*2</span> 会自动算出 29；按 <span class="kbd">Enter</span> 直接保存，按 <span class="kbd">Esc</span> 关闭。</p>' +
      '<p class="muted">分类、账户点一下即选中（选中的会带 ' + ic('check') + '）。时间、标签、周期、报销、凭证图片都收在「更多选项」里。</p></div>' +
      '<div class="help-sec"><h4>② 更省事的记法</h4>' +
      '<p>· <b>' + ic('sparkles') + ' AI 记账</b>：说一句「昨天打车 38」或拍张小票，自动填好金额与分类。<br>' +
      '· <b>' + ic('mic') + ' 语音记账</b>：按住说一句话即可。<br>' +
      '· <b>📋 套用模板</b>：常买的一笔存成模板，下次一键填好。<br>' +
      '· <b>' + ic('wand') + ' 记账规则</b>：备注含「星巴克」自动归到「零食饮料」，导入账单时也生效。</p></div>' +
      '<div class="help-sec"><h4>③ 看懂你的钱</h4>' +
      '<p>「统计」页有本月 / 本年 / 十年三种视角，包含支出结构、环比上月、分类排行、资金流向。' +
      '「' + ic('chart-bar') + ' 报表中心」里还能看财务健康度、年同比、分类趋势、账户对账单，并可一键生成账单海报。</p></div>' +
      '<div class="help-sec"><h4>④ 预算与资产</h4>' +
      '<p>预算中心支持月 / 周 / 年三种周期和自动预算（基础 / 累积 / 纠偏）。' +
      '「资产」页管理账户余额、攒钱目标、借入借出与信用卡额度，还款用转账记录，不会重复计入支出。</p></div>' +
      '<div class="help-sec"><h4>⑤ 数据在哪</h4>' +
      '<p>登录后，成功同步的账目可通过同一账号在其他设备查看；不登录时数据只留在本机。换手机或清缓存前，请先确认「数据与同步」没有待上传操作。报销进度等本机数据不会自动同步。' +
      '主动使用 AI 记账或 AI 问账时，仍会按功能页说明发送相应数据用于识别或回答。' +
      '「我的 → 导出加密文件到本机」可保存账本备份；游客备份包含图片和周期规则，登录状态的加密快照不含这些项目，本机偏好设置不包含在内。</p>' +
      '<button class="btn line sm" id="hpWhere" style="margin-top:8px">数据是怎么保管的？看一遍 →</button></div>' +
      '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:8px"><b>常见问题</b></div>' +
      '<div class="help-sec"><h4>换了手机 / 链接怎么迁？</h4><p class="muted">先在旧设备核对云端与待上传操作，再用同一账号登录新设备并核对账目。本机报销进度等数据不会自动同步，备份范围请以导出页面说明为准。</p></div>' +
      '<div class="help-sec"><h4>怎么导入微信 / 支付宝账单？</h4><p class="muted">我的 → 导入 CSV。系统会自动识别格式、预览并做重复检测，还能把未识别的分类映射到已有分类。</p></div>' +
      '<div class="help-sec"><h4>误删了怎么办？</h4><p class="muted">删除的账目会先进「回收站」，可恢复或彻底删除。</p></div>' +
      '<div class="help-sec"><h4>金额不想被看到？</h4><p class="muted">点右上角 ' + ic('eye') + ' 打开隐私模式，所有金额（含图表）会变成 ****。</p></div>' +
      '</div>'
    )
    const c = $('#hpClose')
    if (c) c.addEventListener('click', closeSheet)
    const hw = $('#hpWhere')
    if (hw) hw.addEventListener('click', () => { closeSheet(); replayOnboard() })
  }

  function openInstallGuide() {
    const standalone = window.App.isStandalone && window.App.isStandalone()
    const ua = navigator.userAgent || ''
    const isIOS = /iPhone|iPad|iPod/i.test(ua)
    const isWechat = /MicroMessenger/i.test(ua)
    const steps = standalone
      ? '<p>当前已经在独立窗口中运行，无需再安装 ' + ic('check') + '</p>'
      : isWechat
        ? '<p>微信内暂不支持直接安装：点右上角「···」选择<b>在浏览器中打开</b>，再按下面的步骤添加。</p>'
        : isIOS
          ? '<p>在 Safari 中打开本页 → 点底部<b>分享</b>按钮 → 选择<b>添加到主屏幕</b>。</p>'
          : '<p>在 Chrome / Edge 中打开本页 → 点右上角<b>菜单</b> → 选择<b>安装应用 / 添加到主屏幕</b>。</p>'
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">添加到主屏幕</span><button id="igClose" class="btn sm line">关闭</button></div>' +
      '<div class="card"><div class="help-sec"><h4>' + ic('smartphone') + ' 像 App 一样使用</h4>' + steps +
      '<p class="muted">装到桌面后可以全屏打开、有独立图标，断网也能查看已加载的页面与本地账目。</p></div></div>' +
      '<button class="btn block" id="igGo">立即安装</button>' +
      '<div class="small muted center" style="margin-top:8px" id="igTip">若按钮无反应，说明当前浏览器需要按上面的步骤手动添加</div>'
    )
    const c = $('#igClose')
    if (c) c.addEventListener('click', closeSheet)
    const go = $('#igGo')
    if (go) go.addEventListener('click', async () => {
      const ok = await window.App.promptInstall()
      if (!ok) {
        const t = $('#igTip')
        if (t) t.textContent = standalone ? '已在独立窗口中运行' : '当前环境不支持一键安装，请按上面的步骤手动添加'
      }
    })
  }

  function openAbout() {
    const isGuest = window.DB.mode === 'guest'
    const env = window.Env || {}
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">关于拾光记账</span><button id="abClose" class="btn sm line">关闭</button></div>' +
      appInfoMissingHtml() +
      '<div class="card" style="text-align:center">' +
      '<div style="font-size:44px">' + ic('sun') + '</div>' +
      '<div style="font-size:18px;font-weight:800;margin-top:4px">拾光记账</div>' +
      '<div class="small muted">版本 ' + (window.App.version || '—') + '</div>' +
      '<div class="small muted" style="margin-top:6px">云端同步 · 图片凭证 · 定期备份</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="kv"><span>当前数据位置</span><b>' + (isGuest ? '本机浏览器' : '我的云端空间') + '</b></div>' +
      '<div class="kv"><span>运行环境</span><b>' + (env.containerName ? env.containerName() : '浏览器') + '</b></div>' +
      '<div class="kv"><span>账号隔离</span><b>按账号独立存储</b></div>' +
      '<div class="kv"><span>图片处理</span><b>压缩后上传，仅本人可读</b></div>' +
      '<div class="kv"><span>AI 能力</span><b>由云端模型服务提供</b></div>' +
      '</div>' +
      '<div class="card"><div class="help-sec"><h4>数据与隐私</h4>' +
      '<p class="muted">账目与凭证只属于你本人，服务端按账号隔离；图片通过临时签名链接读取，链接约 1 小时后失效。' +
      '应用锁、隐私模式、界面偏好等都只保存在本机，不会上传。' +
      '云同步依赖平台后端，若其停止服务，云端数据将无法取回，建议定期「导出加密文件到本机」留存。</p></div>' +
      '<div id="abAddr"></div>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:10px">' +
      '<button class="btn line grow" id="abPrivacy">用户隐私保护指引</button>' +
      '<button class="btn line grow" id="abTerms">用户协议</button>' +
      '</div></div>' +
      '<p class="hint">© ' + new Date().getFullYear() + ' 拾光记账 · 记录每一段值得纪念的时光</p>'
    )
    const c = $('#abClose')
    if (c) c.addEventListener('click', closeSheet)
    const p = $('#abPrivacy')
    if (p) p.addEventListener('click', openPrivacy)
    const t = $('#abTerms')
    if (t) t.addEventListener('click', openTerms)
    /* 当前访问地址由懒加载模块渲染（避免占首屏体积） */
    Lazy.need('vault').then(m => { if (m && m.addrHtml) m.addrHtml('#abAddr') })
  }


  /* 运营主体信息：应用商店与小程序审核会逐字核对，取自 window.APP_INFO */
  const APP_INFO = window.APP_INFO || {}
  const OPERATOR = String(APP_INFO.operator || '').trim()
  const CONTACT = String(APP_INFO.contact || '').trim()

  const OPERATOR_TEXT = OPERATOR || '（运营主体名称尚未配置）'
  const CONTACT_TEXT = CONTACT || '（联系邮箱尚未配置）'

  function appInfoMissingHtml() {
    const miss = []
    if (!OPERATOR) miss.push('运营主体名称（window.APP_INFO.operator）')
    if (!CONTACT) miss.push('联系邮箱（window.APP_INFO.contact）')
    if (!miss.length) return ''
    return '<div class="alert-card" role="alert" style="margin-bottom:12px">' +
      '<b>' + ic('alert') + ' 上线前必须补齐</b><br>以下信息还是空的：' + esc(miss.join('、')) +
      '<br>请在 <code>js/config.js</code> 的 <code>window.APP_INFO</code> 里填写真实信息后再提交审核，' +
      '否则会被判定为「信息不实」。' +
      '</div>'
  }

  const UPDATED = '2026 年 10 月 28 日'

  function privacyHtml() {
    const isGuest = window.DB.mode === 'guest'
    return '<div class="card legal">' +
      appInfoMissingHtml() +
      '<p class="meta">生效日期：' + UPDATED + '　|　更新日期：' + UPDATED + '</p>' +
      '<p>「拾光记账」（以下简称「本应用」）由 ' + esc(OPERATOR_TEXT) + ' 开发并运营。我们深知个人信息对你的重要性，' +
      '并会尽全力保护你的个人信息安全。本指引说明我们如何收集、使用、存储和保护你的个人信息，以及你享有的权利。</p>' +

      '<h4>一、我们收集哪些信息</h4>' +
      '<p>本应用坚持「最小必要」原则。你<b>不登录也能使用</b>，游客账目默认保存在自己的设备上；主动使用 AI 等联网服务时，相关数据仍会按下方说明发送至服务商。</p>' +
      '<table><tr><th>信息类型</th><th>收集场景</th><th>用途</th></tr>' +
      '<tr><td>手机号</td><td>你主动选择「手机验证码」登录时</td><td>创建账号、登录、找回数据</td></tr>' +
      '<tr><td>邮箱地址</td><td>你主动选择「邮箱」登录时</td><td>创建账号、登录、找回密码</td></tr>' +
      '<tr><td>微信账号标识（OpenID / UnionID）</td><td>你主动选择「微信登录」时</td><td>创建账号、登录、跨设备同步</td></tr>' +
      '<tr><td>记账数据（金额、收支方向、分类、账户、备注、标签、时间）</td><td>你录入或导入账单时</td><td>实现记账、统计、预算等核心功能</td></tr>' +
      '<tr><td>图片凭证</td><td>你主动拍照或上传小票时</td><td>作为账目附件保存与查看</td></tr>' +
      '<tr><td>本地偏好设置（主题、字号、隐私模式、应用锁 PIN、记账规则）</td><td>你调整设置时</td><td>仅保存在本机，用于还原你的使用偏好，<b>不上传</b></td></tr>' +
      '</table>' +
      '<p class="meta">我们不收集你的通讯录、位置、相册全量内容、通话记录与短信。相机与相册权限只在你主动上传凭证时按次申请。</p>' +

      '<h4>二、我们如何使用信息</h4>' +
      '<ul>' +
      '<li>提供记账、统计、预算、报表、账单导入导出等核心功能；</li>' +
      '<li>在你使用「AI 记账」「小票识别」时，将当次提交的文字或图片、当前日期和时间、可选分类、账户名与币种，以及最多 12 条历史归类偏好发送至大模型服务以返回识别结果；</li>' +
      '<li>在你主动使用「AI 问账」时，将近 12 个月收支汇总、本月和上月支出分类排行（各最多 8 类）、当月预算、最近 8 笔账目的日期、分类、金额、币种与备注前 20 字，以及账户名、币种和余额发送至大模型服务以生成回答；继续追问时，还会发送当前窗口最近 3 轮问答。不会因此上传完整账目或凭证图片；</li>' +
      '<li>保障账号与数据安全，排查故障。</li>' +
      '</ul>' +
      '<p>我们<b>不会</b>将你的记账数据用于广告投放，<b>不会</b>向任何第三方出售你的个人信息。</p>' +

      '<h4>三、信息的存储</h4>' +
      '<ul>' +
      '<li><b>存储位置</b>：' + (isGuest ? '你当前处于游客模式，账目默认存于本机浏览器（IndexedDB）；主动使用 AI 服务时，仍会按本指引发送相应输入或汇总数据。' : '你的账目与凭证存储在你本人账号的云端空间，服务端按账号严格隔离。云端数据托管于平台后端服务（域名：ledger10.app.workbuddy.host），由第三方平台提供与运维。') + '</li>' +
      '<li><b>存储期限</b>：在你主动删除或注销账号前持续保存；删除后的数据进入回收站，清空回收站即彻底删除。</li>' +
      '<li><b>传输安全</b>：全部接口使用 HTTPS 加密传输；图片通过有效期约 1 小时的临时签名链接读取，链接过期即失效。</li>' +
      '<li><b>加密备份</b>：使用「加密备份到云端」或「导出加密文件到本机」时，数据以 PBKDF2-SHA256 派生密钥、AES-GCM-256 加密后存储，<b>口令不落盘、不上传，我们无法解密</b>。</li>' +
      '</ul>' +

      '<h4>四、信息的对外提供</h4>' +
      '<p>除以下必要情形外，我们不会对外提供你的个人信息：</p>' +
      '<ul>' +
      '<li><b>云服务与存储服务商</b>：为提供账号与数据存储能力而必需的基础设施服务；</li>' +
      '<li><b>大模型服务商</b>：仅在你主动使用 AI 记账 / 票据识别或 AI 问账时，传输上方「我们如何使用信息」所列输入、上下文或账目汇总；游客模式同样适用。单纯打开常规报表不会触发 AI 数据传输；</li>' +
      '<li><b>法律法规要求</b>：依据法律、法规或有权机关强制要求。</li>' +
      '</ul>' +

      '<h4>五、数据可靠性提示</h4>' +
      '<p>跨设备同步依赖平台后端服务持续运行。<b>若该服务停止，云端数据将无法取回。</b>' +
      '建议定期「导出加密文件到本机」，把数据文件留在自己手中作为最终保险。</p>' +

      '<h4>六、你的权利</h4>' +
      '<ul>' +
      '<li><b>查询与更正</b>：在「明细」「资产」「我的」中随时查看和修改全部数据；</li>' +
      '<li><b>导出</b>：CSV 只导出流水表格，不包含图片；游客 JSON 和游客加密备份包含账本及图片等数据，不含本机偏好设置。登录状态的 JSON 不含图片、模板和回收站账目，加密快照也不含周期规则；请另行保存重要资料。</li>' +
      '<li><b>删除</b>：单笔删除进回收站可恢复，清空回收站即彻底删除；</li>' +
      '<li><b>注销账号</b>：可通过下方联系方式提出注销申请，我们将在核实身份后处理并删除你的数据。</li>' +
      '</ul>' +

      '<h4>七、未成年人保护</h4>' +
      '<p>本应用面向成年人。若你是未满 14 周岁的儿童，请在监护人陪同下阅读本指引，并在取得监护人同意后使用。' +
      '我们不会主动收集儿童个人信息；如发现误收集，将尽快删除。</p>' +

      '<h4>八、本指引的更新</h4>' +
      '<p>本指引可能随功能或法规变化而更新，更新后我们会在应用内以弹窗或显著方式提示。若你继续使用，即表示同意更新后的指引。</p>' +

      '<h4>九、联系我们</h4>' +
      '<p>如你对本指引有任何疑问、意见或投诉，或需要行使上述权利，请联系：' + esc(CONTACT_TEXT) + '</p>' +
      '</div>'
  }

  function openPrivacy() {
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">用户隐私保护指引</span><button id="pvClose" class="btn sm line">关闭</button></div>' +
      privacyHtml()
    )
    const c = $('#pvClose')
    if (c) c.addEventListener('click', closeSheet)
  }

  function termsHtml() {
    return '<div class="card legal">' +
      '<p class="meta">生效日期：' + UPDATED + '</p>' +
      appInfoMissingHtml() +
      '<p>欢迎使用「拾光记账」。本协议是你与 ' + esc(OPERATOR_TEXT) + ' 之间就使用本应用所达成的约定。' +
      '请在使用前仔细阅读，你开始使用即表示已阅读并同意本协议。</p>' +

      '<h4>一、服务内容</h4>' +
      '<p>本应用为你提供个人记账、统计、预算、报表、账单导入导出等功能。你可以不注册直接以游客身份使用，' +
      '也可以注册账号以获得云端同步与跨设备使用能力。</p>' +

      '<h4>二、账号与安全</h4>' +
      '<ul>' +
      '<li>你应对账号下的全部行为负责，请妥善保管账号与验证码；</li>' +
      '<li>游客模式下数据仅存于本机，清除浏览器数据或更换设备将导致数据丢失，建议及时注册账号或导出备份；</li>' +
      '<li>应用锁 PIN 仅用于防止他人随手翻看，并非账号密码，遗忘后无法找回。</li>' +
      '</ul>' +

      '<h4>三、云端同步与数据托管</h4>' +
      '<ul>' +
      '<li>登录后账目托管于平台后端（ledger10.app.workbuddy.host），以实现跨设备同步；该服务由第三方平台提供与运维。</li>' +
      '<li><b>风险提示：</b>同步依赖该服务持续运行，<b>若其停止或不可用，云端数据将无法取回，本应用无法单方面恢复。</b></li>' +
      '<li>故强烈建议定期备份：「我的 → 导出加密文件到本机」（口令加密，文件由你保管），或「JSON 备份」「导出 CSV」。备份文件不经过我们的服务器。</li>' +
      '</ul>' +

      '<h4>四、你的责任</h4>' +
      '<ul>' +
      '<li>保证录入内容合法合规，不得利用本应用从事任何违法活动；</li>' +
      '<li>不得对本应用进行反向工程、恶意攻击或干扰其正常运行；</li>' +
      '<li>本应用提供的统计、预算、财务健康度等内容<b>仅供参考</b>，不构成任何投资、税务或财务建议。</li>' +
      '</ul>' +

      '<h4>五、知识产权</h4>' +
      '<p>本应用的界面设计、程序代码及相关素材的权利归开发者所有。你录入的账目数据归你本人所有。</p>' +

      '<h4>六、服务变更与终止</h4>' +
      '<p>我们可能因升级、维护或不可抗力而调整、暂停部分服务，并尽可能提前告知。' +
      '若你违反本协议，我们有权暂停或终止向你提供服务。</p>' +

      '<h4>七、免责声明</h4>' +
      '<p>因不可抗力、网络故障、设备故障、第三方服务中断等非我方原因导致的服务中断或数据延迟，' +
      '我们将尽力协助恢复，但不承担由此产生的间接损失。请务必定期使用「导出加密文件到本机」' +
      '或「JSON 备份」自行留存重要数据。</p>' +

      '<h4>八、适用法律与争议解决</h4>' +
      '<p>本协议适用中华人民共和国大陆地区法律。如发生争议，双方应友好协商解决；协商不成的，可向有管辖权的人民法院提起诉讼。</p>' +

      '<h4>九、联系方式</h4>' +
      '<p>' + esc(CONTACT_TEXT) + '</p>' +
      '</div>'
  }

  function openTerms() {
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">用户协议</span><button id="tmClose" class="btn sm line">关闭</button></div>' +
      termsHtml()
    )
    const c = $('#tmClose')
    if (c) c.addEventListener('click', closeSheet)
  }


  window.Legal = {
    privacyHtml, termsHtml, openPrivacy, openTerms,
    openHelp, openInstallGuide, openAbout,
  }
})()


