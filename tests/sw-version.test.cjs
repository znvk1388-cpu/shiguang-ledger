/* SW 缓存版本必须与当前静态资源内容一致（B6）
 * ------------------------------------------------------------------
 * 这条测试的唯一目的：让「改了资源却忘记 npm run stamp」在 CI 里立刻失败。
 * 没有它，sw.js 的手工版本号迟早会漏改，老用户就会一直跑旧资源。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('service worker cache name matches the hashed contents of every precached asset', async () => {
  const mod = await import('../tools/sw-version.mjs')
  const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')
  const expected = mod.computeCacheName(source)
  assert.equal(mod.currentCacheName(source), expected,
    'sw.js 的 CACHE 与资源内容不一致：请运行 `npm run stamp` 后重新提交')
})

test('precached list has no duplicated or missing entries', async () => {
  const mod = await import('../tools/sw-version.mjs')
  const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')
  const list = mod.listPrecached(source)
  assert.ok(list.length > 30, '预缓存清单数量异常')
  assert.equal(new Set(list).size, list.length, '预缓存清单里存在重复项')
  /* index.html 里 defer 引用的脚本必须全部在首屏壳里，否则离线首开会白屏 */
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), m => m[1])
  for (const src of scripts) {
    assert.ok(list.includes('./' + src.replace(/^\.\//, '')), '首屏脚本未预缓存：' + src)
  }
})
