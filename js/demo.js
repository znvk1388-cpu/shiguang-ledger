/* 示例数据（懒加载模块）
 * ------------------------------------------------------------------
 * 「载入示例数据」只在空账本时点一次，却要带上整张分类×备注配对表，
 * 放首屏会白占 gzip 预算（硬线 158720B），因此搬到懒加载模块；
 * Service Worker 已预缓存，断网也能用。
 * ------------------------------------------------------------------ */
;(function () {
  'use strict'
  const F = window.Fmt
  const U = window.UI
  const $ = U.$
  const S = window.DB
  const openSheet = U.openSheet
  const closeSheet = U.closeSheet
  const toast = U.toast

  /* v3 评审 P2-1 的三条硬规矩：
     ① 账户先有期初余额再逐笔扣减 —— 载入后任何账户余额都不为负；
     ② 分类与备注一一配对，不再出现「购物·服饰｜早餐豆浆油条」；
     ③ 时间落在该场景该发生的钟点（早餐 7–9 点、晚餐 18–20 点），不再每笔 +67 分钟机械递增。
     另外放三笔「正确姿势」：一笔待报销、一笔信用卡消费 + 还款、一条周期房租规则。
     随机数用固定种子：同样的输入永远生成同一套账，截图回归才稳定。 */
  const DEMO_PLAN = [
    /* n 备注 / c 分类「父|子」 / h 钟点区间 / a 金额区间 / k 账户类型 / t 笔数 / s 分布天数 */
    { n: '豆浆油条 / 包子', c: '餐饮|早餐', h: [7, 9], a: [5, 14], k: 'wechat', t: 8, s: 45 },
    { n: '公司楼下快餐', c: '餐饮|午餐', h: [11, 13], a: [18, 35], k: 'alipay', t: 12, s: 45 },
    { n: '食堂刷校园卡', c: '餐饮|午餐', h: [11, 13], a: [8, 18], k: 'campus', t: 5, s: 40 },
    { n: '回家路上买菜做饭', c: '餐饮|晚餐', h: [18, 20], a: [25, 60], k: 'wechat', t: 8, s: 45 },
    { n: '下午一杯咖啡', c: '餐饮|零食饮料', h: [14, 16], a: [12, 28], k: 'wechat', t: 5, s: 40 },
    { n: '便利店买水', c: '餐饮|零食饮料', h: [12, 21], a: [2, 9], k: 'cash', t: 4, s: 35 },
    { n: '地铁通勤', c: '交通|公交地铁', h: [8, 9], a: [3, 8], k: 'alipay', t: 7, s: 45 },
    { n: '下班打车回家', c: '交通|打车', h: [18, 22], a: [18, 46], k: 'alipay', t: 3, s: 40 },
    { n: '超市补货：纸巾洗衣液', c: '购物|日用', h: [15, 21], a: [40, 150], k: 'alipay', t: 4, s: 45 },
    { n: '换季买了两件衣服', c: '购物|服饰', h: [14, 20], a: [120, 400], k: 'alipay', t: 2, s: 40 },
    { n: '和同事吃火锅', c: '餐饮|晚餐', h: [18, 21], a: [80, 160], k: 'wechat', t: 3, s: 42 },
    { n: '周末看电影', c: '娱乐|电影演出', h: [14, 21], a: [40, 90], k: 'alipay', t: 2, s: 40 },
    { n: '健身房月卡', c: '娱乐|运动健身', h: [10, 20], a: [99, 199], k: 'alipay', t: 1, s: 40 },
    { n: '买了本专业书', c: '学习|书籍', h: [10, 22], a: [35, 90], k: 'wechat', t: 1, s: 40 },
    { n: '药店买了感冒药', c: '医疗|药品', h: [10, 20], a: [20, 70], k: 'wechat', t: 1, s: 40 },
    { n: '手机话费充值', c: '通讯|话费', h: [9, 20], a: [30, 100], k: 'alipay', t: 1, s: 40 },
    { n: '本月水电燃气', c: '居住|水电燃气', h: [9, 20], a: [60, 180], k: 'alipay', t: 1, s: 40 },
  ]
  /* 各账户载入后的目标余额（元）。期初余额 = 目标余额 − 该账户净变动，
     所以无论支出怎么分配，余额都不会是负数。 */
  const DEMO_BALANCE = { cash: 260, wechat: 1580, alipay: 2350, bank: 18600, campus: 96, credit: 0 }

  async function openDemoData() {
    if (!confirm('载入一套示例账目（约 70 笔，覆盖最近一个半月）？\n\n' +
      '会为每个账户设置一个期初余额（让余额看起来像真实在用），并加入 1 笔待报销、' +
      '1 笔信用卡消费与还款、1 条周期房租规则。\n\n随时可在「回收站 / 明细」里逐条删除。')) return
    openSheet('<div class="sheet-head"><span class="sheet-title">载入示例数据</span><button id="dmClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" id="dmTip">正在准备账户与分类…</div>')
    $('#dmClose').addEventListener('click', closeSheet)
    const tip = m => { const el = $('#dmTip'); if (el) el.textContent = m }
    try {
      if (!S.state.categories.length || !S.state.accounts.length) await S.seedPresets()
      /* 固定种子 LCG：每次载入生成同一套账，视觉回归基线才不会天天变 */
      let seed = 20261018
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
      const pickInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
      const now = new Date()
      const catByPath = path => {
        const parts = path.split('|')
        const root = S.rootCategories('expense').filter(c => c.name === parts[0])[0]
        if (!root) return null
        if (!parts[1]) return root
        const kid = S.childCategories(root.id).filter(c => c.name === parts[1])[0]
        return kid || root
      }
      const byKind = {}
      S.accounts().forEach(a => { if (!byKind[a.kind]) byKind[a.kind] = a })
      /* 示例要演示信用卡还款，没有信用卡账户就补一个 */
      if (!byKind.credit) {
        byKind.credit = await S.addAccount({
          name: '信用卡', kind: 'credit', icon: '💳', color: '#eb2f96',
          initial_balance: 0, sort_order: 9,
        })
      }
      const fallback = S.accounts()[0]
      const accOf = k => byKind[k] || fallback

      /* ① 先在内存里把整套账算出来，才能据此倒推期初余额 */
      const txns = []
      DEMO_PLAN.forEach(p => {
        const cat = catByPath(p.c)
        if (!cat) return
        for (let i = 0; i < p.t; i++) {
          const off = Math.min(p.s - 1, Math.floor((i + 0.5) * p.s / p.t) + pickInt(0, 1))
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - off)
          d.setHours(pickInt(p.h[0], p.h[1]), pickInt(0, 59), 0, 0)
          const amt = Math.round((p.a[0] + rnd() * (p.a[1] - p.a[0])) * 100) / 100
          txns.push({
            txn_type: 'expense', amount: amt, occurred_at: F.iso(d),
            account_id: accOf(p.k).id, to_account_id: null, category_id: cat.id,
            note: p.n, tags: [], reimbursable: false,
          })
        }
      })

      /* ② 三笔「正确姿势」：待报销 / 信用卡消费 / 信用卡还款 */
      const reimCat = catByPath('交通|打车')
      const reimDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 10, 20)
      txns.push({
        txn_type: 'expense', amount: 128, occurred_at: F.iso(reimDay),
        account_id: accOf('alipay').id, to_account_id: null, category_id: reimCat ? reimCat.id : null,
        note: '出差打车（可报销）', tags: [], reimbursable: true,
      })
      const digiCat = catByPath('购物|数码')
      const ccDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20, 20, 15)
      txns.push({
        txn_type: 'expense', amount: 1299, occurred_at: F.iso(ccDay),
        account_id: accOf('credit').id, to_account_id: null, category_id: digiCat ? digiCat.id : null,
        note: '无线耳机（信用卡）', tags: [], reimbursable: false,
      })
      const payDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 21, 5)
      txns.push({
        txn_type: 'transfer', amount: 1299, occurred_at: F.iso(payDay),
        account_id: accOf('bank').id, to_account_id: accOf('credit').id, category_id: null,
        note: '信用卡还款', tags: [], reimbursable: false,
      })

      /* ③ 本月房租（手工记的这条 + 一条周期规则，演示「每月自动」） */
      const rentCat = catByPath('居住|房租')
      const rentDay = new Date(now.getFullYear(), now.getMonth(), 1, 9, 0)
      txns.push({
        txn_type: 'expense', amount: 2800, occurred_at: F.iso(rentDay),
        account_id: accOf('bank').id, to_account_id: null, category_id: rentCat ? rentCat.id : null,
        note: '本月房租', tags: [], reimbursable: false,
      })

      /* ④ 工资：本月 5 号还没到就记上月 5 号，别造出未来日期的账 */
      let wageDay = new Date(now.getFullYear(), now.getMonth(), 5, 9, 30)
      if (wageDay.getTime() > now.getTime()) wageDay = new Date(now.getFullYear(), now.getMonth() - 1, 5, 9, 30)
      const wageRoot = S.rootCategories('income').filter(c => c.name === '工资')[0]
      const wageKids = wageRoot ? S.childCategories(wageRoot.id) : []
      txns.push({
        txn_type: 'income', amount: 12000, occurred_at: F.iso(wageDay),
        account_id: accOf('bank').id, to_account_id: null,
        category_id: (wageKids[0] || wageRoot || {}).id || null,
        note: '本月工资', tags: [], reimbursable: false,
      })

      /* ⑤ 按账户净变动倒推期初余额 → 落库后每个账户正好等于目标余额（均 ≥ 0） */
      const delta = {}
      txns.forEach(t => {
        if (t.txn_type === 'expense') delta[t.account_id] = (delta[t.account_id] || 0) - t.amount
        else if (t.txn_type === 'income') delta[t.account_id] = (delta[t.account_id] || 0) + t.amount
        else if (t.txn_type === 'transfer') {
          delta[t.account_id] = (delta[t.account_id] || 0) - t.amount
          if (t.to_account_id) delta[t.to_account_id] = (delta[t.to_account_id] || 0) + t.amount
        }
      })
      tip('正在设置账户期初余额…')
      /* 以账户**当前真实余额**为基准倒推，而不是假设从 0 开始：
         账本里可能已经有用户自己记的账，那部分净变动同样会改变余额。 */
      const nowBal = {}
      try {
        const list = await S.accountBalances()
        ;(list || []).forEach(x => { nowBal[x.account.id] = x.balance / 100 })
      } catch (e) { /* 拿不到就按 0 处理 */ }
      for (const a of S.accounts()) {
        const target = DEMO_BALANCE[a.kind] != null ? DEMO_BALANCE[a.kind] : 500
        const init = Number(a.initial_balance || 0) + target - (nowBal[a.id] || 0) - (delta[a.id] || 0)
        await S.updateAccount(a.id, { initial_balance: Math.round(init * 100) / 100 })
      }

      tip('正在写入 ' + txns.length + ' 笔账目…')
      let n = 0
      for (const t of txns) { await S.addTransaction(t); n++ }

      /* ⑥ 周期房租：本月这条已记（last_run_date = 本月 1 日），下一期从下月 1 日开始 */
      if (rentCat) {
        await S.addRecurring({
          txn_type: 'expense', amount: 2800,
          account_id: accOf('bank').id, to_account_id: null, category_id: rentCat.id,
          note: '房租', tags: [], reimbursable: false,
          freq: 'monthly', start_date: F.dstr(rentDay), last_run_date: F.dstr(rentDay), active: true,
        })
      }

      await S.setBudget(F.monthKey(now), null, 5000)
      await S.addGoal({ name: '旅行基金', icon: '✈️', target_amount: 8000, saved_amount: 2400, deadline: null, done: false })
      closeSheet()
      toast('已载入 ' + n + ' 笔示例账目')
      window.App.refresh()
    } catch (e) {
      tip('载入失败：' + (e.message || '请重试'))
    }
  }

  window.Demo = { openDemoData: openDemoData }
})()
