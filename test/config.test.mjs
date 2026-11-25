import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DEFAULTS, resolveConfig } from '../src/config.js'

test('默认配置', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
  assert.deepEqual(resolveConfig({}), { ...DEFAULTS })
})

test('合法覆盖', () => {
  assert.deepEqual(
    resolveConfig({ apiKeyEnv: 'MY_KEY', auth: 'api-key', idleTimeoutMs: 60000 }),
    { apiKeyEnv: 'MY_KEY', auth: 'api-key', idleTimeoutMs: 60000 },
  )
})

test('未知字段与非法值被拒绝', () => {
  const cases = [
    { nope: true },
    { auth: 'oauth' },
    { apiKeyEnv: 'my-key' },
    { apiKeyEnv: '' },
    { idleTimeoutMs: 0 },
    { idleTimeoutMs: 1.5 },
    { idleTimeoutMs: '300000' },
    { idleTimeoutMs: 99999999 },
  ]
  for (const raw of cases) {
    assert.throws(
      () => resolveConfig(raw),
      error => error.code === 'INVALID_CONFIG',
      `应当拒绝：${JSON.stringify(raw)}`,
    )
  }
})
