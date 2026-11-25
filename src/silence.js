/**
 * ChatDemo 预设的“静音”插件：只在挂载该预设的 Agent 作用域内生效。
 *
 * 1. 屏蔽全部客户端工具——chat-demo 的请求里没有客户端工具，给了工具模型
 *    就会切到 agent 模式，破坏 1:1。
 * 2. 用同名 scoped 上下文遮蔽 DSH 必填的 working-directory 上下文，
 *    否则系统提示里会多一行 “Current working directory”。
 *
 * 失败模式：若 DSH 改变抑制逻辑，最多让那一行重新出现，不会破坏会话。
 */
export const name = 'chatdemo-silence'

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const allow = Array.isArray(config.allow) ? config.allow : []
  ctx.effect(() => ctx.tools.restrict({ allow }), 'chatdemo-silence.tools()')
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'working-directory:current',
    order: 0,
    text: '',
    interpolate: false,
  }), 'chatdemo-silence.cwd()')
}
