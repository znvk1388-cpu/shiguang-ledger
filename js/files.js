/* 文件柜（懒加载模块，v1.15）
 *
 * 对标 PocketSmith File Manager（v4 评审 3.5）。
 *
 * 以前凭证相册只是「所有小票的图片墙」，按账目挂载 —— 保单、合同、房产文件、
 * 保修卡这些跟某笔账没关系但必须留着的纸，没地方放。
 * 现在多一个「文件柜」：可以存不挂账的文档，按类型归档、按文件名/备注搜索、标星置顶。
 *
 * 数据边界（项目硬约束：不改表结构、新字段只存 localStorage）：
 *   - 文件本体仍然写 `attachments` 表，只是 `transaction_id` 留空（不挂账）
 *   - 「标签 / 备注 / 星标」写本机 `ledger10_files`：{ [attachmentId]: { tag, note, star, at } }
 *   - 覆盖层丢了只影响分类和星标，文件本身还在，不会丢数据
 */
;(function () {
  'use strict'
  const F = window.Fmt
  const S = window.DB
  const U = window.UI
  const $ = U.$
  const $$ = U.$$
  const esc = F.escapeHtml
  const openSheet = U.openSheet
  const closeSheet = U.closeSheet
  const toast = U.toast
  const ic = window.ic || function () { return '' }

  const KEY = 'ledger10_files'
  const TAGS = ['小票', '保单', '合同', '房产', '保修', '其他']

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch (e) { return {} }
  }
  function save(m) {
    try { localStorage.setItem(KEY, JSON.stringify(m)) } catch (e) { /* 隐私模式忽略 */ }
  }
  function meta(id) { return all()[String(id)] || {} }
  function setMeta(id, patch) {
    const m = all()
    m[String(id)] = Object.assign({}, m[String(id)] || {}, patch)
    save(m)
  }
  function dropMeta(id) {
    const m = all()
    delete m[String(id)]
    save(m)
  }

  function isImage(att) { return /^image\//.test(String(att.content_type || '')) }
  function yearOf(att) {
    const t = String(att.created_at || '')
    const y = Number(t.slice(0, 4))
    if (y > 1990) return String(y)
    return String(new Date().getFullYear())
  }

  let filterTag = ''
  let keyword = ''

  async function rows() {
    let list = []
    try { list = await S.listAllAttachments() } catch (e) { list = [] }
    const m = all()
    const out = (list || []).map(a => {
      const x = m[String(a.id)] || {}
      return {
        att: a,
        tag: x.tag || '',
        note: x.note || '',
        star: !!x.star,
        year: yearOf(a),
      }
    })
    const kw = keyword.trim().toLowerCase()
    return out.filter(r => {
      if (filterTag && r.tag !== filterTag) return false
      if (!kw) return true
      return String(r.att.file_name || '').toLowerCase().indexOf(kw) >= 0 ||
        String(r.note).toLowerCase().indexOf(kw) >= 0
    }).sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || (b.att.id - a.att.id))
  }

  const CSS = '<style>' +
    '.fc-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}' +
    '.fc-ico{width:36px;height:36px;flex:none;border-radius:var(--r-sm);background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:17px;overflow:hidden}' +
    '.fc-ico img{width:100%;height:100%;object-fit:cover}' +
    '.fc-name{font-size:14px;overflow-wrap:anywhere}' +
    '.fc-meta{font-size:11px;color:var(--muted);margin-top:2px}' +
    '.fc-star{background:none;border:0;font-size:17px;line-height:1;padding:6px;color:var(--muted);cursor:pointer}' +
    '.fc-star.on{color:#faad14}' +
    '.fc-year{font-size:12px;font-weight:700;color:var(--muted);margin:14px 0 2px}' +
    '</style>'

  async function openFiles() {
    const list = await rows()
    const groups = {}
    list.forEach(r => { (groups[r.year] = groups[r.year] || []).push(r) })
    const years = Object.keys(groups).sort().reverse()

    const body = list.length
      ? years.map(y => '<div class="fc-year">' + y + ' 年 · ' + groups[y].length + ' 个</div>' +
        groups[y].map(r => rowHtml(r)).join('')).join('')
      : '<div class="empty" style="padding:28px"><div class="big">' + ic('folder') + '</div>' +
        '<div>还没有文件</div><div class="small" style="margin-top:6px">保单、合同、保修卡、小票都可以放进来，不挂账也能存</div></div>'

    openSheet(
      CSS +
      '<div class="sheet-head"><span class="sheet-title">文件柜</span><button id="fcClose" class="btn sm line">关闭</button></div>' +
      '<div class="row" style="gap:8px;margin-bottom:10px">' +
      '<input id="fcSearch" class="input grow" placeholder="搜文件名或备注" value="' + esc(keyword) + '">' +
      '<button class="btn" id="fcAdd" style="flex:none">＋ 添加</button></div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
      '<button class="chip' + (filterTag === '' ? ' on' : '') + '" data-fctag="">全部</button>' +
      TAGS.map(t => '<button class="chip' + (filterTag === t ? ' on' : '') + '" data-fctag="' + t + '">' + t + '</button>').join('') +
      '</div>' +
      '<input type="file" id="fcFile" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" class="hidden">' +
      body +
      '<div class="hint">文件存在你本机（登录后存云端），不挂账也能存；标签和星标只存本机</div>'
    )

    const close = $('#fcClose')
    if (close) close.addEventListener('click', closeSheet)
    const inp = $('#fcSearch')
    if (inp) {
      inp.addEventListener('input', () => { keyword = inp.value })
      inp.addEventListener('change', () => { keyword = inp.value; openFiles() })
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { keyword = inp.value; openFiles() } })
    }
    $$('#sheet [data-fctag]').forEach(b => b.addEventListener('click', () => {
      filterTag = b.getAttribute('data-fctag') || ''
      openFiles()
    }))
    const add = $('#fcAdd')
    const pick = $('#fcFile')
    if (add && pick) {
      add.addEventListener('click', () => pick.click())
      pick.addEventListener('change', async () => {
        const files = Array.prototype.slice.call(pick.files || [])
        if (!files.length) return
        toast('正在上传 ' + files.length + ' 个文件…')
        let ok = 0
        for (const f of files) {
          try {
            const up = await S.uploadFile(f)
            await S.addAttachments(null, [up])
            ok++
          } catch (e) { /* 单个失败不影响其余 */ }
        }
        toast(ok ? '已存入 ' + ok + ' 个文件' : '上传失败，请重试')
        openFiles()
      })
    }
    $$('#sheet [data-fcopen]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-fcopen')
      const r = list.find(x => String(x.att.id) === id)
      if (r) openDetail(r)
    }))
    fillThumbs(list.map(x => x.att))
    $$('#sheet [data-fcstar]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation()
      const id = b.getAttribute('data-fcstar')
      const cur = meta(id)
      setMeta(id, { star: !cur.star })
      openFiles()
    }))
  }

  function rowHtml(r) {
    const a = r.att
    const name = a.file_name || '未命名文件'
    const bits = [r.tag || '未分类', F.bytes(Number(a.size_bytes) || 0)]
    if (a.transaction_id) bits.push('已挂账')
    if (r.note) bits.push(r.note)
    const thumb = isImage(a)
      ? '<div class="fc-ico"><img data-thumb="' + a.id + '" alt=""></div>'
      : '<div class="fc-ico">' + (/pdf/i.test(a.content_type || '') ? ic('file-text') : ic('folder')) + '</div>'
    return '<div class="fc-row">' +
      '<div data-fcopen="' + a.id + '" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer">' +
      thumb +
      '<div style="min-width:0"><div class="fc-name">' + esc(name) + '</div>' +
      '<div class="fc-meta">' + esc(bits.join(' · ')) + '</div></div></div>' +
      '<button class="fc-star' + (r.star ? ' on' : '') + '" data-fcstar="' + a.id + '" aria-label="标星">' +
      (r.star ? '★' : '☆') + '</button></div>'
  }

  /* 缩略图异步补上：云端要签名 URL，本机是 objectURL，都不适合同步拼进字符串 */
  function fillThumbs(list) {
    const imgs = $$('#sheet [data-thumb]')
    if (!imgs.length) return
    const map = {}
    ;(list || []).forEach(a => { map[String(a.id)] = a })
    imgs.forEach(img => {
      const a = map[img.getAttribute('data-thumb')]
      if (!a) return
      S.imageUrl(a).then(url => { if (url) img.src = url }).catch(() => {})
    })
  }

  async function openDetail(r) {
    const a = r.att
    const name = a.file_name || '未命名文件'
    const cur = meta(a.id)
    const url = await S.imageUrl(a).catch(() => '')
    const preview = isImage(a) && url
      ? '<img src="' + url + '" alt="" style="width:100%;max-height:220px;object-fit:contain;border-radius:var(--r-sm);background:var(--bg)">'
      : '<div class="small muted">' + (url ? '点「打开文件」查看' : '这台设备上取不到预览') + '</div>'
    openSheet(
      '<div class="sheet-head"><span class="sheet-title">文件详情</span><button id="fdClose" class="btn sm line">关闭</button></div>' +
      preview +
      '<div class="field" style="margin-top:12px"><label>文件名</label><div style="overflow-wrap:anywhere">' + esc(name) + '</div>' +
      '<div class="tiny muted">' + F.bytes(Number(a.size_bytes) || 0) + (a.transaction_id ? ' · 已挂在某笔账目上' : ' · 未挂账') + '</div></div>' +
      '<div class="field"><label>类型</label><div class="row" style="gap:8px;flex-wrap:wrap">' +
      TAGS.map(t => '<button class="chip' + (cur.tag === t ? ' on' : '') + '" data-fdtag="' + t + '">' + t + '</button>').join('') +
      '</div></div>' +
      '<div class="field"><label>备注</label><input id="fdNote" class="input" placeholder="如：2026 年车险" value="' + esc(cur.note || '') + '"></div>' +
      '<button class="btn block" id="fdOpen">打开文件</button>' +
      '<button class="btn danger block" id="fdDel" style="margin-top:8px">删除</button>'
    )
    $('#fdClose').addEventListener('click', () => openFiles())
    $$('#sheet [data-fdtag]').forEach(b => b.addEventListener('click', () => {
      setMeta(a.id, { tag: b.getAttribute('data-fdtag') })
      toast('已归类为「' + b.getAttribute('data-fdtag') + '」')
      openFiles()
    }))
    const note = $('#fdNote')
    if (note) note.addEventListener('change', () => setMeta(a.id, { note: note.value.trim() }))
    $('#fdOpen').addEventListener('click', () => {
      if (!url) { toast('取不到文件地址'); return }
      if (isImage(a)) U.lightbox(url)
      else window.open(url, '_blank', 'noopener')
    })
    $('#fdDel').addEventListener('click', async () => {
      if (!confirm('删除这个文件？删除后无法恢复')) return
      try {
        await S.removeAttachment(a.id, a.storage_path)
        dropMeta(a.id)
        toast('已删除')
        openFiles()
      } catch (e) { toast(e.message || '删除失败') }
    })
  }

  window.Files = { openFiles, openDetail, TAGS }
})()
