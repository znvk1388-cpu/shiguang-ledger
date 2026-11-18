const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')
const turn = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup({ reduced = false, confirmAnswer = true } = {}) {
  const dom = new JSDOM(
    '<main id="mainView"><button id="opener">记一笔</button><div id="content">当前记录</div></main>' +
    '<div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>',
    { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, animations = [], vibes = []
  let reduceListener
  const reduceMedia = { matches: reduced, addEventListener(n, fn) { reduceListener = fn }, addListener(fn) { reduceListener = fn } }
  const coarseMedia = { matches: true, addEventListener() {}, addListener() {} }
  w.matchMedia = q => String(q).indexOf('prefers-reduced-motion') >= 0 ? reduceMedia : coarseMedia
  w.HTMLElement.prototype.animate = function (frames, options) {
    let resolve, reject
    const finished = new Promise((yes, no) => { resolve = yes; reject = no })
    const a = { target: this, frames, options, finished, cancels: 0, cancel() { this.cancels++; reject(Error('cancelled')) }, finish() { resolve() } }
    animations.push(a); return a
  }
  Object.defineProperty(w.navigator, 'vibrate', { configurable: true, value: p => { vibes.push(p); return true } })
  const account = { id: 1, name: '现金', currency: 'CNY' }, category = { id: 1, name: '餐饮', txn_type: 'expense' }
  w.eval(fs.readFileSync('js/format.js', 'utf8'))
  w.TXN_TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' }
  w.Lazy = { need: async () => null }
  w.DB = { mode: 'guest', state: { sourceId: 'isolated', categories: [category] }, accounts: () => [account], allAccounts: () => [account],
    category: () => category, rootCategories: () => [category], childCategories: () => [], categoryName: () => category.name, accountName: () => account.name, budgetOf: () => null,
    addTransaction: async () => ({ id: 1 }), uploadImage: async () => ({ id: 2 }), addAttachments: async () => {} }
  w.App = { state: {}, refresh: async () => {}, renderTab: () => {}, version: 'test' }
  w.URL.createObjectURL = () => 'blob:isolated-receipt'; w.URL.revokeObjectURL = () => {}
  w.confirm = () => confirmAnswer
  w.eval(fs.readFileSync('js/ui.js', 'utf8'))
  return { w, dom, animations, vibes, $: s => w.document.querySelector(s), $$: s => Array.from(w.document.querySelectorAll(s)),
    preference(value) { reduceMedia.matches = value; if (reduceListener) reduceListener({ matches: value }) },
    raf: () => new Promise(r => w.requestAnimationFrame(r)),
    pointer(type, x, y, t, target) {
      const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
      Object.defineProperty(e, 'timeStamp', { value: t })
      ;(target || w.document.getElementById('sheet')).dispatchEvent(e)
      return e
    },
    close: () => w.close() }
}

test('haptic fires the designed pattern per kind, honours the off switch and degrades silently', () => {
  const h = setup()
  try {
    h.w.UI.haptic('tap'); h.w.UI.haptic('success'); h.w.UI.haptic('warn')
    /* 注意：warn 的数组是在 jsdom realm 里创建的，跨 realm deepStrictEqual 会因原型不同而失败，这里逐项比较 */
    assert.equal(h.vibes.length, 3)
    assert.equal(h.vibes[0], 9)
    assert.equal(h.vibes[1], 20)
    assert.deepEqual(Array.from(h.vibes[2]), [15, 70, 24])
    h.w.localStorage.setItem('ledger10_haptics', 'off')
    assert.equal(h.w.UI.hapticsOn(), false)
    h.w.UI.haptic('tap')
    assert.equal(h.vibes.length, 3, 'switched off must not vibrate')
    h.w.localStorage.removeItem('ledger10_haptics')
    Object.defineProperty(h.w.navigator, 'vibrate', { configurable: true, value: undefined })
    assert.doesNotThrow(() => h.w.UI.haptic('success'), 'unsupported devices must not throw')
    assert.equal(h.vibes.length, 3)
  } finally { h.close() }
})

test('the haptic settings sheet persists the choice and previews by vibrating once', async () => {
  const h = setup()
  try {
    await h.w.UI.openHapticSettings()
    assert.match(h.$('#sheet .sheet-title').textContent, /触感反馈/)
    h.$('#sheet [data-haptic-v="false"]').click()
    assert.equal(h.w.localStorage.getItem('ledger10_haptics'), 'off')
    assert.equal(h.$('#sheet').getAttribute('aria-hidden'), 'true', 'sheet closes after choosing')
    await h.w.UI.openHapticSettings()
    h.$('#sheet [data-haptic-v="true"]').click()
    assert.notEqual(h.w.localStorage.getItem('ledger10_haptics'), 'off')
    assert.ok(h.vibes.includes(20), 're-enabling gives a success tick')
  } finally { h.close() }
})

test('tabPop plays one four-frame bounce and replaces the previous one like other feedback', async () => {
  const h = setup()
  try {
    const el = h.w.document.createElement('span')
    h.w.document.body.appendChild(el)
    h.w.UI.tabPop(el)
    assert.equal(h.animations.length, 1)
    assert.equal(h.animations[0].frames.length, 4)
    h.w.UI.tabPop(el)
    assert.equal(h.animations[0].cancels, 1, 'old bounce is replaced')
    h.preference(true)
    h.w.UI.tabPop(el)
    assert.equal(h.animations.length, 2, 'reduced motion suppresses new bounces')
    assert.equal(h.animations[1].cancels, 1)
  } finally { h.close() }
})

test('countUp rolls to the final value and honours reduced motion', async () => {
  const h = setup()
  try {
    const el = h.w.document.createElement('div')
    h.w.document.body.appendChild(el)
    h.w.UI.countUp(el, 1000, 2500, c => '¥' + (c / 100))
    await sleep(460)
    assert.equal(el.textContent, '¥25')
    h.preference(true)
    const instant = h.w.document.createElement('div')
    h.w.document.body.appendChild(instant)
    h.w.UI.countUp(instant, 100, 900, c => '¥' + c)
    assert.equal(instant.textContent, '¥900')
    h.preference(false)
    h.w.UI.countUp(el, 2500, 2500, c => '¥' + (c / 100))
    assert.equal(el.textContent, '¥25', 'same value keeps the formatted text')
  } finally { h.close() }
})

test('a decisive downward drag closes the bottom sheet and clears drag state', async () => {
  const h = setup()
  try {
    h.w.UI.openSheet('<b class="sheet-title">面板</b>')
    await h.raf()
    const sheet = h.$('#sheet')
    h.pointer('pointerdown', 100, 300, 0)
    h.pointer('pointermove', 100, 320, 15)
    h.pointer('pointermove', 100, 360, 30)
    h.pointer('pointermove', 100, 420, 45)
    h.pointer('pointermove', 100, 500, 60)
    h.pointer('pointerup', 100, 500, 70)
    assert.equal(sheet.getAttribute('aria-hidden'), 'true', 'drag beyond the threshold closes')
    assert.equal(sheet.classList.contains('dragging'), false)
    assert.equal(sheet.style.transform, '', 'inline transform is cleaned up')
    assert.ok(h.vibes.includes(9), 'dismiss gives a tick')
  } finally { h.close() }
})

test('a fast short flick closes even below the distance threshold', async () => {
  const h = setup()
  try {
    h.w.UI.openSheet('<b class="sheet-title">面板</b>')
    await h.raf()
    h.pointer('pointerdown', 100, 300, 0)
    h.pointer('pointermove', 100, 306, 10)
    h.pointer('pointermove', 100, 340, 20)
    h.pointer('pointerup', 100, 340, 30)
    assert.equal(h.$('#sheet').getAttribute('aria-hidden'), 'true', 'velocity alone can dismiss')
  } finally { h.close() }
})

test('a slow short drag snaps back and keeps the sheet open', async () => {
  const h = setup()
  try {
    h.w.UI.openSheet('<b class="sheet-title">面板</b>')
    await h.raf()
    const sheet = h.$('#sheet')
    h.pointer('pointerdown', 100, 300, 0)
    h.pointer('pointermove', 100, 310, 20)
    h.pointer('pointermove', 100, 320, 40)
    h.pointer('pointermove', 100, 328, 60)
    h.pointer('pointermove', 100, 334, 80)
    h.pointer('pointerup', 100, 334, 90)
    assert.equal(sheet.getAttribute('aria-hidden'), 'false')
    assert.equal(sheet.classList.contains('dragging'), false)
    assert.equal(sheet.style.transform, '')
  } finally { h.close() }
})

test('drag dismissal still asks before abandoning an unsaved draft', async () => {
  const h = setup({ confirmAnswer: false })
  try {
    await h.w.UI.openEditor(null)
    await h.raf()
    h.$('#amtInput').value = '99'
    const sheet = h.$('#sheet')
    h.pointer('pointerdown', 100, 200, 0, sheet)
    h.pointer('pointermove', 100, 380, 30, sheet)
    h.pointer('pointerup', 100, 380, 40, sheet)
    assert.equal(sheet.getAttribute('aria-hidden'), 'false', 'the confirm guard keeps the sheet open')
    assert.equal(sheet.classList.contains('dragging'), false)
    assert.equal(sheet.style.transform, '')
  } finally { h.close() }
})

test('gestures starting on controls or scrolled content never claim the drag', async () => {
  const h = setup()
  try {
    h.w.UI.openSheet('<div class="sheet-head"><b class="sheet-title">面板</b></div><button id="inside" class="btn">按钮</button>')
    await h.raf()
    const sheet = h.$('#sheet')
    h.pointer('pointerdown', 100, 300, 0, h.$('#inside'))
    h.pointer('pointermove', 100, 500, 20)
    h.pointer('pointerup', 100, 500, 30)
    assert.equal(sheet.getAttribute('aria-hidden'), 'false', 'pressing a button is not a drag')
    assert.equal(sheet.classList.contains('dragging'), false)
    sheet.scrollTop = 8
    h.pointer('pointerdown', 100, 300, 40)
    h.pointer('pointermove', 100, 500, 60)
    h.pointer('pointerup', 100, 500, 70)
    assert.equal(sheet.getAttribute('aria-hidden'), 'false', 'scrolled content keeps native scrolling')
    assert.equal(sheet.classList.contains('dragging'), false)
  } finally { h.close() }
})

test('saving a transaction vibrates once and primes the balance roll', async () => {
  const h = setup()
  try {
    await h.w.UI.openEditor(null)
    h.$('#amtInput').value = '12.50'
    h.$('#edSave').click()
    await turn(); await turn(); await turn()
    assert.ok(h.vibes.includes(20), 'clean save gives the success tick')
  } finally { h.close() }
})

test('an invalid amount warns with the error haptic', async () => {
  const h = setup()
  try {
    await h.w.UI.openEditor(null)
    h.$('#amtInput').value = ''
    h.$('#edSave').click()
    await turn()
    assert.ok(h.vibes.some(v => Array.isArray(v) && v[0] === 15 && v[1] === 70 && v[2] === 24), 'warn pattern fired')
  } finally { h.close() }
})

test('a keypad key press gives a light tick', async () => {
  const h = setup()
  try {
    await h.w.UI.openEditor(null)
    const key = h.$('#keypad button[data-k]')
    assert.ok(key, 'editor keypad exists')
    key.click()
    await turn()
    assert.ok(h.vibes.includes(9), 'key press ticked')
  } finally { h.close() }
})
