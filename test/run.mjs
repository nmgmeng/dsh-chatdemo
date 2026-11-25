/**
 * 本地与 CI 共用的测试入口：逐个 import 测试文件，不启动子进程
 * （受限沙箱里 node --test 的 spawn 会 EPERM）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(dir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()

for (const name of files) {
  await import(pathToFileURL(path.join(dir, name)).href)
}
