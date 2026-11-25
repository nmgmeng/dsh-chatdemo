import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { resolveAuth, API_ORIGIN } from '../src/auth.js'

function ctxWith(services) {
  return { get: name => services[name] }
}

test('账户优先：返回 x-dsh-auth-token 与失效回调', async () => {
  let rejected
  let askedUrl
  const account = {
    resolveToken: async url => {
      askedUrl = url
      return 'account-token'
    },
    rejectToken: async token => { rejected = token },
  }
  const auth = await resolveAuth(ctxWith({ deepseekAccount: account }), { auth: 'auto', apiKeyEnv: 'DEEPSEEK_API_KEY' })
  assert.equal(askedUrl, API_ORIGIN)
  assert.equal(auth.kind, 'account')
  assert.deepEqual(auth.headers, { 'x-dsh-auth-token': 'account-token' })
  auth.reject()
  assert.equal(rejected, 'account-token')
})

test('未登录账户时回退到凭据引用', async () => {
  const account = { resolveToken: async () => undefined }
  const credentials = { resolve: async ref => (ref === 'DEEPSEEK_API_KEY' ? { value: 'key-value' } : undefined) }
  const auth = await resolveAuth(ctxWith({ deepseekAccount: account, credentials }), { auth: 'auto', apiKeyEnv: 'DEEPSEEK_API_KEY' })
  assert.equal(auth.kind, 'api-key')
  assert.deepEqual(auth.headers, { 'x-api-key': 'key-value' })
})

test('api-key 模式跳过账户', async () => {
  let accountAsked = false
  const account = { resolveToken: async () => { accountAsked = true; return 'tok' } }
  const credentials = { resolve: async () => ({ value: 'key-value' }) }
  const auth = await resolveAuth(ctxWith({ deepseekAccount: account, credentials }), { auth: 'api-key', apiKeyEnv: 'DEEPSEEK_API_KEY' })
  assert.equal(accountAsked, false)
  assert.equal(auth.kind, 'api-key')
})

test('account 模式未登录直接失败', async () => {
  await assert.rejects(
    resolveAuth(ctxWith({ deepseekAccount: { resolveToken: async () => undefined } }), { auth: 'account', apiKeyEnv: 'DEEPSEEK_API_KEY' }),
    error => error.code === 'ACCOUNT_SIGN_IN_REQUIRED',
  )
})

test('两个都没有时 MISSING_CREDENTIAL，且不带密钥', async () => {
  await assert.rejects(
    resolveAuth(ctxWith({}), { auth: 'auto', apiKeyEnv: 'DSH_CHATDEMO_TEST_KEY_ABSENT' }),
    error => error.code === 'MISSING_CREDENTIAL' && !/tok|key/i.test(error.message.replace(/DEEPSEEK_API_KEY|[A-Z_]+_KEY/g, '')),
  )
})
