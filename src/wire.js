/**
 * chat-demo 1:1 请求构造。
 *
 * 契约来源：github.com/deepseek-ai/chat-demo（main）的
 * `src/services/chat/reply.ts` / `src/services/chat/store.ts`，逐条对应
 * docs/SPEC.md。本文件只做「DSH 消息 → chat-demo wire body」的纯函数转换，
 * 不碰网络，方便单测。
 */

/** demo 固定使用的模型 id。 */
export const MODEL = 'deepseek-flash'

/** demo 的固定 system 提示词。 */
export const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 安全审查恒为 high。 */
export const SAFETY_CHECK = Object.freeze({ level: 'high' })

/** 阅读链接工具恒在。 */
export const TOOL_READ_URL = Object.freeze({ type: 'deepseek_read_url', name: 'deepseek_read_url' })

/** 智能搜索工具在搜索开关打开时追加。 */
export const TOOL_WEB_SEARCH = Object.freeze({ type: 'deepseek_web_search', name: 'deepseek_web_search' })

/** replayState 里我们自己的响应类别。 */
export const REPLAY_KIND = 'chatdemo-messages'

const pad = (value, length = 2) => String(value).padStart(length, '0')

/**
 * demo 的 latest_reminder 五项：日期、星期、地点、平台、语言。
 * 日期与星期用本地时区；地点未知时为空串。
 * @param {{ now?: Date, locale?: string, location?: string }} [options]
 * @returns {string} 例如 `2026-11-23,星期日,,Web,中文`
 */
export function createReminder(options = {}) {
  const now = options.now ?? new Date()
  const locale = options.locale ?? 'zh-CN'
  const location = options.location ?? ''
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const language = locale === 'en-US' ? 'English' : '中文'
  return [date, weekday, location, 'Web', language].join(',')
}

/**
 * 把一条 user 消息转成 demo 的 MessageParam。
 * 文件在前、文本在后；无文件时用字符串形式。
 * @param {{ content: readonly any[] }} message
 * @param {(block: any) => string} fileIdOf 返回 Files API 的 file_id
 * @returns {{ role: 'user', content: string | any[] }}
 */
export function toUserParam(message, fileIdOf) {
  const blocks = []
  const texts = []
  for (const block of message.content ?? []) {
    if (block?.type === 'image' || block?.type === 'file') {
      blocks.push({
        type: block.type === 'image' ? 'image' : 'document',
        source: { type: 'file', file_id: fileIdOf(block) },
      })
    } else if (block?.type === 'text') {
      texts.push(block.text)
    }
  }
  const text = texts.join('')
  if (blocks.length === 0) {
    return { role: 'user', content: text }
  }
  const parts = [...blocks]
  if (text.length > 0) {
    parts.push({ type: 'text', text })
  }
  return { role: 'user', content: parts }
}

/**
 * 读取 assistant 消息上的 chatdemo replayState。
 * @param {{ source?: any }} message
 * @returns {{ reminder?: string, readLinks?: any[] } | undefined}
 */
export function readReplay(message) {
  const state = message?.source?.replayState
  if (state === null || typeof state !== 'object') return undefined
  const response = state.response
  if (response === null || typeof response !== 'object') return undefined
  if (response.kind !== REPLAY_KIND || response.version !== 1) return undefined
  return {
    reminder: typeof response.reminder === 'string' ? response.reminder : undefined,
    readLinks: Array.isArray(response.readLinks) ? response.readLinks : [],
  }
}

/**
 * 转一条 assistant 历史消息：历史思考不回传；文本去掉 citations 合并；
 * read_link 的调用与结果原样回传（结果带 signature）。
 * @param {{ content: readonly any[] }} message
 * @param {{ readLinks?: any[] }} replay
 * @returns {{ role: 'assistant', content: any[] }}
 */
export function toAssistantParam(message, replay) {
  const content = []
  // read_link 对先回传：demo 里它发生在正文之前，且历史正文只剩 text。
  for (const pair of replay.readLinks ?? []) {
    const use = pair?.use
    if (use) {
      content.push({ type: use.type, id: use.id, name: use.name, input: use.input, kind: use.kind })
    }
    if (pair?.result) {
      content.push(pair.result)
    }
  }
  let text = null
  for (const block of message.content ?? []) {
    if (block?.type === 'text') {
      if (text !== null) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = { type: 'text', text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}` }
        content.push(text)
      }
      continue
    }
    // 思考、客户端工具调用等一律不回传（demo 的 toAssistantParam 语义）。
    text = null
  }
  return { role: 'assistant', content: content.filter(block => block.type !== 'text' || block.text !== '') }
}

/**
 * 判断一轮回答是否可用：有非空正文；被拒绝的轮次不回传。
 * @param {{ content: readonly any[] }} message
 */
export function hasUsableText(message) {
  return (message.content ?? []).some(block => block?.type === 'text' && block.text.trim() !== '')
}

/**
 * 从 DSH 的消息序列构造 demo 的 messages。
 *
 * - 首条 system 消息给出 system，其余 system 忽略；
 * - 只保留「user + 可用 assistant」成对的轮次；末尾的 user 是本轮提问；
 * - reminder 只在内容变化时插入，插在对应 user 之前；
 * - 本轮 reminder 由调用方给出（适配器在请求时计算）。
 *
 * @param {object} input
 * @param {readonly any[]} input.messages DSH 的 RequestMessage 序列
 * @param {string} [input.system] 显式 system（一次性调用时用）
 * @param {string} input.reminder 本轮 latest_reminder
 * @param {(block: any) => string} input.fileIdOf 图片/文件到 file_id 的映射
 * @returns {{ system: string, messages: any[] }}
 */
export function buildMessages({ messages, system, reminder, fileIdOf }) {
  let systemText = system ?? ''
  const conversation = []
  for (const message of messages ?? []) {
    if (message?.role === 'system') {
      const text = (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('')
      if (text.length > 0) systemText = systemText.length > 0 ? `${systemText}\n\n${text}` : text
      continue
    }
    conversation.push(message)
  }

  const out = []
  let previousReminder
  const pushReminder = value => {
    if (typeof value === 'string' && value.length > 0 && value !== previousReminder) {
      out.push({ role: 'latest_reminder', content: value })
      previousReminder = value
    }
  }

  let index = 0
  while (index < conversation.length) {
    const user = conversation[index]
    const assistant = conversation[index + 1]
    if (user?.role !== 'user') {
      index += 1
      continue
    }
    if (assistant?.role !== 'assistant') {
      // 末尾提问；中间孤立 user 直接丢弃。
      if (index === conversation.length - 1) {
        pushReminder(reminder)
        out.push(toUserParam(user, fileIdOf))
        index += 1
        continue
      }
      index += 1
      continue
    }
    if (!hasUsableText(assistant)) {
      // demo 的 isUsableReply：没有正文的轮次整轮丢弃。
      index += 2
      continue
    }
    const replay = readReplay(assistant) ?? {}
    pushReminder(replay.reminder)
    out.push(toUserParam(user, fileIdOf))
    out.push(toAssistantParam(assistant, replay))
    index += 2
  }

  return { system: systemText.length > 0 ? systemText : SYSTEM_PROMPT, messages: out }
}

/**
 * 组装完整请求体（不含 stream；由传输层追加）。
 * @param {object} input
 * @param {string} input.system
 * @param {any[]} input.messages
 * @param {boolean} [input.thinking]
 * @param {boolean} [input.search]
 * @returns {object}
 */
export function buildBody({ system, messages, thinking = true, search = true }) {
  return {
    model: MODEL,
    system,
    messages,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    tools: search ? [TOOL_READ_URL, TOOL_WEB_SEARCH] : [TOOL_READ_URL],
    safety_check: SAFETY_CHECK,
  }
}
