/**
 * 校验 npm pack 的实际文件清单（CI 与本地发布前用）。
 * 用法：npm pack --dry-run --json > pack.json && node test/pack-list.mjs pack.json
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const target = process.argv[2]
if (!target) {
  console.error('用法：node test/pack-list.mjs <pack.json>')
  process.exit(2)
}
const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
const data = JSON.parse(raw)
const files = (data[0]?.files ?? []).map(entry => entry.path)
assert.ok(files.length >= 8, `打包文件过少：${files.length}`)

const ALLOWED = [
  /^package\.json$/,
  /^src\/.+\.js$/,
  /^cordis\.patch\.yml$/,
  /^locale\/[a-z]{2}\.json$/,
  /^docs\/.+$/,
  /^icon\.svg$/,
  /^README(\.en)?\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^NOTICE$/,
]

for (const file of files) {
  assert.ok(ALLOWED.some(pattern => pattern.test(file)), `发布包出现未白名单文件：${file}`)
  assert.ok(!file.startsWith('dev/'), 'dev/ 不应进包')
  assert.ok(!file.startsWith('test/'), 'test/ 不应进包')
  assert.ok(!file.startsWith('.github/'), '.github/ 不应进包')
}

const required = ['package.json', 'cordis.patch.yml', 'src/index.js', 'src/wire.js', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'docs/SPEC.md']
for (const file of required) {
  assert.ok(files.includes(file), `发布包缺少 ${file}`)
}

console.log(`OK: 发布包清单通过（${files.length} 个文件）`)
