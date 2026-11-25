import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function walk(relative) {
  const absolute = path.join(ROOT, relative)
  const stat = fs.statSync(absolute)
  if (stat.isFile()) return [relative]
  const out = []
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) out.push(...walk(next))
    else out.push(next)
  }
  return out
}

const manifest = JSON.parse(read('package.json'))

const INCLUDED = [
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  ...walk('src'),
  ...walk('locale'),
  ...walk('docs'),
]

const FORBIDDEN = [
  [/C:\\Users/i, '本机用户目录'],
  [/\/Users\//i, 'macOS 用户目录'],
  [/nmgmc/i, '本机用户名'],
  [/\.config[\\/]secrets/i, '本机密钥目录'],
  [/[A-Za-z]:\\[A-Za-z0-9_]+/i, '盘符绝对路径'],
  [/sk-[A-Za-z0-9]{16,}/, '疑似 API key'],
  [/DEEPSEEK_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{8,}/, '疑似写死的 key'],
  [/BEGIN [A-Z ]*PRIVATE KEY/, '私钥'],
  [/dsh-chatdemo-requests\.jsonl/, '调试落盘文件'],
  [/dsh-chatdemo-debug|model\.module\.load|provider\.module\.load/, '调试代码残留'],
]

test('清单：公开包、无私有标记、有 DSH 版本范围', () => {
  assert.equal(manifest.name, 'dsh-chatdemo')
  assert.equal(manifest.private, undefined)
  assert.match(manifest.engines.dsh, /^>=0\.2\.2-rc\.\d+ <0\.3\.0-0$/)
  assert.equal(manifest.dependencies, undefined, '不引入第三方运行时依赖')
  assert.ok(manifest.files.includes('src'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('locale'))
  assert.ok(manifest.files.includes('docs'))
  for (const bad of ['dev', 'test', '.github', 'node_modules']) {
    assert.ok(!manifest.files.includes(bad), `files 不应包含 ${bad}`)
  }
})

test('files 白名单里的每一项都真实存在', () => {
  for (const entry of manifest.files) {
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `缺少 files 条目：${entry}`)
  }
})

test('发布内容不含本机路径、密钥或调试落盘', () => {
  // README 里会提到旧的 @local 包名（迁移说明），所以只对运行时代码做严格检查。
  const strict = ['package.json', 'cordis.patch.yml', ...walk('src'), ...walk('locale'), ...walk('docs')]
  for (const relative of INCLUDED) {
    const text = read(relative)
    for (const [pattern, label] of FORBIDDEN) {
      assert.ok(!pattern.test(text), `${relative} 命中 ${label}`)
    }
  }
  for (const relative of strict) {
    assert.ok(!read(relative).includes('@local/'), `${relative} 仍引用本地包名`)
  }
})

test('locale 元数据与详情页', () => {
  for (const locale of ['en', 'zh']) {
    const data = JSON.parse(read(`locale/${locale}.json`))
    assert.ok(data.meta.title.length > 0)
    assert.ok(data.meta.description.length > 0)
    assert.equal(data.meta.detail, 'docs/DETAIL.md')
  }
  const detail = read('docs/DETAIL.md')
  const images = detail.split(/\r?\n/).filter(line => /^!\[[^\]]*\]\([^)]+\)$/.test(line.trim()))
  assert.equal(images.length, 1, '详情文档只允许一张图')
  const imagePath = images[0].match(/\(([^)]+)\)/)[1]
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', imagePath)))
})

test('图标是有效图片且不超过 256 KiB', () => {
  const icon = fs.readFileSync(path.join(ROOT, 'icon.svg'))
  assert.ok(icon.length > 0 && icon.length <= 256 * 1024)
  assert.match(icon.toString('utf8').trimStart().slice(0, 4), /<svg/)
})

test('patch：三行、预设 id、persona 与 wire 常量一致', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /name: dsh-chatdemo\b/)
  assert.match(patch, /name: dsh-chatdemo\/model/)
  assert.match(patch, /name: dsh-chatdemo\/silence/)
  assert.match(patch, /id: chatdemo\b/)
  assert.match(patch, /prefix: 该助手为DeepSeek，由深度求索公司创造。/)
  const wire = read('src/wire.js')
  assert.match(wire, /SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'/)
})

test('契约锁定：不发这些字段、端点固定', () => {
  const wire = read('src/wire.js')
  const auth = read('src/auth.js')
  assert.ok(!/max_tokens\s*:/.test(wire), 'body 不应出现 max_tokens')
  assert.ok(!/temperature\s*:/.test(wire), 'body 不应出现 temperature')
  assert.ok(!/output_config\s*:/.test(wire), 'body 不应出现 output_config')
  assert.match(auth, /https:\/\/api\.deepseek\.com/)
  assert.ok(!/baseURL/.test(read('src/config.js')), '配置面不提供 baseURL')
})

test('CI 与测试目录存在但不在发布包内', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci.yml')))
  assert.ok(fs.existsSync(path.join(ROOT, 'test')))
  assert.ok(!manifest.files.includes('test'))
})
