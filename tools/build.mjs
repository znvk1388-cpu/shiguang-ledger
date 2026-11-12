/* 生产构建（B7）：压缩 JS / CSS，输出到 dist/
 * ------------------------------------------------------------------
 * 现状：index.html 直接引 js/ui.js（204KB）等未压缩源码，低端手机解析成本高。
 * 目标：加一层最小构建，不改模块结构、不加打包器 —— 每个文件独立压缩，
 *      相对路径保持不变，dist/ 与仓库同构，所以 index.html 一行都不用改。
 *
 * 用法：npm run build
 * 产物：dist/（可直接部署；sw.js 会按 dist 内容重新盖章）
 */
import { transform } from 'esbuild'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeCacheName } from './sw-version.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const SKIP_MIN = new Set(['js/vendor/workbuddy-cloud-sdk.js', 'js/vendor/papaparse.min.js'])

const kb = n => (n / 1024).toFixed(1) + 'KB'
const copy = rel => {
  const to = join(DIST, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(ROOT, rel), to)
}
const write = (rel, text) => {
  const to = join(DIST, rel)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, text)
}

async function minifyJs(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const out = await transform(src, { loader: 'js', minify: true, target: 'es2018', legalComments: 'none' })
  write(rel, out.code)
  return [src.length, out.code.length]
}
async function minifyCss(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const out = await transform(src, { loader: 'css', minify: true })
  write(rel, out.code)
  return [src.length, out.code.length]
}

async function main() {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })

  /* 静态文件原样复制 */
  for (const f of ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png']) copy(f)
  for (const f of readdirSync(join(ROOT, 'assets'))) copy(join('assets', f))

  let rawJs = 0, minJs = 0, rawCss = 0, minCss = 0
  for (const f of readdirSync(join(ROOT, 'js'))) {
    if (extname(f) !== '.js') continue
    const rel = join('js', f)
    if (SKIP_MIN.has(rel.replace(/\\/g, '/'))) { copy(rel); continue }
    const [a, b] = await minifyJs(rel)
    rawJs += a; minJs += b
  }
  for (const f of readdirSync(join(ROOT, 'css'))) {
    if (extname(f) !== '.css') continue
    const [a, b] = await minifyCss(join('css', f))
    rawCss += a; minCss += b
  }
  /* vendor 目录：第三方库已经是压缩产物，原样复制（二次压缩收益低、出错风险高） */
  for (const v of readdirSync(join(ROOT, 'js', 'vendor'))) copy(join('js', 'vendor', v))

  /* sw.js 必须按 dist 的实际内容重新盖章，否则新版本仍然命中旧缓存 */
  const swSrc = readFileSync(join(ROOT, 'sw.js'), 'utf8')
  let swDist = swSrc
  const name = computeCacheName(swSrc, DIST)
  swDist = swDist.replace(/const CACHE = '[^']*'/, "const CACHE = '" + name + "'")
  write('sw.js', swDist)

  const size = rel => statSync(join(DIST, rel)).size
  console.log('构建完成 → dist/')
  console.log('  JS  ' + kb(rawJs) + ' → ' + kb(minJs) + '  (压缩 ' + Math.round((1 - minJs / rawJs) * 100) + '%)')
  console.log('  CSS ' + kb(rawCss) + ' → ' + kb(minCss) + '  (压缩 ' + Math.round((1 - minCss / rawCss) * 100) + '%)')
  console.log('  ui.js ' + kb(size('js/ui.js')) + ' · app.js ' + kb(size('js/app.js')))
  console.log('  sw 缓存名 ' + name)
}

main().catch(e => { console.error(e); process.exitCode = 1 })
