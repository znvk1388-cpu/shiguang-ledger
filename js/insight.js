/* 洞察模块
   1) 报表中心：年同比、财务健康指标、分类趋势、账户对账单
   2) 相册视图：所有凭证图片墙
   3) 标签管理：重命名 / 合并 / 删除标签 + 标签报表
   4) 账单海报：生成可保存分享的 PNG
   5) 按当前筛选导出 CSV
   全部为只读聚合或基于现有字段的更新，不新增表结构。 */
window.Insight = (function () {
  const F = window.Fmt
  const S = window.DB
  const U = () => window.UI
  /* 图表模块按需加载（见 js/lazy.js）：它不在首屏渲染路径上，
     首屏 gzip 预算很紧，所以移出关键路径。已加入 SW 预缓存，点开无等待。 */
  const charts = () => window.Lazy.need('charts')

  /* ---------------- 通用 ---------------- */
  function sumRows(rows) {
    let income = 0, expense = 0
    ;(rows || []).forEach(m => { income += F.toCents(m.income); expense += F.toCents(m.expense) })
    return { income, expense, balance: income - expense }
  }
  function baseAmountReader() {
    const currencies = {}
    S.allAccounts().forEach(a => { currencies[a.id] = a.currency || 'CNY' })
    return row => F.toBase(F.toCents(row.amount), currencies[row.account_id] || 'CNY')
  }
  function yearRange(y) { return { from: F.iso(new Date(y, 0, 1)), to: F.iso(new Date(y + 1, 0, 1)) } }

  /* ---------------- 一、报表中心 ---------------- */
  async function openReportCenter() {
    const st = window.App.state
    const y = st.year || new Date().getFullYear()
    const m = st.month || (new Date().getMonth() + 1)
    const from = F.iso(F.monthStart(y, m))
    const to = F.iso(F.monthEnd(y, m))

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">报表中心</span><button id="rpClose" class="btn sm line">关闭</button></div>' +
      '<div class="list-item" id="rpAsk"><div class="ico">' + ic('send') + '</div><div class="grow"><div>AI 问账</div>' +
      '<div class="small muted">用一句话查账，基于本机数据回答</div></div><span class="muted">›</span></div>' +
      '<div class="card" style="padding:0">' +
      '<div class="list-item" id="rpH"><div class="ico">' + ic('heart') + '</div><div class="grow"><div>财务健康度</div>' +
      '<div class="small muted">储蓄率 · 收支比 · 日均支出</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpAudit"><div class="ico">' + ic('search') + '</div><div class="grow"><div>消费洞察</div>' +
      '<div class="small muted">固定支出 · 高频小额 · 环比异常</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpY"><div class="ico">' + ic('trending-up') + '</div><div class="grow"><div>年同比（YoY）</div>' +
      '<div class="small muted">今年 vs 去年逐月对比</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpT"><div class="ico">' + ic('chart-bar') + '</div><div class="grow"><div>分类趋势</div>' +
      '<div class="small muted">各大类近 12 个月走势</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpA"><div class="ico">' + ic('file-text') + '</div><div class="grow"><div>账户对账单</div>' +
      '<div class="small muted">按账户导出台账（含余额）</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpG"><div class="ico">' + ic('image') + '</div><div class="grow"><div>凭证相册</div>' +
      '<div class="small muted">所有小票图片墙</div></div><span class="muted">›</span></div>' +
      '<div class="list-item" id="rpTag"><div class="ico">' + ic('tag') + '</div><div class="grow"><div>标签管理</div>' +
      '<div class="small muted">重命名 · 合并 · 删除 · 报表</div></div><span class="muted">›</span></div>' +
      '</div>' +
      '<button class="btn block" id="rpPoster">' + ic('palette') + ' 生成本月账单海报</button>' +
      '<button class="btn line block" id="rpYearImg" style="margin-top:8px">' + ic('upload') + ' 导出年度报告图片</button>' +
      '<button class="btn line block" id="rpCsv" style="margin-top:8px">' + ic('upload') + ' 导出当前筛选明细 CSV</button>' +
      '<div class="hint">常规报表在本机计算；AI 问账会按提问页说明发送数据。</div>'
    )
    document.getElementById('rpClose').addEventListener('click', U().closeSheet)
    document.getElementById('rpAsk').addEventListener('click', () => {
      Lazy.need('ask').then(m => { if (m) m.openAskSheet() })
    })
    document.getElementById('rpH').addEventListener('click', () => openHealth())
    document.getElementById('rpAudit').addEventListener('click', () => openAudit())
    document.getElementById('rpY').addEventListener('click', () => openYoY())
    document.getElementById('rpT').addEventListener('click', () => openCatTrend())
    document.getElementById('rpA').addEventListener('click', () => openStatementPicker())
    document.getElementById('rpG').addEventListener('click', () => openGallerySheet())
    document.getElementById('rpTag').addEventListener('click', () => openTagManager())
    document.getElementById('rpPoster').addEventListener('click', () => makePoster(y, m))
    document.getElementById('rpYearImg').addEventListener('click', () => exportYearImage(y))
    document.getElementById('rpCsv').addEventListener('click', () => exportFilteredCsv(st))
  }

  /* ---------- 财务健康度 ---------- */
  async function openHealth() {
    const st = window.App.state
    const y = st.year || new Date().getFullYear()
    const m = st.month || (new Date().getMonth() + 1)
    const from = F.iso(F.monthStart(y, m))
    const to = F.iso(F.monthEnd(y, m))
    const rows = await S.monthlySummary(from, to).catch(() => [])
    const { income, expense, balance } = sumRows(rows)
    const days = new Date(y, m, 0).getDate()
    const isCurrent = new Date().getFullYear() === y && (new Date().getMonth() + 1) === m
    const passed = isCurrent ? new Date().getDate() : days
    /* 边界：无任何记录 / 只有支出没有收入时，储蓄率、收支比不可计算（避免除零与 0% 误导） */
    const hasData = income > 0 || expense > 0
    const hasIncome = income > 0
    const savingRate = hasIncome ? balance / income * 100 : null
    const ratio = hasIncome ? expense / income * 100 : null
    const avg = expense / Math.max(passed, 1)

    /* 同期历史均值，用于对比 */
    const yFrom = F.iso(new Date(y - 1, 0, 1))
    const yTo = F.iso(new Date(y, 0, 1))
    const hist = await S.monthlySummary(yFrom, yTo).catch(() => [])
    const sameMonth = (hist || []).find(h => h.month_key === (y - 1) + '-' + F.pad2(m))
    const lastYearExpense = sameMonth ? F.toCents(sameMonth.expense) : 0
    const yoy = lastYearExpense > 0 ? (expense - lastYearExpense) / lastYearExpense * 100 : null

    /* 缺少收入记录不能证明真实收入为零，不对不完整账目作健康评级。 */
    let grade
    if (!hasData) {
      grade = ['—', '数据不足，记几笔后再来查看']
    } else if (!hasIncome) {
      grade = ['—', '缺少收入记录，暂不评级']
    } else {
      grade = savingRate >= 30 ? ['A', '很稳，继续保持'] :
        savingRate >= 15 ? ['B', '健康，还有提升空间'] :
          savingRate >= 0 ? ['C', '基本持平，注意控制'] : ['D', '这个月在吃老本']
    }
    const heroBg = grade[0] === 'A' || grade[0] === 'B' ? 'linear-gradient(135deg,#12a150,#4fd08a)' :
      grade[0] === 'C' ? 'linear-gradient(135deg,#f5a524,#ffc45c)' :
        grade[0] === 'D' ? 'linear-gradient(135deg,#e5484d,#ff7b7f)' : 'linear-gradient(135deg,#2f6bef,#6a8dff)'

    /* 无收入但有支出：给出明确警示与下一步动作 */
    const warnHtml = (hasData && !hasIncome && expense > 0)
      ? '<div class="alert-card">本月已支出 <b class="num">¥' + F.yuan(expense) + '</b>，但没有收入记录，储蓄健康度无法评估。' +
        '建议先补记本月收入，或到预算中心设一个本月预算来控制支出。</div>'
      : ''
    const emptyHtml = !hasData
      ? '<div class="card"><div class="small muted" style="text-align:center;padding:8px 0">这个月还没有任何记录，记几笔收支后再来看健康度吧。</div></div>'
      : ''

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">财务健康度 · ' + y + '年' + m + '月</span><button id="hClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="text-align:center;background:' + heroBg + ';color:#fff;box-shadow:none">' +
      '<div style="font-size:13px;opacity:.9">已记录收支参考</div>' +
      '<div style="font-size:44px;font-weight:800;line-height:1.1">' + grade[0] + '</div>' +
      '<div style="font-size:13px;opacity:.9">' + grade[1] + '</div></div>' +
      warnHtml + emptyHtml +
      '<div class="card">' +
      metricRow('储蓄率', savingRate == null ? '—' : savingRate.toFixed(1) + '%',
        savingRate == null ? 'var(--sub)' : savingRate >= 20 ? 'var(--income)' : savingRate >= 0 ? 'var(--warn)' : 'var(--expense)',
        savingRate == null ? '收入为 0，无法计算' : '结余 ÷ 收入，20% 以上比较健康') +
      metricRow('收支比', ratio == null ? '—' : ratio.toFixed(1) + '%',
        ratio == null ? 'var(--sub)' : ratio <= 80 ? 'var(--income)' : ratio <= 100 ? 'var(--warn)' : 'var(--expense)',
        ratio == null ? '收入为 0，无法计算' : (ratio > 100 ? '支出已超过收入，超支 ' + (ratio - 100).toFixed(0) + '%' : '支出 ÷ 收入，越低越好')) +
      metricRow('日均支出', F.money(Math.round(avg)), 'var(--text)', isCurrent ? '按本月已过天数平均' : '按该月全部天数平均') +
      metricRow('本月结余', F.money(balance), balance >= 0 ? 'var(--income)' : 'var(--expense)', '收入 − 支出') +
      (yoy != null ? metricRow('去年同期对比', (yoy > 0 ? '↑ ' : '↓ ') + Math.abs(yoy).toFixed(0) + '%',
        yoy > 0 ? 'var(--expense)' : 'var(--income)', '去年 ' + m + ' 月整月支出 ¥' + F.yuan(lastYearExpense) + (isCurrent ? '；本月尚未结束，不代表同日进度对比' : '')) : '') +
      '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:8px"><b>月度收支</b></div>' +
      '<div class="kv"><span>收入</span><b class="num" style="color:var(--income)">¥' + F.yuan(income) + '</b></div>' +
      '<div class="kv"><span>支出</span><b class="num" style="color:var(--expense)">¥' + F.yuan(expense) + '</b></div>' +
      '</div>' +
      (hasData
        ? '<div class="card"><div class="between" style="margin-bottom:6px"><b>评级依据</b><span class="tiny muted">各项如何影响评级</span></div>' +
          '<div class="kv"><span>储蓄率</span><span class="small muted">' +
          (savingRate == null ? '收入为 0 → 不计入评级' : '≥30% 评 A · ≥15% 评 B · ≥0% 评 C · <0% 评 D') + '</span></div>' +
          '<div class="kv"><span>收入记录</span><span class="small muted">' +
          (hasIncome ? '仅根据已记录的收入与支出计算' : '缺少收入记录，无法判断实际收支情况') + '</span></div>' +
          '<div class="kv"><span>日均支出</span><span class="small muted">仅作参考，不参与评级</span></div>' +
          '</div>'
        : '') +
      '<button class="btn block" id="hExport" style="margin-top:12px">' + ic('upload') + ' 导出为图片</button>'
    )
    document.getElementById('hClose').addEventListener('click', U().closeSheet)
    document.getElementById('hExport').addEventListener('click', () => {
      const spec = {
        title: '财务健康度 · ' + y + ' 年 ' + m + ' 月',
        subtitle: '评级 ' + grade[0] + ' · ' + grade[1],
        hero: { label: '本月结余', value: F.money(balance), note: '收入 ¥' + F.yuan(income) + ' · 支出 ¥' + F.yuan(expense), tone: balance >= 0 ? 'income' : 'expense' },
        stats: [
          { k: '储蓄率', v: savingRate == null ? '—' : savingRate.toFixed(1) + '%', note: savingRate == null ? '收入为 0，无法计算' : '结余 ÷ 收入', tone: savingRate == null ? 'sub' : savingRate >= 20 ? 'income' : savingRate >= 0 ? 'warn' : 'expense' },
          { k: '收支比', v: ratio == null ? '—' : ratio.toFixed(1) + '%', note: ratio == null ? '收入为 0，无法计算' : (ratio > 100 ? '已超支 ' + (ratio - 100).toFixed(0) + '%' : '越低越好'), tone: ratio == null ? 'sub' : ratio <= 80 ? 'income' : ratio <= 100 ? 'warn' : 'expense' },
          { k: '日均支出', v: F.money(Math.round(avg)), note: isCurrent ? '按已过 ' + passed + ' 天' : '按该月 ' + days + ' 天', tone: 'text' },
        ],
        sections: [
          {
            title: '月度收支', note: y + ' 年 ' + m + ' 月',
            rows: [
              { k: '收入', v: F.money(income), tone: 'income' },
              { k: '支出', v: F.money(expense), tone: 'expense' },
              { k: '结余', v: F.money(balance), tone: balance >= 0 ? 'income' : 'expense' },
            ],
          },
        ],
      }
      if (yoy != null) {
        spec.sections.push({
          title: '与去年同期对比', note: '去年 ' + m + ' 月 ¥' + F.yuan(lastYearExpense),
          rows: [{ k: '支出变化', v: (yoy > 0 ? '↑ ' : '↓ ') + Math.abs(yoy).toFixed(0) + '%', tone: yoy > 0 ? 'expense' : 'income' }],
        })
      }
      try { showReportImage('健康度图片', buildReportImage(spec), '拾光记账-健康度-' + y + '年' + m + '月.png') } catch (e) { U().toast('生成图片失败') }
    })
  }
  function metricRow(k, v, color, sub) {
    return '<div class="kv"><span>' + k + '<div class="tiny muted">' + sub + '</div></span>' +
      '<b class="num" style="color:' + color + '">' + v + '</b></div>'
  }

  /* ---------- 年同比 ---------- */
  async function openYoY() {
    const y = window.App.state.year || new Date().getFullYear()
    const cur = yearRange(y)
    const prev = yearRange(y - 1)
    const [a, b] = await Promise.all([
      S.monthlySummary(cur.from, cur.to).catch(() => []),
      S.monthlySummary(prev.from, prev.to).catch(() => []),
    ])
    const map = {}
    ;(a || []).forEach(r => { map[r.month_key.slice(5)] = Object.assign({}, map[r.month_key.slice(5)], { cur: F.toCents(r.expense) }) })
    ;(b || []).forEach(r => { map[r.month_key.slice(5)] = Object.assign({}, map[r.month_key.slice(5)], { prev: F.toCents(r.expense) }) })
    const rows = []
    for (let i = 1; i <= 12; i++) {
      const k = F.pad2(i)
      const v = map[k] || {}
      rows.push({ label: i + '月', cur: v.cur || 0, prev: v.prev || 0 })
    }
    const maxV = Math.max(1, ...rows.map(r => Math.max(r.cur, r.prev)))
    const totalCur = rows.reduce((s, r) => s + r.cur, 0)
    const totalPrev = rows.reduce((s, r) => s + r.prev, 0)
    const diff = totalPrev > 0 ? (totalCur - totalPrev) / totalPrev * 100 : null

    const bars = rows.map(r => {
      const hc = Math.round(r.cur / maxV * 90)
      const hp = Math.round(r.prev / maxV * 90)
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">' +
        '<div style="display:flex;align-items:flex-end;gap:2px;height:96px">' +
        '<div style="width:9px;height:' + Math.max(hp, 1) + 'px;background:#c9d4ea;border-radius:3px" title="去年 ¥' + F.yuan(r.prev) + '"></div>' +
        '<div style="width:9px;height:' + Math.max(hc, 1) + 'px;background:linear-gradient(180deg,#2f6bef,#6a8dff);border-radius:3px" title="今年 ¥' + F.yuan(r.cur) + '"></div>' +
        '</div><div class="tiny muted">' + r.label.replace('月', '') + '</div></div>'
    }).join('')

    const list = rows.filter(r => r.cur || r.prev).map(r => {
      const d = r.prev > 0 ? (r.cur - r.prev) / r.prev * 100 : null
      return '<div class="kv"><span>' + r.label + '</span><span class="num">' +
        '<b style="color:var(--expense)">¥' + F.yuan(r.cur) + '</b>' +
        (d != null ? ' <span class="small" style="color:' + (d > 0 ? 'var(--expense)' : 'var(--income)') + '">' + (d > 0 ? '↑' : '↓') + Math.abs(d).toFixed(0) + '%</span>' : '') +
        '</span></div>'
    }).join('')

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">年同比 · ' + y + ' vs ' + (y - 1) + '</span><button id="yClose" class="btn sm line">关闭</button></div>' +
      '<div class="card"><div class="between" style="margin-bottom:10px"><b>逐月支出对比</b>' +
      '<span class="tiny muted"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#c9d4ea"></i> 去年　' +
      '<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#2f6bef"></i> 今年</span></div>' +
      '<div style="display:flex;gap:3px;align-items:flex-end">' + bars + '</div></div>' +
      '<div class="card">' +
      '<div class="kv"><span>' + y + ' 年累计支出</span><b class="num" style="color:var(--expense)">¥' + F.yuan(totalCur) + '</b></div>' +
      '<div class="kv"><span>' + (y - 1) + ' 年累计支出</span><b class="num" style="color:var(--sub)">¥' + F.yuan(totalPrev) + '</b></div>' +
      (diff != null ? '<div class="kv"><span>同比变化</span><b class="num" style="color:' + (diff > 0 ? 'var(--expense)' : 'var(--income)') + '">' + (diff > 0 ? '↑ ' : '↓ ') + Math.abs(diff).toFixed(1) + '%</b></div>' : '') +
      '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:6px"><b>逐月明细</b></div>' + (list || '<div class="small muted">暂无数据</div>') + '</div>' +
      '<button class="btn block" id="yExport" style="margin-top:12px">' + ic('upload') + ' 导出为图片</button>'
    )
    document.getElementById('yClose').addEventListener('click', U().closeSheet)
    document.getElementById('yExport').addEventListener('click', () => {
      const maxAll = Math.max(1, ...rows.map(r => Math.max(r.cur, r.prev)))
      const spec = {
        title: '年同比 · ' + y + ' vs ' + (y - 1),
        subtitle: '逐月支出对比',
        hero: {
          label: y + ' 年累计支出', value: F.money(totalCur),
          note: (y - 1) + ' 年 ¥' + F.yuan(totalPrev),
          tone: 'expense',
        },
        stats: [
          { k: y + ' 年', v: F.money(totalCur), note: '今年累计', tone: 'expense' },
          { k: (y - 1) + ' 年', v: F.money(totalPrev), note: '去年累计', tone: 'sub' },
          {
            k: '同比变化',
            v: diff == null ? '—' : (diff > 0 ? '↑ ' : '↓ ') + Math.abs(diff).toFixed(1) + '%',
            note: diff == null ? '去年无数据' : (diff > 0 ? '比去年多花' : '比去年少花'),
            tone: diff == null ? 'sub' : diff > 0 ? 'expense' : 'income',
          },
        ],
        sections: [
          {
            title: '逐月支出', note: '今年 / 去年',
            bars: rows.map(r => ({
              name: r.label,
              value: Math.max(r.cur, r.prev),
              text: F.money(r.cur) + ' / ¥' + F.yuan(r.prev),
              tone: r.cur === maxAll ? 'expense' : 'brand',
            })),
          },
        ],
      }
      const detailed = rows.filter(r => r.cur || r.prev).map(r => {
        const d = r.prev > 0 ? (r.cur - r.prev) / r.prev * 100 : null
        return {
          k: r.label,
          v: F.money(r.cur),
          note: '去年 ¥' + F.yuan(r.prev) + (d != null ? ' · ' + (d > 0 ? '↑' : '↓') + Math.abs(d).toFixed(0) + '%' : ''),
          tone: d == null ? 'text' : d > 0 ? 'expense' : 'income',
        }
      })
      if (detailed.length) spec.sections.push({ title: '逐月明细', note: '今年 vs 去年', rows: detailed.slice(0, 12) })
      try { showReportImage('年同比图片', buildReportImage(spec), '拾光记账-年同比-' + y + '.png') } catch (e) { U().toast('生成图片失败') }
    })
  }

  /* ---------- 分类趋势 ---------- */
  async function openCatTrend() {
    const sym = F.escapeHtml(F.currencySym(F.baseCurrency()))
    const money = cents => F.moneySym(cents, sym)
    const roots = S.rootCategories('expense')
    if (!roots.length) { U().toast('还没有支出分类'); return }
    let sel = roots[0].id
    const render = async () => {
      const C = await charts()
      const root = roots.find(r => r.id === sel)
      const ids = [root.id].concat(S.childCategories(root.id).map(c => c.id))
      const now = new Date()
      const from = F.iso(new Date(now.getFullYear(), now.getMonth() - 11, 1))
      const to = F.iso(new Date(now.getFullYear(), now.getMonth() + 1, 1))
      const { rows } = await S.listTransactions({ from, to, type: 'expense', limit: 100000 })
      const toBase = baseAmountReader()
      const byMonth = {}
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        byMonth[F.monthKey(d)] = 0
      }
      rows.forEach(t => {
        if (ids.indexOf(t.category_id) < 0) return
        const k = F.monthOf(t.occurred_at)
        if (byMonth[k] != null) byMonth[k] += toBase(t)
      })
      const points = Object.keys(byMonth).sort().map(k => ({ label: Number(k.slice(5)) + '月', value: byMonth[k] }))
      const total = points.reduce((s, p) => s + p.value, 0)
      const peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0] || { value: 0 })
      const html = '<div class="card"><div class="between" style="margin-bottom:6px"><b>近 12 个月走势</b>' +
        '<span class="tiny muted">合计 ' + sym + F.yuan(total) + '</span></div>' +
        C.line(points) +
        '<div class="small muted" style="margin-top:6px">最高 ' + (peak ? peak.label : '—') + ' ' + sym + F.yuan(peak ? peak.value : 0) +
        ' · 月均 ' + sym + F.yuan(Math.round(total / 12)) + '</div></div>'
      return { html: html, data: { root: root, points: points, total: total, peak: peak } }
    }
    let body = (await render()).html
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">分类趋势</span><button id="ctClose" class="btn sm line">关闭</button></div>' +
      '<div class="chips" id="ctChips">' +
      roots.map(r => '<button class="chip' + (r.id === sel ? ' on' : '') + '" data-ct="' + r.id + '">' + F.escapeHtml(r.icon) + ' ' + F.escapeHtml(r.name) + '</button>').join('') +
      '</div><div id="ctBody">' + body + '</div>' +
      '<button class="btn block" id="ctExport" style="margin-top:12px">' + ic('upload') + ' 导出为图片</button>'
    )
    document.getElementById('ctClose').addEventListener('click', U().closeSheet)
    document.getElementById('ctExport').addEventListener('click', async () => {
      const r = await render()
      const d = r.data
      const sorted = d.points.slice().sort((a, b) => b.value - a.value)
      const top = sorted.slice(0, 5).filter(p => p.value > 0)
      const maxV = Math.max(1, ...d.points.map(p => p.value))
      const spec = {
        title: '分类趋势 · ' + (d.root ? d.root.name : ''),
        subtitle: '近 12 个月 · 合计 ' + sym + F.yuan(d.total),
        hero: {
          label: '12 个月合计', value: money(d.total),
          note: '月均 ' + sym + F.yuan(Math.round(d.total / 12)),
          tone: 'brand',
        },
        stats: [
          { k: '最高月份', v: d.peak ? d.peak.label : '—', note: d.peak ? money(d.peak.value) : '', tone: 'text' },
          { k: '月均', v: money(Math.round(d.total / 12)), note: '12 个月平均', tone: 'text' },
          { k: '有记录月份', v: String(d.points.filter(p => p.value > 0).length) + ' 个月', note: '共 12 个月', tone: 'text' },
        ],
        sections: [
          {
            title: '各月支出', note: '单位：元',
            bars: d.points.map(p => ({
              name: p.label, value: p.value, text: money(p.value),
              tone: p.value === maxV ? 'expense' : 'brand',
            })),
          },
        ],
      }
      if (top.length) {
        spec.sections.push({
          title: '支出最多的月份', note: 'Top ' + top.length,
          rows: top.map(p => ({ k: p.label, v: money(p.value), note: '占 ' + (d.total > 0 ? (p.value / d.total * 100).toFixed(0) : 0) + '%', tone: 'expense' })),
        })
      }
      try { showReportImage('分类趋势图片', buildReportImage(spec), '拾光记账-分类趋势-' + (d.root ? d.root.name : '') + '.png') } catch (e) { U().toast('生成图片失败') }
    })
    document.querySelectorAll('#sheet [data-ct]').forEach(b => {
      b.addEventListener('click', async () => {
        sel = Number(b.getAttribute('data-ct'))
        document.querySelectorAll('#ctChips .chip').forEach(x => x.classList.remove('on'))
        b.classList.add('on')
        document.getElementById('ctBody').innerHTML = '<div class="small muted" style="padding:16px">统计中…</div>'
        document.getElementById('ctBody').innerHTML = (await render()).html
      })
    })
  }

  /* ---------- 账户对账单 ---------- */
  async function openStatementPicker() {
    const accs = S.allAccounts()
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">账户对账单</span><button id="stClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="padding:0">' +
      accs.map(a => '<div class="list-item" data-sta="' + a.id + '"><div class="ico">' + F.escapeHtml(a.icon || '💰') + '</div>' +
        '<div class="grow"><div>' + F.escapeHtml(a.name) + '</div>' +
        '<div class="small muted">' + (window.ACCOUNT_KIND_LABEL[a.kind] || '账户') + '</div></div><span class="muted">›</span></div>').join('') +
      '</div>'
    )
    document.getElementById('stClose').addEventListener('click', U().closeSheet)
    document.querySelectorAll('#sheet [data-sta]').forEach(el =>
      el.addEventListener('click', () => openStatement(Number(el.getAttribute('data-sta')))))
  }

  async function openStatement(accountId) {
    const accs = S.allAccounts()
    const a = accs.find(x => x.id === accountId)
    if (!a) return
    const currency = a.currency || 'CNY'
    const money = cents => F.moneySym(cents, F.currencySym(currency))
    const now = new Date()
    const defFrom = F.iso(new Date(now.getFullYear(), now.getMonth(), 1))
    const defTo = F.iso(new Date(now.getFullYear(), now.getMonth() + 1, 1))
    const render = async (from, to) => {
      const { rows } = await S.listTransactions({ from, to, accountId, limit: 100000 })
      const sorted = rows.slice().sort((x, y) => (x.occurred_at < y.occurred_at ? -1 : x.occurred_at > y.occurred_at ? 1 : x.id - y.id))
      let inflow = 0, outflow = 0
      const lines = sorted.map(t => {
        const cents = F.toCents(t.amount)
        let delta = 0
        if (t.txn_type === 'income') delta = t.account_id === accountId ? cents : 0
        else if (t.txn_type === 'expense') delta = t.account_id === accountId ? -cents : 0
        else {
          if (t.account_id === accountId) delta = -cents
          else if (t.to_account_id === accountId) delta = cents
        }
        if (delta > 0) inflow += delta; else outflow += -delta
        const name = t.txn_type === 'transfer'
          ? (S.accountName(t.account_id) + ' → ' + S.accountName(t.to_account_id))
          : (t.category_id ? S.categoryName(t.category_id) : '未分类')
        return '<div class="kv"><span>' + F.isoDay(t.occurred_at).slice(5) + '　' + F.escapeHtml(name) +
          (t.note ? '<div class="tiny muted ellipsis">' + F.escapeHtml(t.note) + '</div>' : '') + '</span>' +
          '<b class="num" style="color:' + (delta >= 0 ? 'var(--income)' : 'var(--expense)') + '">' +
          (delta >= 0 ? '+' : '-') + F.escapeHtml(money(Math.abs(delta))) + '</b></div>'
      }).join('')
      return { count: sorted.length, inflow, outflow, html: lines || '<div class="small muted" style="padding:14px">该区间没有流水</div>', rows: sorted }
    }
    let r = await render(defFrom, defTo)
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">对账单 · ' + F.escapeHtml(a.name) + '（' + F.escapeHtml(currency) + '）</span><button id="sClose" class="btn sm line">关闭</button></div>' +
      '<div class="row" style="gap:8px;margin-bottom:10px">' +
      '<input id="stFrom" class="input grow" type="date" value="' + defFrom.slice(0, 10) + '">' +
      '<span class="muted">—</span>' +
      '<input id="stTo" class="input grow" type="date" value="' + F.dstr(new Date(now.getFullYear(), now.getMonth() + 1, 0)) + '">' +
      '</div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="row"><div class="grow"><div class="small muted">期间流入</div><div id="stInflow" class="num" style="color:var(--income);font-weight:700">' + F.escapeHtml(money(r.inflow)) + '</div></div>' +
      '<div class="grow"><div class="small muted">期间流出</div><div id="stOutflow" class="num" style="color:var(--expense);font-weight:700">' + F.escapeHtml(money(r.outflow)) + '</div></div>' +
      '<div class="grow"><div class="small muted">笔数</div><div id="stCount" class="num" style="font-weight:700">' + r.count + '</div></div></div></div>' +
      '<div class="card" id="stBody">' + r.html + '</div>' +
      '<button class="btn line block" id="stCsv">导出对账单 CSV</button>'
    )
    document.getElementById('sClose').addEventListener('click', U().closeSheet)
    const body = document.getElementById('stBody')
    let reloadSequence = 0
    const reload = async () => {
      const ticket = ++reloadSequence
      const f = document.getElementById('stFrom').value
      const t = document.getElementById('stTo').value
      const end = t ? F.ymdLocal(t) : null
      if (end) end.setDate(end.getDate() + 1)
      try {
        const next = await render(f ? F.iso(F.ymdLocal(f)) : defFrom, end ? F.iso(end) : defTo)
        if (ticket !== reloadSequence || document.getElementById('stBody') !== body) return
        r = next
        body.innerHTML = r.html
        document.getElementById('stInflow').textContent = money(r.inflow)
        document.getElementById('stOutflow').textContent = money(r.outflow)
        document.getElementById('stCount').textContent = String(r.count)
      } catch (e) {
        if (ticket === reloadSequence && document.getElementById('stBody') === body) U().toast('读取对账单失败，请重试')
      }
    }
    document.getElementById('stFrom').addEventListener('change', reload)
    document.getElementById('stTo').addEventListener('change', reload)
    document.getElementById('stCsv').addEventListener('click', () => {
      const head = ['日期', '类型', '分类/流向', '账户', '目标账户', '备注', '金额', '币种']
      const lines = [head.join(',')].concat(r.rows.map(t => [
        F.isoLocal(t.occurred_at), window.TXN_TYPE_LABEL[t.txn_type] || t.txn_type,
        t.category_id ? S.categoryName(t.category_id) : '',
        S.accountName(t.account_id), t.to_account_id ? S.accountName(t.to_account_id) : '',
        t.note || '', t.amount, currency,
      ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')))
      download('对账单-' + a.name + '-' + F.dstr(new Date()) + '.csv', '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8')
      U().toast('已导出')
    })
  }

  /* ---------- 相册 ---------- */
  async function galleryData(limit) {
    const { rows } = await S.listTransactions({ limit: limit || 200 })
    const withAtt = []
    const map = await S.listAttachments(rows.map(t => t.id))
    rows.forEach(t => {
      const atts = map[t.id] || []
      atts.forEach(a => withAtt.push({ att: a, txn: t }))
    })
    return withAtt
  }
  async function openGallerySheet() {
    const items = await galleryData(120)
    if (!items.length) {
      U().openSheet('<div class="sheet-head"><span class="sheet-title">凭证相册</span><button id="gClose" class="btn sm line">关闭</button></div>' +
        '<div class="empty" style="padding:30px"><div class="big">' + ic('image') + '</div><div>还没有凭证图片</div>' +
        '<div class="small" style="margin-top:6px">记账时上传小票，会自动出现在这里</div></div>')
      document.getElementById('gClose').addEventListener('click', U().closeSheet)
      return
    }
    const byMonth = {}
    items.forEach(it => {
      const k = F.monthOf(it.txn.occurred_at)
      ;(byMonth[k] = byMonth[k] || []).push(it)
    })
    const keys = Object.keys(byMonth).sort().reverse()
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">凭证相册 · ' + items.length + ' 张</span><button id="gClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin:-4px 2px 8px">点图片可放大查看</div>' +
      keys.map(k => '<div class="small muted" style="margin:10px 2px 6px">' + k.replace('-', ' 年 ') + ' 月 · ' + byMonth[k].length + ' 张</div>' +
        '<div class="gallery">' + byMonth[k].map(it =>
          '<img class="gcell" data-gatt="' + it.att.id + '" alt="" loading="lazy">').join('') + '</div>').join('')
    )
    document.getElementById('gClose').addEventListener('click', U().closeSheet)

    /* 图片 URL 是签名链接，一次只取可视区域的，避免上百个请求把流量吃光 */
    const byId = {}
    items.forEach(it => { byId[it.att.id] = it })
    const imgs = Array.prototype.slice.call(document.querySelectorAll('#sheet img[data-gatt]'))
    const load = async (img) => {
      if (img.getAttribute('data-loaded')) return
      img.setAttribute('data-loaded', '1')
      const it = byId[img.getAttribute('data-gatt')]
      if (!it) return
      const url = await S.imageUrl(it.att)
      if (url) img.src = url
    }
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return
          io.unobserve(en.target)
          load(en.target)
        })
      }, { root: document.getElementById('sheet'), rootMargin: '300px 0px' })
      imgs.forEach(img => io.observe(img))
    } else {
      imgs.forEach(load)
    }
    imgs.forEach(img => img.addEventListener('click', () => { if (img.src) U().lightbox(img.src) }))
  }

  /* ---------- 标签管理 ---------- */
  /* 游客侧读回的行不会摘内部标记（云端由 store.cleanTags 处理），
     `_op:`/`_ord:` 开头的是幂等/导入标记，不属于用户标签，收集时必须剔除 */
  function isInternalTag(tag) {
    const s = String(tag)
    return s.slice(0, 4) === '_op:' || s.slice(0, 5) === '_ord:'
  }
  async function collectTags() {
    const { rows } = await S.listTransactions({ limit: 100000 })
    const toBase = baseAmountReader()
    const stat = {}
    rows.forEach(t => (t.tags || []).forEach(tag => {
      if (!tag || isInternalTag(tag)) return
      const k = String(tag)
      stat[k] = stat[k] || { count: 0, amount: 0 }
      stat[k].count++
      if (t.txn_type === 'expense') stat[k].amount += toBase(t)
    }))
    return { stat, rows }
  }

  async function openTagManager() {
    const { stat } = await collectTags()
    const tags = Object.keys(stat).sort((a, b) => stat[b].count - stat[a].count)
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">标签管理</span><button id="tgClose" class="btn sm line">关闭</button></div>' +
      (tags.length
        ? '<div class="card" style="padding:0">' + tags.map(t =>
          '<div class="list-item"><div class="ico">' + ic('tag') + '</div>' +
          '<div class="grow"><div>' + F.escapeHtml(t) + '</div>' +
          '<div class="small muted">' + stat[t].count + ' 笔 · 支出 ¥' + F.yuan(stat[t].amount) + '</div></div>' +
          '<button class="btn sm line" data-tgrename="' + F.escapeHtml(t) + '">改名</button>' +
          '<button class="btn sm danger" data-tgdel="' + F.escapeHtml(t) + '" style="margin-left:4px">删</button></div>').join('') + '</div>'
        : '<div class="empty" style="padding:24px"><div class="big">' + ic('tag') + '</div><div>还没有用过标签</div>' +
          '<div class="small" style="margin-top:6px">记账时在「标签」里填，比如「出差」「AA」</div></div>') +
      '<button class="btn line block" id="tgReport" style="margin-top:12px">' + ic('chart-bar') + ' 查看标签报表</button>'
    )
    document.getElementById('tgClose').addEventListener('click', U().closeSheet)
    document.getElementById('tgReport').addEventListener('click', () => openTagReport())
    document.querySelectorAll('#sheet [data-tgrename]').forEach(b =>
      b.addEventListener('click', () => renameTag(b.getAttribute('data-tgrename'))))
    document.querySelectorAll('#sheet [data-tgdel]').forEach(b =>
      b.addEventListener('click', () => removeTag(b.getAttribute('data-tgdel'))))
  }

  async function renameTag(oldTag) {
    const to = prompt('把标签「' + oldTag + '」改成（改成已有标签即为合并）：', oldTag)
    if (to == null) return
    const target = String(to).trim()
    if (!target || target === oldTag) return
    try {
      const { rows } = await S.listTransactions({ tag: oldTag, limit: 100000 })
      let n = 0
      for (const t of rows) {
        const set = {}
        ;(t.tags || []).forEach(x => { if (x !== oldTag) set[x] = 1 })
        set[target] = 1
        /* 带 updated_at 乐观锁：其他设备刚改过这条时不静默覆盖 */
        await S.updateTransaction(t.id, { tags: Object.keys(set) }, t.updated_at)
        n++
      }
      U().toast('已更新 ' + n + ' 笔')
      window.App.refresh()
      openTagManager()
    } catch (e) { U().toast('操作失败：' + (e.message || '')) }
  }

  async function removeTag(tag) {
    if (!confirm('从所有账目里移除标签「' + tag + '」？（不会删除账目本身）')) return
    try {
      const { rows } = await S.listTransactions({ tag, limit: 100000 })
      for (const t of rows) {
        await S.updateTransaction(t.id, { tags: (t.tags || []).filter(x => x !== tag) }, t.updated_at)
      }
      U().toast('已移除')
      window.App.refresh()
      openTagManager()
    } catch (e) { U().toast('操作失败') }
  }

  async function openTagReport() {
    const sym = F.escapeHtml(F.currencySym(F.baseCurrency()))
    const C = await charts()
    const { stat } = await collectTags()
    const items = Object.keys(stat).map(t => ({ name: t, value: stat[t].amount, count: stat[t].count }))
      .filter(x => x.value > 0).sort((a, b) => b.value - a.value)
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">标签报表</span><button id="trClose" class="btn sm line">关闭</button></div>' +
      (items.length
        ? '<div class="card"><div class="between" style="margin-bottom:10px"><b>标签支出排行</b>' +
          '<span class="tiny muted">共 ' + items.length + ' 个标签</span></div>' +
          C.barList(items.slice(0, 15).map(x => ({ name: x.name, value: x.value, color: '#7c5cff' }))) + '</div>' +
          '<div class="card">' + items.slice(0, 20).map(x =>
            '<div class="kv"><span>' + F.escapeHtml(x.name) + '<div class="tiny muted">' + x.count + ' 笔</div></span>' +
            '<b class="num">' + sym + F.yuan(x.value) + '</b></div>').join('') + '</div>'
        : '<div class="empty" style="padding:24px">暂无带标签的支出</div>')
    )
    document.getElementById('trClose').addEventListener('click', U().closeSheet)
  }

  /* ---------- 账单海报 ---------- */
  async function makePoster(y, m) {
    const from = F.iso(F.monthStart(y, m))
    const to = F.iso(F.monthEnd(y, m))
    U().toast('正在生成海报…')
    let days, cats
    try {
      const r = await Promise.all([S.monthlySummary(from, to), S.categorySummary(from, to, 'expense')])
      days = r[0]; cats = r[1]
    } catch (e) { U().toast('生成失败'); return }
    const { income, expense, balance } = sumRows(days)
    const items = (cats || []).filter(c => c.category_id != null).map(c => {
      const cat = S.category(c.category_id)
      return { name: cat ? cat.name : '未分类', value: F.toCents(c.total), color: cat ? cat.color : '#8a93a6' }
    }).sort((a, b) => b.value - a.value).slice(0, 6)

    const W = 750, H = 1000
    const cv = document.createElement('canvas')
    cv.width = W; cv.height = H
    const g = cv.getContext('2d')
    const grad = g.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#1d2b64'); grad.addColorStop(0.55, '#3a5bd9'); grad.addColorStop(1, '#6d8dff')
    g.fillStyle = grad; g.fillRect(0, 0, W, H)
    g.fillStyle = 'rgba(255,255,255,.10)'
    g.beginPath(); g.arc(W - 80, 90, 190, 0, Math.PI * 2); g.fill()
    g.beginPath(); g.arc(60, H - 120, 150, 0, Math.PI * 2); g.fill()

    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '500 26px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillText('拾光记账 · 月度账单', 60, 110)
    g.fillStyle = '#fff'; g.font = '800 46px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillText(y + ' 年 ' + m + ' 月', 60, 172)
    g.font = '500 24px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText('本月支出', 60, 250)
    g.fillStyle = '#fff'; g.font = '800 84px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillText(F.money(expense), 60, 340)

    g.font = '500 26px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillStyle = 'rgba(255,255,255,.9)'
    g.fillText('收入 ¥' + F.yuan(income), 60, 400)
    g.fillText('结余 ' + F.money(balance), 320, 400)

    /* 分类条形 */
    let yy = 470
    const maxV = items.length ? items[0].value : 1
    items.forEach(it => {
      g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '600 28px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
      g.fillText(it.name, 60, yy)
      g.textAlign = 'right'
      g.fillText(F.money(it.value), W - 60, yy)
      g.textAlign = 'left'
      g.fillStyle = 'rgba(255,255,255,.22)'
      roundRect(g, 60, yy + 14, W - 120, 18, 9); g.fill()
      g.fillStyle = it.color || '#fff'
      roundRect(g, 60, yy + 14, Math.max(18, (W - 120) * it.value / maxV), 18, 9); g.fill()
      yy += 78
    })

    g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '500 22px system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
    g.fillText('由「拾光记账」生成 · ' + F.dstr(new Date()), 60, H - 60)

    const url = cv.toDataURL('image/png')
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">本月账单海报</span><button id="poClose" class="btn sm line">关闭</button></div>' +
      '<img src="' + url + '" alt="账单海报" style="width:100%;border-radius:16px;box-shadow:var(--shadow)">' +
      '<a class="btn block" id="poSave" download="拾光记账-' + y + '年' + m + '月.png" href="' + url + '" style="margin-top:12px;text-decoration:none">保存图片</a>' +
      '<div class="small muted center" style="margin-top:8px">手机上长按图片也可保存 / 分享</div>'
    )
    document.getElementById('poClose').addEventListener('click', U().closeSheet)
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }

  /* ---------- 按筛选导出 ---------- */
  async function exportFilteredCsv(st) {
    const r = window.UI.periodRange(st)
    const opt = { from: r.from, to: r.to, limit: 100000 }
    const f = st.filters || {}
    if (f.type) opt.type = f.type
    if (f.accountId) opt.accountId = f.accountId
    if (f.categoryId) opt.categoryId = f.categoryId
    if (f.keyword) opt.keyword = f.keyword
    if (f.tag) opt.tag = f.tag
    if (f.minAmount) opt.minAmount = f.minAmount
    if (f.maxAmount) opt.maxAmount = f.maxAmount
    if (f.reimbursable) opt.reimbursable = true
    try {
      const { rows } = await S.listTransactions(opt)
      if (!rows.length) { U().toast('当前筛选没有数据'); return }
      const atts = await S.listAttachments(rows.map(t => t.id))
      const head = ['日期', '类型', '金额', '账本', '账户', '目标账户', '分类', '备注', '标签', '报销', '图片数']
      const lines = [head.join(',')].concat(rows.map(t => {
        const c = t.category_id ? S.category(t.category_id) : null
        return [
          F.isoLocal(t.occurred_at), window.TXN_TYPE_LABEL[t.txn_type] || t.txn_type, t.amount,
          t.book_id ? S.bookName(t.book_id) : '',
          t.account_id ? S.accountName(t.account_id) : '',
          t.to_account_id ? S.accountName(t.to_account_id) : '',
          c ? (c.parent_id ? S.categoryName(c.parent_id) + '/' + c.name : c.name) : '',
          t.note || '', (t.tags || []).join(' '), t.reimbursable ? '是' : '',
          (atts[t.id] || []).length,
        ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')
      }))
      download('拾光记账-筛选-' + F.dstr(new Date()) + '.csv', '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8')
      U().toast('已导出 ' + rows.length + ' 笔')
    } catch (e) { U().toast('导出失败：' + (e.message || '')) }
  }

  /* ---------- 消费洞察（漏洞审计） ---------- */
  /* 从四个角度指出「钱悄悄流走的地方」：固定/订阅支出、高频小额聚集区、
     大额支出、环比异常分类。全部由现有账目实时聚合，不新增表结构。 */
  async function openAudit() {
    const sym = F.escapeHtml(F.currencySym(F.baseCurrency()))
    const money = cents => F.moneySym(cents, sym)
    const esc = F.escapeHtml
    const st = window.App.state
    const y = st.year || new Date().getFullYear()
    const m = st.month || (new Date().getMonth() + 1)
    const from = F.iso(F.monthStart(y, m))
    const to = F.iso(F.monthEnd(y, m))
    const py = m === 1 ? y - 1 : y
    const pm = m === 1 ? 12 : m - 1
    const prevFrom = F.iso(F.monthStart(py, pm))

    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">消费洞察</span><button id="auClose" class="btn sm line">关闭</button></div>' +
      '<div id="auBody"><div class="card"><div class="small muted">正在分析本月账目…</div></div></div>'
    )
    document.getElementById('auClose').addEventListener('click', U().closeSheet)

    let rows = []
    let prevRows = []
    let rules = []
    try {
      const cur = await S.listTransactions({ from: from, to: to, type: 'expense', limit: 100000 }).catch(() => ({ rows: [] }))
      const prev = await S.listTransactions({ from: prevFrom, to: to, type: 'expense', limit: 100000 }).catch(() => ({ rows: [] }))
      const rl = S.listRecurring ? await S.listRecurring().catch(() => []) : []
      rows = cur.rows || []
      prevRows = (prev.rows || []).filter(t => t.occurred_at < from)
      rules = rl || []
    } catch (e) { /* 出错时按空数据处理 */ }

    const body = document.getElementById('auBody')
    if (!body) return

    if (!rows.length) {
      body.innerHTML = '<div class="card" style="text-align:center"><div style="font-size:34px">' + ic('search') + '</div>' +
        '<div style="font-weight:700;margin-top:4px">这个月还没有支出记录</div>' +
        '<div class="small muted" style="margin-top:4px">记几笔之后再来看，这里会指出钱悄悄流走的地方。</div></div>'
      return
    }

    const now = new Date()
    const isCurrent = now.getFullYear() === y && (now.getMonth() + 1) === m
    const daysInMonth = new Date(y, m, 0).getDate()
    const elapsed = isCurrent ? now.getDate() : daysInMonth
    const toBase = baseAmountReader()
    const totalCents = rows.reduce((s, t) => s + toBase(t), 0)
    const catName = id => (id ? S.categoryName(id) : '未分类')

    /* 1) 固定 / 订阅支出（按周期折算到每月） */
    const perMonth = { daily: 30.4, weekly: 4.33, monthly: 1, yearly: 1 / 12 }
    const fixedList = (rules || []).filter(r => r.active !== false && r.txn_type === 'expense').map(r => {
      const per = Math.round(toBase(r) * (perMonth[r.freq] || 1))
      return { name: r.note || catName(r.category_id), per: per }
    }).filter(x => x.per > 0).sort((a, b) => b.per - a.per)
    const fixedCents = fixedList.reduce((s, x) => s + x.per, 0)

    /* 2) 高频小额聚集区（单笔 ≤ ¥50 且出现 ≥ 5 次） */
    const SMALL_CAP = 5000
    const smallMap = {}
    rows.forEach(t => {
      if (toBase(t) > SMALL_CAP) return
      const k = t.category_id || 0
      if (!smallMap[k]) smallMap[k] = { n: 0, sum: 0 }
      smallMap[k].n++
      smallMap[k].sum += toBase(t)
    })
    const smallList = Object.keys(smallMap)
      .map(k => ({ id: Number(k), n: smallMap[k].n, sum: smallMap[k].sum }))
      .filter(x => x.n >= 5)
      .sort((a, b) => b.sum - a.sum)
      .slice(0, 4)

    /* 3) 大额支出 Top 5 */
    const bigList = rows.slice().sort((a, b) => toBase(b) - toBase(a)).slice(0, 5)

    /* 4) 环比异常：本月 ≥ ¥200 且（上月为 0 或增长 ≥ 50%） */
    const curByCat = {}
    const prevByCat = {}
    rows.forEach(t => { const k = t.category_id || 0; curByCat[k] = (curByCat[k] || 0) + toBase(t) })
    prevRows.forEach(t => { const k = t.category_id || 0; prevByCat[k] = (prevByCat[k] || 0) + toBase(t) })
    const spikes = Object.keys(curByCat).map(k => {
      const c = curByCat[k]
      const p = prevByCat[k] || 0
      return { id: Number(k), cur: c, prev: p, growth: p > 0 ? Math.round((c - p) / p * 100) : null }
    }).filter(x => x.cur >= 20000 && (x.prev === 0
      /* 上月完全没有数据时（新用户首月）不列"新增"，否则整屏都是噪音 */
      ? prevRows.length > 0
      : x.growth >= 50))
      .sort((a, b) => b.cur - a.cur).slice(0, 4)

    /* ---- 组装 ---- */
    const cards = []

    cards.push('<div class="card"><div class="between" style="margin-bottom:6px"><b>' +
      (isCurrent ? '本月' : m + '月') + '支出概览</b>' +
      '<span class="tiny muted">' + elapsed + ' 天</span></div>' +
      '<div class="row" style="gap:8px">' +
      '<div style="flex:1;min-width:0"><div class="small muted">总支出</div>' +
      '<div class="num" style="font-size:19px;font-weight:700">' + sym + F.yuan(totalCents) + '</div></div>' +
      '<div style="flex:1;min-width:0"><div class="small muted">笔数</div>' +
      '<div class="num" style="font-size:19px;font-weight:700">' + rows.length + '</div></div>' +
      '<div style="flex:1;min-width:0"><div class="small muted">日均</div>' +
      '<div class="num" style="font-size:19px;font-weight:700">' + sym + F.yuan(Math.round(totalCents / Math.max(elapsed, 1))) + '</div></div>' +
      '</div></div>')

    if (fixedList.length) {
      const pct = Math.round(fixedCents / totalCents * 100)
      cards.push('<div class="card"><div class="between" style="margin-bottom:6px"><b>固定 / 周期支出</b>' +
        '<span class="tiny muted">每月约 ' + sym + F.yuan(fixedCents) + ' · 占支出 ' + pct + '%</span></div>' +
        fixedList.slice(0, 6).map(x => '<div class="kv"><span class="ellipsis">' + esc(x.name) + '</span>' +
          '<b class="num">' + sym + F.yuan(x.per) + '/月</b></div>').join('') +
        (fixedList.length > 6 ? '<div class="tiny muted">还有 ' + (fixedList.length - 6) + ' 项…</div>' : '') +
        '<div class="small muted" style="margin-top:8px">这些是不记账也会自动扣的钱，先看清总额再决定留哪些。</div></div>')
    }

    if (smallList.length) {
      cards.push('<div class="card"><div class="between" style="margin-bottom:6px"><b>高频小额聚集区</b>' +
        '<span class="tiny muted">单笔 ≤ ' + sym + '50 且 ≥ 5 次</span></div>' +
        smallList.map(x => '<div class="kv"><span class="ellipsis">' + esc(catName(x.id)) + ' · ' + x.n + ' 笔</span>' +
          '<b class="num">' + sym + F.yuan(x.sum) + '</b></div>').join('') +
        '<div class="small muted" style="margin-top:8px">单笔不痛，累计最痛——这是最容易无感流失的钱。</div></div>')
    }

    if (bigList.length) {
      cards.push('<div class="card"><div class="between" style="margin-bottom:6px"><b>大额支出 Top 5</b>' +
        '<span class="tiny muted">本月</span></div>' +
        bigList.map(t => '<div class="kv"><span class="ellipsis">' + esc(t.note || catName(t.category_id)) +
          ' <span class="tiny muted">' + esc(F.isoDay(t.occurred_at).slice(5)) + '</span></span>' +
          '<b class="num">' + sym + F.yuan(toBase(t)) + '</b></div>').join('') + '</div>')
    }

    if (spikes.length) {
      cards.push('<div class="card"><div class="between" style="margin-bottom:6px"><b>环比异常</b>' +
        '<span class="tiny muted">对比上月</span></div>' +
        spikes.map(x => '<div class="kv"><span class="ellipsis">' + esc(catName(x.id)) + '</span>' +
          '<b class="num">' + (x.prev === 0
            ? '新增 ' + sym + F.yuan(x.cur)
            : money(x.prev) + ' → ' + sym + F.yuan(x.cur) + '（+' + x.growth + '%）') + '</b></div>').join('') +
        '<div class="small muted" style="margin-top:8px">这些分类比上个月明显变多了，值得回头看一眼是不是必要开销。</div></div>')
    }

    /* 结论 */
    const notes = []
    if (fixedCents > 0) {
      notes.push('每月固定支出约 <span class="num">' + sym + F.yuan(fixedCents) + '</span>，占本月支出的 ' +
        Math.round(fixedCents / totalCents * 100) + '%')
    }
    if (smallList.length) {
      const s = smallList[0]
      notes.push('「' + esc(catName(s.id)) + '」小额共 ' + s.n + ' 笔、<span class="num">' + sym + F.yuan(s.sum) +
        '</span>，平均每笔 <span class="num">' + sym + F.yuan(Math.round(s.sum / s.n)) + '</span>')
    }
    if (spikes.length) {
      notes.push('「' + esc(catName(spikes[0].id)) + '」比上月多花 <span class="num">' + sym +
        F.yuan(spikes[0].cur - spikes[0].prev) + '</span>')
    }
    cards.push('<div class="card"><div style="font-weight:700;margin-bottom:6px">小结</div>' +
      (notes.length
        ? '<ul class="small" style="margin:0;padding-left:18px">' + notes.map(n => '<li style="margin-bottom:4px">' + n + '</li>').join('') + '</ul>'
        : '<div class="small muted">本月没有发现明显的异常开支，保持得不错。</div>') +
      '<div class="hint" style="margin-top:8px">洞察只基于你自己的账目实时计算，不额外上传任何数据</div></div>')

    body.innerHTML = cards.join('')

    /* 导出为图片：把上面几块结论固化成一张可分享的 PNG */
    const exWrap = document.createElement('button')
    exWrap.className = 'btn block'
    exWrap.id = 'auExport'
    exWrap.style.marginTop = '12px'
    exWrap.innerHTML = '' + ic('upload') + ' 导出为图片'
    body.appendChild(exWrap)
    exWrap.addEventListener('click', () => {
      const avg = Math.round(totalCents / Math.max(elapsed, 1))
      const spec = {
        title: '消费洞察 · ' + y + ' 年 ' + m + ' 月',
        subtitle: '共 ' + rows.length + ' 笔支出' + (isCurrent ? ' · 已过 ' + elapsed + ' 天' : ''),
        hero: { label: (isCurrent ? '本月' : m + '月') + '总支出', value: money(totalCents), note: '日均 ' + sym + F.yuan(avg), tone: 'expense' },
        stats: [
          { k: '总支出', v: money(totalCents), note: rows.length + ' 笔', tone: 'expense' },
          { k: '日均支出', v: money(avg), note: '按 ' + elapsed + ' 天', tone: 'text' },
          {
            k: '固定支出占比',
            v: fixedCents > 0 ? Math.round(fixedCents / Math.max(totalCents, 1) * 100) + '%' : '—',
            note: fixedCents > 0 ? '每月约 ' + sym + F.yuan(fixedCents) : '没有周期记账',
            tone: fixedCents > 0 ? 'warn' : 'sub',
          },
        ],
        sections: [],
      }
      if (fixedList.length) {
        spec.sections.push({
          title: '固定 / 周期支出', note: '每月约 ' + sym + F.yuan(fixedCents),
          bars: fixedList.slice(0, 6).map(x => ({ name: x.name, value: x.per, text: money(x.per) + '/月', tone: 'brand' })),
        })
      }
      if (smallList.length) {
        spec.sections.push({
          title: '高频小额聚集区', note: '单笔 ≤ ' + sym + '50 且 ≥ 5 次',
          rows: smallList.map(x => ({
            k: catName(x.id), v: money(x.sum), note: x.n + ' 笔 · 均 ' + sym + F.yuan(Math.round(x.sum / x.n)), tone: 'text',
          })),
        })
      }
      if (bigList.length) {
        spec.sections.push({
          title: '大额支出 Top 5', note: (isCurrent ? '本月' : m + '月'),
          rows: bigList.map(t => ({
            k: t.note || catName(t.category_id),
            v: money(toBase(t)),
            note: F.isoDay(t.occurred_at).slice(5) + ' · ' + catName(t.category_id),
            tone: 'expense',
          })),
        })
      }
      if (spikes.length) {
        spec.sections.push({
          title: '环比异常', note: '对比上月',
          rows: spikes.map(x => ({
            k: catName(x.id),
            v: x.prev === 0 ? '新增 ' + sym + F.yuan(x.cur) : money(x.cur),
            note: x.prev === 0 ? '上月没有这笔' : '上月 ' + sym + F.yuan(x.prev) + '（+' + x.growth + '%）',
            tone: 'warn',
          })),
        })
      }
      if (!spec.sections.length) {
        spec.sections.push({ title: '小结', note: '', rows: [{ k: '没有发现明显异常开支', v: '', tone: 'income' }] })
      }
      try { showReportImage('消费洞察图片', buildReportImage(spec), '拾光记账-消费洞察-' + y + '年' + m + '月.png') } catch (e) { U().toast('生成图片失败') }
    })
  }

  /* ---------------- 报表出图（PNG） ----------------
     把任一报表面板的结论画成一张可保存 / 分享的图片。
     颜色跟随当前主题，浅色底深色字、深色底浅色字，导出后依然可读。 */
  const RF = 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei"'
  const THEME_LIGHT = { bg: '#ffffff', card: '#f4f6fb', text: '#1b1f27', sub: '#6b7488', track: '#e4e9f3', brand: '#2f6bef', income: '#12a150', expense: '#e5484d', warn: '#d98600' }
  const THEME_DARK = { bg: '#191c23', card: '#232733', text: '#eef1f7', sub: '#9aa3b5', track: '#333a4a', brand: '#6a8dff', income: '#4fd08a', expense: '#ff7b7f', warn: '#ffc45c' }
  function themeOf() {
    const t = document.documentElement.getAttribute('data-theme')
    if (t === 'dark') return THEME_DARK
    if (t === 'light') return THEME_LIGHT
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? THEME_DARK : THEME_LIGHT
    } catch (e) { return THEME_LIGHT }
  }
  function toneColor(th, tone) {
    if (tone === 'income') return th.income
    if (tone === 'expense') return th.expense
    if (tone === 'warn') return th.warn
    if (tone === 'brand') return th.brand
    if (tone === 'sub') return th.sub
    return th.text
  }
  function fitText(g, s, max) {
    let t = String(s == null ? '' : s)
    if (g.measureText(t).width <= max) return t
    while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1)
    return t + '…'
  }

  /* spec = { title, subtitle, hero:{label,value,note,tone},
             stats:[{k,v,note,tone}], sections:[{title,note,bars:[{name,value,text,color}],rows:[{k,v,note,tone}]}],
             footer } */
  function buildReportImage(spec) {
    const th = themeOf()
    const W = 750
    const PAD = 52
    const CW = W - PAD * 2
    const stats = spec.stats || []
    const sections = spec.sections || []
    const statRows = Math.ceil(stats.length / 3)
    let hSec = 0
    sections.forEach(sec => {
      const n = (sec.bars ? sec.bars.length : 0) + (sec.rows ? sec.rows.length : 0)
      hSec += 64 + n * 62 + 22
    })
    const H = 150 + (spec.hero ? 142 : 0) + statRows * 104 + hSec + 96

    const cv = document.createElement('canvas')
    cv.width = W; cv.height = H
    const g = cv.getContext('2d')
    g.fillStyle = th.bg
    g.fillRect(0, 0, W, H)
    g.textBaseline = 'alphabetic'

    let y = 0
    /* 顶部品牌条 */
    g.fillStyle = th.brand
    g.fillRect(0, 0, W, 6)
    y = 84
    g.fillStyle = th.text
    g.font = '800 38px ' + RF
    g.fillText(fitText(g, spec.title || '报表', CW), PAD, y)
    if (spec.subtitle) {
      y += 36
      g.fillStyle = th.sub
      g.font = '500 22px ' + RF
      g.fillText(fitText(g, spec.subtitle, CW), PAD, y)
    }
    y = 150

    if (spec.hero) {
      roundRect(g, PAD, y, CW, 122, 18)
      g.fillStyle = th.card; g.fill()
      g.fillStyle = th.sub; g.font = '500 22px ' + RF
      g.fillText(spec.hero.label || '', PAD + 24, y + 40)
      g.fillStyle = toneColor(th, spec.hero.tone)
      g.font = '800 54px ' + RF
      g.fillText(fitText(g, spec.hero.value, CW - 48), PAD + 24, y + 96)
      if (spec.hero.note) {
        g.fillStyle = th.sub; g.font = '500 20px ' + RF
        g.textAlign = 'right'
        g.fillText(fitText(g, spec.hero.note, CW - 48), PAD + CW - 24, y + 40)
        g.textAlign = 'left'
      }
      y += 142
    }

    if (stats.length) {
      const gap = 12
      const cw = (CW - gap * 2) / 3
      stats.forEach((s, i) => {
        const col = i % 3
        const row = Math.floor(i / 3)
        const x = PAD + col * (cw + gap)
        const yy = y + row * 104
        roundRect(g, x, yy, cw, 92, 16)
        g.fillStyle = th.card; g.fill()
        g.fillStyle = th.sub; g.font = '500 19px ' + RF
        g.fillText(fitText(g, s.k, cw - 32), x + 16, yy + 30)
        g.fillStyle = toneColor(th, s.tone)
        g.font = '800 30px ' + RF
        g.fillText(fitText(g, s.v, cw - 32), x + 16, yy + 68)
        if (s.note) {
          g.fillStyle = th.sub; g.font = '500 15px ' + RF
          g.fillText(fitText(g, s.note, cw - 32), x + 16, yy + 86)
        }
      })
      y += statRows * 104
    }

    sections.forEach(sec => {
      const bars = sec.bars || []
      const rows = sec.rows || []
      const n = bars.length + rows.length
      const boxH = 64 + n * 62 + 22
      roundRect(g, PAD, y, CW, boxH, 18)
      g.fillStyle = th.card; g.fill()
      let yy = y + 40
      g.fillStyle = th.text; g.font = '700 25px ' + RF
      g.fillText(fitText(g, sec.title || '', CW * 0.62), PAD + 22, yy)
      if (sec.note) {
        g.fillStyle = th.sub; g.font = '500 18px ' + RF
        g.textAlign = 'right'
        g.fillText(fitText(g, sec.note, CW * 0.34), PAD + CW - 22, yy)
        g.textAlign = 'left'
      }
      yy += 24

      const maxV = bars.length ? Math.max(1, ...bars.map(b => Math.abs(b.value) || 0)) : 1
      bars.forEach(b => {
        g.fillStyle = th.text; g.font = '600 22px ' + RF
        g.fillText(fitText(g, b.name, CW - 220), PAD + 22, yy + 18)
        g.font = '700 22px ' + RF
        g.textAlign = 'right'
        g.fillText(fitText(g, b.text || '', 190), PAD + CW - 22, yy + 18)
        g.textAlign = 'left'
        roundRect(g, PAD + 22, yy + 28, CW - 44, 12, 6)
        g.fillStyle = th.track; g.fill()
        const raw = Math.abs(b.value || 0)
        const bw = raw > 0 ? Math.max(12, (CW - 44) * raw / maxV) : 0
        if (bw > 0) {
          roundRect(g, PAD + 22, yy + 28, bw, 12, 6)
          g.fillStyle = b.color || (b.tone ? toneColor(th, b.tone) : th.brand); g.fill()
        }
        yy += 62
      })
      rows.forEach(r => {
        g.fillStyle = th.text; g.font = '600 22px ' + RF
        g.fillText(fitText(g, r.k, CW - 240), PAD + 22, yy + 22)
        if (r.note) {
          g.fillStyle = th.sub; g.font = '500 16px ' + RF
          g.fillText(fitText(g, r.note, CW - 240), PAD + 22, yy + 44)
        }
        g.fillStyle = toneColor(th, r.tone)
        g.font = '700 23px ' + RF
        g.textAlign = 'right'
        g.fillText(fitText(g, r.v, 220), PAD + CW - 22, yy + 32)
        g.textAlign = 'left'
        yy += 62
      })
      y += boxH + 14
    })

    g.fillStyle = th.sub; g.font = '500 19px ' + RF
    g.fillText(spec.footer || ('由「拾光记账」生成 · ' + F.dstr(new Date())), PAD, y + 46)

    return cv
  }

  function showReportImage(title, cv, filename) {
    const url = cv.toDataURL('image/png')
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">' + F.escapeHtml(title) + '</span><button id="riClose" class="btn sm line">关闭</button></div>' +
      '<img src="' + url + '" alt="报表图片" style="width:100%;border-radius:16px;box-shadow:var(--shadow)">' +
      '<a class="btn block" id="riSave" download="' + F.escapeHtml(filename) + '" href="' + url + '" style="margin-top:12px;text-decoration:none">保存图片</a>' +
      '<div class="small muted center" style="margin-top:8px">手机上长按图片也可保存 / 分享</div>'
    )
    document.getElementById('riClose').addEventListener('click', U().closeSheet)
  }

  /* ---------- 年度报告图片 ---------- */
  async function exportYearImage(y) {
    const yy = y || window.App.state.year || new Date().getFullYear()
    const r = yearRange(yy)
    U().toast('正在生成年报图片…')
    let months, cats
    try {
      const res = await Promise.all([S.monthlySummary(r.from, r.to), S.categorySummary(r.from, r.to, 'expense')])
      months = res[0]; cats = res[1]
    } catch (e) { U().toast('生成失败，请稍后重试'); return }
    const { income, expense, balance } = sumRows(months)
    const byMonth = {}
    ;(months || []).forEach(m => {
      byMonth[m.month_key.slice(5)] = { income: F.toCents(m.income), expense: F.toCents(m.expense), n: m.txn_count || 0 }
    })
    const now = new Date()
    const isCur = now.getFullYear() === yy
    const passedMonths = isCur ? now.getMonth() + 1 : 12
    const list = []
    for (let i = 1; i <= 12; i++) {
      const v = byMonth[F.pad2(i)] || { income: 0, expense: 0, n: 0 }
      list.push({ label: i + '月', income: v.income, expense: v.expense, n: v.n })
    }
    const active = list.filter(m => m.income || m.expense)
    const maxE = Math.max(1, ...list.map(m => m.expense))
    const top = (cats || []).filter(c => c.category_id != null).map(c => {
      const cat = S.category(c.category_id)
      return { name: cat ? cat.name : '未分类', value: F.toCents(c.total), color: cat ? cat.color : '#8a93a6' }
    }).sort((a, b) => b.value - a.value).slice(0, 8)

    const spec = {
      title: yy + ' 年记账报告',
      subtitle: (isCur ? '截至 ' + passedMonths + ' 月' : '全年 12 个月') + ' · 有记录 ' + active.length + ' 个月',
      hero: {
        label: '全年支出', value: F.money(expense),
        note: '收入 ¥' + F.yuan(income) + ' · 结余 ' + F.money(balance),
        tone: 'expense',
      },
      stats: [
        { k: '全年收入', v: F.money(income), note: '共 ' + (months || []).reduce((s, m) => s + (m.txn_count || 0), 0) + ' 笔', tone: 'income' },
        { k: '全年支出', v: F.money(expense), note: '共 ' + active.length + ' 个月有记录', tone: 'expense' },
        {
          k: '储蓄率',
          v: income > 0 ? (balance / income * 100).toFixed(1) + '%' : '—',
          note: income > 0 ? '结余 ÷ 收入' : '缺少收入记录',
          tone: income > 0 ? (balance / income >= 0.2 ? 'income' : balance >= 0 ? 'warn' : 'expense') : 'sub',
        },
        { k: '月均支出', v: F.money(Math.round(expense / Math.max(passedMonths, 1))), note: '按 ' + passedMonths + ' 个月', tone: 'text' },
        { k: '月均结余', v: F.money(Math.round(balance / Math.max(passedMonths, 1))), note: '按 ' + passedMonths + ' 个月', tone: balance >= 0 ? 'income' : 'expense' },
        { k: '最高支出月', v: (list.slice().sort((a, b) => b.expense - a.expense)[0] || { label: '—' }).label, note: F.money(maxE), tone: 'warn' },
      ],
      sections: [
        {
          title: '逐月支出', note: '单位：元',
          bars: list.map(m => ({
            name: m.label, value: m.expense, text: F.money(m.expense),
            tone: m.expense === maxE ? 'expense' : 'brand',
          })),
        },
      ],
    }
    if (top.length) {
      spec.sections.push({
        title: '支出分类 Top ' + top.length, note: '全年合计',
        bars: top.map(it => ({ name: it.name, value: it.value, text: F.money(it.value), color: it.color })),
      })
    }
    try {
      showReportImage('年报图片', buildReportImage(spec), '拾光记账-' + yy + '年报.png')
    } catch (e) { U().toast('生成图片失败') }
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  }

  async function openMonthReport() {
    const C = await charts()
    const st = window.App.state
    const from = F.iso(F.monthStart(st.year, st.month))
    const to = F.iso(F.monthEnd(st.year, st.month))
    let days
    let cats
    try {
      const r = await Promise.all([S.monthlySummary(from, to), S.categorySummary(from, to, 'expense')])
      days = r[0]; cats = r[1]
    } catch (e) {
      U().toast('生成报表失败'); return
    }
    let expense = 0
    let income = 0
    ;(days || []).forEach(d => { expense += F.toCents(d.expense); income += F.toCents(d.income) })
    const items = (cats || []).filter(c => c.category_id != null).map(c => {
      const cat = S.category(c.category_id)
      return { name: cat ? cat.name : '未分类', value: F.toCents(c.total), color: cat ? cat.color : '#8a93a6' }
    }).sort((a, b) => b.value - a.value)
    /* 日均：当月按已过天数，历史月份按整月天数，避免拿今天的日期去除历史月份 */
    const nowD = new Date()
    const isCurrentMonth = nowD.getFullYear() === st.year && (nowD.getMonth() + 1) === st.month
    const passed = isCurrentMonth ? nowD.getDate() : new Date(st.year, st.month, 0).getDate()
    const report =
      '<div class="report-doc">' +
      '<div class="rd-head"><div class="rd-sub">' + st.year + ' 年 ' + st.month + ' 月 · 记账报告</div>' +
      '<div class="rd-big num">支出 ¥' + F.yuan(expense) + '</div>' +
      '<div class="rd-row"><span>收入 ¥' + F.yuan(income) + '</span><span>结余 ' + F.money(income - expense) + '</span><span>日均 ¥' + F.yuan(Math.round(expense / Math.max(passed, 1))) + '</span></div></div>' +
      (items.length ? '<div class="rd-sec">支出分类 Top ' + Math.min(items.length, 8) + '</div>' + C.donut(items) : '') +
      (items.length ? '<div class="rd-list">' + items.slice(0, 8).map(it =>
        '<div class="rd-li"><span>' + F.escapeHtml(it.name) + '</span><span class="num">¥' + F.yuan(it.value) + '</span></div>').join('') + '</div>' : '') +
      '<div class="rd-foot">由「拾光记账」生成 · ' + F.dstr(new Date()) + '</div>' +
      '</div>'
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">月度报表</span><button id="rpClose" class="btn sm line">关闭</button></div>' +
      report +
      '<button class="btn block" id="rpPrint" style="margin-top:12px">' + window.ic('printer') + ' 打印 / 存为 PDF</button>' +
      '<button class="btn line block" id="rpImg" style="margin-top:8px">' + window.ic('upload') + ' 导出为图片（PNG）</button>' +
      '<div class="small muted" style="margin-top:6px">打印对话框选「另存为 PDF」可存 PDF；导出图片适合直接发朋友圈 / 发给家人</div>'
    )
    document.getElementById('rpClose').addEventListener('click', U().closeSheet)
    document.getElementById('rpImg').addEventListener('click', () => {
      {
      const top = items.slice(0, 8)
      const spec = {
        title: st.year + ' 年 ' + st.month + ' 月 · 记账报告',
        subtitle: '共记录 ' + (days || []).length + ' 天 · 日均 ¥' + F.yuan(Math.round(expense / Math.max(passed, 1))),
        hero: { label: '本月支出', value: F.money(expense), note: '结余 ' + F.money(income - expense), tone: 'expense' },
        stats: [
          { k: '收入', v: F.money(income), note: '本月全部收入', tone: 'income' },
          { k: '支出', v: F.money(expense), note: '本月全部支出', tone: 'expense' },
          { k: '结余', v: F.money(income - expense), note: '收入 − 支出', tone: income - expense >= 0 ? 'income' : 'expense' },
        ],
        sections: [],
      }
      if (top.length) {
        spec.sections.push({
          title: '支出分类 Top ' + top.length, note: '单位：元',
          bars: top.map(it => ({
            name: it.name, value: it.value, text: F.money(it.value),
            color: it.color,
          })),
        })
        spec.sections.push({
          title: '分类明细', note: '按金额降序',
          rows: top.map(it => ({
            k: it.name, v: F.money(it.value),
            note: '占 ' + (expense > 0 ? (it.value / expense * 100).toFixed(0) : 0) + '%',
            tone: 'text',
          })),
        })
      }
      try {
        showReportImage('月度报表图片',
          buildReportImage(spec),
          '拾光记账-' + st.year + '年' + st.month + '月-报表.png')
      } catch (e) { U().toast('生成图片失败') }
      }
    })
    document.getElementById('rpPrint').addEventListener('click', () => {
      const pa = document.getElementById('printArea')
      if (!pa) { window.print(); return }
      pa.innerHTML = report
      pa.classList.add('on')
      setTimeout(() => { window.print(); pa.classList.remove('on') }, 80)
    })
  }

  return {
    openReportCenter, openMonthReport, openHealth, openAudit, openYoY, openCatTrend, openStatement, openStatementPicker,
    openGallerySheet, galleryData, openTagManager, openTagReport, makePoster, exportFilteredCsv,
    buildReportImage, showReportImage, exportYearImage,
  }
})()

