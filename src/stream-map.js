/**
 * chat-demo SSE 事件 → DSH StreamChunk。
 *
 * 只处理 text / thinking 两类内容块；server_tool_use、web_search_tool_result、
 * web_fetch_tool_result、citations、signature 都不进入 DSH 的块模型——
 * 它们要么与正文无关，要么按 SPEC 的回放规则根本不回传。
 *
 * 纯函数，输入是已解析的 SSE 事件对象，方便单测。
 */
import { llmError } from './errors.js'

/** 把 chat-demo 的 stop_reason 映射成 DSH 的 FinishReason。 */
export function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn': return { kind: 'stop' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'refusal': return { kind: 'stop' }
    default: return { kind: 'stop' }
  }
}

/** 一条服务端工具事件的可读描述；返回 undefined 表示不展示。 */
export function describeServerTool(block) {
  if (block?.type === 'server_tool_use') {
    const input = block.input ?? {}
    switch (input.action) {
      case 'search': {
        const queries = Array.isArray(input.queries) ? input.queries : input.query ? [input.query] : []
        return queries.length > 0 ? `[联网] 搜索：${queries.join(' / ')}` : '[联网] 搜索'
      }
      case 'open_page': return `[联网] 打开：${input.url ?? ''}`
      case 'find_in_page': return `[联网] 查找：${input.url ?? ''}`
      case 'read_link': return `[联网] 阅读：${input.url ?? ''}`
      default: return undefined
    }
  }
  if (block?.type === 'web_search_tool_result') {
    const results = Array.isArray(block.content) ? block.content.filter(item => item?.type === 'web_search_result') : []
    return `[联网] 搜索到 ${results.length} 个网页`
  }
  if (block?.type === 'web_fetch_tool_result' && block.content?.type === 'web_fetch_result') {
    return `[联网] 已读取：${block.content.url ?? ''}`
  }
  return undefined
}

/** 从 wire usage 更新累计用量。 */
export function updateUsage(usage, raw) {
  if (!raw || typeof raw !== 'object') return
  const pairs = [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
  ]
  for (const [wire, local] of pairs) {
    const value = raw[wire]
    if (Number.isSafeInteger(value) && value >= 0) usage[local] = value
  }
}

/** 流内 error 帧 → 失败码。 */
function streamErrorCode(error) {
  const type = typeof error?.type === 'string' ? error.type : ''
  if (type.includes('rate_limit')) return 'RATE_LIMIT'
  if (type.includes('overloaded') || type.includes('api_error') || type.includes('server')) return 'SERVER'
  if (type.includes('auth') || type.includes('permission')) return 'AUTH'
  return 'INVALID_RESPONSE'
}

/**
 * @param {AsyncIterable<Record<string, any>>} events 已解析的 SSE 事件
 * @param {{ model: string, reminder?: string }} options
 * @returns {AsyncGenerator<any>}
 */
export async function* mapEvents(events, options) {
  const usage = { inputTokens: 0, outputTokens: 0 }
  /** wire index → { emitted: number|null, type: 'text'|'reasoning', text: string } */
  const blocks = new Map()
  /** read_link 的调用与结果；只有带 signature 的结果才进入回放。 */
  const readUses = new Map()
  const readResults = new Map()
  let emitted = 0
  let reason
  let started = false
  let settled = false
  let refusal = false
  /** 整个响应只保留一个正文块：服务端会因引用把正文切成多段，DSH 按块渲染会切断表格和句子。 */
  let openText = null
  /** 联网过程行：全部收集后作为一个推理块收尾，避免思考面板被拆成很多小段。 */
  const traceLines = []

  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        if (started) throw llmError('MALFORMED_RESPONSE', 'chatdemo: duplicate message_start')
        started = true
        updateUsage(usage, event.message?.usage)
        break
      }
      case 'content_block_start': {
        if (!started) throw llmError('MALFORMED_RESPONSE', 'chatdemo: event precedes message_start')
        const native = event.content_block ?? {}
        if (native.type === 'text') {
          const initial = native.text ?? ''
          if (openText === null) {
            openText = { index: emitted++, text: initial }
            yield { type: 'block-start', index: openText.index, blockType: 'text' }
          } else {
            openText.text += initial
          }
          blocks.set(event.index, { emitted: openText.index, type: 'text', text: initial })
          if (initial.length > 0) {
            yield { type: 'text-delta', index: openText.index, text: initial }
          }
        } else if (native.type === 'thinking') {
          const initial = native.thinking ?? ''
          const index = emitted++
          blocks.set(event.index, { emitted: index, type: 'reasoning', text: initial })
          yield { type: 'block-start', index, blockType: 'reasoning' }
          if (initial.length > 0) {
            yield { type: 'reasoning-delta', index, text: initial }
          }
        } else {
          // 服务端工具块：不映射成 DSH 块，仅占位以便跳过它的 delta。
          blocks.set(event.index, { emitted: null, type: native.type, text: '' })
          if (native.type === 'server_tool_use' && native.kind === 'read_link') {
            readUses.set(native.id, { type: native.type, id: native.id, name: native.name, input: native.input, kind: native.kind })
          } else if (native.type === 'web_fetch_tool_result' && native.kind === 'read_link') {
            readResults.set(native.tool_use_id, native)
          }
          // 联网过程先收集，流结束时合并成一个推理块。
          const line = describeServerTool(native)
          if (line !== undefined) traceLines.push(line)
        }
        break
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index)
        if (block === undefined || block.emitted === null) break
        const delta = event.delta ?? {}
        if (delta.type === 'text_delta' && block.type === 'text' && openText !== null) {
          openText.text += delta.text ?? ''
          yield { type: 'text-delta', index: openText.index, text: delta.text ?? '' }
        } else if (delta.type === 'thinking_delta' && block.type === 'reasoning') {
          block.text += delta.thinking ?? ''
          yield { type: 'reasoning-delta', index: block.emitted, text: delta.thinking ?? '' }
        }
        // signature_delta / citations_delta / input_json_delta 忽略。
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index)
        if (block === undefined || block.emitted === null) break
        // 正文块故意不在这里结束：整个响应共用一个正文块。
        if (block.type === 'text') break
        yield {
          type: 'block-end',
          index: block.emitted,
          block: { type: 'reasoning', text: block.text },
        }
        block.closed = true
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) {
          reason = mapStopReason(event.delta.stop_reason)
          refusal = event.delta.stop_reason === 'refusal'
        }
        updateUsage(usage, event.usage)
        break
      }
      case 'message_stop': {
        settled = true
        break
      }
      case 'error': {
        const error = event.error ?? event
        const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'stream error'
        throw llmError(streamErrorCode(error), `chatdemo: 上游流内错误：${message}`)
      }
      default:
        // ping 等事件忽略。
        break
    }
    if (settled) break
  }

  if (!settled || reason === undefined) {
    throw llmError('STREAM_CLOSED', 'chatdemo: stream ended before message_stop')
  }
  if (emitted === 0) {
    throw llmError('EMPTY_RESPONSE', 'chatdemo: empty response')
  }
  if (refusal) {
    // demo 对 refusal 丢弃思考与正文；这里已在流式阶段发出，只能按正常结束收尾。
    // v1 记录在 finish 的 meta 里，上游无法撤回已显示的文字。
    reason = { kind: 'stop' }
  }
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  // 只有读取成功且有签名时才回放；签名缺失时调用与结果都不回传（demo 的规则）。
  const readLinks = []
  for (const [id, use] of readUses) {
    const result = readResults.get(id)
    if (result !== undefined && typeof result.signature === 'string' && result.signature.trim() !== '') {
      readLinks.push({ use, result })
    }
  }
  // 正文块在最后收尾（整个响应共用一个块）。
  if (openText !== null) {
    yield { type: 'block-end', index: openText.index, block: { type: 'text', text: openText.text } }
    openText = null
  }
  // 联网过程合并成一个推理块收尾：思考面板里只多一段，而不是每次搜索一段。
  if (traceLines.length > 0) {
    const text = traceLines.join('\n')
    const index = emitted++
    yield { type: 'block-start', index, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'reasoning', text } }
  }
  yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason,
    replayState: {
      response: {
        kind: 'chatdemo-messages',
        version: 1,
        model: options.model,
        ...(options.reminder === undefined ? {} : { reminder: options.reminder }),
        readLinks,
      },
    },
  }
}
