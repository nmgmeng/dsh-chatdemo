import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mapEvents } from '../src/stream-map.js'
import { readSse, withIdle } from '../src/sse.js'

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const events = [
  { type: 'message_start', message: { id: 'm1', model: 'deepseek-flash', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '我们' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '需要' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'deepseek_web_search', input: {}, kind: 'deep_search' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [], kind: 'deep_search' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '你好' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '！' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { url: 'https://e.x' } } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]

test('块序列：联网过程合并为末尾一个推理块', async () => {
  const chunks = await collect(mapEvents((async function* () { yield* events })(), { model: 'chatdemo-flash', reminder: 'R' }))
  assert.deepEqual(chunks.map(c => c.type), [
    'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'text-delta', 'block-end',
    'block-start', 'reasoning-delta', 'block-end',
    'usage', 'finish',
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[3].block, { type: 'reasoning', text: '我们需要' })
  assert.deepEqual(chunks[4], { type: 'block-start', index: 1, blockType: 'text' })
  assert.deepEqual(chunks[7].block, { type: 'text', text: '你好！' })
  assert.deepEqual(chunks[8], { type: 'block-start', index: 2, blockType: 'reasoning' })
  assert.deepEqual(chunks[9], { type: 'reasoning-delta', index: 2, text: '[联网] 搜索到 0 个网页' })
  assert.deepEqual(chunks[10].block, { type: 'reasoning', text: '[联网] 搜索到 0 个网页' })
  assert.equal(chunks[11].usage.inputTokens, 10)
  assert.equal(chunks[11].usage.outputTokens, 5)
  assert.equal(chunks[11].usage.totalTokens, 15)
  assert.deepEqual(chunks[12].reason, { kind: 'stop' })
  assert.equal(chunks[12].replayState.response.kind, 'chatdemo-messages')
  assert.equal(chunks[12].replayState.response.reminder, 'R')
})

test('read_link 只有带签名才进入 replayState', async () => {
  const readLinkEvents = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'r1', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://e.x' }, kind: 'read_link' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', tool_use_id: 'r1', content: { type: 'web_fetch_result', url: 'https://e.x' }, kind: 'read_link', signature: 'sig' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '读完了' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const chunks = await collect(mapEvents((async function* () { yield* readLinkEvents })(), { model: 'm' }))
  const readLinks = chunks.at(-1).replayState.response.readLinks
  assert.equal(readLinks.length, 1)
  assert.equal(readLinks[0].use.id, 'r1')
  assert.equal(readLinks[0].result.signature, 'sig')

  const unsigned = readLinkEvents.map(e => e.type === 'content_block_start' && e.content_block.type === 'web_fetch_tool_result'
    ? { ...e, content_block: { ...e.content_block, signature: '' } }
    : e)
  const unsignedChunks = await collect(mapEvents((async function* () { yield* unsigned })(), { model: 'm' }))
  assert.equal(unsignedChunks.at(-1).replayState.response.readLinks.length, 0)
})

test('正文跨多个 wire 文本块必须合并成一个 DSH 文本块', async () => {
  const splitText = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '满足以下' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**任意一项**即可诊断' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '继续' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '。\n\n| 指标 | 界值 |\n| :--- | :--- |\n| TC | 5.2 |' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '\n| TG | 1.7 |' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const merged = await collect(mapEvents((async function* () { yield* splitText })(), { model: 'm' }))
  const textStarts = merged.filter(c => c.type === 'block-start' && c.blockType === 'text')
  assert.equal(textStarts.length, 1)
  const textEnd = merged.find(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text, '满足以下**任意一项**即可诊断。\n\n| 指标 | 界值 |\n| :--- | :--- |\n| TC | 5.2 |\n| TG | 1.7 |')
})

test('协议错误映射成官方失败码', async () => {
  const onlyTools = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's', name: 'deepseek_web_search', input: {}, kind: 'deep_search' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  await assert.rejects(
    collect(mapEvents((async function* () { yield* onlyTools })(), { model: 'm' })),
    error => error.code === 'EMPTY_RESPONSE' && /empty response/.test(error.message),
  )
  await assert.rejects(
    collect(mapEvents((async function* () { yield events[0] })(), { model: 'm' })),
    error => error.code === 'STREAM_CLOSED' && /before message_stop/.test(error.message),
  )
  await assert.rejects(
    collect(mapEvents((async function* () {
      yield { type: 'message_start', message: { usage: {} } }
      yield { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }
    })(), { model: 'm' })),
    error => error.code === 'RATE_LIMIT',
  )
})

test('SSE 分帧：跨 chunk 切断也能解析', async () => {
  const sseText = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'
    + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"A"}}\n\n'
  const bytes = new TextEncoder().encode(sseText)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 20))
      controller.enqueue(bytes.slice(20, 60))
      controller.enqueue(bytes.slice(60))
      controller.close()
    },
  })
  const parsed = await collect(readSse(stream))
  assert.deepEqual(parsed.map(e => e.type), ['message_start', 'content_block_start'])
  assert.equal(parsed[1].content_block.text, 'A')
})

test('withIdle：无响应时按 TIMEOUT 失败', async () => {
  const hang = (async function* () {
    await new Promise(() => {})
  })()
  await assert.rejects(
    collect(withIdle(hang, { idleTimeoutMs: 20 })),
    error => error.code === 'TIMEOUT',
  )
})
