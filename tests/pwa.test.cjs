const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

function updatePage({ failMessage = false } = {}) {
  const events = [], timers = new Map(), handlers = new Map(), notices = []
  let timerId = 0
  const btn = { disabled: false, textContent: '', addEventListener(type, fn) { handlers.set(type, fn) } }
  const bar = { getAttribute() { return null }, setAttribute() {}, innerHTML: '' }
  const workers = new EventTarget()
  const cacheNames = new Set(['ledger10-v41', 'ledger10-v42', 'another-app'])
  const UI = { $: s => s === '#updateBar' ? bar : btn, $$: () => [], toast: s => notices.push(s) }
  const context = vm.createContext({
    window: { UI, DB: {}, Fmt: {}, caches: true },
    document: { addEventListener() {} }, navigator: { serviceWorker: workers },
    caches: { keys: async () => [...cacheNames], delete: async k => { cacheNames.delete(k); events.push('delete') } },
    location: { reload() { events.push('reload') } }, ic: () => '',
    setTimeout(fn) { timers.set(++timerId, fn); return timerId }, clearTimeout(id) { timers.delete(id) },
  })
  vm.runInContext(read('js/app.js'), context)
  const waiting = { postMessage(message) { if (failMessage) throw new Error('worker unavailable'); events.push(message.type) } }
  context.window.App.showUpdateBar({ waiting })
  return { context, events, timers, notices, workers, cacheNames, btn, click: () => handlers.get('click')() }
}

test('updating retains offline caches and reloads only after the new worker takes control', async () => {
  const page = updatePage()
  await page.click()
  assert.deepEqual(page.events, ['SKIP_WAITING'])
  assert.equal(page.cacheNames.size, 3)
  assert.equal(page.btn.disabled, true)
  await page.click()
  assert.deepEqual(page.events, ['SKIP_WAITING'])
  page.workers.dispatchEvent(new Event('controllerchange'))
  page.workers.dispatchEvent(new Event('controllerchange'))
  assert.deepEqual(page.events, ['SKIP_WAITING', 'reload'])
  assert.equal(page.timers.size, 0)
})

test('worker timeout and message failure let the user retry without clearing caches', async () => {
  for (const failMessage of [false, true]) {
    const page = updatePage({ failMessage })
    await page.click()
    if (!failMessage) [...page.timers.values()][0]()
    assert.equal(page.btn.disabled, false)
    assert.equal(page.cacheNames.size, 3)
    assert.equal(page.events.includes('reload'), false)
    assert.equal(page.notices.length, 1)
  }
})

function worker({ failAt } = {}) {
  const handlers = new Map(), cacheNames = new Set(['ledger10-v41', 'ledger10-v42', 'ledger10-v43', 'ledger10-v44', 'ledger10-v45', 'ledger10-v46', 'ledger10-v47', 'ledger10-v48', 'another-app'])
  const downloaded = [], deleted = []
  let claimed = false
  const context = vm.createContext({
    self: { location: { href: 'https://ledger.test/sw.js', origin: 'https://ledger.test' }, addEventListener: (type, handler) => handlers.set(type, handler), clients: { claim: async () => { claimed = true } } },
    caches: {
      open: async () => ({ add: async req => { if (req.url === failAt) throw new Error('offline'); downloaded.push(req.url) } }),
      keys: async () => [...cacheNames], delete: async key => { deleted.push(key); cacheNames.delete(key) },
    },
    Request: class { constructor(url) { this.url = url } }, URL,
  })
  vm.runInContext(read('sw.js'), context)
  return { handlers, cacheNames, downloaded, deleted, claimed: () => claimed }
}

test('failed installation leaves the old offline version available', async () => {
  const w = worker({ failAt: './js/app.js' })
  let pending
  w.handlers.get('install')({ waitUntil(p) { pending = p } })
  await assert.rejects(pending, /offline/)
  assert.equal(w.cacheNames.has('ledger10-v41'), true)
  assert.deepEqual(w.deleted, [])
})

test('cached pages and scripts stay on the active version; unrelated data is never cached', async () => {
  const handlers = new Map(), calls = [], writes = []
  const oldScript = { body: 'v42 app.js' }, oldPage = { body: 'v42 index.html' }
  const cache = new Map([['https://ledger.test/js/app.js', oldScript], ['https://ledger.test/index.html', oldPage]])
  const urlOf = value => new URL(value.url || value, 'https://ledger.test/sw.js').href
  const context = vm.createContext({
    self: { location: { href: 'https://ledger.test/sw.js', origin: 'https://ledger.test' }, addEventListener: (name, handler) => handlers.set(name, handler) },
    URL,
    caches: { open: async () => ({ match: async req => cache.get(urlOf(req)), put: async (req, res) => { writes.push(req); cache.set(urlOf(req), res) } }) },
    fetch: async req => { calls.push(req); return { body: 'v43 pending', status: 200, type: 'basic', clone() { return this } } },
  })
  vm.runInContext(read('sw.js'), context)
  async function fetchRequest(url, mode = 'cors') {
    let result
    handlers.get('fetch')({ request: { method: 'GET', url, mode }, respondWith(p) { result = p } })
    return result ? await result : null
  }
  assert.equal(await fetchRequest('https://ledger.test/js/app.js'), oldScript)
  assert.equal(await fetchRequest('https://ledger.test/?sharecode=test', 'navigate'), oldPage)
  assert.equal(await fetchRequest('https://ledger.test/private/export.json'), null)
  assert.equal(await fetchRequest('https://ledger.test/private/download', 'navigate'), null)
  assert.equal(await fetchRequest('https://ledger.test/.cloud/database/transactions'), null)
  assert.equal(calls.length, 0)
  assert.equal(writes.length, 0)
  assert.equal(cache.get('https://ledger.test/js/app.js'), oldScript)
})

test('all precached files exist and activation removes only old app versions', async () => {
  const w = worker()
  let pending
  w.handlers.get('install')({ waitUntil(p) { pending = p } })
  await pending
  for (const url of w.downloaded) assert.ok(fs.existsSync(path.join(root, url)), url)
  w.handlers.get('activate')({ waitUntil(p) { pending = p } })
  await pending
  assert.deepEqual(w.deleted, ['ledger10-v41', 'ledger10-v42', 'ledger10-v43', 'ledger10-v44', 'ledger10-v45', 'ledger10-v46', 'ledger10-v47'])
  assert.equal(w.cacheNames.has('ledger10-v48'), true)
  assert.equal(w.cacheNames.has('another-app'), true)
  assert.equal(w.claimed(), true)
})

test('manifest icons and application scripts are valid local assets', () => {
  const manifest = JSON.parse(read('manifest.json'))
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(root, icon.src))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    const [width, height] = icon.sizes.split('x').map(Number)
    assert.equal(png.readUInt32BE(16), width)
    assert.equal(png.readUInt32BE(20), height)
  }
  function check(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) check(file)
      else if (file.endsWith('.js')) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })
    }
  }
  check(path.join(root, 'js'))
  new vm.Script(read('sw.js'), { filename: 'sw.js' })
})

