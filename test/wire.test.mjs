import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  MODEL, SYSTEM_PROMPT, SAFETY_CHECK, REPLAY_KIND,
  createReminder, toUserParam, readReplay, toAssistantParam, hasUsableText,
  buildMessages, buildBody,
} from '../src/wire.js'

const fileIdOf = () => 'file-api-test'
const text = t => ({ type: 'text', text: t })
const reasoning = t => ({ type: 'reasoning', text: t })
const system = t => ({ role: 'system', content: [text(t)] })
const user = (...blocks) => ({ role: 'user', content: blocks })
const assistant = (blocks, replay) => ({
  role: 'assistant',
  content: blocks,
  source: { kind: 'model', provider: 'chatdemo', model: MODEL, ...(replay ? { replayState: replay } : {}) },
})
const replay = (reminder, readLinks = []) => ({
  response: { kind: REPLAY_KIND, version: 1, model: MODEL, reminder, readLinks },
})

test('reminder 格式与语言', () => {
  const reminder = createReminder({ now: new Date(2026, 10, 23, 12, 0, 0), locale: 'zh-CN' })
  assert.match(reminder, /^2026-11-23,.+,Web,中文$/)
  assert.ok(!reminder.startsWith('2026-11-23,,,'))
  assert.equal(createReminder({ now: new Date(2026, 10, 23), locale: 'en-US' }).split(',')[4], 'English')
})

test('单轮：system 提取、reminder 插入、user 字符串形式', () => {
  const built = buildMessages({
    messages: [system(SYSTEM_PROMPT), user(text('你好'))],
    reminder: '2026-11-23,星期日,,Web,中文',
    fileIdOf,
  })
  assert.equal(built.system, SYSTEM_PROMPT)
  assert.deepEqual(built.messages, [
    { role: 'latest_reminder', content: '2026-11-23,星期日,,Web,中文' },
    { role: 'user', content: '你好' },
  ])
})

test('历史：思考不回传、reminder 去重', () => {
  const built = buildMessages({
    messages: [
      system(SYSTEM_PROMPT),
      user(text('第一问')),
      assistant([reasoning('内部思考'), text('第一答')], replay('R1')),
      user(text('第二问')),
    ],
    reminder: 'R1',
    fileIdOf,
  })
  assert.deepEqual(built.messages, [
    { role: 'latest_reminder', content: 'R1' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
    { role: 'user', content: '第二问' },
  ])
})

test('reminder 变化时再插一条', () => {
  const built = buildMessages({
    messages: [
      system(SYSTEM_PROMPT),
      user(text('Q1')),
      assistant([text('A1')], replay('R1')),
      user(text('Q2')),
      assistant([text('A2')], replay('R2')),
      user(text('Q3')),
    ],
    reminder: 'R2',
    fileIdOf,
  })
  const reminders = built.messages.filter(m => m.role === 'latest_reminder').map(m => m.content)
  assert.deepEqual(reminders, ['R1', 'R2'])
})

test('文本合并：相邻拼接、被思考隔开补空行', () => {
  assert.deepEqual(
    toAssistantParam(assistant([text('A'), text('B')]), {}).content,
    [{ type: 'text', text: 'AB' }],
  )
  assert.deepEqual(
    toAssistantParam(assistant([text('A'), reasoning('t'), text('B')]), {}).content,
    [{ type: 'text', text: 'A' }, { type: 'text', text: '\n\nB' }],
  )
})

test('read_link 回放：调用与结果原样在前', () => {
  const use = { type: 'server_tool_use', id: 'srvtoolu_x', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://e.x' }, kind: 'read_link' }
  const result = { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_x', content: { type: 'web_fetch_result', url: 'https://e.x' }, kind: 'read_link', signature: 'sig' }
  const message = assistant([text('读完了')], replay(undefined, [{ use, result }]))
  assert.deepEqual(
    toAssistantParam(message, readReplay(message)).content,
    [use, result, { type: 'text', text: '读完了' }],
  )
})

test('没有正文的轮次整轮丢弃', () => {
  const built = buildMessages({
    messages: [
      system(SYSTEM_PROMPT),
      user(text('Q1')),
      assistant([reasoning('只有思考')], replay('R1')),
      user(text('Q2')),
    ],
    reminder: 'R1',
    fileIdOf,
  })
  assert.deepEqual(built.messages, [
    { role: 'latest_reminder', content: 'R1' },
    { role: 'user', content: 'Q2' },
  ])
})

test('图片：文件在前、文本在后、file_id 引用', () => {
  const withImage = toUserParam(
    user({ type: 'image', attachment: { attachmentId: 'sha256:x' } }, text('帮我判作业')),
    fileIdOf,
  )
  assert.deepEqual(withImage, {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'file', file_id: 'file-api-test' } },
      { type: 'text', text: '帮我判作业' },
    ],
  })
})

test('body：工具顺序、thinking、safety、无 max_tokens', () => {
  const body = buildBody({ system: SYSTEM_PROMPT, messages: [], thinking: true, search: true })
  assert.equal(body.model, MODEL)
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.deepEqual(body.safety_check, SAFETY_CHECK)
  assert.deepEqual(body.tools.map(t => t.name), ['deepseek_read_url', 'deepseek_web_search'])
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.output_config, undefined)
  assert.equal(body.temperature, undefined)
  assert.deepEqual(buildBody({ system: 's', messages: [], search: false }).tools.map(t => t.name), ['deepseek_read_url'])
  assert.deepEqual(buildBody({ system: 's', messages: [], thinking: false }).thinking, { type: 'disabled' })
})

test('工具函数', () => {
  assert.equal(hasUsableText(assistant([reasoning('x')])), false)
  assert.equal(hasUsableText(assistant([text(' ')])), false)
  assert.equal(hasUsableText(assistant([text('有')])), true)
  assert.equal(readReplay(assistant([], { response: { kind: 'other', version: 1 } })), undefined)
})
