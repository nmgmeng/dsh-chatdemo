/**
 * dsh-chatdemo：把 chat-demo 的请求形状注册成 DSH 的一个 provider。
 *
 * 这是一个 Host 插件：不 import 任何 @deepseek-ai/* 运行时包，adapter 用普通
 * 对象实现 LlmAdapter 契约。请求体由 wire.js 构造，事件由 stream-map.js 映射。
 *
 * 契约（不可配置）：一句话 system、safety_check=high、服务端搜索工具、
 * 不发 max_tokens/temperature/output_config、只回放正文与 read_link、
 * 固定上游端点 https://api.deepseek.com/anthropic。
 */
import { buildMessages, buildBody, createReminder, MODEL, SYSTEM_PROMPT } from './wire.js'
import { readSse, withIdle } from './sse.js'
import { mapEvents } from './stream-map.js'
import { llmError, failureCodeForStatus, errorMessageFromBody, parseRetryAfter } from './errors.js'
import { resolveConfig } from './config.js'
import { resolveAuth, MESSAGES_URL, FILES_URL, USER_AGENT } from './auth.js'

/** chat-demo 上传前把长边压到这个像素上限；未超限时原样上传。 */
const MAX_IMAGE_EDGE = 4096
/** Files API 的 beta 头，与 demo 一致。 */
const FILES_BETA = 'files-api-2025-04-14'
/** Files API 上传超时（单次）。 */
const FILE_UPLOAD_TIMEOUT_MS = 60000

/** Electron 主进程才有 nativeImage；web/测试环境下为 undefined。 */
let nativeImage
try {
  ({ nativeImage } = await import('electron'))
} catch {
  nativeImage = undefined
}

/** 长边超过 4096 时按比例缩小；JPEG 用 JPEG 编码，其余用 PNG（退回原图不阻断请求）。 */
function fitImage(data, mediaType) {
  if (typeof nativeImage?.createFromBuffer !== 'function') return { bytes: data, mediaType }
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(data))
    if (image.isEmpty()) return { bytes: data, mediaType }
    const { width, height } = image.getSize()
    const longest = Math.max(width, height)
    if (longest <= MAX_IMAGE_EDGE) return { bytes: data, mediaType }
    const scale = MAX_IMAGE_EDGE / longest
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'best',
    })
    return mediaType === 'image/jpeg'
      ? { bytes: resized.toJPEG(100), mediaType: 'image/jpeg' }
      : { bytes: resized.toPNG(), mediaType: 'image/png' }
  } catch {
    return { bytes: data, mediaType }
  }
}

/** 单次失败的可读说明；不包含请求体、令牌或用户内容。 */
function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * 建立本轮的取消控制：外部 signal 只做桥接，超时由各阶段自己的计时器触发。
 * @param {AbortSignal | undefined} external
 */
function createIdle(external) {
  const controller = new AbortController()
  const onAbort = () => {
    try { controller.abort() } catch { /* 已结束 */ }
  }
  if (external?.aborted === true) onAbort()
  else external?.addEventListener?.('abort', onAbort, { once: true })
  return {
    controller,
    signal: controller.signal,
    get externallyAborted() { return external?.aborted === true },
    stop() { external?.removeEventListener?.('abort', onAbort) },
  }
}

/** 带超时的 fetch：超时先 abort，再抛 TIMEOUT。 */
async function fetchWithTimeout(url, init, timeoutMs, externalSignal) {
  const controller = new AbortController()
  const onAbort = () => {
    try { controller.abort() } catch { /* 已结束 */ }
  }
  if (externalSignal?.aborted === true) onAbort()
  else externalSignal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort() } catch { /* 已结束 */ }
      reject(llmError('TIMEOUT', `chatdemo: 上游超过 ${timeoutMs} 毫秒没有响应（可在插件行调大 idleTimeoutMs）。`))
    }, timeoutMs)
  })
  try {
    const request = fetch(url, { ...init, signal: controller.signal })
    // 超时先到时请求可能稍后才失败；挂一个空 catch 防止未处理拒绝。
    if (typeof request?.catch === 'function') request.catch(() => {})
    return await Promise.race([request, timeout])
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener?.('abort', onAbort)
  }
}

export const name = 'chatdemo-provider'

export const inject = ['llm']

/** 模型 id：与内置 deepseek 路由区分开。 */
export const CHATDEMO_MODEL = 'chatdemo-flash'

/** 不联网变体：智搜关闭，用模型选择器当“智能搜索”开关。 */
export const CHATDEMO_MODEL_NOSEARCH = 'chatdemo-flash-nosearch'

const PROVIDER = 'chatdemo'

const MODEL_INFO = Object.freeze({
  provider: PROVIDER,
  id: CHATDEMO_MODEL,
  name: 'ChatDemo 1:1',
  description: '按 chat-demo 客户端的请求形状直连：一句话 system、服务端搜索、latest_reminder。',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 1048576 },
  // 只暴露“开/关”，对齐 chat-demo 的深度思考按钮；low/high/max 在 chat-demo 里没有对应概念。
  reasoning: {
    efforts: [
      { id: 'off', name: '关闭' },
      { id: 'high', name: '开启' },
    ],
    defaultEffort: 'high',
  },
})

const MODELS = Object.freeze({
  [CHATDEMO_MODEL]: Object.freeze({ info: MODEL_INFO, search: true }),
  [CHATDEMO_MODEL_NOSEARCH]: Object.freeze({
    info: Object.freeze({
      ...MODEL_INFO,
      id: CHATDEMO_MODEL_NOSEARCH,
      name: 'ChatDemo 1:1（不联网）',
      description: '与 ChatDemo 1:1 相同，但不声明 deepseek_web_search。',
    }),
    search: false,
  }),
})

/** 第三方适配器的失败只被采信自有 code + failure；见 errors.js。 */
function providerFailure(status, authKind, bodyText, retryAfter) {
  const code = failureCodeForStatus(status, authKind)
  const detail = errorMessageFromBody(bodyText)
  const hint = code === 'RATE_LIMIT' ? '（上游限流，稍后重试）' : ''
  return llmError(
    code,
    `chatdemo: HTTP ${status}${detail ? `：${detail}` : ''}${hint}`,
    {
      status,
      ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
    },
  )
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  /** attachmentId → file_id（进程内复用；不落盘）。 */
  const fileIdCache = new Map()

  /**
   * 收集本轮里出现的图片引用；文件块（document）在扩展模式下服务端不支持。
   * @param {readonly any[]} messages
   */
  function collectImages(messages) {
    const refs = []
    for (const message of messages ?? []) {
      for (const block of message?.content ?? []) {
        if (block?.type === 'file') {
          throw llmError(
            'UNSUPPORTED_CONTENT',
            'chatdemo: 聊天模式只支持图片附件；请移除文件附件，或改用普通 DSH 模型处理文档。',
          )
        }
        if (block?.type === 'image') {
          if (block.offloaded === true) {
            throw llmError('UNSUPPORTED_CONTENT', 'chatdemo: 这张图片已被移出请求，无法上传。')
          }
          refs.push(block.attachment)
        }
      }
    }
    return refs
  }

  /** 把一张规范化图片上传到 Files API，返回 file_id。 */
  async function ensureFileId(ref, auth, signal) {
    const cached = fileIdCache.get(ref.attachmentId)
    if (cached !== undefined) return cached
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      throw llmError('INVALID_REQUEST', 'chatdemo: 没有 attachments 服务，无法读取图片。')
    }
    const bytes = await attachments.readImageRequest(
      ref,
      { width: ref.width, height: ref.height, maxBytes: ref.bytes },
      signal,
    )
    const fitted = fitImage(bytes.data, bytes.mediaType)
    const form = new FormData()
    form.append('file', new Blob([fitted.bytes], { type: fitted.mediaType }), ref.name ?? 'image')
    let response
    try {
      response = await fetchWithTimeout(FILES_URL, {
        method: 'POST',
        headers: {
          ...auth.headers,
          'anthropic-beta': FILES_BETA,
          'user-agent': USER_AGENT,
        },
        body: form,
      }, FILE_UPLOAD_TIMEOUT_MS, signal)
    } catch (error) {
      if (error?.failure !== undefined) throw error
      if (signal?.aborted === true) throw llmError('ABORTED', 'chatdemo: 图片上传已取消。')
      throw llmError('FILES_API', `chatdemo: 图片上传失败：${messageOf(error)}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw llmError('FILES_API', `chatdemo: 图片上传 HTTP ${response.status}：${errorMessageFromBody(text)}`, { status: response.status })
    }
    const payload = await response.json().catch(() => undefined)
    if (typeof payload?.id !== 'string' || payload.id.length === 0) {
      throw llmError('FILES_API', 'chatdemo: 图片上传响应缺少 file id。')
    }
    fileIdCache.set(ref.attachmentId, payload.id)
    return payload.id
  }

  /**
   * 一次模型调用。options 由 DSH 的 LLM 运行时给出。
   * @param {any} options
   */
  async function* stream(options) {
    const auth = await resolveAuth(ctx, config)
    const idle = createIdle(options.signal)
    try {
      const images = collectImages(options.messages)
      const fileIds = new Map()
      for (const ref of images) {
        if (!fileIds.has(ref.attachmentId)) {
          fileIds.set(ref.attachmentId, await ensureFileId(ref, auth, options.signal))
        }
      }

      const reminder = createReminder({ locale: 'zh-CN', location: '' })
      // “深度思考”开关：模型选择器里的 reasoning effort 选 off 即关闭；其余都按开启处理。
      const thinking = options.reasoningEffort !== 'off'
      // “智能搜索”开关：不联网模型只声明 deepseek_read_url。
      const modelEntry = MODELS[options.model] ?? MODELS[CHATDEMO_MODEL]
      const search = modelEntry.search
      const built = buildMessages({
        messages: options.messages,
        system: options.system,
        reminder,
        fileIdOf: block => fileIds.get(block.attachment.attachmentId),
      })
      const body = { ...buildBody({ system: built.system, messages: built.messages, thinking, search }), stream: true }

      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': USER_AGENT,
        ...auth.headers,
      }
      if (fileIds.size > 0) headers['anthropic-beta'] = FILES_BETA

      let response
      try {
        response = await fetchWithTimeout(MESSAGES_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, config.idleTimeoutMs, options.signal)
      } catch (error) {
        if (error?.failure !== undefined) throw error
        if (idle.externallyAborted) throw llmError('ABORTED', 'chatdemo: 请求已取消。')
        throw llmError('TRANSPORT', `chatdemo: 网络失败：${messageOf(error)}`)
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const failure = providerFailure(
          response.status,
          auth.kind,
          text,
          parseRetryAfter(response.headers.get('retry-after')),
        )
        if (auth.kind === 'account' && (response.status === 401 || response.status === 403)) auth.reject?.()
        throw failure
      }
      if (response.body === null) {
        throw llmError('MALFORMED_RESPONSE', 'chatdemo: 响应没有 body。')
      }

      try {
        yield* mapEvents(
          withIdle(readSse(response.body), {
            idleTimeoutMs: config.idleTimeoutMs,
            signal: options.signal,
            controller: idle.controller,
          }),
          { model: options.model ?? MODEL, reminder },
        )
      } catch (error) {
        if (error?.failure !== undefined) throw error
        if (idle.externallyAborted) throw llmError('ABORTED', 'chatdemo: 请求已取消。')
        throw llmError('TRANSPORT', `chatdemo: 读取响应失败：${messageOf(error)}`)
      }
    } finally {
      idle.stop()
    }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'ChatDemo (1:1)' }
    },

    // 交给 dsh-llm-retry 的默认策略：可重试的失败码与退避。
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 5,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        backoff: Object.freeze({ initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }),
      })
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels() {
      return Object.values(MODELS).map(entry => entry.info)
    },

    async resolveModel(provider, model) {
      const entry = MODELS[model]
      if (entry === undefined) {
        throw llmError('UNKNOWN_MODEL', `chatdemo: 未知模型 ${model}`)
      }
      return entry.info
    },

    async prepareCall(provider, model) {
      const entry = MODELS[model]
      if (entry === undefined) {
        throw llmError('UNKNOWN_MODEL', `chatdemo: 未知模型 ${model}`)
      }
      return { model: entry.info, stream: opts => stream(opts) }
    },

    stream,
  }

  ctx.llm.registerAdapter([PROVIDER], adapter)
}

export { SYSTEM_PROMPT }
