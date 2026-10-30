/* 智能记账模块
   1) 记账规则引擎：关键词/金额 → 自动分类、打标签、指定账户
   2) 备注智能补全：从历史账目里学高频备注
   3) AI 智能记账：一句话 / 一张小票 → 自动填单（云端免密钥大模型）
   全部为纯前端能力，规则与草稿存 localStorage，不改动云端表结构。 */
window.Smart = (function () {
  const F = window.Fmt
  const S = window.DB
  const U = () => window.UI

  const RULE_KEY = 'ledger10_rules'
  const DRAFT_KEY = 'ledger10_draft'

  /* ---------------- 通用小工具 ---------------- */
  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return fallback
      const v = JSON.parse(raw)
      return v == null ? fallback : v
    } catch (e) { return fallback }
  }
  function writeJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true } catch (e) { return false }
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  /* ---------------- 一、记账规则 ---------------- */
  /* 规则结构：
     { id, on, name, field: 'note'|'amount'|'account'|'category', op: 'contains'|'equals'|'gt'|'lt',
       value, setType, setCategoryId, setAccountId, addTags: [] } */
  function listRules() {
    const arr = readJson(RULE_KEY, [])
    return Array.isArray(arr) ? arr : []
  }
  function saveRules(list) { return writeJson(RULE_KEY, list || []) }

  /* 规则输入模型：编辑器、CSV、AI 记账、历史回刷四条线传进来的字段名并不一致
     （前三条是 category_id / account_id，回刷那条线是 matchCtx 转出来的
      categoryId / accountId）。以前匹配器只认驼峰，等于「账户=」「分类=」
     这两类条件在编辑器里从来不会命中。现在全部在这里归一成一份，
     匹配器只认这一份；以后新增入口也不用再改匹配逻辑。 */
  function normCtx(input) {
    const p = input || {}
    const cat = p.category_id != null ? p.category_id : p.categoryId
    const acc = p.account_id != null ? p.account_id : p.accountId
    return {
      txn_type: p.txn_type || p.type || 'expense',
      amount: Number(p.amount) || 0,
      category_id: cat == null ? null : cat,
      account_id: acc == null ? null : acc,
      note: p.note || '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      reimbursable: !!p.reimbursable,
    }
  }
  /* 归一化结果写回调用方：它原来用什么字段名，就还写什么，
     避免 ui.js 读 category_id 而 csv.js 读到 undefined 这类事情。 */
  function writeBackCtx(payload, c) {
    if (!payload) return
    if (c.txn_type) payload.txn_type = c.txn_type
    if (c.category_id != null) payload.category_id = c.category_id
    if (c.account_id != null) payload.account_id = c.account_id
    payload.tags = c.tags
    if (c.reimbursable) payload.reimbursable = true
    /* 兼容历史上用驼峰传参的调用方（ matchCtx 那一类 ） */
    if ('categoryId' in payload) payload.categoryId = c.category_id
    if ('accountId' in payload) payload.accountId = c.account_id
  }

  function matchOne(rule, ctx) {
    if (!rule || rule.on === false) return false
    const v = String(rule.value == null ? '' : rule.value).trim()
    if (!v) return false
    const note = String(ctx.note || '')
    const catName = ctx.category_id ? S.categoryName(ctx.category_id) : ''
    const accName = ctx.account_id ? S.accountName(ctx.account_id) : ''
    const amt = Number(ctx.amount) || 0
    switch (rule.field) {
      case 'amount': {
        const n = Number(v)
        if (!isFinite(n)) return false
        if (rule.op === 'gt') return amt > n
        if (rule.op === 'lt') return amt < n
        return amt === n
      }
      case 'account':
        return rule.op === 'equals' ? accName === v : accName.indexOf(v) >= 0
      case 'category':
        return rule.op === 'equals' ? catName === v : catName.indexOf(v) >= 0
      case 'note':
      default:
        return rule.op === 'equals' ? note === v : note.indexOf(v) >= 0
    }
  }

  /* 把规则套用到一笔待保存的账目上（就地修改传入对象，返回命中的规则名）
     opts.fillOnly = true 时只填补空白字段，绝不覆盖用户已经选好的内容。
     规则按列表顺序执行；某条规则勾了「命中后停止」就跳出，后面的不再匹配
     （Firefly III 的 stop processing：给精确规则留一条「拦住泛规则」的路）。 */
  function applyRules(payload, opts) {
    const fillOnly = !!(opts && opts.fillOnly)
    const hits = []
    if (!payload) return hits
    const c = normCtx(payload)
    /* 先套用「分类纠正记忆」：这是用户亲手改过的，优先级高于内置规则 */
    if (c.txn_type !== 'transfer' && !(fillOnly && c.category_id)) {
      const m = matchCatFix(c.note, c.txn_type)
      if (m) {
        c.category_id = m.categoryId
        hits.push('记忆·' + m.kw)
        bumpCatFix(m.id)
      }
    }
    const rules = listRules()
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (!matchOne(rule, c)) continue
      let acted = false
      if (rule.setType && rule.setType !== 'transfer' && !fillOnly && c.txn_type !== 'transfer') {
        c.txn_type = rule.setType
        acted = true
      }
      if (rule.setCategoryId && c.txn_type !== 'transfer' && !(fillOnly && c.category_id)) {
        c.category_id = rule.setCategoryId
        acted = true
      }
      if (rule.setAccountId && !(fillOnly && c.account_id)) {
        c.account_id = rule.setAccountId
        acted = true
      }
      if (rule.addTags && rule.addTags.length) {
        const set = {}
        ;(c.tags || []).concat(rule.addTags).forEach(t => { if (t) set[t] = 1 })
        const merged = Object.keys(set)
        if (merged.length !== (c.tags || []).length) acted = true
        c.tags = merged
      }
      if (rule.setReimb && c.txn_type === 'expense' && !c.reimbursable) {
        c.reimbursable = true
        acted = true
      }
      if (acted) hits.push(rule.name || rule.value)
      if (rule.stop) break
    }
    /* 归一化结果写回调用方（少了这一步，规则命中了但字段一个都没变） */
    writeBackCtx(payload, c)
    return hits
  }

  /* 只推断分类（不覆盖用户已选的），给导入用 */
  function guessCategoryId(note, kind) {
    const fix = suggestCategoryFix(note, kind)
    if (fix) return fix
    const rules = listRules()
    for (const rule of rules) {
      if (rule.on === false) continue
      if (!rule.setCategoryId) continue
      if (matchOne(rule, { note, amount: 0 })) return rule.setCategoryId
    }
    return null
  }

  /* ---------------- 一·五、分类纠正记忆 ----------------
     用户改了 AI / 规则给出的分类时，记住「这条备注 → 这个分类」，下次自动套用。
     表结构不可改，记忆只存本机 localStorage，可在「记账规则」页查看与删除。 */
  const CATFIX_KEY = 'ledger10_catfix'
  /* 归一化备注：去掉空白、数字、标点与金额单位，留下可复用的「关键词」 */
  function normNote(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u3000]+/g, '')
      .replace(/[0-9０-９.,，。、!！?？:：;；'"“”‘’()（）\[\]【】<>《》+\-*/\\|~`@#$%^&_=￥¥元]/g, '')
      .toLowerCase()
      .slice(0, 24)
  }
  function listCatFixes() {
    const arr = readJson(CATFIX_KEY, [])
    return Array.isArray(arr) ? arr : []
  }
  function saveCatFixes(list) { return writeJson(CATFIX_KEY, (list || []).slice(0, 200)) }
  /* 相似度打分：完全相同 > 互相包含 > 公共前缀（≥2 字） */
  function fixScore(kw, n) {
    if (!kw || kw.length < 2 || !n) return 0
    if (n === kw) return 10000
    if (n.indexOf(kw) >= 0 || kw.indexOf(n) >= 0) return 1000 + Math.min(n.length, kw.length)
    let p = 0
    const lim = Math.min(kw.length, n.length)
    while (p < lim && kw.charAt(p) === n.charAt(p)) p++
    if (p >= 2) return 100 + p
    return 0
  }
  function matchCatFix(note, kind) {
    const n = normNote(note)
    if (n.length < 2) return null
    let best = null
    listCatFixes().forEach(f => {
      if (kind && f.kind && f.kind !== kind) return
      const sc = fixScore(f.kw, n)
      if (!sc) return
      if (!best || sc > best.score) best = { id: f.id, kw: f.kw, categoryId: f.categoryId, score: sc }
    })
    return best
  }
  function suggestCategoryFix(note, kind) {
    const m = matchCatFix(note, kind)
    return m ? m.categoryId : null
  }
  /* 学习一次纠正；同一关键词被改到别的分类时覆盖旧记录，避免互相打架 */
  function learnCategoryFix(note, categoryId, opts) {
    const kw = normNote(note)
    const cid = Number(categoryId) || null
    if (kw.length < 2 || !cid) return null
    const kind = (opts && opts.kind) || null
    const list = listCatFixes()
    const same = list.find(f => f.kw === kw && f.categoryId === cid)
    if (same) {
      same.n = (same.n || 1) + 1
      same.at = Date.now()
      saveCatFixes(list)
      return same
    }
    const replaced = list.filter(f => f.kw === kw).length
    const next = [{ id: uid(), kw, categoryId: cid, kind, n: 1, used: 0, at: Date.now() }]
      .concat(list.filter(f => f.kw !== kw))
    saveCatFixes(next)
    return { kw, categoryId: cid, replaced: replaced }
  }
  function bumpCatFix(id) {
    const list = listCatFixes()
    const f = list.find(x => x.id === id)
    if (!f) return
    f.used = (f.used || 0) + 1
    saveCatFixes(list)
  }
  function removeCatFix(id) { saveCatFixes(listCatFixes().filter(f => f.id !== id)) }
  function clearCatFixes() { saveCatFixes([]) }

  /* 首次进入时铺一套常用规则（只铺一次，用户可随意改/删） */
  const SEED_FLAG = 'ledger10_rules_seeded'
  function seedDefaultRules() {
    try { if (localStorage.getItem(SEED_FLAG) === '1') return 0 } catch (e) { return 0 }
    try { localStorage.setItem(SEED_FLAG, '1') } catch (e) { /* 忽略 */ }
    if (listRules().length) return 0
    const cats = S.state.categories || []
    const pick = (kind, name) => {
      const c = cats.find(x => x.kind === kind && x.name === name)
      return c ? c.id : null
    }
    const seeds = [
      { name: '咖啡奶茶自动归类', field: 'note', value: '咖啡', setCategoryId: pick('expense', '零食饮料') },
      { name: '星巴克自动归类', field: 'note', value: '星巴克', setCategoryId: pick('expense', '零食饮料') },
      { name: '奶茶自动归类', field: 'note', value: '奶茶', setCategoryId: pick('expense', '零食饮料') },
      { name: '外卖自动归类', field: 'note', value: '外卖', setCategoryId: pick('expense', '外卖') },
      { name: '打车自动归类', field: 'note', value: '打车', setCategoryId: pick('expense', '打车') },
      { name: '地铁公交自动归类', field: 'note', value: '地铁', setCategoryId: pick('expense', '公交地铁') },
      { name: '超市自动归类', field: 'note', value: '超市', setCategoryId: pick('expense', '日用') },
      { name: '话费充值自动归类', field: 'note', value: '话费', setCategoryId: pick('expense', '话费') },
    ].filter(r => r.setCategoryId)
    if (!seeds.length) return 0
    const list = listRules()
    seeds.forEach(s => list.push({
      id: uid(), on: true, name: s.name, field: s.field, op: 'contains', value: s.value,
      setType: null, setCategoryId: s.setCategoryId, setAccountId: null, addTags: [],
    }))
    saveRules(list)
    return seeds.length
  }

  /* 规则摘要：列表与「应用到历史」预览共用同一套措辞，避免两处说法不一致 */
  function ruleCondText(r) {
    return (r.field === 'amount' ? '金额' : r.field === 'account' ? '账户' : r.field === 'category' ? '分类' : '备注') +
      (r.field === 'amount' ? (r.op === 'gt' ? ' > ' : r.op === 'lt' ? ' < ' : ' = ') : (r.op === 'equals' ? ' 等于 ' : ' 包含 ')) +
      '「' + F.escapeHtml(r.value) + '」'
  }
  function ruleActsText(r) {
    const acts = []
    if (r.setCategoryId) acts.push('分类→' + F.escapeHtml(S.categoryName(r.setCategoryId)))
    if (r.setAccountId) acts.push('账户→' + F.escapeHtml(S.accountName(r.setAccountId)))
    if (r.setType) acts.push('类型→' + window.TXN_TYPE_LABEL[r.setType])
    if (r.addTags && r.addTags.length) acts.push('标签→' + F.escapeHtml(r.addTags.join('/')))
    if (r.setReimb) acts.push('标记待报销')
    return acts
  }
  /* 已有账目当规则上下文用：直接走同一套归一化，字段名差异在 normCtx 里消化 */
  function matchCtx(t) {
    return normCtx(t)
  }
  /* 这条规则会给某一笔账目带来哪些改动；返回空对象表示「命中了但无需改」 */
  function rulePatch(rule, t) {
    const patch = {}
    if (rule.setType && rule.setType !== 'transfer' && t.txn_type !== 'transfer' && t.txn_type !== rule.setType) {
      patch.txn_type = rule.setType
    }
    if (rule.setCategoryId && t.txn_type !== 'transfer' && Number(t.category_id) !== Number(rule.setCategoryId)) {
      patch.category_id = rule.setCategoryId
    }
    if (rule.setAccountId && Number(t.account_id) !== Number(rule.setAccountId)) patch.account_id = rule.setAccountId
    if (rule.addTags && rule.addTags.length) {
      /* 云端读回的 tags 已经摘掉了内部标记，但 `_ord:<交易单号>` 必须原样带回去，
         否则「规则回刷历史」会把导入幂等的判据洗掉，同一份账单又能再导一遍 */
      const base = (t.tags || []).slice()
      if (t._ord) base.push('_ord:' + t._ord)
      const set = {}
      base.concat(rule.addTags).forEach(x => { if (x) set[x] = 1 })
      const merged = Object.keys(set)
      if (merged.length !== (t.tags || []).length) patch.tags = merged
    }
    if (rule.setReimb && t.txn_type === 'expense' && !t.reimbursable) patch.reimbursable = true
    return patch
  }
  function patchText(patch) {
    const out = []
    if (patch.txn_type) out.push('类型→' + (window.TXN_TYPE_LABEL[patch.txn_type] || patch.txn_type))
    if (patch.category_id) out.push('分类→' + F.escapeHtml(S.categoryName(patch.category_id) || '未分类'))
    if (patch.account_id) out.push('账户→' + F.escapeHtml(S.accountName(patch.account_id) || '—'))
    if (patch.tags) out.push('标签已更新')
    if (patch.reimbursable) out.push('标记待报销')
    return out.join(' · ')
  }

  /* 应用到已有账目：先试运行（影响几笔、改什么），确认后才写库。
     Firefly III 的「apply rules to existing transactions」，也是规则能不能闭环的关键：
     用户往往先记了账才想到「以后这类都归到 X」。 */
  async function openRuleApply(rule) {
    const esc = F.escapeHtml
    const identity = () => {
      const id = S.mode === 'cloud' ? S.state && S.state.uid : S.mode === 'guest' ? S.state && S.state.sourceId : ''
      return id ? JSON.stringify([S.mode, String(id), S.currentBookId()]) : ''
    }
    const scope = identity()
    if (!scope) { U().toast('无法确认当前账号或账本，请重新打开'); return }
    U().openSheet(
      '<div class="sheet-head"><span class="sheet-title">应用到已有账目</span><button id="raClose" class="btn sm line">关闭</button></div>' +
      '<div class="card" style="box-shadow:none;background:var(--brand-soft)"><div class="small">当 ' + ruleCondText(rule) + '</div>' +
      '<div class="small" style="color:var(--brand);margin-top:2px">' + (ruleActsText(rule).join(' · ') || '未设置动作') + '</div></div>' +
      '<p class="small muted">正在检查最近 1000 笔账目…</p><div id="raBody"></div>')
    document.getElementById('raClose').addEventListener('click', U().closeSheet)
    const originalBody = document.getElementById('raBody')
    const active = () => identity() === scope && document.getElementById('raBody') === originalBody &&
      originalBody && !originalBody.closest('[aria-hidden="true"]')
    let res
    try { res = await S.listTransactions({ limit: 1000 }) } catch (e) {
      if (active()) originalBody.innerHTML = '<div class="err">读取账目失败：' + esc(e.message || '请重试') + '</div>'
      return
    }
    if (!active()) { U().toast('账号、账本或面板已切换，请重新打开核对'); return }
    const hits = []
    ;(res.rows || []).forEach(t => {
      if (!matchOne(rule, matchCtx(t))) return
      const patch = rulePatch(rule, t)
      if (Object.keys(patch).length) hits.push({ t: t, patch: patch })
    })
    const body = document.getElementById('raBody')
    if (!hits.length) {
      body.innerHTML = '<div class="empty" style="padding:20px"><div class="big">' + ic('check') + '</div>' +
        '<div>没有需要改的账目</div><div class="small" style="margin-top:6px">最近 1000 笔里，符合条件且还需要改的一笔都没有。</div></div>' +
        '<button class="btn line block" id="raDone">知道了</button>'
      document.getElementById('raDone').addEventListener('click', U().closeSheet)
      return
    }
    const list = hits.slice(0, 20).map(h => '<div class="list-item" style="padding:8px 12px">' +
      '<div class="grow"><div class="small ellipsis">' + esc(h.t.note || S.categoryName(h.t.category_id) || '（无备注）') + '</div>' +
      '<div class="tiny muted">' + F.isoDay(h.t.occurred_at) + ' · ' + patchText(h.patch) + '</div></div>' +
      '<span class="num small">¥' + F.yuan(F.toCents(h.t.amount)) + '</span></div>').join('')
    body.innerHTML = '<div class="card small">将影响 <b class="num">' + hits.length + '</b> 笔' +
      (hits.length > 20 ? '（下面列出前 20 笔）' : '') + '，检查范围是最近 ' + (res.rows || []).length + ' 笔。</div>' +
      '<div class="card" style="padding:0">' + list + '</div>' +
      '<div class="err" id="raErr"></div>' +
      '<button class="btn block" id="raRun">应用到这 ' + hits.length + ' 笔</button>' +
      '<div class="hint">只改分类 / 账户 / 标签 / 报销标记，不会改金额和日期。改动会同步到云端。</div>'
    const btn = document.getElementById('raRun')
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      if (!active()) { U().toast('账号、账本或面板已切换，请重新打开核对'); return }
      btn.disabled = true
      let ok = 0, conflict = 0, uncertain = false, stopped = false
      for (let i = 0; i < hits.length; i++) {
        if (!active()) { stopped = true; break }
        btn.textContent = '应用中 ' + (i + 1) + ' / ' + hits.length
        try {
          await S.updateTransaction(hits[i].t.id, hits[i].patch, hits[i].t.updated_at)
          if (!active()) { uncertain = true; stopped = true; break }
          ok++
        } catch (e) {
          if (e && e.code === 'CONFLICT') conflict++
          else { uncertain = true; break }
        }
      }
      U().toast('已确认更新 ' + ok + ' 笔' + (conflict ? '，' + conflict + ' 笔被其他设备改过已跳过' : '') +
        (uncertain ? '；有一笔结果待核对，请检查账目与同步状态，未继续处理后续记录' : stopped ? '；账号、账本或面板已切换，请核对后续记录' : ''))
      if (active()) U().closeSheet()
      if (window.App && window.App.refresh) window.App.refresh()
    })
  }

  function openRuleManager(editId) {
    const rules = listRules()
    const editing = editId ? rules.find(r => r.id === editId) : null
    const cats = S.state.categories || []
    const accs = S.allAccounts()
    const catOpts = (sel) => cats.map(c =>
      '<option value="' + c.id + '"' + (Number(sel) === c.id ? ' selected' : '') + '>' +
      (c.parent_id ? '　' + F.escapeHtml(c.name) : F.escapeHtml((c.icon || '') + ' ' + c.name)) + '</option>').join('')
    const accOpts = (sel) => accs.map(a =>
      '<option value="' + a.id + '"' + (Number(sel) === a.id ? ' selected' : '') + '>' + F.escapeHtml((a.icon || '') + ' ' + a.name) + '</option>').join('')

    let html = '<div class="sheet-head"><span class="sheet-title">记账规则</span><button id="rlClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin-bottom:12px">命中「备注/金额/账户」条件时，自动帮你填好分类、标签和账户。导入账单和手动记账都会生效。</div>'

    /* 分类纠正记忆：用户改过的分类会排在规则之前生效 */
    const fixes = listCatFixes()
    if (fixes.length) {
      html += '<div class="divider">我纠正过的分类（' + fixes.length + '）</div>' +
        '<div class="small muted" style="margin-bottom:8px">你改过 AI / 规则给出的分类后，这里会记住「关键词 → 分类」，下次自动套用。优先级高于下面的规则。</div>' +
        fixes.map(f => {
          const cat = S.category(f.categoryId)
          const name = cat ? (cat.parent_id ? S.categoryName(cat.parent_id) + '/' + cat.name : cat.name) : '（已删除的分类）'
          const kindLabel = f.kind === 'income' ? '收入' : f.kind === 'expense' ? '支出' : ''
          return '<div class="list-item">' +
            '<div class="grow"><div style="font-weight:600">「' + F.escapeHtml(f.kw) + '」→ ' + F.escapeHtml((cat && cat.icon ? cat.icon + ' ' : '') + name) + '</div>' +
            '<div class="small muted">' + (kindLabel ? kindLabel + ' · ' : '') + '已套用 ' + (f.used || 0) + ' 次 · 学习于 ' +
            F.isoDay(new Date(f.at || Date.now()).toISOString()) + '</div></div>' +
            '<button class="btn sm danger" data-cfdel="' + f.id + '" style="flex:none">忘掉</button>' +
            '</div>'
        }).join('') +
        '<button class="btn sm line block" id="cfClear" style="margin-bottom:4px">清空全部纠正记忆</button>'
    }

    if (!rules.length) {
      html += '<div class="divider">规则</div>' +
        '<div class="empty" style="padding:20px"><div class="big">' + ic('wand') + '</div><div>还没有规则</div>' +
        '<div class="small" style="margin-top:6px">例：备注含「星巴克」→ 分类设为「零食饮料」</div></div>'
    } else {
      html += '<div class="divider">规则（' + rules.length + '）</div>'
      html += rules.map((r, i) => {
        const acts = ruleActsText(r)
        return '<div class="list-item" style="align-items:flex-start;flex-wrap:wrap;gap:0">' +
          '<div class="grow" style="flex-basis:100%"><div style="font-weight:600">' + F.escapeHtml(r.name || ('规则 ' + (i + 1))) +
          (r.on === false ? ' <span class="tiny muted">已停用</span>' : '') +
          (r.stop ? ' <span class="tiny muted">命中即停</span>' : '') + '</div>' +
          '<div class="small muted">当 ' + ruleCondText(r) + '</div>' +
          '<div class="small" style="color:var(--brand)">' + (acts.join(' · ') || '未设置动作') + '</div></div>' +
          /* 编辑 / 应用到历史 / 排序：Firefly 那套「规则能改、能回溯」的最小闭环 */
          '<div class="row" style="gap:4px;margin-top:6px;flex-basis:100%">' +
          '<button class="btn sm line" data-rledit="' + r.id + '">编辑</button>' +
          '<button class="btn sm line" data-rlapply="' + r.id + '">应用到已有</button>' +
          '<button class="btn sm line" data-rlmove="' + r.id + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="上移">↑</button>' +
          '<button class="btn sm line" data-rlmove="' + r.id + '" data-dir="1"' + (i === rules.length - 1 ? ' disabled' : '') + ' aria-label="下移">↓</button>' +
          '<button class="btn sm line" data-rltoggle="' + r.id + '">' + (r.on === false ? '启用' : '停用') + '</button>' +
          '<button class="btn sm danger" data-rldel="' + r.id + '">删</button>' +
          '</div></div>'
      }).join('')
    }

    const sel = (v, cur) => v === cur ? ' selected' : ''
    const ed = editing || {}
    html += '<div class="divider">' + (editing ? '编辑规则' : '新建规则') + '</div>' +
      '<div class="field"><label>规则名称（可留空）</label><input id="rlName" class="input" placeholder="如：咖啡自动归类" maxlength="16" value="' + F.escapeHtml(ed.name || '') + '"></div>' +
      '<div class="field"><label>条件</label>' +
      '<div class="row" style="gap:8px">' +
      '<select id="rlField" class="select" style="width:104px;flex:none">' +
      '<option value="note"' + sel('note', ed.field || 'note') + '>备注</option>' +
      '<option value="amount"' + sel('amount', ed.field) + '>金额</option>' +
      '<option value="account"' + sel('account', ed.field) + '>账户</option>' +
      '<option value="category"' + sel('category', ed.field) + '>分类</option></select>' +
      '<select id="rlOp" class="select" style="width:92px;flex:none">' +
      (ed.field === 'amount'
        ? '<option value="gt"' + sel('gt', ed.op || 'gt') + '>大于</option><option value="lt"' + sel('lt', ed.op) + '>小于</option>'
        : '<option value="contains"' + sel('contains', ed.op || 'contains') + '>包含</option><option value="equals"' + sel('equals', ed.op) + '>等于</option>') +
      '</select>' +
      '<input id="rlValue" class="input grow" placeholder="如：星巴克" value="' + F.escapeHtml(ed.value || '') + '">' +
      '</div></div>' +
      '<div class="field"><label>满足时自动设置（可只填一项）</label>' +
      '<div class="row" style="gap:8px;margin-bottom:8px">' +
      '<select id="rlType" class="select" style="width:96px;flex:none"><option value="">类型不变</option>' +
      '<option value="expense"' + sel('expense', ed.setType) + '>支出</option>' +
      '<option value="income"' + sel('income', ed.setType) + '>收入</option></select>' +
      '<select id="rlCat" class="select grow"><option value="">分类不变</option>' + catOpts(ed.setCategoryId) + '</select>' +
      '</div>' +
      '<div class="row" style="gap:8px">' +
      '<select id="rlAcc" class="select grow"><option value="">账户不变</option>' + accOpts(ed.setAccountId) + '</select>' +
      '<input id="rlTags" class="input grow" placeholder="加标签，逗号分隔" value="' + F.escapeHtml((ed.addTags || []).join(',')) + '">' +
      '</div>' +
      /* 两个 Firefly 式开关：报销标记是拾光已有的字段；「命中即停」给精确规则拦住泛规则的路 */
      '<div class="row" style="gap:14px;margin-top:10px;align-items:center">' +
      '<label class="row small" style="gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="rlReimb"' + (ed.setReimb ? ' checked' : '') + '> 标记为待报销</label>' +
      '<label class="row small" style="gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="rlStop"' + (ed.stop ? ' checked' : '') + '> 命中后不再匹配后面的规则</label>' +
      '</div></div>' +
      '<div class="err" id="rlErr"></div>' +
      '<button class="btn block" id="rlAdd">' + (editing ? '保存修改' : '添加规则') + '</button>' +
      (editing ? '<button class="btn line block" id="rlCancelEdit" style="margin-top:8px">取消编辑</button>' : '')

    U().openSheet(html)
    document.getElementById('rlClose').addEventListener('click', U().closeSheet)
    document.querySelectorAll('#sheet [data-cfdel]').forEach(b => {
      b.addEventListener('click', () => {
        removeCatFix(b.getAttribute('data-cfdel'))
        openRuleManager()
      })
    })
    const cfClear = document.getElementById('cfClear')
    if (cfClear) cfClear.addEventListener('click', () => {
      if (!confirm('清空全部纠正记忆？之后不再自动套用你改过的分类。')) return
      clearCatFixes()
      U().toast('已清空纠正记忆')
      openRuleManager()
    })
    document.querySelectorAll('#sheet [data-rldel]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-rldel')
        saveRules(listRules().filter(x => x.id !== id))
        openRuleManager()
      })
    })
    document.querySelectorAll('#sheet [data-rltoggle]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-rltoggle')
        const list = listRules().map(x => x.id === id ? Object.assign({}, x, { on: x.on === false }) : x)
        saveRules(list)
        openRuleManager()
      })
    })
    document.querySelectorAll('#sheet [data-rledit]').forEach(b => {
      b.addEventListener('click', () => openRuleManager(b.getAttribute('data-rledit')))
    })
    document.querySelectorAll('#sheet [data-rlapply]').forEach(b => {
      b.addEventListener('click', () => {
        const rule = listRules().find(x => x.id === b.getAttribute('data-rlapply'))
        if (rule) openRuleApply(rule)
      })
    })
    /* 顺序就是优先级：命中即停的规则必须能排到前面才有意义 */
    document.querySelectorAll('#sheet [data-rlmove]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-rlmove')
        const dir = Number(b.getAttribute('data-dir'))
        const list = listRules()
        const i = list.findIndex(x => x.id === id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= list.length) return
        const tmp = list[i]
        list[i] = list[j]
        list[j] = tmp
        saveRules(list)
        openRuleManager()
      })
    })
    const cancelEdit = document.getElementById('rlCancelEdit')
    if (cancelEdit) cancelEdit.addEventListener('click', () => openRuleManager())
    const fieldSel = document.getElementById('rlField')
    const opSel = document.getElementById('rlOp')
    fieldSel.addEventListener('change', () => {
      const numeric = fieldSel.value === 'amount'
      opSel.innerHTML = numeric
        ? '<option value="gt">大于</option><option value="lt">小于</option>'
        : '<option value="contains">包含</option><option value="equals">等于</option>'
    })
    document.getElementById('rlAdd').addEventListener('click', () => {
      const value = document.getElementById('rlValue').value.trim()
      const err = document.getElementById('rlErr')
      if (!value) { err.textContent = '请填写条件值'; return }
      const setCat = document.getElementById('rlCat').value
      const setAcc = document.getElementById('rlAcc').value
      const setType = document.getElementById('rlType').value
      const tags = document.getElementById('rlTags').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      const setReimb = !!document.getElementById('rlReimb').checked
      const stop = !!document.getElementById('rlStop').checked
      if (!setCat && !setAcc && !setType && !tags.length && !setReimb) { err.textContent = '至少设置一项自动动作'; return }
      const rule = {
        id: editing ? editing.id : uid(),
        on: editing ? editing.on !== false : true,
        name: document.getElementById('rlName').value.trim(),
        field: fieldSel.value, op: opSel.value, value,
        setType: setType || null,
        setCategoryId: setCat ? Number(setCat) : null,
        setAccountId: setAcc ? Number(setAcc) : null,
        addTags: tags,
        setReimb: setReimb || undefined,
        stop: stop || undefined,
      }
      const list = listRules()
      if (editing) {
        /* 原地替换：编辑规则不能把它挪到队尾，顺序本身是有含义的 */
        const i = list.findIndex(x => x.id === editing.id)
        if (i >= 0) list[i] = rule
        else list.push(rule)
      } else {
        list.push(rule)
      }
      saveRules(list)
      U().toast(editing ? '规则已更新' : '规则已添加')
      openRuleManager()
    })
  }

  /* ---------------- 二、备注智能补全 ---------------- */
  const NOTE_TTL = 5 * 60 * 1000
  let noteCache = null
  let noteAt = 0
  async function noteSuggestions() {
    if (noteCache && Date.now() - noteAt < NOTE_TTL) return noteCache
    try {
      const { rows } = await S.listTransactions({ limit: 400 })
      const stat = {}
      rows.forEach(t => {
        const n = (t.note || '').trim()
        if (!n || n.length > 30) return
        stat[n] = (stat[n] || 0) + 1
      })
      noteCache = Object.keys(stat).sort((a, b) => stat[b] - stat[a]).slice(0, 40)
    } catch (e) { noteCache = [] }
    noteAt = Date.now()
    return noteCache
  }
  function invalidateNoteCache() { noteCache = null; noteAt = 0 }

  /* ---------------- 三、AI 智能记账（懒加载） ----------------
     实现已挪到 js/ai.js（window.AI）：这块必须联网 + 用户点击才会用到，
     留在首屏会白占 155KB 的 gzip 预算。这里只做转发，window.Smart 的调用面不变。 */
  function aiMod() {
    if (!window.Lazy) return Promise.reject(new Error('懒加载器未就绪'))
    return window.Lazy.need('ai').then(function (m) {
      if (!m) throw new Error('AI 模块加载失败，请检查网络后重试')
      return m
    })
  }
  function aiParse(text, imageDataUrl) { return aiMod().then(function (m) { return m.aiParse(text, imageDataUrl) }) }
  function openAiSheet(t) { return aiMod().then(function (m) { return m.openAiSheet(t) }) }

  return {
    listRules, saveRules, applyRules, normCtx, guessCategoryId, openRuleManager, seedDefaultRules,
    openRuleApply, rulePatch, ruleCondText, ruleActsText,
    normNote, listCatFixes, learnCategoryFix, suggestCategoryFix, matchCatFix, removeCatFix, clearCatFixes,
    noteSuggestions, invalidateNoteCache,
    aiParse, openAiSheet,
  }
})()

