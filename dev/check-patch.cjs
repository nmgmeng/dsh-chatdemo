/**
 * 校验 cordis.patch.yml 能解析、行与预设声明符合预期。
 * 用法：node dev/check-patch.cjs "<profile>/node_modules"（js-yaml 从 profile 借）
 */
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const profileNodeModules = process.argv[2]
if (!profileNodeModules) {
  console.error('用法：node dev/check-patch.cjs "<profile>/node_modules"')
  process.exit(2)
}
const requireFromProfile = createRequire(path.join(profileNodeModules, 'noop.js'))
const yaml = requireFromProfile('js-yaml')

const patchPath = path.join(__dirname, '..', 'cordis.patch.yml')
const patch = yaml.load(fs.readFileSync(patchPath, 'utf8'))
const rows = patch[0].insert
console.log('rows:', rows.map(r => `${r.id} -> ${r.name}`).join(' | '))
const preset = rows.find(r => r.id === 'preset-chatdemo')
console.log('preset id:', preset.config.id)
console.log('children:', preset.config.plugins.map(p => p.name).join(' | '))
const persona = preset.config.plugins.find(p => p.id === 'persona')
console.log('persona prefix matches:', persona.config.prefix === '该助手为DeepSeek，由深度求索公司创造。')
