/* 管理类面板（懒加载模块）
 * ------------------------------------------------------------------
 * 分类管理 / 账户管理 / 回收站 / 周期记账 / 汇率设置 / 界面配色，
 * 都是从「我的」里点进去才用的低频面板，合计约 12KB 源码。
 * 放首屏会白占 gzip 预算（硬线 158720B），因此搬到懒加载模块；
 * Service Worker 已预缓存，断网也能打开。
 * ------------------------------------------------------------------ */
;(function () {
  'use strict'
  const F = window.Fmt
  const U = window.UI
  const S = window.DB
  const $ = U.$
  const $$ = U.$$
  const esc = F.escapeHtml
  const openSheet = U.openSheet
  const closeSheet = U.closeSheet
  const toast = U.toast

  const FREQ_LABEL = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' }

  /* 内部 id 可能是自增数字（游客）也可能是服务端返回的数字字符串，
     统一成「纯数字就转 Number」再回传，避免 eq('id','12') 与 eq('id',12) 两种写法 */
  function idOf(v) { return /^\d+$/.test(String(v)) ? Number(v) : v }

  function openCategoryManager() {
    const kinds = ['expense', 'income']
    let html = '<div class="sheet-head"><span class="sheet-title">分类管理</span><button id="catClose" class="btn sm line">关闭</button></div>'
    html += '<div class="small muted" style="margin-bottom:10px">点任意分类可改名、换图标或删除。</div>'
    kinds.forEach(k => {
      html += '<div class="field"><label>' + (k === 'expense' ? '支出' : '收入') + '</label><div style="display:flex;flex-wrap:wrap;gap:6px">'
      const roots = S.rootCategories(k)
      if (!roots.length) html += '<span class="small muted">还没有分类</span>'
      roots.forEach(p => {
        html += '<button type="button" class="chip" data-cat="' + p.id + '" style="background:' + (p.color || '#8a93a6') + '1f;border:0">' +
          esc(p.icon || '') + ' ' + esc(p.name) + '</button>'
        S.childCategories(p.id).forEach(c => {
          html += '<button type="button" class="chip" data-cat="' + c.id + '" style="opacity:.75;border:0">' + esc(c.name) + '</button>'
        })
      })
      html += '</div></div>'
    })
    html += '<div class="field"><label>新增顶级分类</label>' +
      '<div class="row"><select id="newCatKind" class="select" style="width:96px;flex:none"><option value="expense">支出</option><option value="income">收入</option></select>' +
      '<input id="newCatName" class="input grow" placeholder="分类名，如「宠物」" maxlength="12">' +
      '<input id="newCatIcon" class="input" style="width:64px;flex:none" value="📦" maxlength="4"></div></div>' +
      '<div class="err" id="catErr"></div>' +
      '<button class="btn block" id="newCatSave">添加分类</button>'
    openSheet(html)
    $('#catClose').addEventListener('click', closeSheet)
    $$('[data-cat]', $('#sheet')).forEach(b => {
      b.addEventListener('click', () => openCategoryEditor(b.getAttribute('data-cat')))
    })
    $('#newCatSave').addEventListener('click', async () => {
      const name = $('#newCatName').value.trim()
      if (!name) { $('#catErr').textContent = '请填写分类名'; return }
      try {
        await S.addCategory({
          name, kind: $('#newCatKind').value, icon: $('#newCatIcon').value.trim() || '📦',
          color: '#8a93a6', sort_order: 99,
        })
        toast('已添加')
        openCategoryManager()
        window.App.refresh()
      } catch (e) { $('#catErr').textContent = '添加失败' }
    })
  }

  /* 单个分类编辑（B1）：改名 / 换图标 / 换色 / 删除。
     删除前先把「会影响几笔账目」算出来告诉用户 —— 分类删掉后账目还在，
     只是分类变空，这个预期必须提前说清，否则用户会以为账也一起删了。 */
  async function openCategoryEditor(id) {
    const c = S.category(idOf(id))
    if (!c) { toast('分类不存在，请刷新后重试'); return }
    let used = 0
    try {
      const r = await S.listTransactions({ categoryId: c.id, limit: 1 })
      used = Number(r && r.total) || 0
    } catch (e) { /* 统计失败不影响编辑 */ }
    const kids = S.childCategories(c.id).length
    const root = !c.parent_id
    let html = '<div class="sheet-head"><span class="sheet-title">编辑分类</span><button id="ceClose" class="btn sm line">关闭</button></div>'
    html += '<div class="field"><label for="ceName">分类名称</label>' +
      '<input id="ceName" class="input" maxlength="12" value="' + esc(c.name) + '"></div>'
    html += '<div class="row" style="gap:8px">' +
      '<div class="field grow" style="margin-top:0"><label for="ceIcon">图标</label>' +
      '<input id="ceIcon" class="input" maxlength="4" value="' + esc(c.icon || '📦') + '"></div>' +
      '<div class="field" style="width:96px;flex:none;margin-top:0"><label for="ceColor">颜色</label>' +
      '<input id="ceColor" class="input" type="color" value="' + (c.color || '#8a93a6') + '" style="padding:2px;height:42px"></div></div>'
    html += '<div class="err" id="ceErr"></div>'
    html += '<button class="btn block" id="ceSave">保存修改</button>'
    if (root) html += '<div class="divider">危险操作</div><button class="btn block danger" id="ceDel">删除这个分类</button>'
    html += '<div class="hint">' +
      (used ? '已有 ' + used + ' 笔账目用了这个分类。删除后这些账目的分类会变成「未分类」，账目本身与金额都不受影响。' : '暂时没有账目使用这个分类。') +
      (kids ? ' 它下面还有 ' + kids + ' 个子分类，需要先删掉子分类。' : '') +
      '</div>'
    openSheet(html)
    $('#ceClose').addEventListener('click', closeSheet)
    $('#ceSave').addEventListener('click', async () => {
      const name = $('#ceName').value.trim()
      if (!name) { $('#ceErr').textContent = '请填写分类名'; return }
      const btn = $('#ceSave')
      btn.disabled = true
      try {
        await S.updateCategory(c.id, { name: name, icon: $('#ceIcon').value.trim() || '📦', color: $('#ceColor').value })
        toast('已保存')
        openCategoryManager()
        window.App.refresh()
      } catch (e) {
        $('#ceErr').textContent = '保存失败：' + (e && e.message ? e.message : '请重试')
        btn.disabled = false
      }
    })
    const del = $('#ceDel')
    if (del) del.addEventListener('click', async () => {
      if (kids) { toast('请先删除它下面的 ' + kids + ' 个子分类'); return }
      const msg = used
        ? '删除后这 ' + used + ' 笔账目的分类会变成「未分类」，账目不会丢。确定删除？'
        : '确定删除这个分类？'
      if (!(await confirmSheet({ title: '删除分类', danger: true, okText: '删除', body: msg }))) return
      del.disabled = true
      try {
        await S.deleteCategory(c.id)
        toast('已删除')
        openCategoryManager()
        window.App.refresh()
      } catch (e) {
        toast('删除失败：' + (e && e.message ? e.message : '请重试'))
        del.disabled = false
      }
    })
  }

  function openAccountManager() {
    const base = F.baseCurrency()
    const list = S.allAccounts()
    let html = '<div class="sheet-head"><span class="sheet-title">账户管理</span><button id="amClose" class="btn sm line">关闭</button></div>'
    if (list.length) {
      html += '<div class="field" style="margin:0 0 10px"><label>各账户</label>' +
        '<div class="small muted">点账户可改名、改期初余额；金额按账户币种保存，总资产按「汇率设置」折算成 ' + base + '。</div></div>'
    }
    html += list.map(a => {
      const cur = a.currency || 'CNY'
      return '<div class="list-item"><button type="button" class="ico" data-acc="' + a.id + '" style="border:0;background:none;cursor:pointer">' + esc(a.icon || '💰') + '</button>' +
      '<div class="grow" data-acc="' + a.id + '" style="cursor:pointer"><div>' + esc(a.name) + '</div><div class="small muted">期初 ' +
        F.moneySym(F.toCents(a.initial_balance), F.currencySym(cur)) + ' · ' + cur + '</div></div>' +
      '<button class="btn sm line" data-acc="' + a.id + '" style="flex:none">编辑</button>' +
      '<button class="btn sm danger" data-del="' + a.id + '" style="flex:none;margin-left:4px">删除</button></div>'
    }).join('') || '<div class="small muted">暂无账户</div>'
    html += '<div class="hint">删除账户不会删除已有账目。修改币种不会换算历史金额，仅改变后续统计的折算口径。</div>'
    openSheet(html)
    $('#amClose').addEventListener('click', closeSheet)
    $$('[data-acc]', $('#sheet')).forEach(el => {
      el.addEventListener('click', () => openAccountEditor(el.getAttribute('data-acc')))
    })
    $$('[data-del]', $('#sheet')).forEach(b => {
      b.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '删除账户', danger: true, okText: '删除', body: '确定删除该账户？已记录的账目不会被删除。' }))) return
        try {
          await S.deleteAccount(idOf(b.getAttribute('data-del')))
          toast('已删除')
          openAccountManager()
          window.App.refresh()
        } catch (e) { toast('删除失败：' + (e && e.message ? e.message : '请重试')) }
      })
    })
  }

  /* 账户编辑（B1）：名称 / 期初余额 / 币种。
     期初余额以前完全改不了，只能删了重建 —— 而删账户会把历史账目变成「无账户」。 */
  function openAccountEditor(id) {
    const a = S.allAccounts().find(x => String(x.id) === String(id))
    if (!a) { toast('账户不存在，请刷新后重试'); return }
    const cur = a.currency || 'CNY'
    let html = '<div class="sheet-head"><span class="sheet-title">编辑账户</span><button id="aeClose" class="btn sm line">关闭</button></div>'
    html += '<div class="field"><label for="aeName">账户名称</label>' +
      '<input id="aeName" class="input" maxlength="12" value="' + esc(a.name) + '"></div>'
    html += '<div class="row" style="gap:8px">' +
      '<div class="field grow" style="margin-top:0"><label for="aeInit">期初余额（' + esc(cur) + '）</label>' +
      '<input id="aeInit" class="input" inputmode="decimal" value="' + esc(String(F.yuan(F.toCents(a.initial_balance)))) + '"></div>' +
      '<div class="field" style="width:110px;flex:none;margin-top:0"><label for="aeCur">币种</label>' +
      '<select id="aeCur" class="select">' +
      F.CURRENCIES.map(c => '<option value="' + c.code + '"' + (c.code === cur ? ' selected' : '') + '>' + c.code + '</option>').join('') +
      '</select></div></div>'
    html += '<div class="field"><label for="aeIcon">图标</label>' +
      '<input id="aeIcon" class="input" maxlength="4" value="' + esc(a.icon || '💰') + '"></div>'
    html += '<div class="err" id="aeErr"></div><button class="btn block" id="aeSave">保存修改</button>'
    html += '<div class="hint">期初余额是「开始记账时这个账户里已有的钱」，改了会直接改变总资产与净资产曲线，不会生成账目。</div>'
    openSheet(html)
    $('#aeClose').addEventListener('click', closeSheet)
    $('#aeSave').addEventListener('click', async () => {
      const name = $('#aeName').value.trim()
      if (!name) { $('#aeErr').textContent = '请填写账户名'; return }
      const initRaw = $('#aeInit').value.trim()
      if (initRaw && !/^-?\d*(\.\d{0,2})?$/.test(initRaw)) { $('#aeErr').textContent = '期初余额最多两位小数'; return }
      const btn = $('#aeSave')
      btn.disabled = true
      try {
        await S.updateAccount(a.id, {
          name: name,
          icon: $('#aeIcon').value.trim() || '💰',
          initial_balance: F.yuan(F.toCents(Number(initRaw || 0))),
          currency: $('#aeCur').value,
        })
        toast('已保存')
        openAccountManager()
        window.App.refresh()
      } catch (e) {
        $('#aeErr').textContent = '保存失败：' + (e && e.message ? e.message : '请重试')
        btn.disabled = false
      }
    })
  }

  async function openTrash() {
    const { rows } = await S.listTransactions({ includeDeleted: 'deleted', limit: 100000 }).catch(() => ({ rows: [] }))
    let html = '<div class="sheet-head"><span class="sheet-title">回收站</span><button id="trashClose" class="btn sm line">关闭</button></div>'
    if (!rows.length) {
      html += '<div class="empty" style="padding:24px"><div class="big">' + ic('trash') + '</div><div>回收站是空的</div><div class="small" style="margin-top:6px">删除的账目会先到这里，可恢复或彻底删除</div></div>'
    } else {
      html += rows.map(t => {
        const cat = t.category_id ? S.categoryName(t.category_id) : (t.txn_type === 'transfer' ? '转账' : '')
        return '<div class="list-item" data-trash="' + t.id + '">' +
          '<div class="ico">' + (t.txn_type === 'income' ? '💰' : t.txn_type === 'transfer' ? '' + ic('refresh') + '' : '' + ic('receipt') + '') + '</div>' +
          '<div class="grow"><div>' + (cat ? esc(cat) + ' · ' : '') + F.money(F.toCents(t.amount)) + '</div>' +
          '<div class="small muted">' + esc(t.note || '') + ' · ' + F.humanDay(t.occurred_at) + '</div></div>' +
          '<button class="btn sm" data-restore="' + t.id + '">恢复</button>' +
          '<button class="btn sm danger" data-purge="' + t.id + '" style="margin-left:4px">彻底删</button></div>'
      }).join('')
    }
    openSheet(html)
    $('#trashClose').addEventListener('click', closeSheet)
    $$('#sheet [data-restore]').forEach(b => {
      b.addEventListener('click', async () => {
        await S.restoreTransaction(Number(b.getAttribute('data-restore')))
        toast('已恢复')
        openTrash()
        window.App.refresh()
      })
    })
    $$('#sheet [data-purge]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '彻底删除', danger: true, okText: '彻底删除', body: '彻底删除后无法恢复，确定？' }))) return
        await S.purgeTransaction(Number(b.getAttribute('data-purge')))
        toast('已彻底删除')
        openTrash()
        window.App.refresh()
      })
    })
  }

  /* 周期账单：按「下次到期」排的到期视图（Firefly recurring / Actual schedules）。
     以前只有一张平铺列表，用户看不到「下个月房租几号扣」，也没法补记或跳过某一期。 */
  async function openRecurringManager() {
    const rules = await S.listRecurring()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const items = rules.map(r => {
      const due = F.nextDue(r.last_run_date || null, String(r.start_date).slice(0, 10), r.freq)
      const days = due ? Math.round((new Date(due + 'T00:00:00') - today) / 86400000) : 9999
      return { r: r, due: due, days: days }
    }).sort((a, b) => a.days - b.days)

    const dueText = it => {
      if (!it.due) return '未排期'
      if (it.days < 0) return it.due.slice(5) + '（逾期 ' + Math.abs(it.days) + ' 天）'
      if (it.days === 0) return '今天到期'
      if (it.days === 1) return '明天到期'
      return it.due.slice(5) + '（' + it.days + ' 天后）'
    }
    const rowHtml = it => {
      const r = it.r
      const name = r.note || (r.category_id ? S.categoryName(r.category_id) : window.TXN_TYPE_LABEL[r.txn_type] || '周期账目')
      const late = it.days < 0
      return '<div class="list-item" style="flex-wrap:wrap;align-items:flex-start">' +
        '<div class="ico">' + (r.txn_type === 'income' ? '💰' : ic('repeat')) + '</div>' +
        '<div class="grow" style="min-width:0"><div class="ellipsis">' + esc(name) + (r.active ? '' : ' <span class="tiny muted">已暂停</span>') + '</div>' +
        '<div class="small ' + (late ? '' : 'muted') + '"' + (late ? ' style="color:var(--expense)"' : '') + '>' +
        (FREQ_LABEL[r.freq] || r.freq) + ' · ' + esc(dueText(it)) + '</div></div>' +
        '<div class="num" style="font-weight:700;flex:none">¥' + F.yuan(F.toCents(r.amount)) + '</div>' +
        '<div class="row" style="gap:4px;margin-top:6px;flex-basis:100%">' +
        '<button class="btn sm line" data-post="' + r.id + '">补记本期</button>' +
        '<button class="btn sm line" data-skip="' + r.id + '">跳过本期</button>' +
        '<button class="btn sm line" data-toggle="' + r.id + '">' + (r.active ? '停用' : '启用') + '</button>' +
        '<button class="btn sm danger" data-rdel="' + r.id + '">删</button>' +
        '</div></div>'
    }
    const group = (title, list) => list.length
      ? '<div class="divider">' + title + '（' + list.length + '）</div>' + list.map(rowHtml).join('')
      : ''

    let html = '<div class="sheet-head"><span class="sheet-title">周期账单</span><button id="recClose" class="btn sm line">关闭</button></div>'
    if (!rules.length) {
      html += '<div class="empty" style="padding:24px"><div class="big">' + ic('repeat') + '</div><div>还没有周期规则</div>' +
        '<div class="small" style="margin-top:6px">记一笔时选择「周期」，房租 / 话费 / 会员就会按期自动补记</div></div>'
    } else {
      const late = items.filter(x => x.days < 0 && x.r.active)
      const soon = items.filter(x => x.days >= 0 && x.days <= 7 && x.r.active)
      const month = items.filter(x => x.days > 7 && x.days <= 30 && x.r.active)
      const rest = items.filter(x => x.days > 30 || !x.r.active)
      const monthly = items.filter(x => x.r.active && x.r.txn_type === 'expense')
        .reduce((s, x) => s + F.toCents(x.r.amount), 0)
      html += '<div class="card" style="box-shadow:none;background:var(--brand-soft)">' +
        '<div class="small muted">在用的周期支出合计</div>' +
        '<div class="num" style="font-size:24px;font-weight:800">¥' + F.yuan(monthly) + '</div>' +
        '<div class="tiny muted">按月计；按「下次到期」排序，到期后打开应用会自动补记</div></div>' +
        group('已到期未补记', late) + group('未来 7 天', soon) +
        group('8–30 天', month) + group('更远 / 已暂停', rest)
    }
    openSheet(html)
    $('#recClose').addEventListener('click', closeSheet)

    const byId = id => rules.find(x => x.id === Number(id))
    $$('#sheet [data-post]').forEach(b => {
      b.addEventListener('click', async () => {
        const it = items.find(x => x.r.id === Number(b.getAttribute('data-post')))
        if (!it || !it.due) return
        const r = it.r
        b.disabled = true
        try {
          const d = new Date(it.due + 'T12:00:00')
          await S.addTransaction({
            txn_type: r.txn_type, amount: Number(r.amount), occurred_at: F.iso(d),
            account_id: r.account_id, to_account_id: r.to_account_id, category_id: r.category_id,
            note: r.note || '', tags: (Array.isArray(r.tags) ? r.tags.slice() : []).concat('auto'),
            reimbursable: !!r.reimbursable, book_id: r.book_id,
          })
          await S.updateRecurring(r.id, { last_run_date: it.due })
          toast('已补记 ' + it.due.slice(5) + ' 这一期')
          await openRecurringManager()
          window.App.refresh()
        } catch (e) { toast('补记失败：' + (e.message || '请重试')); b.disabled = false }
      })
    })
    $$('#sheet [data-skip]').forEach(b => {
      b.addEventListener('click', async () => {
        const it = items.find(x => x.r.id === Number(b.getAttribute('data-skip')))
        if (!it || !it.due) return
        if (!(await confirmSheet({ title: '跳过这一期', okText: '跳过', body: '跳过 ' + it.due.slice(5) + ' 这一期？之后仍按周期继续。' }))) return
        b.disabled = true
        try {
          await S.updateRecurring(it.r.id, { last_run_date: it.due })
          toast('已跳过这一期')
          await openRecurringManager()
        } catch (e) { toast('操作失败'); b.disabled = false }
      })
    })
    $$('#sheet [data-toggle]').forEach(b => {
      b.addEventListener('click', async () => {
        const r = byId(b.getAttribute('data-toggle'))
        if (!r) return
        await S.updateRecurring(r.id, { active: !r.active })
        openRecurringManager()
      })
    })
    $$('#sheet [data-rdel]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: '删除周期规则', danger: true, okText: '删除', body: '删除该规则？已生成的账目不受影响' }))) return
        await S.deleteRecurring(Number(b.getAttribute('data-rdel')))
        openRecurringManager()
      })
    })
  }

  function openFxSettings() {
    const base = F.baseCurrency()
    const rates = F.fxRates()
    const rows = F.CURRENCIES.filter(c => c.code !== 'CNY').map(c =>
      '<div class="row" style="gap:10px;margin-bottom:8px;align-items:center">' +
      '<span class="grow small">' + c.code + ' <span class="muted">' + esc(c.name) + '</span></span>' +
      '<input class="input num" style="width:112px;flex:none;text-align:right" type="number" step="0.0001" min="0" ' +
      'data-fx="' + c.code + '" value="' + (rates[c.code] != null ? rates[c.code] : '') + '">' +
      '<span class="tiny muted" style="flex:none">CNY</span></div>').join('')

    openSheet(
      '<div class="sheet-head"><span class="sheet-title">汇率设置</span><button id="fxClose" class="btn sm line">关闭</button></div>' +
      '<div class="card">' +
      '<div class="field" style="margin:0"><label>基准币种</label>' +
      '<select id="fxBase" class="select">' +
      F.CURRENCIES.map(c => '<option value="' + c.code + '"' + (c.code === base ? ' selected' : '') + '>' +
        c.code + ' · ' + c.name + '</option>').join('') +
      '</select></div>' +
      '<div class="small muted" style="margin-top:8px">所有账户的余额与净资产都会折算成基准币种显示。</div>' +
      '</div>' +
      '<div class="card"><div class="between" style="margin-bottom:8px"><b>汇率</b>' +
      '<span class="tiny muted">1 单位外币 = ? 人民币</span></div>' +
      rows +
      '<div class="small muted" style="margin-top:4px">留空或填 0 表示恢复默认值。汇率只存在本机，不会上传。</div></div>' +
      '<button class="btn block" id="fxSave">保存汇率</button>' +
      '<button class="btn line block" id="fxFetch" style="margin-top:8px">从网络更新汇率</button>' +
      '<div class="small muted" style="margin-top:6px" id="fxAt">' + fxAtText() + '</div>' +
      '<button class="btn line block" id="fxReset" style="margin-top:8px">恢复默认汇率</button>' +
      '<div class="hint">汇率只存在本机，不会上传。设置后，外币账户的余额、净资产趋势、收支与分类统计都会折算成基准币种后再汇总；账户列表里仍显示原币种金额。</div>'
    )
    $('#fxClose').addEventListener('click', closeSheet)
    $('#fxSave').addEventListener('click', () => {
      F.setBaseCurrency($('#fxBase').value)
      $$('#sheet [data-fx]').forEach(inp => {
        const v = inp.value.trim()
        F.setFxRate(inp.getAttribute('data-fx'), v === '' ? 0 : Number(v))
      })
      closeSheet()
      toast('汇率已保存')
      window.App.renderTab()
    })
    $('#fxReset').addEventListener('click', () => {
      F.resetFxRates()
      closeSheet()
      toast('已恢复默认汇率')
      window.App.renderTab()
    })
    /* 在线汇率（D4）：点一下就从公开汇率服务拉一次。
       按钮本身就是同意动作，因此不再叠一层确认弹层 —— 这一层是 sheet，
       再弹确认会把汇率面板顶掉，用户还得重新打开。
       失败一律只提示、不动已有汇率：记账不能因为第三方接口挂了而不可用。 */
    $('#fxFetch').addEventListener('click', async () => {
      const btn = $('#fxFetch')
      if (!btn || btn.disabled) return
      const label = btn.textContent
      btn.disabled = true
      btn.textContent = '正在获取…'
      try {
        const pack = await F.fetchRates()
        F.applyRates(pack)
        closeSheet()
        toast('汇率已按最新行情更新')
        window.App.renderTab()
        openFxSettings()
      } catch (e) {
        btn.disabled = false
        btn.textContent = label
        toast((e && e.message) ? e.message : '更新失败，请稍后再试')
      }
    })
  }

  /* 上次联机更新的时间；没更新过就说明当前用的是手填值 */
  function fxAtText() {
    const at = F.fxUpdatedAt ? F.fxUpdatedAt() : ''
    if (!at) return '当前为手动汇率，尚未联机更新过'
    let t = at
    try { t = F.dtstr(new Date(at)) } catch (e) { t = at }
    return '上次联机更新：' + t + '（向 open.er-api.com 请求，不发送账目数据）'
  }

  function openUiSettings() {
    const u = window.App.uiSettings()
    const chip = (group, v, label, on) =>
      '<button class="chip' + (on ? ' on' : '') + '" data-ui-' + group + '="' + v + '">' + label + '</button>'
    const homeOn = key => { try { return localStorage.getItem('ledger10_home_' + key) !== 'off' } catch (e) { return true } }
    const homeChip = (key, label) =>
      '<button class="chip' + (homeOn(key) ? ' on' : '') + '" data-home="' + key + '">' + label + (homeOn(key) ? ' · 显示' : ' · 隐藏') + '</button>'
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">界面与配色</span><button id="uiClose" class="btn sm line">关闭</button></div>' +
      '<div class="field"><label>字号大小</label><div class="chips">' +
      chip('scale', 'compact', '小 · 一屏看更多', u.scale === 'compact') +
      chip('scale', 'normal', '标准', u.scale === 'normal') +
      chip('scale', 'large', '大 · 看得更清楚', u.scale === 'large') +
      '</div></div>' +
      '<div class="field"><label>支出 / 收入配色</label><div class="chips">' +
      chip('palette', 'bright', '标准（红出绿进）', u.palette === 'bright') +
      chip('palette', 'colorblind', '色盲友好（蓝出橙进）', u.palette === 'colorblind') +
      '</div><div class="small muted" style="margin-top:6px">标准配色沿用国内习惯：支出红、收入绿。色盲友好模式改用蓝 / 橙，靠明暗而非红绿区分。</div></div>' +
      /* 首页卡片可定制：明细页顶部那两块，不是每个人都要 */
      '<div class="field"><label>首页显示</label><div class="chips">' +
      homeChip('quick', '快捷记账条') +
      homeChip('budget', '预算卡') +
      '</div><div class="small muted" style="margin-top:6px">关掉后明细页更清爽，功能入口在「记一笔」和统计页里都还在。</div></div>' +
      '<div class="hint">设置只影响本机显示，不会改动任何账目数据</div>'
    )
    const c = $('#uiClose')
    if (c) c.addEventListener('click', closeSheet)
    $$('#sheet [data-ui-scale]').forEach(b => b.addEventListener('click', () => {
      window.App.setUiSettings({ scale: b.getAttribute('data-ui-scale') })
      openUiSettings()
    }))
    $$('#sheet [data-ui-palette]').forEach(b => b.addEventListener('click', () => {
      window.App.setUiSettings({ palette: b.getAttribute('data-ui-palette') })
      openUiSettings()
    }))
    $$('#sheet [data-home]').forEach(b => b.addEventListener('click', () => {
      const key = 'ledger10_home_' + b.getAttribute('data-home')
      try {
        if (homeOn(b.getAttribute('data-home'))) localStorage.setItem(key, 'off')
        else localStorage.removeItem(key)
      } catch (e) { /* 忽略 */ }
      openUiSettings()
      window.App.refresh()
    }))
  }
  function openBookSheet() {
    const ic = window.ic || function () { return '' }
    const books = S.books()
    const active = S.activeBookId()
    let html = '<div class="sheet-head"><span class="sheet-title">账本管理</span><button id="bkClose" class="btn sm line">关闭</button></div>'
    html += '<div class="list-item" data-book="" style="cursor:pointer">' +
      '<div class="ico">' + ic('globe') + '</div><div class="grow"><div>全部账本</div><div class="small muted">合并查看所有账目</div></div>' +
      (active == null ? '<span style="color:var(--brand)">' + ic('check') + '</span>' : '') + '</div>'
    html += books.map(b =>
      '<div class="list-item" data-book="' + b.id + '" style="cursor:pointer">' +
      '<div class="ico">' + esc(b.icon || '📒') + '</div><div class="grow"><div>' + esc(b.name) + '</div></div>' +
      (active === b.id ? '<span style="color:var(--brand)">' + ic('check') + '</span>' : '') +
      (books.length > 1 ? '<button class="btn sm danger" data-bkdel="' + b.id + '" style="margin-left:6px">删</button>' : '') +
      '</div>').join('')
    html += '<div class="field" style="margin-top:10px"><label>新建账本（如：旅行、装修、恋爱）</label>' +
      '<div class="row"><input id="bkIcon" class="input" style="width:60px;flex:none" value="📒" maxlength="4">' +
      '<input id="bkName" class="input grow" placeholder="账本名称" maxlength="12">' +
      '<button class="btn" id="bkAdd" style="flex:none">创建</button></div></div>' +
      '<div class="hint">账户与分类所有账本共用；账目、预算、周期、攒钱目标按账本分开</div>'
    openSheet(html)
    $('#bkClose').addEventListener('click', closeSheet)
    $$('#sheet [data-book]').forEach(el => {
      el.addEventListener('click', async (ev) => {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-bkdel')) return
        const v = el.getAttribute('data-book')
        S.setActiveBook(v ? Number(v) : null)
        closeSheet()
        window.App.refresh()
      })
    })
    $$('#sheet [data-bkdel]').forEach(b => {
      b.addEventListener('click', async () => {
        const id = Number(b.getAttribute('data-bkdel'))
        if (!(await confirmSheet({ title: '删除账本', danger: true, okText: '删除', body: '删除该账本？其中的账目/预算/周期会转移到另一个账本，不会丢失' }))) return
        try {
          await S.deleteBook(id)
          toast('账本已删除，数据已转移')
          openBookSheet()
          window.App.refresh()
        } catch (e) { toast(e.message || '删除失败') }
      })
    })
    $('#bkAdd').addEventListener('click', async () => {
      const name = $('#bkName').value.trim()
      if (!name) { toast('请填写账本名称'); return }
      await S.addBook({ name, icon: $('#bkIcon').value.trim() || '📒', sort_order: S.books().length })
      toast('账本已创建')
      openBookSheet()
    })
  }

  /* ---------- 应用锁（本机 PIN） ---------- */
  function openLockSettings() {
    const ic = window.ic || function () { return '' }
    const cfg = window.App.lockConfig()
    if (!cfg.on) {
      openSheet(
        '<div class="sheet-head"><span class="sheet-title">开启应用锁</span><button id="lkClose" class="btn sm line">关闭</button></div>' +
        '<div class="small muted" style="margin-bottom:12px">打开 App 时先输入 4 位 PIN，防止别人随手翻到你的账目。</div>' +
        '<div class="field"><label>设置 4 位 PIN</label><input id="lkPin1" class="input num" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>' +
        '<div class="field"><label>再输一次</label><input id="lkPin2" class="input num" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>' +
        '<div class="err" id="lkErr"></div>' +
        '<button class="btn block" id="lkSave">开启应用锁</button>' +
        '<div class="hint">PIN 只保存在这台设备上；忘记时可以清除，账目不会丢</div>'
      )
      $('#lkClose').addEventListener('click', closeSheet)
      $('#lkSave').addEventListener('click', async () => {
        const a = ($('#lkPin1').value || '').trim()
        const b = ($('#lkPin2').value || '').trim()
        const err = $('#lkErr')
        if (!/^\d{4}$/.test(a)) { err.textContent = 'PIN 需要是 4 位数字'; return }
        if (a !== b) { err.textContent = '两次输入不一致'; return }
        await window.App.enableLock(a)
        closeSheet()
        toast('应用锁已开启')
        window.App.renderTab()
      })
      return
    }

    openSheet(
      '<div class="sheet-head"><span class="sheet-title">应用锁</span><button id="lkClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="between"><b>' + ic('lock') + ' 应用锁已开启</b><span class="small muted">打开时需输入 PIN</span></div></div>' +
      '<div class="divider">修改 PIN</div>' +
      '<div class="field"><label>当前 PIN</label><input id="lkOld" class="input num" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>' +
      '<div class="field"><label>新 PIN</label><input id="lkPin1" class="input num" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>' +
      '<div class="field"><label>再输一次</label><input id="lkPin2" class="input num" type="password" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>' +
      '<div class="err" id="lkErr"></div>' +
      '<button class="btn block" id="lkSave">保存新 PIN</button>' +
      '<button class="btn ghost block" id="lkOff" style="margin-top:8px">关闭应用锁</button>'
    )
    $('#lkClose').addEventListener('click', closeSheet)
    $('#lkSave').addEventListener('click', async () => {
      const err = $('#lkErr')
      const oldPin = ($('#lkOld').value || '').trim()
      const a = ($('#lkPin1').value || '').trim()
      const b = ($('#lkPin2').value || '').trim()
      if (!await window.App.verifyPin(oldPin)) { err.textContent = '当前 PIN 不正确'; return }
      if (!/^\d{4}$/.test(a)) { err.textContent = '新 PIN 需要是 4 位数字'; return }
      if (a !== b) { err.textContent = '两次输入不一致'; return }
      await window.App.enableLock(a)
      closeSheet()
      toast('PIN 已更新')
    })
    $('#lkOff').addEventListener('click', async () => {
      if (!(await confirmSheet({ title: '关闭应用锁', danger: true, okText: '关闭', body: '关闭应用锁？之后打开 App 不再需要 PIN。' }))) return
      window.App.disableLock()
      closeSheet()
      toast('应用锁已关闭')
      window.App.renderTab()
    })
  }

  /* ---------- 外观（深色模式） ---------- */
  function openThemeSettings() {
    const ic = window.ic || function () { return '' }
    const cur = window.App.themeMode()
    const opts = [['auto', '' + ic('sun') + ' 跟随系统'], ['light', '' + ic('sun') + ' 浅色'], ['dark', '' + ic('moon') + ' 深色']]
    const chip = (v, l) =>
      '<button class="chip" data-theme-v="' + v + '" style="' +
      (v === cur ? 'background:var(--brand);color:#fff;border-color:var(--brand);font-weight:600' : '') +
      ';text-align:left;padding:13px 15px;font-size:15px;width:100%">' + l + '</button>'
    openSheet(
      '<div class="sheet-head"><div class="sheet-title">外观</div>' +
      '<button class="period-btn" id="sheetClose">' + ic('close') + '</button></div>' +
      '<div class="row" style="margin-bottom:4px"><div class="grow small muted">深色模式让夜间记账更护眼，选择「跟随系统」会自动随手机设置切换</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">' +
      opts.map(o => chip(o[0], o[1])).join('') + '</div>'
    )
    const c = $('#sheetClose')
    if (c) c.addEventListener('click', closeSheet)
    $$('#sheet [data-theme-v]').forEach(b => b.addEventListener('click', async () => {
      window.App.setThemeMode(b.getAttribute('data-theme-v'))
      closeSheet()
      toast('外观已更新')
      window.App.renderTab()
    }))
  }

  /* 固定支出 · 订阅：把「周期记账」里激活的支出规则按月均成本汇总，
     让用户一眼看清每月被订阅吃掉多少钱（v1.16 从 ui.js 搬来，省首屏预算）。 */
  async function openSubscriptionSheet() {
    const ic = window.ic || function () { return '' }
    const rules = (await S.listRecurring()).filter(r => r.active && r.txn_type === 'expense')
    const FREQ = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' }
    const monthlyCost = r => {
      const c = F.toCents(r.amount)
      if (r.freq === 'daily') return Math.round(c * 30)
      if (r.freq === 'weekly') return Math.round(c * 4.33)
      if (r.freq === 'yearly') return Math.round(c / 12)
      return c
    }
    const nextDue = r => {
      const last = r.last_run_date ? String(r.last_run_date).slice(0, 10) : null
      const start = String(r.start_date).slice(0, 10)
      const base = last || start
      const d = new Date(+base.slice(0, 4), +base.slice(5, 7) - 1, +base.slice(8, 10))
      if (last) {
        if (r.freq === 'daily') d.setDate(d.getDate() + 1)
        else if (r.freq === 'weekly') d.setDate(d.getDate() + 7)
        else if (r.freq === 'monthly') d.setMonth(d.getMonth() + 1)
        else d.setFullYear(d.getFullYear() + 1)
      }
      return F.dstr(d)
    }
    let total = 0
    rules.forEach(r => { total += monthlyCost(r) })
    const rows = rules.map(r => {
      const name = r.note || (r.category_id ? S.categoryName(r.category_id) : '支出')
      return '<div class="list-item"><div class="ico">' + ic('pin') + '</div>' +
        '<div class="grow"><div>' + esc(name) + '</div>' +
        '<div class="small muted">' + (FREQ[r.freq] || r.freq) + ' · 下次 ' + nextDue(r) + '</div></div>' +
        '<div style="text-align:right"><div class="num" style="font-weight:700">¥' + F.yuan(F.toCents(r.amount)) + '</div>' +
        '<div class="tiny muted">月均 ¥' + F.yuan(monthlyCost(r)) + '</div></div></div>'
    }).join('')
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">固定支出 · 订阅</span><button id="subClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="background:var(--brand-soft);box-shadow:none">' +
      '<div class="small muted">每月固定支出合计</div>' +
      '<div class="sub-total num">¥' + F.yuan(total) + '</div>' +
      '<div class="small muted" style="margin-top:2px">每年约 ¥' + F.yuan(total * 12) + ' · 检查下有没忘了取消的订阅</div></div>' +
      (rows || '<div class="empty" style="padding:24px">还没有固定支出<br><span class="small">记一笔时选「周期」就会自动出现在这里</span></div>')
    )
    $('#subClose').addEventListener('click', closeSheet)
  }

  window.Manage = {
    openCategoryManager: openCategoryManager,
    openLockSettings: openLockSettings,
    openBookSheet: openBookSheet,
    openThemeSettings: openThemeSettings,
    openAccountManager: openAccountManager,
    openTrash: openTrash,
    openRecurringManager: openRecurringManager,
    openFxSettings: openFxSettings,
    openUiSettings: openUiSettings,
    openSubscriptionSheet: openSubscriptionSheet,
  }
})()
