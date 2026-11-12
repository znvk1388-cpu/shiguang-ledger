/* SW 缓存版本盖章（B6）
 * ------------------------------------------------------------------
 * 背景：sw.js 里的 `const CACHE = 'ledger10-vNN'` 原来靠发版时手改。
 * 忘改一次，老用户就会一直跑旧 CSS / 旧 JS（PWA 的资源全从缓存来），
 * 而开发者本地看不出任何异常 —— 这是最难排查的一类线上问题。
 *
 * 做法：把 sw.js 里 CORE_SHELL / CORE_LAZY 列出的所有静态资源内容
 * 一起算一个短哈希，写回 CACHE。改了任何一个资源却没重新盖章，
 * tests/sw-version.test.cjs 会直接失败，CI 也会拦住。
 *
 * 用法：npm run stamp（发版前跑一次）
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SW_PATH = join(ROOT, 'sw.js')

/* 从 sw.js 文本里抽出被预缓存的资源清单（保持声明顺序） */
export function listPrecached(source) {
  const block = (name) => {
    const m = new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]').exec(source)
    if (!m) throw new Error('sw.js 里找不到 ' + name)
    return Array.from(m[1].matchAll(/'([^']+)'/g), x => x[1])
  }
  const all = [...block('CORE_SHELL'), ...block('CORE_LAZY')]
  /* './' 是目录别名，实际文件是 index.html，已经单独列出，跳过避免重复读目录 */
  return Array.from(new Set(all.filter(u => u !== './')))
}

/* 只跟「内容」有关，跟机器路径、时间无关，保证多台机器算出同一个哈希 */
export function computeCacheName(source, root) {
  const base = root || ROOT
  const files = listPrecached(source).sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    const abs = join(base, rel.replace(/^\.\//, ''))
    let buf
    try {
      buf = readFileSync(abs)
    } catch (e) {
      throw new Error('预缓存列表里有读不到的文件：' + rel)
    }
    hash.update(rel)
    hash.update('\u0000')
    // Git checkout 可能转换文本换行；图片等二进制必须逐字节参与哈希。
    hash.update(/\.(?:html?|css|[cm]?js|json|svg|txt|xml|webmanifest)$/i.test(extname(rel))
      ? buf.toString('utf8').replace(/\r\n/g, '\n') : buf)
    hash.update('\u0000')
  }
  return 'ledger10-' + hash.digest('hex').slice(0, 12)
}

export function currentCacheName(source) {
  const m = /const CACHE = '([^']+)'/.exec(source)
  return m ? m[1] : ''
}

function main() {
  const source = readFileSync(SW_PATH, 'utf8')
  const want = computeCacheName(source)
  const have = currentCacheName(source)
  if (have === want) {
    console.log('sw 缓存版本已是最新：' + want)
    return
  }
  writeFileSync(SW_PATH, source.replace(/const CACHE = '[^']*'/, "const CACHE = '" + want + "'"), 'utf8')
  console.log('sw 缓存版本已更新：' + have + ' → ' + want)
}

if (process.argv[1] && process.argv[1].endsWith('sw-version.mjs')) main()
