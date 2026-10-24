/* 轻量 SVG 图表：柱状趋势、环形占比、日历热力图，无外部依赖 */
window.Charts = (function () {
  const M = (cents) => window.Fmt.moneyText(cents)

  /* 关于尺寸（v3 评审 P1-1）：原来是 viewBox 700 宽 + width:100%，
     在 332px 的卡片里整体缩到 47%，11px 的轴标签实际只有 5.5px，图「只能看形状」。
     现在 viewBox 按窄屏基准（360）出图，再用 max-width 兜住桌面端放大倍数，
     保证任意宽度下轴文字都 ≥11px。 */
  function svg(w, h, inner) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="height:auto;display:block;max-width:520px;margin:0 auto" preserveAspectRatio="xMidYMid meet" role="img">' + inner + '</svg>'
  }
  function shortMoney(cents) {
    if (window.Fmt.privacy()) return '****'
    const v = cents / 100
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + '万'
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k'
    return v.toFixed(0)
  }

  /* ===================== 坐标轴取整（nice scale）=====================
     v4 评审 缺陷 3：原来 Y 轴直接按 min/max 三等分，刻度落在 1.6 / 1.8 / 2.1 / 2.3 万
     这种数上，肉眼看着间距忽大忽小（0.2、0.3、0.2），图表「不专业」。
     这里把 [lo,hi] 扩到 1/2/2.5/5×10ⁿ 的整数倍刻度，并额外要求步长能整齐地
     换算成轴标签单位，否则 1.75 万会被 shortMoney 四舍五入成 1.8 万，
     又变成 1.5 / 1.8 / 2 / 2.3 / 2.5 这种假均匀。 */
  function niceScale(lo, hi, want) {
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null
    const peak = Math.max(Math.abs(lo), Math.abs(hi))
    /* 轴标签粒度（单位：分）。shortMoney 的口径：
       ≥1万元 → 「x.y 万」一位小数 → 步长须为 1000 元的倍数；
       1000~1万元 → 「x.y k」一位小数 → 步长须为 100 元的倍数；
       1000 元以下 → 整数元 → 步长须为 1 元的倍数（否则 2.5 元会被 toFixed(0) 抹成 3） */
    const grain = peak >= 1000000 ? 100000 : peak >= 100000 ? 10000 : 100
    let best = null
    for (let e = 0; e <= 12; e++) {
      [1, 2, 2.5, 5, 10].forEach(k => {
        const step = k * Math.pow(10, e)
        if (step <= 0) return
        if (Math.abs(step / grain - Math.round(step / grain)) > 1e-9) return
        const a = Math.floor(lo / step) * step
        const b = Math.ceil(hi / step) * step
        const cnt = Math.round((b - a) / step) + 1
        if (cnt < 3 || cnt > 7) return
        const score = Math.abs(cnt - (want || 5))
        if (!best || score < best.score) best = { lo: a, hi: b, step, cnt, score }
      })
    }
    return best
  }

  /* X 轴标签等距采样。v4 评审 缺陷 3：原来是「偶数位 + 强制最后一个」，
     12 个月时会在 i=10 和 i=11 各贴一个标签，「9月 10月」叠在一起。
     现在按 stride 采样，末点若与上一个采样点太近就替换掉它，保证既等距又有当月。 */
  function xLabelIdx(n) {
    if (n <= 0) return []
    if (n === 1) return [0]
    const stride = Math.max(1, Math.ceil(n / 7))
    const idx = []
    for (let i = 0; i < n; i += stride) idx.push(i)
    if (idx[idx.length - 1] !== n - 1) {
      if (n - 1 - idx[idx.length - 1] < stride) idx[idx.length - 1] = n - 1
      else idx.push(n - 1)
    }
    return idx
  }

  /* 分组柱状图：rows = [{label, income, expense}]（单位：分） */
  function trend(rows) {
    const n = Math.max(rows.length, 1)
    const W = 360
    const H = 200
    const padL = 34
    const padR = 10
    const padT = 12
    const padB = 26
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    let max = 0
    rows.forEach(r => { max = Math.max(max, r.income || 0, r.expense || 0) })
    if (max === 0) max = 10000
    const step = plotW / n
    const bw = Math.min(14, (step - 8) / 2)

    /* Y 轴取整（v4 缺陷 3）：柱子高度按整数轴的顶部算，刻度也是整数。
       最高柱不再正好顶到轴顶（会差一小段），但刻度读得出来 —— 这是专业图表的做法 */
    const sc = niceScale(0, max, 4)
    const axisMax = sc ? sc.hi : max

    let g = ''
    /* 网格线 + Y 轴刻度 */
    if (sc) {
      for (let i = 0; i < sc.cnt; i++) {
        const y = padT + plotH * (i / (sc.cnt - 1))
        /* 同上：取整掉浮点误差，刻度格式才统一 */
        const val = Math.round(axisMax * (1 - i / (sc.cnt - 1)))
        g += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 4" opacity=".5"/>'
        g += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="12" style="fill:var(--sub)">' + shortMoney(val) + '</text>'
      }
    } else {
      for (let i = 0; i <= 3; i++) {
        const y = padT + plotH * (i / 3)
        const val = max * (1 - i / 3)
        g += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 4" opacity=".5"/>'
        g += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="12" style="fill:var(--sub)">' + shortMoney(val) + '</text>'
      }
    }
    rows.forEach((r, i) => {
      const cx = padL + step * i + step / 2
      const hi = plotH * ((r.income || 0) / axisMax)
      const he = plotH * ((r.expense || 0) / axisMax)
      if (r.income) g += '<rect x="' + (cx - bw - 2) + '" y="' + (padT + plotH - hi) + '" width="' + bw + '" height="' + Math.max(hi, 1) + '" rx="3" style="fill:var(--income)" opacity=".85"/>'
      if (r.expense) g += '<rect x="' + (cx + 2) + '" y="' + (padT + plotH - he) + '" width="' + bw + '" height="' + Math.max(he, 1) + '" rx="3" style="fill:var(--expense)" opacity=".85"/>'
      g += '<text x="' + cx + '" y="' + (H - 10) + '" text-anchor="middle" font-size="12" style="fill:var(--sub)">' + r.label + '</text>'
    })
    return svg(W, H, g)
  }

  /* ===================== 饼图配色去重（v4 缺陷 4）=====================
     预设分类里有「两个橙 / 两个粉 / 两个蓝」，老用户库里存的就是旧色板，
     不能靠改预设解决。这里在渲染时按相邻色距去重：离已用颜色太近的，
     换成备用色板里还没用过的第一个颜色。颜色是「分类身份」的一部分，
     所以只换真正撞车的，不重排全部。 */
  const DISTINCT_FALLBACK = ['#2f6bff', '#ff7a45', '#13c2c2', '#9254de', '#f759ab',
    '#73d13d', '#faad14', '#597ef7', '#eb2f96', '#8a93a6', '#d4380d', '#08979c']
  const COLOR_MIN_DIST = 80

  function hexRGB(h) {
    const s = String(h || '').replace('#', '')
    if (s.length !== 6) return [138, 147, 166]
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
  }
  function colorDist(a, b) {
    const A = hexRGB(a), B = hexRGB(b)
    /* 加权欧氏距离：人眼对绿色最敏感、对红色最不敏感 */
    return Math.sqrt(2 * (A[0] - B[0]) ** 2 + 4 * (A[1] - B[1]) ** 2 + 3 * (A[2] - B[2]) ** 2)
  }
  function dedupColors(list, reserved) {
    const used = reserved ? [reserved] : []
    return list.map(c => {
      const near = used.some(u => colorDist(u, c) < COLOR_MIN_DIST)
      if (!near) { used.push(c); return c }
      const alt = DISTINCT_FALLBACK.find(f => used.every(u => colorDist(u, f) >= COLOR_MIN_DIST))
      const out = alt || c
      used.push(out)
      return out
    })
  }

  /* 环形图：items = [{name, value(cents), color, id}]
     v4 缺陷 4：① 超过 8 类时把尾部合并成「其他」—— 原来扇区画全部 14 类、
     图例只列前 8 类，第 9 类起的扇区根本没有对应图例，用户对不上号；
     ② 颜色渲染时去重（见 dedupColors）；
     ③ 点扇区高亮对应图例，反之亦然。 */
  function donut(items) {
    const raw = (items || []).filter(it => (it.value || 0) > 0)
    if (!raw.length) return ''
    const TOP = 8
    let list = raw.slice()
    let other = null
    if (list.length > TOP) {
      const head = list.slice(0, TOP)
      const tail = list.slice(TOP)
      other = {
        name: '其他', id: null,
        value: tail.reduce((s, i) => s + i.value, 0),
        color: '#8a93a6',
        merged: tail.length,
      }
      list = head.concat([other])
    }
    /* 颜色去重：合并出的「其他」固定灰色，把它预留出来不参与替换，
       否则本月「其他」分类自己排进前 8 时，会出现两个一模一样的灰色扇区（实测踩到） */
    const dyn = dedupColors(list.filter(it => it !== other).map(it => it.color || '#8a93a6'), other ? other.color : null)
    let k = 0
    list = list.map(it => (it === other ? it : Object.assign({}, it, { color: dyn[k++] })))

    const total = list.reduce((s, i) => s + i.value, 0) || 1
    const R = 62
    const C = 2 * Math.PI * R
    let offset = 0
    let arcs = ''
    const arcsMeta = []
    list.forEach(it => {
      const frac = it.value / total
      const len = frac * C
      const clickable = it.id != null
      arcs += '<circle class="donut-arc' + (clickable ? ' clickable' : '') + '" data-arc="' + arcsMeta.length + '"' +
        (clickable ? ' data-cat="' + it.id + '" role="button" tabindex="0" title="点击查看该分类明细"' : '') +
        ' cx="90" cy="90" r="' + R + '" fill="none" stroke="' + it.color + '" stroke-width="26" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 90 90)"/>'
      arcsMeta.push(it)
      offset += len
    })
    const center = '<text x="90" y="86" text-anchor="middle" font-size="13" style="fill:var(--sub)">合计</text>' +
      '<text x="90" y="108" text-anchor="middle" font-size="18" font-weight="700" style="fill:var(--text)">' + M(Math.round(total)) + '</text>'
    const chart = '<svg viewBox="0 0 180 180" width="180" height="180" role="img">' + arcs + center + '</svg>'

    /* 图例：一条不漏，且与扇区一一对应。尾部合并后最多 9 行 */
    let legend = ''
    list.forEach((it, i) => {
      const pct = (it.value / total * 100).toFixed(1)
      const clickable = it.id != null
      const sub = it === other && it.merged ? '（' + it.merged + ' 类合并）' : ''
      legend += '<div class="bar-item donut-legend' + (clickable ? ' clickable' : '') + '" data-arc="' + i + '"' +
        (clickable ? ' data-cat="' + it.id + '" role="button" tabindex="0" title="点击查看该分类明细"' : '') + '>' +
        '<span style="width:10px;height:10px;border-radius:3px;background:' + it.color + ';flex:none"></span>' +
        '<span class="grow ellipsis" style="font-size:13.5px">' + window.Fmt.escapeHtml(it.name) + sub + '</span>' +
        '<span class="muted small">' + pct + '%</span>' +
        '<span style="width:84px;text-align:right;font-size:13.5px;font-weight:600" class="num">¥' + window.Fmt.yuan(it.value) + '</span>' +
        '</div>'
    })
    return '<div class="donut-box" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
      '<div style="flex:none">' + chart + '</div>' +
      '<div class="grow" style="min-width:200px;display:flex;flex-direction:column;gap:8px">' + legend + '</div>' +
      '</div>'
  }

  /* 横向条形排行：items = [{name, value, color, sub, id}]
     宽度 = 该分类金额 ÷ 最大值（最长条占满轨道）；填充用分类主题色；
     右端显示金额，悬停显示占比；金额为 0 的不渲染；带 id 的可点击跳转筛选 */
  function barList(items) {
    const list = (items || []).filter(it => (it.value || 0) > 0)
    if (!list.length) return ''
    const max = Math.max(...list.map(i => i.value), 1)
    const total = list.reduce((s, i) => s + i.value, 0) || 1
    const esc = window.Fmt.escapeHtml
    return '<div class="bar-list">' + list.map(it => {
      const w = (it.value / max * 100).toFixed(1)
      const pct = (it.value / total * 100).toFixed(1)
      const color = it.color || '#2f6bff'
      const clickable = it.id != null
      return '<div class="bar-item' + (clickable ? ' clickable' : '') + '"' +
        (clickable ? ' data-cat="' + it.id + '" role="button" tabindex="0"' : '') +
        ' title="' + esc(it.name) + ' · ¥' + M(it.value) + ' · 占比 ' + pct + '%' +
        (clickable ? ' · 点击查看明细' : '') + '">' +
        '<span class="name ellipsis">' + esc(it.name) + '</span>' +
        '<span class="bar-track"><i class="bar-fill" style="width:' + w + '%;background:' + color + '"></i></span>' +
        '<span class="val num">¥' + window.Fmt.yuan(it.value) + '</span>' +
        '</div>'
    }).join('') + '</div>'
  }

  /* 日历热力图：map = {'YYYY-MM-DD': cents}，year 为年份 */
  function heatmap(year, map) {
    const start = new Date(year, 0, 1)
    const end = new Date(year, 11, 31)
    /* 对齐到周日开始，逐周（列）生成，每周 7 天（行） */
    const cols = []
    let cur = new Date(start)
    cur.setDate(cur.getDate() - cur.getDay())
    const max = Math.max(...Object.values(map), 1)
    while (cur <= end || cur.getDay() !== 0) {
      const week = []
      for (let d = 0; d < 7; d++) {
        const key = window.Fmt.dstr(cur)
        const inYear = cur.getFullYear() === year
        const v = inYear ? (map[key] || 0) : 0
        let lv = 0
        if (v > 0) {
          const r = v / max
          lv = r > 0.66 ? 4 : r > 0.4 ? 3 : r > 0.15 ? 2 : 1
        }
        week.push('<i class="' + (lv ? 'l' + lv : '') + (inYear ? '' : ' out') +
          '" title="' + key + ' ¥' + M(v) + '"></i>')
        cur.setDate(cur.getDate() + 1)
      }
      cols.push(week)
      if (cols.length > 60) break
    }
    const cells = cols.map(week => week.join(''))
    return '<div id="heatScroll" style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px">' +
      '<div class="heat-map" style="min-width:' + (cols.length * 15) + 'px">' +
      cells.join('') + '</div></div>' +
      /* 图例色块用类名而非内联色：深色主题下需要整体换一套色阶 */
      '<div class="row small muted heat-legend" style="margin-top:8px;justify-content:flex-end">少 ' +
      [0, 1, 2, 3, 4].map(l => '<i class="hl l' + l + '"></i>').join('') +
      ' 多</div>'
  }

  /* 单系列折线图：points = [{label, value(cents)}]，可正可负 */
  function line(points) {
    const n = Math.max(points.length, 1)
    const W = 360
    const H = 190
    const padL = 38
    const padR = 12
    const padT = 14
    const padB = 26
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    let min = Infinity
    let max = -Infinity
    points.forEach(p => { min = Math.min(min, p.value); max = Math.max(max, p.value) })
    if (!isFinite(min)) { min = 0; max = 100 }
    if (min === max) {
      /* 全零（无数据）时给一个 0~100 元的空轴，避免刻度全是 0 */
      if (min === 0) { min = 0; max = 10000 }
      else { const d = Math.abs(min) * 0.5 || 100; min -= d; max += d }
    }
    const span = max - min
    const pad = span * 0.08
    /* 全为正数（如净资产）时下界不跌破 0，否则会出现 -756 这类无意义的负刻度 */
    min = min >= 0 ? Math.max(0, min - pad) : min - pad
    max = max <= 0 ? Math.min(0, max + pad) : max + pad
    const x = i => padL + plotW * (n === 1 ? 0.5 : i / (n - 1))
    /* Y 轴取整（v4 缺陷 3）：刻度改用整数轴。原来按 min/max 三等分，
       净资产会给出 1.6 / 1.8 / 2.1 / 2.3 万这种间距不均的刻度 */
    const sc = niceScale(min, max, 5)
    const lo = sc ? sc.lo : min
    const hi = sc ? sc.hi : max
    const yTicks = sc ? sc.cnt : 4
    const y = v => padT + plotH * (1 - (v - lo) / (hi - lo))

    let g = ''
    for (let i = 0; i < yTicks; i++) {
      /* 必须取整：lo + (hi-lo)*(1-i/(n-1)) 有浮点误差，2,500,000.0000000005
         会让 shortMoney 的 `v % 10000 === 0` 判断失效，同一根轴上出现
         「1250万」和「250.0万」两种格式（v4 实测） */
      const v = Math.round(lo + (hi - lo) * (1 - i / (yTicks - 1)))
      const yy = padT + plotH * (i / (yTicks - 1))
      g += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 4" opacity=".5"/>'
      g += '<text x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="12" style="fill:var(--sub)">¥' + shortMoney(v) + '</text>'
    }
    /* 零轴 */
    if (lo < 0 && hi > 0) {
      g += '<line x1="' + padL + '" y1="' + y(0) + '" x2="' + (W - padR) + '" y2="' + y(0) + '" style="stroke:var(--line)" stroke-width="1.2"/>'
    }
    const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ')
    /* 渐变填充 */
    g += '<defs><linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--brand)" stop-opacity=".22"/><stop offset="1" style="stop-color:var(--brand)" stop-opacity="0"/></linearGradient></defs>'
    g += '<path d="' + path + ' L' + x(n - 1).toFixed(1) + ' ' + y(lo).toFixed(1) + ' L' + x(0).toFixed(1) + ' ' + y(lo).toFixed(1) + ' Z" fill="url(#lineFill)"/>'
    g += '<path d="' + path + '" fill="none" style="stroke:var(--brand)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'
    /* X 轴标签等距采样，末两月不再挤在一起（v4 缺陷 3） */
    const show = xLabelIdx(n)
    points.forEach((p, i) => {
      g += '<circle cx="' + x(i) + '" cy="' + y(p.value) + '" r="3.2" fill="#fff" style="stroke:var(--brand)" stroke-width="2"><title>' + p.label + ' ¥' + window.Fmt.yuan(p.value) + '</title></circle>'
      if (show.indexOf(i) >= 0) {
        g += '<text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="12" style="fill:var(--sub)">' + p.label + '</text>'
      }
    })
    return svg(W, H, g)
  }

  /* 资金流向图（桑基式）：flow = { left:[{key,name,color,value}], right:[{key,name,color,value}], links:[{l,r,value}] }（value 单位：分） */
  function sankey(flow) {
    const L = flow.left || []
    const R = flow.right || []
    const links = flow.links || []
    if (!L.length || !R.length || !links.length) return ''
    let total = 0
    L.forEach(n => { total += n.value })
    if (total <= 0) return ''
    const esc = window.Fmt.escapeHtml
    const W = 560
    const padT = 12
    const padB = 12
    const gap = 10
    const leftX = 100
    const leftW = 16
    const rightX = W - 130
    const rightW = 16
    const H = Math.max(240, Math.max(L.length, R.length) * 34 + 24)
    const plotH = H - padT - padB
    const scale = plotH / total

    let yL = padT
    const Lpos = L.map(n => {
      const h = Math.max(3, n.value * scale)
      const o = { n, y: yL, h, cur: yL }
      yL += h + gap
      return o
    })
    let yR = padT
    const Rpos = R.map(n => {
      const h = Math.max(3, n.value * scale)
      const o = { n, y: yR, h, cur: yR }
      yR += h + gap
      return o
    })
    const Lmap = {}
    const Rmap = {}
    Lpos.forEach(p => { Lmap[p.n.key] = p })
    Rpos.forEach(p => { Rmap[p.n.key] = p })

    let g = ''
    links.forEach(lk => {
      const lp = Lmap[lk.l]
      const rp = Rmap[lk.r]
      if (!lp || !rp) return
      const w = Math.max(1, lk.value * scale)
      const sy = lp.cur + w / 2
      const ey = rp.cur + w / 2
      lp.cur += w
      rp.cur += w
      const x1 = leftX + leftW
      const x2 = rightX
      const cx = (x1 + x2) / 2
      g += '<path d="M' + x1 + ' ' + sy + ' C ' + cx + ' ' + sy + ', ' + cx + ' ' + ey + ', ' + x2 + ' ' + ey +
        '" fill="none" stroke="' + (lp.n.color || '#2f6bff') + '" stroke-width="' + w.toFixed(1) + '" opacity="0.30">' +
        '<title>' + esc(lp.n.name) + ' → ' + esc(rp.n.name) + ' ¥' + M(lk.value) + '</title></path>'
    })
    Lpos.forEach(p => {
      g += '<rect x="' + leftX + '" y="' + p.y.toFixed(1) + '" width="' + leftW + '" height="' + p.h.toFixed(1) + '" rx="3" fill="' + (p.n.color || '#2f6bff') + '"/>'
      g += '<text x="' + (leftX - 7) + '" y="' + (p.y + p.h / 2 + 4).toFixed(1) + '" text-anchor="end" font-size="11.5" style="fill:var(--text)">' + esc(p.n.name) + '</text>'
    })
    Rpos.forEach(p => {
      g += '<rect x="' + rightX + '" y="' + p.y.toFixed(1) + '" width="' + rightW + '" height="' + p.h.toFixed(1) + '" rx="3" fill="' + (p.n.color || '#e5484d') + '"/>'
      g += '<text x="' + (rightX + rightW + 7) + '" y="' + (p.y + p.h / 2 + 4).toFixed(1) + '" text-anchor="start" font-size="11.5" style="fill:var(--text)">' + esc(p.n.name) + '</text>'
    })
    return svg(W, H, g)
  }

  return { trend, donut, barList, heatmap, line, sankey }
})()
