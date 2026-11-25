/**
 * 凭据解析：优先复用 DSH 已有登录态，其次复用官方路由同一个凭据引用。
 *
 * - 账户：ctx.get('deepseekAccount').resolveToken(origin)（Host-only）；
 *   只对 https://api.deepseek.com 生效，401 时用 rejectToken 清掉失效登录。
 * - API key：ctx.get('credentials').resolve(apiKeyEnv)，最后回退到进程环境变量。
 *
 * 插件不保存、不缓存、不打印任何令牌；每次请求现取。
 */
import { llmError } from './errors.js'

export const API_ORIGIN = 'https://api.deepseek.com'
export const MESSAGES_URL = `${API_ORIGIN}/anthropic/v1/messages`
export const FILES_URL = `${API_ORIGIN}/anthropic/v1/files`
export const USER_AGENT = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * @typedef {object} ResolvedAuth
 * @property {'account'|'api-key'} kind
 * @property {string} token
 * @property {Record<string,string>} headers 鉴权头（不含 content-type 等请求头）
 * @property {() => void} [reject] 账户模式下报告失效令牌
 */

/** @param {string} token @returns {ResolvedAuth} */
function apiKeyAuth(token) {
  return Object.freeze({
    kind: 'api-key',
    token,
    headers: Object.freeze({ 'x-api-key': token }),
  })
}

/**
 * @param {{ get?: (name: string) => any }} ctx
 * @param {Readonly<{ apiKeyEnv: string, auth: string }>} config
 * @returns {Promise<ResolvedAuth>}
 */
export async function resolveAuth(ctx, config) {
  const mode = config.auth
  const get = typeof ctx?.get === 'function' ? name => ctx.get(name) : () => undefined

  if (mode !== 'api-key') {
    const account = get('deepseekAccount')
    if (account !== undefined && typeof account?.resolveToken === 'function') {
      let token
      try {
        token = await account.resolveToken(API_ORIGIN)
      } catch {
        token = undefined
      }
      if (typeof token === 'string' && token.length > 0) {
        return Object.freeze({
          kind: 'account',
          token,
          headers: Object.freeze({ 'x-dsh-auth-token': token }),
          reject: () => {
            try {
              void account.rejectToken?.(token)
            } catch {
              // 失效令牌清理失败不影响本轮错误上报。
            }
          },
        })
      }
    }
    if (mode === 'account') {
      throw llmError('ACCOUNT_SIGN_IN_REQUIRED', 'chatdemo: 未登录 DSH 账户。请在设置里登录，或把 auth 改成 auto/api-key。')
    }
  }

  const ref = config.apiKeyEnv
  const credentials = get('credentials')
  if (credentials !== undefined && typeof credentials?.resolve === 'function') {
    let hit
    try {
      hit = await credentials.resolve(ref)
    } catch {
      hit = undefined
    }
    if (hit !== undefined && typeof hit?.value === 'string' && hit.value.length > 0) {
      return apiKeyAuth(hit.value)
    }
  }

  const ambient = process.env[ref]
  if (typeof ambient === 'string' && ambient.length > 0) {
    return apiKeyAuth(ambient)
  }

  throw llmError(
    'MISSING_CREDENTIAL',
    `chatdemo: 没有可用的 ${ref} 凭据。请在 DSH 登录，或在 DSH 凭据/环境变量里配置 ${ref}。`,
  )
}
