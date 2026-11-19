/* 拾光 Pro 激活码签发工具（卖家本地使用）
 * ------------------------------------------------------------------
 * 签发 N 个 Pro 买断激活码：
 *      node tools/license-sign.mjs --key "D:\path\private-dir\shiguang-pro-private-key.pem" --count 5 --serial 101
 * 自检一枚激活码（用公钥目录即可）：
 *      node tools/license-sign.mjs --verify "SJ1.xxx.yyy" --pub "D:\path\private-dir\shiguang-pro-public-key.txt"
 * 输出的激活码直接粘贴给买家；--serial 用于与订单号对应（1–65535）。
 */
import { createPrivateKey, createPublicKey, sign, verify, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DAY0 = Date.UTC(2026, 0, 1)

function parseArgs() {
  const out = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key') out.key = argv[++i]
    if (argv[i] === '--count') out.count = Number(argv[++i])
    if (argv[i] === '--serial') out.serial = Number(argv[++i])
    if (argv[i] === '--verify') out.verify = argv[++i]
    if (argv[i] === '--pub') out.pub = argv[++i]
  }
  return out
}

const args = parseArgs()
function b64url(buf) { return Buffer.from(buf).toString('base64url') }

function buildPayload(plan, serial) {
  const days = Math.floor((Date.now() - DAY0) / 86400000)
  const p = Buffer.alloc(10)
  p[0] = 0x53; p[1] = 0x4A; p[2] = 0x31          /* 'SJ1' */
  p[3] = plan
  p.writeUInt32BE(days, 4)
  p.writeUInt16BE(serial & 0xFFFF, 8)
  return p
}

function makeCode(privPem, plan, serial) {
  const payload = buildPayload(plan, serial)
  const sig = sign(null, payload, createPrivateKey(privPem))   /* Ed25519：纯数据签名 */
  return 'SJ1.' + b64url(payload) + '.' + b64url(sig)
}

if (args.verify) {
  if (!args.pub) { console.error('--verify 需要 --pub 指向公钥文件'); process.exit(1) }
  const rawPub = Buffer.from(readFileSync(args.pub, 'utf8').trim(), 'base64url')
  const code = String(args.verify).replace(/\s+/g, '')
  const [tag, p1, p2] = code.split('.')
  if (tag !== 'SJ1' || !p1 || !p2) { console.log('无效：格式'); process.exit(1) }
  const payload = Buffer.from(p1, 'base64url')
  const sig = Buffer.from(p2, 'base64url')
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: rawPub.toString('base64url') }
  webcrypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']).then(key =>
    webcrypto.subtle.verify({ name: 'Ed25519' }, key, sig, payload)
  ).then(ok => {
    console.log(ok ? '有效' : '无效：签名不通过')
    if (payload.length === 10) {
      console.log('plan=' + payload[3] + ' serial=' + payload.readUInt16BE(8) +
        ' issued=' + new Date(DAY0 + payload.readUInt32BE(4) * 86400000).toISOString().slice(0, 10))
    }
    process.exit(ok ? 0 : 1)
  })
} else {
  if (!args.key) { console.error('用法：node tools/license-sign.mjs --key <私钥PEM路径> [--count 1] [--serial 1]'); process.exit(1) }
  const privPem = readFileSync(args.key, 'utf8')
  const count = Math.max(1, Math.min(100, args.count || 1))
  let serial = Math.max(0, Math.min(65535, args.serial || 1))
  for (let i = 0; i < count; i++) {
    console.log(makeCode(privPem, 1, serial))
    serial = (serial + 1) & 0xFFFF
  }
}
