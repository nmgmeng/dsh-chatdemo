import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { apply, CHATDEMO_MODEL, CHATDEMO_MODEL_NOSEARCH } from '../src/index.js'
import { SYSTEM_PROMPT } from '../src/wire.js'

function sse(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

const OK_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '好' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]

function makeCtx({ key = 'test-key', account, attachments } = {}) {
  const services = {
    credentials: key === undefined ? undefined : { resolve: async ref => (ref === 'DEEPSEEK_API_KEY' ? { value: key } : undefined) },
    deepseekAccount: account,
    attachments,
  }
  const state = { adapter: undefined, requests: [] }
  const ctx = {
    get: name => services[name],
    llm: {
      registerAdapter(_providers, adapter) { state.adapter = adapter },
    },
  }
  return { ctx, state }
}

function useFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

const MESSAGES = [
  { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
  { role: 'user', content: [{ type: 'text', text: '你好' }] },
]

async function run(adapter, extra = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'chatdemo', model: CHATDEMO_MODEL, messages: MESSAGES, ...extra })) {
    chunks.push(chunk)
  }
  return chunks
}

test('请求体与鉴权头：一句话 system、服务端工具、无 max_tokens', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const fake = useFetch(() => new Response(sse(OK_EVENTS), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    const chunks = await run(state.adapter, { reasoningEffort: 'high' })
    assert.equal(chunks.at(-1).type, 'finish')
    const { url, init } = fake.calls[0]
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(init.headers['x-api-key'], 'test-key')
    assert.equal(init.headers['content-type'], 'application/json')
    const body = JSON.parse(init.body)
    assert.equal(body.system, SYSTEM_PROMPT)
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.deepEqual(body.tools.map(t => t.name), ['deepseek_read_url', 'deepseek_web_search'])
    assert.deepEqual(body.safety_check, { level: 'high' })
    assert.equal(body.max_tokens, undefined)
    assert.equal(body.output_config, undefined)
    assert.equal(body.stream, true)
  } finally {
    fake.restore()
  }
})

test('reasoningEffort=off 关闭深度思考；不联网变体只声明 read_url', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const fake = useFetch(() => new Response(sse(OK_EVENTS), { status: 200 }))
  try {
    await run(state.adapter, { reasoningEffort: 'off' })
    assert.deepEqual(JSON.parse(fake.calls[0].init.body).thinking, { type: 'disabled' })

    await run(state.adapter, { model: CHATDEMO_MODEL_NOSEARCH })
    assert.deepEqual(JSON.parse(fake.calls[1].init.body).tools.map(t => t.name), ['deepseek_read_url'])
  } finally {
    fake.restore()
  }
})

test('账户模式发 x-dsh-auth-token，不发 x-api-key', async () => {
  const account = { resolveToken: async () => 'account-token', rejectToken: async () => {} }
  const { ctx, state } = makeCtx({ account })
  apply(ctx, { auth: 'account' })
  const fake = useFetch(() => new Response(sse(OK_EVENTS), { status: 200 }))
  try {
    await run(state.adapter)
    const headers = fake.calls[0].init.headers
    assert.equal(headers['x-dsh-auth-token'], 'account-token')
    assert.equal(headers['x-api-key'], undefined)
  } finally {
    fake.restore()
  }
})

test('429 → RATE_LIMIT 带 providerRetryAfterMs', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const fake = useFetch(() => new Response(JSON.stringify({ error: { message: 'slow down' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '2' },
  }))
  try {
    await assert.rejects(
      run(state.adapter),
      error => error.code === 'RATE_LIMIT' && error.failure?.providerRetryAfterMs === 2000,
    )
  } finally {
    fake.restore()
  }
})

test('账户 401 → ACCOUNT_TOKEN_INVALID 并清除失效令牌', async () => {
  let rejected
  const account = { resolveToken: async () => 'account-token', rejectToken: async token => { rejected = token } }
  const { ctx, state } = makeCtx({ account })
  apply(ctx, { auth: 'account' })
  const fake = useFetch(() => new Response('{}', { status: 401 }))
  try {
    await assert.rejects(run(state.adapter), error => error.code === 'ACCOUNT_TOKEN_INVALID')
    assert.equal(rejected, 'account-token')
  } finally {
    fake.restore()
  }
})

test('缺少凭据 → MISSING_CREDENTIAL，且不发请求', async () => {
  const { ctx, state } = makeCtx({ key: undefined })
  apply(ctx, { apiKeyEnv: 'DSH_CHATDEMO_ABSENT_KEY' })
  const fake = useFetch(() => new Response(sse(OK_EVENTS), { status: 200 }))
  try {
    await assert.rejects(run(state.adapter), error => error.code === 'MISSING_CREDENTIAL')
    assert.equal(fake.calls.length, 0)
  } finally {
    fake.restore()
  }
})

test('文件附件 → UNSUPPORTED_CONTENT，不发请求', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const fake = useFetch(() => new Response(sse(OK_EVENTS), { status: 200 }))
  try {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
      { role: 'user', content: [{ type: 'file', path: 'a.pdf' }] },
    ]
    await assert.rejects(run(state.adapter, { messages }), error => error.code === 'UNSUPPORTED_CONTENT')
    assert.equal(fake.calls.length, 0)
  } finally {
    fake.restore()
  }
})

test('非法配置在 apply 时失败', () => {
  const { ctx } = makeCtx()
  assert.throws(() => apply(ctx, { baseURL: 'https://example.com' }), error => error.code === 'INVALID_CONFIG')
})

test('模型目录：两个变体都在，且带推理档位', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const models = await state.adapter.listModels()
  assert.deepEqual(models.map(m => m.id), [CHATDEMO_MODEL, CHATDEMO_MODEL_NOSEARCH])
  assert.deepEqual(models[0].reasoning.efforts.map(e => e.id), ['off', 'high'])
  assert.ok(models[0].inputModalities.includes('image'))
})
