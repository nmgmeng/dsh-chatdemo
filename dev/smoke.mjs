/**
 * 直连冒烟：验证 wire body 与上游 SSE，不经过 DSH。
 *
 *   PowerShell:  $env:DEEPSEEK_API_KEY = '...'; node dev/smoke.mjs
 *
 * 只从环境变量读 key，不读任何文件；输出不含 key 与请求头。
 */
import { strict as assert } from 'node:assert'
import { buildBody, buildMessages, createReminder, SYSTEM_PROMPT } from '../src/wire.js'
import { readSse } from '../src/sse.js'

const key = process.env.DEEPSEEK_API_KEY
if (typeof key !== 'string' || key.length === 0) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY')
  process.exit(2)
}

const reminder = createReminder({ locale: 'zh-CN' })
const built = buildMessages({
  messages: [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: '用一句话介绍你自己。' }] },
  ],
  reminder,
  fileIdOf: () => {
    throw new Error('本次冒烟不涉及图片')
  },
})
const body = { ...buildBody({ system: built.system, messages: built.messages, thinking: true, search: false }), stream: true }
assert.equal(body.max_tokens, undefined)
assert.equal(body.temperature, undefined)
assert.equal(body.system, SYSTEM_PROMPT)

const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)',
    'x-api-key': key,
  },
  body: JSON.stringify(body),
})
if (!response.ok) {
  console.error('HTTP', response.status, (await response.text()).slice(0, 300))
  process.exit(1)
}

let text = ''
let finish
for await (const event of readSse(response.body)) {
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text ?? ''
  if (event.type === 'content_block_start' && event.content_block?.type === 'text') text += event.content_block.text ?? ''
  if (event.type === 'message_delta') finish = event.delta?.stop_reason
  if (event.type === 'error') throw new Error(`stream error: ${JSON.stringify(event.error)}`)
}
console.log('stop_reason:', finish)
console.log('text:', text.slice(0, 200))
console.log('OK: 真实请求通过（未打印任何凭据）')
