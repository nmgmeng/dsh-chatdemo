/**
 * SSE 分帧与空闲超时。
 *
 * readSse 把 fetch 的 ReadableStream 拆成已解析事件；withIdle 在外层给每次
 * 读取加一个空闲计时器：超时就 abort 上游并抛 TIMEOUT（不会无限等）。
 */
import { llmError } from './errors.js'

/**
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<Record<string, any>>}
 */
export async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n')
        if (data.length === 0) continue
        try {
          yield JSON.parse(data)
        } catch {
          // 无法解析的帧直接跳过，与 demo 客户端行为一致。
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* 连接已断开 */ }
  }
}

/**
 * 给事件迭代器加空闲超时。
 * @template T
 * @param {AsyncIterable<T>} events
 * @param {{ idleTimeoutMs: number, signal?: AbortSignal, controller?: AbortController }} options
 * @returns {AsyncGenerator<T>}
 */
export async function* withIdle(events, options) {
  const idleTimeoutMs = options.idleTimeoutMs
  const controller = options.controller
  const iterator = events[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { controller?.abort() } catch { /* 已结束 */ }
          reject(llmError('TIMEOUT', `chatdemo: 上游超过 ${idleTimeoutMs} 毫秒没有任何响应（可在插件行调大 idleTimeoutMs）。`))
        }, idleTimeoutMs)
      })
      let result
      try {
        const next = iterator.next()
        // timeout 先到时，这个 next 可能稍后才失败；挂一个空 catch 防止未处理拒绝。
        if (typeof next?.catch === 'function') next.catch(() => {})
        result = await Promise.race([next, timeout])
      } catch (error) {
        if (options.signal?.aborted === true) throw llmError('ABORTED', 'chatdemo: 请求已取消。')
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (result.done === true) return
      yield result.value
    }
  } finally {
    // 不等待：挂起的 read 可能永远不返回，await return() 会把取消也拖住。
    try {
      const returned = iterator.return?.()
      if (returned !== undefined && typeof returned.then === 'function') returned.catch(() => {})
    } catch {
      // 已结束
    }
  }
}
