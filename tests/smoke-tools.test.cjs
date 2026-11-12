/* 发布工具的反例：空白页面不能通过冒烟。 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome')

test('smoke rejects an inert blank page even without console errors', { skip: !existsSync(chrome), timeout: 40000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>inert fixture</title></head><body></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['tools/smoke.mjs', `http://127.0.0.1:${server.address().port}/`], {
        cwd: root, env: { ...process.env, CHROME_PATH: chrome }, stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = '', stdout = ''
      child.stdout.on('data', data => { output += data; stdout += data })
      child.stderr.on('data', data => { output += data })
      child.on('error', reject)
      child.on('close', code => resolve({ code, output, stdout }))
    })
    assert.notEqual(result.code, 0, '没有游客入口、数据或交互的页面不能验收通过：\n' + result.output)
    assert.match(result.output, /游客入口/, '必须因页面缺少游客入口而失败，不能因浏览器启动错误误通过')
    const report = JSON.parse(result.stdout)
    assert.equal(path.dirname(report.profile), path.join(root, 'shots'))
    assert.equal(existsSync(report.profile), false, '失败退出后必须清理本次独立 profile')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('CDP evaluation exceptions reject instead of becoming successful values', async () => {
  const { evaluationValue } = await import('../tools/smoke.mjs')
  assert.throws(() => evaluationValue({
    result: { type: 'object', subtype: 'error' },
    exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: 'Error: database unavailable' } }
  }), /database unavailable/)
  assert.equal(evaluationValue({ result: { type: 'number', value: 12.5 } }), 12.5)
})

test('profile cleanup accepts only dedicated direct children of repository shots', async () => {
  const fs = require('node:fs')
  const { safeProfilePath } = await import('../tools/smoke.mjs')
  const shots = path.join(root, 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(shots, '.smoke-profile-test-'))
  try {
    assert.equal(safeProfilePath(fixture), fs.realpathSync(fixture))
    assert.throws(() => safeProfilePath(root), /拒绝清理/)
    assert.throws(() => safeProfilePath(shots), /拒绝清理/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
