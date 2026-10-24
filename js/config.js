/* 云服务公开配置：由 workbuddy_cloud_service 的 publicConfig 注入，可安全放在前端 */
window.PUBLIC_CONFIG = {
  endpoint: 'https://ledger10.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_Icuf91j2nz8W6Ssco518Wg_EVq2ZlDqP3V9hj22RaLG9kawalddG7zt',
}

/* 预设分类：两级，参考 ezBookkeeping 的账户/分类模型
   ⚠️ 配色是「感知距离」挑过的（v4 评审 缺陷 4）：原来「餐饮 #ff7a45 / 购物 #ff9f43」
   两个橙、「医疗 #f759ab / 人情 #ff7875」两个粉、「居住 #597ef7 / 学习 #40a9ff」两个蓝
   挨在一起，饼图里根本分不出来。现在同组最小色距 93（原来是 74）。
   改这里只影响新装与示例数据；老用户库里已存的近似色由 Charts.donut 在渲染时去重。 */
window.PRESET_CATEGORIES = {
  expense: [
    { name: '餐饮', icon: '🍜', color: '#ff7a45', children: ['早餐', '午餐', '晚餐', '外卖', '零食饮料'] },
    { name: '购物', icon: '🛒', color: '#faad14', children: ['日用', '服饰', '数码', '美妆'] },
    { name: '交通', icon: '🚇', color: '#36cfc9', children: ['公交地铁', '打车', '火车机票', '加油'] },
    { name: '居住', icon: '🏠', color: '#597ef7', children: ['房租', '水电燃气', '物业', '维修'] },
    { name: '娱乐', icon: '🎮', color: '#9254de', children: ['游戏', '电影演出', '运动健身', '旅行'] },
    { name: '医疗', icon: '💊', color: '#f759ab', children: ['药品', '门诊', '体检'] },
    { name: '学习', icon: '📚', color: '#40a9ff', children: ['学费', '书籍', '考试', '网课'] },
    { name: '人情', icon: '🎁', color: '#eb2f96', children: ['红包', '送礼', '请客'] },
    { name: '通讯', icon: '📱', color: '#73d13d', children: ['话费', '宽带', '会员订阅'] },
    { name: '其他', icon: '📦', color: '#8a93a6', children: [] },
  ],
  income: [
    { name: '工资', icon: '💼', color: '#52c41a', children: ['全职', '实习'] },
    { name: '奖学金', icon: '🏆', color: '#fa8c16', children: [] },
    { name: '兼职', icon: '💵', color: '#13c2c2', children: ['外快', '家教'] },
    { name: '理财', icon: '📈', color: '#2f54eb', children: ['利息', '基金', '股票'] },
    { name: '红包', icon: '🧧', color: '#eb2f96', children: ['压岁钱', '转账'] },
    { name: '报销', icon: '🧾', color: '#722ed1', children: [] },
    { name: '其他', icon: '✨', color: '#8a93a6', children: [] },
  ],
}

/* 预设账户 */
window.PRESET_ACCOUNTS = [
  { name: '现金', kind: 'cash', icon: '💵', color: '#52c41a' },
  { name: '微信', kind: 'wechat', icon: '💬', color: '#07c160' },
  { name: '支付宝', kind: 'alipay', icon: '🅰️', color: '#1677ff' },
  { name: '银行卡', kind: 'bank', icon: '🏦', color: '#722ed1' },
  { name: '校园卡', kind: 'campus', icon: '🎓', color: '#fa8c16' },
]

window.ACCOUNT_KIND_LABEL = {
  cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行卡',
  credit: '信用卡', campus: '校园卡', other: '其他',
  loan_in: '借入 · 我欠别人', loan_out: '借出 · 别人欠我',
}

window.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }

/* ==========================================================================
   运营主体信息（会出现在「隐私指引」「用户协议」「关于」三处）
   --------------------------------------------------------------------------
   operator / contact 是应用商店与微信小程序审核会逐字核对的内容。
   下面填的是**可直接使用的默认值**；若你有正式主体名称与对外邮箱，
   改这两行即可，别处不用动。留空时界面会显示醒目的「未配置」提示条。
   ========================================================================== */
window.APP_INFO = {
  appName: '拾光记账',
  operator: '拾光记账开发团队',
  contact: 'contact@shiguangji.com',
  version: '',     /* 留空则用 js/app.js 里的 VERSION */
}
