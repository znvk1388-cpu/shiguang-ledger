/* 拾光 Pro 激活码密钥工具（卖家本地使用，不进入分发产物）
 * ------------------------------------------------------------------
 * 1) 生成密钥对：
 *      node tools/license-keygen.mjs --out "D:\path\to\private-dir"
 *    私钥 PEM 写到指定目录（务必在仓库外并做好备份），公钥自动回填
 *    js/license.js 的 __PRO_LICENSE_PUB__ 占位符。
 * 2) 签发激活码见 tools/license-sign.mjs。
 */
import { generateKeyPairSync, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LICENSE_JS = join(ROOT, 'js', 'license.js')
const PLACEHOLDER = /__PRO_LICENSE_PUB__/

function parseArgs() {
  const out = { out: null }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i]
    if (argv[i] === '--force') out.force = true
  }
  if (!out.out) {
    console.error('用法：node tools/license-keygen.mjs --out <私钥保存目录（务必在仓库外）> [--force]')
    process.exit(1)
  }
  return out
}

const args = parseArgs()
const privDir = resolve(args.out)
const privPath = join(privDir, 'shiguang-pro-private-key.pem')
const pubPath = join(privDir, 'shiguang-pro-public-key.txt')
if (existsSync(privPath) && !args.force) {
  console.error('私钥已存在：' + privPath + '（覆盖请加 --force，但同一私钥签发的激活码才能被已发布公钥验证）')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const jwk = publicKey.export({ format: 'jwk' })            /* jwk.x = base64url 的 32 字节原始公钥 */
const rawPub = Buffer.from(jwk.x, 'base64url')
const pubB64url = rawPub.toString('base64url')

mkdirSync(privDir, { recursive: true })
writeFileSync(privPath, privPem, { mode: 0o600 })
writeFileSync(pubPath, pubB64url + '\n')

const src = readFileSync(LICENSE_JS, 'utf8')
if (!PLACEHOLDER.test(src) && !src.includes(pubB64url)) {
  console.error('js/license.js 里找不到 __PRO_LICENSE_PUB__ 占位符，也没有已写入的同一把公钥——检查文件是否被改动。')
  process.exit(1)
}
if (PLACEHOLDER.test(src)) {
  writeFileSync(LICENSE_JS, src.replace(PLACEHOLDER, pubB64url), 'utf8')
}

const fingerprint = createHash('sha256').update(rawPub).digest('hex').slice(0, 16)
console.log('私钥已保存：' + privPath)
console.log('公钥指纹  ：' + fingerprint)
console.log('js/license.js 已回填公钥。请把私钥目录整体备份（丢失将无法再签发可被现有公钥验证的激活码）。')
