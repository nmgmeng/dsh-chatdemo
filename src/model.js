/**
 * 预设绑定模型：让「ChatDemo 语气」的会话不用再手选模型，并在切走时恢复原模型。
 *
 * 背景：DSH 的模型是会话级记录（model/selection），预设只负责子插件，
 * 不绑定模型；dsh-agent-default-model 又是全局默认，不能拿来给单个预设用。
 *
 * 实测（DSH 0.2.2-rc.3）发现的坑，这里都兜住：
 *   1. 新会话的 Agent 可能要到首条消息才创建 —— 预设事件先记 pending，
 *      等 agent/created 再补；
 *   2. 会话头里的 agentPreset 是最初创建时的值（可能是 standard）——
 *      预设判断用 agentPresets.presetForSession() 投影；
 *   3. Web 客户端会在切换预设后几毫秒把当前模型写回来 —— 首轮之前看到
 *      非 chatdemo 的 model/selection 就再纠正一次；
 *   4. 事件可能根本没送到插件作用域 —— 额外每 1.5 秒扫一遍作为兜底。
 *
 * 安全规则：
 *   - 进入 chatdemo 预设前记住当前模型，切走时恢复它；
 *   - 没有记忆（例如插件重载过）时，切走事件里回退到部署默认模型；
 *   - 只处理“当前还停在 chatdemo 模型”的会话，用户后来手选的不覆盖；
 *   - 首轮之后不再做进入侧的选择（用户手选优先）。
 */
const PRESET_ID = 'chatdemo'
const PROVIDER = 'chatdemo'
const MODEL = 'chatdemo-flash'
const RECONCILE_INTERVAL_MS = 1500

/** SessionId 在不同调用里可能是字符串或 branded 值，统一成字符串做键。 */
function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.session?.meta?.id
  return id === undefined || id === null ? undefined : String(id)
}

/** 只保留 provider/model/effort，避免把来源等无关字段写进选择。 */
function selectionOf(current) {
  if (current === undefined || current === null) return undefined
  if (typeof current.provider !== 'string' || typeof current.model !== 'string') return undefined
  return {
    provider: current.provider,
    model: current.model,
    ...(typeof current.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}),
  }
}

export const name = 'chatdemo-model'

export const inject = ['agents']

export function apply(ctx) {
  const get = typeof ctx?.get === 'function' ? name => ctx.get(name) : () => undefined
  /** sessionId → 还没等到 Agent 的 chatdemo 预设选择。 */
  const pending = new Set()
  /** sessionId → 活 Agent（用于预设切换时定位）。 */
  const live = new Map()
  /** sessionId → 进入 chatdemo 之前的模型选择（切走时恢复）。 */
  const previous = new Map()

  /** 会话当前记录的预设（投影），读不到再退回会话头。 */
  function presetFor(agent) {
    try {
      const presets = get('agentPresets')
      const id = presets?.presetForSession?.(agent?.session)
      if (typeof id === 'string' && id.length > 0) return id
    } catch {
      // 投影不可用时退回下面的头字段。
    }
    return agent?.session?.meta?.agentPreset
  }

  /** DSH 的部署默认模型；指向 chatdemo 时不用（避免自己恢复自己）。 */
  function deploymentDefault() {
    try {
      const service = get('agentDefaultModel')
      const selection = selectionOf(service?.currentSelection?.())
      if (selection !== undefined && selection.provider !== PROVIDER) return selection
    } catch {
      // 服务不可用时不回退。
    }
    return undefined
  }

  /** 进入 chatdemo 前记下当前选择；已经停在 chatdemo 时不覆盖记忆。 */
  function remember(agent) {
    const id = sessionIdOf(agent)
    if (id === undefined || previous.has(id)) return
    const model = agent?.model
    const current = typeof model?.current === 'function' ? selectionOf(model.current()) : undefined
    if (current === undefined || current.provider === PROVIDER) return
    previous.set(id, current)
  }

  function selectChatDemo(agent) {
    try {
      const model = agent?.model
      if (typeof model?.select !== 'function') return
      const current = typeof model.current === 'function' ? model.current() : undefined
      if (current?.provider === PROVIDER) return
      remember(agent)
      model.select({ provider: PROVIDER, model: MODEL })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[chatdemo] 自动选择模型失败：${message}`)
    }
  }

  /**
   * 从 chatdemo 切走时恢复原模型。
   * @param {any} agent
   * @param {boolean} allowDefault 没有记忆时是否回退到部署默认（只在明确的切走事件里为 true）
   */
  function restore(agent, allowDefault) {
    try {
      const model = agent?.model
      if (typeof model?.select !== 'function') return
      const id = sessionIdOf(agent)
      const current = typeof model.current === 'function' ? model.current() : undefined
      if (current?.provider !== PROVIDER) {
        if (id !== undefined) previous.delete(id)
        return
      }
      const target = (id === undefined ? undefined : previous.get(id)) ?? (allowDefault ? deploymentDefault() : undefined)
      if (target === undefined || target.provider === PROVIDER) return
      model.select(target)
      if (id !== undefined) previous.delete(id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[chatdemo] 恢复模型失败：${message}`)
    }
  }

  function applyTo(agent) {
    const id = sessionIdOf(agent)
    if (id !== undefined) pending.delete(id)
    selectChatDemo(agent)
  }

  /**
   * 给“已选 chatdemo 预设、但还没发过请求”的活会话补选择；
   * 已切到别的预设、但模型还停在 chatdemo 的会话恢复原模型。
   */
  function reconcile(agentList) {
    let agents = agentList
    if (agents === undefined) {
      try {
        agents = get('agents')?.list?.()
      } catch {
        return
      }
    }
    for (const agent of agents ?? []) {
      try {
        const id = sessionIdOf(agent)
        if (id !== undefined) live.set(id, agent)
        const preset = presetFor(agent)
        if (preset === PRESET_ID) {
          if (typeof agent?.session?.requestHeader === 'function' && agent.session.requestHeader() !== undefined) continue
          applyTo(agent)
        } else if (preset !== undefined && preset !== null) {
          // 事件没送到时也能恢复：只有“最近一次请求就是 chatdemo”的会话
          // 才允许回退到部署默认，避免把手工选的 chatdemo 模型也改掉。
          const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined
          restore(agent, header?.config?.provider === PROVIDER)
        }
      } catch {
        // 单个会话读取失败不影响其它会话。
      }
    }
  }

  reconcile()

  // 事件没送到时，靠低频扫描兜底。
  ctx.effect(() => {
    const timer = setInterval(() => reconcile(), RECONCILE_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'chatdemo-model.reconcile()')

  ctx.on('agent/created', payload => {
    const agent = payload?.agent
    const id = sessionIdOf(agent)
    if (id !== undefined) live.set(id, agent)
    // resume/clear/compact 保留会话已有的选择；只有全新会话才需要补。
    if (payload?.source !== 'startup') return
    if (presetFor(agent) === PRESET_ID || (id !== undefined && pending.has(id))) {
      applyTo(agent)
    }
  })

  ctx.on('agent/disposed', payload => {
    const id = sessionIdOf(payload?.agent)
    if (id !== undefined) {
      live.delete(id)
      previous.delete(id)
    }
  })

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    const id = sessionId === undefined || sessionId === null ? undefined : String(sessionId)
    const agent = (id === undefined ? undefined : live.get(id)) ?? get('agents')?.get?.(sessionId)
    if (agentPreset !== PRESET_ID) {
      if (id !== undefined) pending.delete(id)
      if (agent !== undefined) restore(agent, true)
      return
    }
    if (id !== undefined) pending.add(id)
    if (agent !== undefined) applyTo(agent)
  })

  /**
   * 兜底：Web 客户端在切换预设/打开会话时会把自己的当前模型写回来（实测发生在
   * preset 事件后几毫秒），可能覆盖我们的选择。首轮之前只要看到 chatdemo 会话里
   * 出现非 chatdemo 的选择，就再纠正一次；首轮之后不再干涉用户手选。
   */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'model/selection') return
    try {
      const id = session?.id === undefined ? undefined : String(session.id)
      if (id === undefined) return
      if (event.data?.provider === PROVIDER) return
      const agent = live.get(id) ?? get('agents')?.get?.(session.id)
      if (agent === undefined) return
      if (presetFor(agent) !== PRESET_ID) return
      if (typeof session.requestHeader === 'function' && session.requestHeader() !== undefined) return
      applyTo(agent)
    } catch {
      // 纠错失败不影响会话。
    }
  })
}
