/**
 * 插件配置：只有三个运行参数，全部有可用默认值。
 *
 * 契约类字段（端点、模型 id、system、safety_check、工具顺序、reminder、
 * 图片长边、历史回放）不在这里——它们不是配置项。
 */
import { llmError } from './errors.js'

export const DEFAULTS = Object.freeze({
  /** 凭据引用名；不是密钥本身。与 DSH 官方 DeepSeek 路由共用同一个引用。 */
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  /** auto：有 DSH 账户授权就用账户，否则用凭据引用；account / api-key 仅用于排障。 */
  auth: 'auto',
  /** SSE 空闲超时；超过这么久没有任何字节就按 TIMEOUT 失败。 */
  idleTimeoutMs: 300000,
})

const AUTH_MODES = new Set(['auto', 'account', 'api-key'])
const MIN_IDLE_MS = 1000
const MAX_IDLE_MS = 3600000

/**
 * 校验并冻结行配置。未知字段直接失败，避免把拼写错误静默吞掉。
 * @param {unknown} raw
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw llmError('INVALID_CONFIG', 'chatdemo: 插件配置必须是一个对象。')
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw llmError('INVALID_CONFIG', `chatdemo: 未知配置项 "${key}"；可用项：${Object.keys(DEFAULTS).join(', ')}。`)
    }
  }

  const apiKeyEnv = raw.apiKeyEnv ?? DEFAULTS.apiKeyEnv
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
    throw llmError('INVALID_CONFIG', 'chatdemo: apiKeyEnv 必须是大写环境变量名（字母/数字/下划线，字母开头）。')
  }

  const auth = raw.auth ?? DEFAULTS.auth
  if (!AUTH_MODES.has(auth)) {
    throw llmError('INVALID_CONFIG', 'chatdemo: auth 只能是 auto、account 或 api-key。')
  }

  const idleTimeoutMs = raw.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < MIN_IDLE_MS || idleTimeoutMs > MAX_IDLE_MS) {
    throw llmError('INVALID_CONFIG', `chatdemo: idleTimeoutMs 必须是 ${MIN_IDLE_MS}–${MAX_IDLE_MS} 之间的整数。`)
  }

  return Object.freeze({ apiKeyEnv, auth, idleTimeoutMs })
}
