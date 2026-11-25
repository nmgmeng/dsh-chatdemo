import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { apply } from '../src/model.js'

function makeCtx({ presets, defaultSelection } = {}) {
  const handlers = new Map()
  const registry = new Map()
  const ctx = {
    on(name, handler) { handlers.set(name, handler) },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'agents') return { get: id => registry.get(String(id)), list: () => [...registry.values()] }
      if (name === 'agentPresets') {
        return presets === undefined ? undefined : { presetForSession: presets }
      }
      if (name === 'agentDefaultModel') {
        return defaultSelection === undefined ? undefined : { currentSelection: () => defaultSelection }
      }
      return undefined
    },
  }
  return { ctx, handlers, registry }
}

function makeAgent({ preset = 'chatdemo', id = 's1', current = undefined, fail = false, header = undefined } = {}) {
  const calls = []
  let state = current
  return {
    calls,
    setCurrent(value) { state = value },
    agent: {
      session: {
        id,
        meta: { id, agentPreset: preset },
        requestHeader: () => header,
      },
      model: {
        current: () => state,
        select(selection) {
          if (fail) throw new Error('catalog not ready')
          calls.push(selection)
          state = selection
        },
      },
    },
  }
}

test('新会话（startup）且预设为 chatdemo：自动选中 chatdemo-flash', () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx)
  const { agent, calls } = makeAgent()
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
})

test('会话头仍是 standard，但投影已记录 chatdemo：也要选中', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  const { agent, calls } = makeAgent({ preset: 'standard' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.equal(calls.length, 1)
})

test('resume / clear / compact 不动用户已有选择', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  for (const source of ['resume', 'clear', 'compact']) {
    const { agent, calls } = makeAgent()
    handlers.get('agent/created')({ agent, source })
    assert.equal(calls.length, 0, `${source} 不应改模型`)
  }
})

test('其它预设不动作', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'standard' })
  apply(ctx)
  const { agent, calls } = makeAgent({ preset: 'standard' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.equal(calls.length, 0)
})

test('已经是 chatdemo 路由时不重复写入', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  const { agent, calls } = makeAgent({ current: { provider: 'chatdemo', model: 'chatdemo-flash' } })
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.equal(calls.length, 0)
})

test('首轮前切到 chatdemo 预设：给活 agent 补选择', () => {
  const { ctx, handlers, registry } = makeCtx()
  apply(ctx)
  const { agent, calls } = makeAgent()
  registry.set('s1', agent)
  handlers.get('agent-preset/selected')('s1', 'chatdemo')
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
})

test('切预设时 Agent 还没创建：记 pending，等 agent/created 再补', () => {
  const { ctx, handlers } = makeCtx({ presets: () => null })
  apply(ctx)
  handlers.get('agent-preset/selected')('s-new', 'chatdemo')
  // Agent 之后才创建，会话头仍是 standard，投影也读不到 —— 靠 pending 兜住。
  const { agent, calls } = makeAgent({ id: 's-new', preset: 'standard' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
})

test('切到其它预设或会话没有活 agent 时安全跳过', () => {
  const { ctx, handlers, registry } = makeCtx()
  apply(ctx)
  handlers.get('agent-preset/selected')('missing', 'chatdemo')
  const { agent, calls } = makeAgent()
  registry.set('s2', agent)
  handlers.get('agent-preset/selected')('s2', 'standard')
  assert.equal(calls.length, 0)
})

test('agent/disposed 后不再向旧 Agent 写选择', () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx)
  const { agent, calls } = makeAgent({ id: 's3' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  handlers.get('agent/disposed')({ agent })
  handlers.get('agent-preset/selected')('s3', 'chatdemo')
  handlers.get('agent/created')({ agent: makeAgent({ id: 's3' }).agent, source: 'resume' })
  assert.equal(calls.length, 1)
})

test('插件激活时补选：未发过请求的 chatdemo 会话直接选中', () => {
  const { ctx, registry } = makeCtx({ presets: () => 'chatdemo' })
  const { agent, calls } = makeAgent({ id: 's-live' })
  registry.set('s-live', agent)
  apply(ctx)
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
})

test('插件激活时补选：已经发过请求的会话不动', () => {
  const { ctx, registry } = makeCtx({ presets: () => 'chatdemo' })
  const { agent, calls } = makeAgent({ id: 's-used', header: { config: { provider: 'deepseek-official' } } })
  registry.set('s-used', agent)
  apply(ctx)
  assert.equal(calls.length, 0)
})

test('客户端写回 deepseek 选择：首轮前纠正成 chatdemo', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  const { agent, calls, setCurrent } = makeAgent({ id: 's-correct' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  calls.length = 0
  setCurrent({ provider: 'deepseek-official', model: 'deepseek-flash' })
  const session = { id: 's-correct', requestHeader: () => undefined }
  handlers.get('session/event')(session, { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
})

test('首轮之后不再纠正用户手选', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  const { agent, calls } = makeAgent({ id: 's-after' })
  handlers.get('agent/created')({ agent, source: 'startup' })
  calls.length = 0
  const session = { id: 's-after', requestHeader: () => ({ config: { provider: 'deepseek-official' } }) }
  handlers.get('session/event')(session, { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.equal(calls.length, 0)
})

test('从 chatdemo 切走：恢复进入前的模型', () => {
  const { ctx, handlers } = makeCtx({ presets: () => 'chatdemo' })
  apply(ctx)
  const { agent, calls } = makeAgent({ id: 's-back', current: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  handlers.get('agent/created')({ agent, source: 'startup' })
  assert.deepEqual(calls, [{ provider: 'chatdemo', model: 'chatdemo-flash' }])
  calls.length = 0
  handlers.get('agent-preset/selected')('s-back', 'standard')
  assert.deepEqual(calls, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
})

test('没有记忆时切走：回退到部署默认模型', () => {
  const { ctx, handlers } = makeCtx({
    presets: () => 'standard',
    defaultSelection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  })
  apply(ctx)
  const { agent, calls } = makeAgent({ id: 's-default', preset: 'standard', current: { provider: 'chatdemo', model: 'chatdemo-flash' } })
  handlers.get('agent/created')({ agent, source: 'resume' })
  handlers.get('agent-preset/selected')('s-default', 'standard')
  assert.deepEqual(calls, [{ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }])
})

test('部署默认也指向 chatdemo 时不做恢复（避免自己恢复自己）', () => {
  const { ctx, handlers } = makeCtx({
    presets: () => 'standard',
    defaultSelection: { provider: 'chatdemo', model: 'chatdemo-flash' },
  })
  apply(ctx)
  const { agent, calls } = makeAgent({ id: 's-loop', preset: 'standard', current: { provider: 'chatdemo', model: 'chatdemo-flash' } })
  handlers.get('agent/created')({ agent, source: 'resume' })
  handlers.get('agent-preset/selected')('s-loop', 'standard')
  assert.equal(calls.length, 0)
})

test('选择失败只告警，不抛出', () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx)
  const { agent } = makeAgent({ fail: true })
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => handlers.get('agent/created')({ agent, source: 'startup' }))
  } finally {
    console.warn = warn
  }
})
