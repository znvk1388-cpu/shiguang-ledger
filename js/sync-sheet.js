/* ============================================================
 * 「数据与同步」面板（js/sync-sheet.js · window.SyncSheet）
 * ------------------------------------------------------------
 * 从 js/sync.js 里拆出来，单独懒加载：面板是本应用最长的弹层之一，
 * 而「看同步状态」并不是首屏必经路径。核心的写失败兜底（待上传队列）
 * 仍然留在 js/sync.js 里，首屏就装好钩子，不会漏记。
 * ============================================================ */
window.SyncSheet = (function () {
  const Sync = () => window.Sync
  const F = window.Fmt

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function when(t) {
    if (!t) return '—'
    try { return F.dstr(new Date(t)) } catch (e) { return '—' }
  }

  const STATE_LABEL = { pending: '待上传', failed: '上次失败', review: '待核对', conflict: '与云端冲突' }

  /* ---------------- 界面 ---------------- */
  async function open() {
    const U2 = window.UI
    if (!U2 || !U2.openSheet) return
    U2.openSheet('<div class="sheet-head"><span class="sheet-title">数据与同步</span><button id="syClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin:6px 0">正在检查…</div>')
    bindClose()
    const st = await Sync().inspect()
    let mig = null
    try {
      const M = await window.Lazy.need('migrate')
      if (M && M.status) mig = M.status()
    } catch (e) { /* 迁移状态取不到不影响主面板 */ }
    render(st, mig)
  }

  function bindClose() {
    const c = document.getElementById('syClose')
    if (c) c.addEventListener('click', () => window.UI.closeSheet())
  }

  function ownerLabel(st) {
    if (st.mode !== 'cloud') return '本机（游客账本）'
    const o = String(st.owner || '')
    return o.indexOf('u:') === 0 ? '账号 ' + esc(o.slice(2, 12)) + '…' : '云端账号'
  }

  function render(st, mig, msg, tone) {
    const U2 = window.UI
    const dot = st.online ? '<span style="color:var(--income)">●</span> 在线' : '<span style="color:var(--warn,#d98600)">●</span> 离线'
    const banner = msg ? '<div class="small" style="margin:8px 0;color:' + (tone === 'err' ? 'var(--expense)' : 'var(--income)') + '">' + esc(msg) + '</div>' : ''
    const rows = []
    rows.push(['数据源', ownerLabel(st)])
    rows.push(['网络', dot])
    rows.push(['本机账目', st.localTxns >= 0 ? st.localTxns + ' 笔' : '—'])
    if (st.mode === 'cloud') {
      rows.push(['云端账目', st.cloudTxns != null ? st.cloudTxns + ' 笔' : '读取失败'])
      rows.push(['云端最近更新', when(st.cloudAt)])
      rows.push(['上次对齐云端', st.lastPullAt ? when(st.lastPullAt) : '尚未成功对齐'])
    } else {
      rows.push(['云端账目', '登录后可用'])
    }
    rows.push(['本机最近写入', when(st.localAt)])
    rows.push(['账户 / 账本', st.accounts + ' / ' + st.books])

    let warn = ''
    /* 上一次自动对齐失败：必须显式告诉用户，不能只在后台静默失败 */
    if (st.lastError) {
      warn += '<div class="card" style="border-left:3px solid var(--expense)"><div class="small"><b>上次同步未成功</b><br>' +
        esc(st.lastError) + '<br><span class="muted">云端数据没有被改动，本机数据也没有丢。检查网络后点下方「以云端为准」重试。</span></div></div>'
    }
    if (st.mode === 'cloud') {
      if (st.cloudError) warn += '<div class="card" style="border-left:3px solid var(--expense)"><div class="small">读取云端失败：' + esc(st.cloudError) + '</div></div>'
      if (st.behind) warn += '<div class="card" style="border-left:3px solid var(--warn,#d98600)"><div class="small">云端有比你更新的数据（可能是另一台设备写的）。点下面的「以云端为准」刷新一下。</div></div>'
      if (st.diff != null && st.diff > 0) warn += '<div class="card" style="border-left:3px solid var(--warn,#d98600)"><div class="small">云端比你这里多 ' + st.diff + ' 笔。若你刚在别的设备记过账，刷新即可。</div></div>'
      if (st.diff != null && st.diff < 0) warn += '<div class="card" style="border-left:3px solid var(--warn,#d98600)"><div class="small">你这里比云端多 ' + (-st.diff) + ' 笔，通常是刚才有写入没成功（见下方待上传）。</div></div>'
    }

    /* ---- 待上传队列 ---- */
    const q = Sync().outbox()
    const queue = q.length
      ? '<div class="card" style="padding:0">' +
          '<div class="list-item" style="background:transparent"><div class="ico">⏳</div>' +
          '<div class="grow"><div>待上传 ' + q.length + ' 条</div>' +
          '<div class="small muted">只属于当前数据源（' + esc(st.mode === 'cloud' ? '本账号' : '游客账本') + '）；重试前请先确认这些操作确实没生效</div></div>' +
          '<button class="btn sm" id="syRetryAll">全部重试</button></div>' +
          q.map(x => '<div class="list-item">' +
            '<div class="grow"><div>' + esc(Sync().LABEL[x.method] || x.method) +
            ' <span class="tiny muted">' + esc(STATE_LABEL[x.state] || '待上传') + (x.tries ? ' · 已试 ' + x.tries + ' 次' : '') + '</span></div>' +
            '<div class="small muted">' + when(x.at) + ' · ' + esc(x.msg || '网络异常') + '</div></div>' +
            '<button class="btn sm line" data-syretry="' + esc(x.id) + '">重试</button>' +
            '<button class="btn sm line" data-sydrop="' + esc(x.id) + '" style="margin-left:6px">丢弃</button>' +
          '</div>').join('') +
        '</div>'
      : '<div class="card"><div class="small muted">没有待上传的改动。</div></div>'

    /* ---- 冲突：不静默覆盖，也不参与批量重试，必须由人决定 ---- */
    const nConflict = q.filter(x => x.state === 'conflict').length
    const conflictCard = nConflict
      ? '<div class="card" style="border-left:3px solid var(--expense)">' +
          '<div class="small"><b>' + nConflict + ' 条修改与云端冲突</b><br>' +
          '这些记录在你编辑期间被另一台设备改过。为避免覆盖别人的修改，应用<b>没有自动写入</b>，' +
          '也不会在「全部重试」里重放。<br>请回到账目列表，重新打开这几笔并保存 —— 会弹出两版对比让你选。</div>' +
        '</div>'
      : ''

    /* ---- 旧版无主队列：保留、不认领，交给用户核对 ---- */
    const legacy = st.legacy
      ? '<div class="card" style="border-left:3px solid var(--expense)">' +
          '<div class="small"><b>发现 ' + st.legacy + ' 条旧版本遗留的待上传记录</b><br>' +
          '它们来自升级前的版本，<b>没有记录所属账号</b>，无法判断属于谁。为避免把别的账号的操作重放到当前账号，' +
          '应用不会自动处理它们。<br>请核对后选择：确认这些就是当前账号的操作 → 「认领」；不确定 → 「丢弃」。</div>' +
          '<div class="row" style="gap:8px;margin-top:10px">' +
          '<button class="btn grow" id="syAdopt">认领到当前数据源</button>' +
          '<button class="btn line grow" id="syDropLegacy">全部丢弃</button></div>' +
        '</div>'
      : ''

    /* ---- 游客数据：迁移结果 + 显式清理 ---- */
    let guestCard = ''
    if (mig && (mig.done || mig.lastTryAt || mig.problems.length)) {
      const okAll = mig.done && !mig.cleanedAt
      guestCard = '<div class="card" style="border-left:3px solid ' + (mig.done ? 'var(--income)' : 'var(--warn,#d98600)') + '">' +
        '<div class="small"><b>' + (mig.done ? '本机游客数据已完整迁移' : '本机游客数据迁移未完成') + '</b><br>' +
        '待迁移 ' + mig.txns + ' 笔账目 / ' + mig.images + ' 张凭证' +
        (mig.doneAt ? '，完成于 ' + when(mig.doneAt) : '') + '。<br>' +
        (mig.problems.length ? '<span style="color:var(--expense)">未通过项：' + esc(mig.problems.join('；')) + '</span><br>' : '') +
        '<span class="muted">本机副本一直保留着 —— 它是这份数据在云端之外的唯一备份，确认无误后再清理。</span></div>' +
        (okAll ? '<button class="btn line block" id="syCleanGuest" style="margin-top:10px">清理本机游客数据（不可恢复）</button>' : '') +
        '</div>'
    }

    const body =
      '<div class="sheet-head"><span class="sheet-title">数据与同步</span><button id="syClose" class="btn sm line">关闭</button></div>' +
      '<div class="small muted" style="margin:4px 0 10px">' +
      '登录后是「在线优先」：每次记账直接写到云端，正常情况下不会出现两台设备各写各的。' +
      '回到前台 / 恢复联网时，应用会<b>自动对齐云端</b>（约每 45 秒检查一次），' +
      '账户、分类、预算、账本的改动同样会被发现，多台设备之间不需要手动刷新。' +
      '断网时写入会失败，失败的操作会收进下面的「待上传」，不会静悄悄丢掉。' +
      '</div>' +
      /* 风险提示：同步依赖平台后端，停服即取不回 —— 提审口径与用户告知共用同一段文案 */
      '<div class="card" style="border-left:3px solid var(--warn,#d98600)">' +
      '<div class="small"><b>关于云同步的风险提示</b><br>' +
      '登录后的数据托管在平台后端，跨设备同步依赖该服务持续运行。' +
      '如果平台停止服务，云端数据将<b>无法取回</b>。' +
      '建议长期养成定期「导出加密文件到本机」的习惯 —— 文件在你自己手里，谁也拿不走。' +
      '</div></div>' +
      /* 换设备 / 换链接 引导：用户最容易困惑的点 */
      '<div class="card">' +
      '<div class="small"><b>换了设备 / 换了链接，数据怎么回来？</b><br>' +
      '1. 在新设备打开应用 → 「我的」<br>' +
      '2. 用同一个手机号 / 邮箱登录<br>' +
      '3. 稍等几秒，应用会自动从云端拉取全部账目<br>' +
      '<span class="muted">数据绑的是你的账号，不是某一条链接 —— 我重新发布后地址会变，登录同一账号照样能看到数据。</span>' +
      '</div></div>' + banner +
      '<div class="card" style="padding:0">' + rows.map(r =>
        '<div class="list-item"><div class="grow">' + r[0] + '</div><div class="small">' + r[1] + '</div></div>').join('') + '</div>' +
      warn + conflictCard + queue + legacy + guestCard +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn line grow" id="syCheck">重新检查</button>' +
        (st.mode === 'cloud' ? '<button class="btn grow" id="syPull">以云端为准（刷新）</button>'
          : '<button class="btn grow" id="syPull" disabled>以云端为准（需登录）</button>') +
      '</div>' +
      '<button class="btn line block" id="sySnap" style="margin-top:8px">以本机为准（导出本机快照）</button>' +
      '<div class="small muted" style="margin-top:8px">' +
      '冲突策略：修改账目时会带上「读取时的版本号」做校验。若这条在你编辑期间被另一台设备改过，' +
      '保存会被拦下并弹出两版对比，由你决定保留哪一版 —— <b>不会静默覆盖</b>。' +
      '需要整体兜底时，用上面两个按钮分别「以云端为准」或「以本机为准」。' +
      '</div>'

    U2.openSheet(body)
    bindClose()
    bind(st, mig)
  }

  function bind(st, mig) {
    const check = document.getElementById('syCheck')
    if (check) check.addEventListener('click', async () => { await open() })

    const pull = document.getElementById('syPull')
    if (pull) pull.addEventListener('click', async () => {
      if (st.mode !== 'cloud') return
      pull.disabled = true
      pull.textContent = '正在刷新…'
      /* force=true：不看指纹，直接把账户/分类/账本/预算/目标 + 账目全量重拉 */
      const r = await Sync().autoPull(null, true)
      await open()
      /* 只有真的成功才说成功；失败要把原因原样说出来 */
      if (r && r.ok) window.UI.toast('已按云端数据刷新')
      else window.UI.toast('刷新失败：' + ((r && (r.error || r.skipped)) || '未知原因'))
    })

    const snap = document.getElementById('sySnap')
    if (snap) snap.addEventListener('click', () => {
      if (window.UI && window.UI.openBackupSheet) window.UI.openBackupSheet()
      else window.UI.toast('请到「我的 → JSON 备份 / 恢复」导出')
    })

    const ra = document.getElementById('syRetryAll')
    if (ra) ra.addEventListener('click', async () => {
      ra.disabled = true
      const r = await Sync().retryAll()
      const m = r.error ? r.error
        : ('重试完成：成功 ' + r.ok + ' 条，判定已存在跳过 ' + r.skipped + ' 条，仍失败 ' + r.fail + ' 条')
      await open()
      if (window.UI) window.UI.toast(m)
    })

    document.querySelectorAll('[data-syretry]').forEach(b => b.addEventListener('click', async () => {
      const r = await Sync().retryOne(b.getAttribute('data-syretry'))
      if (r.error) { await open(); window.UI.toast(r.error); return }
      await open()
      window.UI.toast(r.skipped ? '这条其实已经保存过了，已从队列移除' : '重试成功')
    }))

    document.querySelectorAll('[data-sydrop]').forEach(b => b.addEventListener('click', async () => {
      Sync().drop(b.getAttribute('data-sydrop'))
      await open()
    }))

    /* 旧版队列：认领 / 丢弃都要用户显式点，且认领后仍需逐条核对 */
    const ad = document.getElementById('syAdopt')
    if (ad) ad.addEventListener('click', async () => {
      const r = Sync().adoptLegacy()
      await open()
      window.UI.toast(r.error ? r.error
        : ('已认领 ' + r.moved + ' 条，标记为「待核对」——请逐条确认后再重试，避免重复记账'))
    })
    const dl = document.getElementById('syDropLegacy')
    if (dl) dl.addEventListener('click', async () => {
      if (!confirm('确定丢弃全部旧版本遗留的待上传记录？这些操作将不会被上传。')) return
      Sync().clearLegacy()
      await open()
      window.UI.toast('已丢弃旧版遗留记录')
    })

    /* 清理本机游客数据：唯一会真正删数据的入口，二次确认 */
    const cg = document.getElementById('syCleanGuest')
    if (cg) cg.addEventListener('click', async () => {
      if (!confirm('清理后本机游客数据将永久删除（云端副本不受影响）。确定继续？')) return
      try {
        const M = await window.Lazy.need('migrate')
        await M.cleanGuestData()
        await open()
        window.UI.toast('本机游客数据已清理')
      } catch (e) { window.UI.toast('清理失败：' + ((e && e.message) || '未知错误')) }
    })
  }

  /* ---------------- 冲突处理 ----------------
     两端同时改同一条账目时，保存会被 updated_at 乐观锁拦下（见 js/store.js）。
     绝不静默覆盖：把两版摆出来让用户选。放在本模块是因为它只在冲突时用得上，
     不占首屏那 155KB 的 gzip 预算。 */
  function showConflict(err, id, payload) {
    const U2 = window.UI
    const S = window.DB
    if (!U2 || !U2.openSheet) return
    const sv = (err && err.server) || {}
    const L = window.TXN_TYPE_LABEL || {}
    const line = (k, v) => '<div class="small"><span class="muted">' + k + '：</span>' + esc(v) + '</div>'
    const mine = line('类型', L[payload.txn_type] || payload.txn_type) +
      line('金额', F.money(payload.amount)) + line('备注', payload.note || '（空）') +
      line('时间', F.dstr(F.parseIso(payload.occurred_at)))
    const theirs = line('金额', F.money(sv.amount)) + line('备注', sv.note || '（空）') +
      line('时间', sv.occurred_at ? F.dstr(F.parseIso(sv.occurred_at)) : '—')
    U2.openSheet(
      '<div class="sheet-head"><b class="sheet-title">这条已被其他设备改过</b></div>' +
      '<p class="small">为避免覆盖掉你在另一台设备上的修改，这次保存被拦下了。请选择保留哪一版：</p>' +
      '<div class="card"><b>你的这一版（尚未保存）</b>' + mine + '</div>' +
      '<div class="card"><b>云端当前的版本</b>' + theirs + '</div>' +
      '<button class="btn block" id="cfKeep">用我的版本覆盖云端</button>' +
      '<button class="btn line block" id="cfDrop" style="margin-top:8px">放弃我的修改，用云端版本</button>')
    document.getElementById('cfKeep').addEventListener('click', async () => {
      try {
        /* 不带版本号 = 强制写入；用户已明确选择覆盖 */
        await S.updateTransaction(id, payload)
        U2.closeSheet(); window.App.refresh(); U2.toast('已用你的版本覆盖云端')
      } catch (e) { U2.toast('覆盖失败：' + ((e && e.message) || '请重试')) }
    })
    document.getElementById('cfDrop').addEventListener('click', async () => {
      U2.closeSheet()
      try { if (window.Sync) await window.Sync.autoPull(null, true) } catch (e) { /* 拉取失败也不阻塞关闭 */ }
      window.App.refresh(); U2.toast('已改用云端版本')
    })
  }

  return { open: open, showConflict: showConflict }
})()
