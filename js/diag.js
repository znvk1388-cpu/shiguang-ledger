/* 本机诊断记录（v1.22.0）
 * --------------------------------------------------------------------------
 * 目的：买家说「闪退/点了没反应」时，能让他一键把最近错误带出来，而不是靠猜。
 * 只记「错误消息 + 来源位置 + 时间」，各字段截断，最多 20 条，存本机
 * ledger10_diag；不记任何账目内容，不联网，不进备份（纯排障信息）。
 * 写入全部 try/catch：诊断永远不能反过来影响记账主流程。
 */
window.Diag = (function () {
  'use strict'
  const KEY = 'ledger10_diag'
  const MAX = 20

  function read() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY) || '[]')
      return Array.isArray(a) ? a : []
    } catch (e) { return [] }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)) } catch (e) { /* 存不下就放弃 */ }
  }
  function clip(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  /* kind: 'error'（脚本异常）| 'rejection'（未处理的 Promise 失败）| 'manual'（业务主动记录） */
  function logError(kind, message, source) {
    const list = read()
    list.push({
      t: new Date().toISOString(),
      kind: kind === 'rejection' ? 'rejection' : kind === 'manual' ? 'manual' : 'error',
      msg: clip(message, 200),
      src: clip(source, 120),
    })
    write(list.slice(-MAX))
    return list.length > MAX ? MAX : list.length
  }

  function recent() { return read() }

  function clear() { write([]) }

  /* 给「意见反馈」拼装用的纯文本摘要；没有记录时返回「（无）」而不是空串 */
  function summary(limit) {
    const list = recent().slice(-(limit || 5))
    if (!list.length) return '（无）'
    return list.map(x => '- ' + String(x.t || '').slice(0, 19).replace('T', ' ') + ' [' + x.kind + '] ' + x.msg + (x.src ? ' @' + x.src : '')).join('\n')
  }

  return { logError: logError, recent: recent, clear: clear, summary: summary, MAX: MAX, KEY: KEY }
})()
