/**
 * 失败构造：让适配器抛出的错误被 DSH 认成官方失败码。
 *
 * 依据 @deepseek-ai/dsh-llm 的 adapter-failure：第三方 Error 只有在同时带
 * 自有 `code` 与 `failure`（两者 code 一致）时才被采信，否则归一成 UNKNOWN。
 * 因此所有错误都带这两样，且绝不包含请求体、令牌或用户内容。
 */

/**
 * @param {string} code LLM_FAILURE_CODES 中的码，或 HTTP_<status>
 * @param {string} message 面向用户的单行说明（不含密钥）
 * @param {{ status?: number, providerRetryAfterMs?: number }} [extra]
 * @returns {Error}
 */
export function llmError(code, message, extra = {}) {
  const text = typeof message === 'string' && message.length > 0 ? message : code
  const error = new Error(text)
  error.name = 'LlmError'
  error.code = code
  error.failure = Object.freeze({
    message: text,
    code,
    ...(Number.isInteger(extra.status) ? { status: extra.status } : {}),
    ...(Number.isFinite(extra.providerRetryAfterMs) && extra.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: extra.providerRetryAfterMs }
      : {}),
  })
  return error
}

/**
 * HTTP 状态 → 官方失败码。
 * @param {number} status
 * @param {'account'|'api-key'} kind
 */
export function failureCodeForStatus(status, kind) {
  switch (status) {
    case 401:
      return kind === 'account' ? 'ACCOUNT_TOKEN_INVALID' : 'AUTH'
    case 403:
      return 'AUTH'
    case 402:
      return kind === 'account' ? 'ACCOUNT_QUOTA' : 'QUOTA'
    case 408:
      return 'TIMEOUT'
    case 429:
      return 'RATE_LIMIT'
    case 400:
    case 404:
    case 413:
    case 415:
    case 422:
      return 'INVALID_REQUEST'
    default:
      return status >= 500 ? 'SERVER' : `HTTP_${status}`
  }
}

/**
 * 从错误响应体里取一句可展示的 message；永不回显请求内容。
 * @param {string} text
 * @returns {string}
 */
export function errorMessageFromBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 400)
  } catch {
    // 非 JSON 错误体：截断原文即可。
  }
  return text.slice(0, 400)
}

/**
 * Retry-After（秒或 HTTP 日期）→ 毫秒。
 * @param {string|null|undefined} header
 * @returns {number|undefined}
 */
export function parseRetryAfter(header) {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}
