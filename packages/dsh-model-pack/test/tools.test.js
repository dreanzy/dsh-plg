import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTiers, probeSupport, registerTierTool } from '../lib/tools.js'

/**
 * 替身服务的约定：
 * - `subagents` 只暴露 `startActivation` 与 `getProvider`，其余一律不给，
 *   这样用例同时证明了本模块没有偷偷用别的字段；
 * - `llm.resolveCallConfig` 默认同步返回，抛错的那几条用例分别覆盖同步抛与
 *   reject 两种形态——两者都必须算「确定性失败」；
 * - `logger.warn` 只收集不打印，失败的路径也据此断言「只 warn 不抛」。
 */

const PRIMARY = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }
const FALLBACK = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }

const TIER1 = { name: 'Scout', primary: PRIMARY, fallbacks: [FALLBACK] }

function resolvedWith(tiers, id = 'standard') {
  return { id, pack: { name: '标准', tiers }, source: 'default', brokenBinding: false, warnings: [] }
}

/** 假的 agent：`ctx.get('tools')` 返回会记录 `register` 的对象，`session.header.cwd` 供刷新用。 */
function makeAgent(cwd = 'D:\\work\\alpha') {
  const registered = []
  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const agent = { ctx: { get: (name) => (name === 'tools' ? tools : undefined) }, session: { header: { cwd } } }
  return { agent, registered, tools }
}

function makeHarness({
  tiers = { tier1: TIER1 },
  probe = () => {},
  startError,
  childId = 'child-1',
  subagentsReplace,
} = {}) {
  const started = []
  const probed = []
  const resolvedCalls = []
  const warnings = []

  const subagents = {
    startActivation: async (spec) => {
      started.push(spec)
      if (startError !== undefined) throw startError
      return { childId }
    },
    getProvider: (name) => ({ name, capabilities: { agentOptions: true, depthLimit: true } }),
    ...(subagentsReplace === undefined ? {} : subagentsReplace),
  }

  const deps = {
    resolveFor: async (cwd) => {
      resolvedCalls.push(cwd)
      return resolvedWith(tiers)
    },
    llm: {
      resolveCallConfig: (selection) => {
        probed.push(selection)
        return probe(selection)
      },
    },
    subagents,
    logger: { warn: (message) => warnings.push(message) },
  }

  return { deps, started, probed, resolvedCalls, warnings }
}

/** 让注册后的异步刷新跑完。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function executeOf(registered, tier, extra, exec) {
  assert.equal(registered.length, 1, '应当恰好注册一个工具')
  const definition = registered[0]
  assert.equal(definition.name, 'subagent_tier')
  return definition.execute({ tier, prompt: '把 X 改掉', ...extra }, exec)
}

/* ------------------------------------------------------------------ *
 * 正常路径（spec §6.2 的第 3、4、5 步）
 * ------------------------------------------------------------------ */

test('正常路径：按首选路由启动，参数逐字段相等', async () => {
  const harness = makeHarness()
  const { agent, registered } = makeAgent()

  const dispose = registerTierTool(agent, harness.deps)
  assert.equal(typeof dispose, 'function')

  const result = await executeOf(
    registered,
    'tier1',
    { label: '改 X', cwd: 'D:/work/beta' },
    { agent },
  )

  assert.deepEqual(result, { kind: 'activation', subagentId: 'child-1', tier: 'tier1' })
  assert.equal(harness.started.length, 1)

  const spec = harness.started[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  // 标签带档位前缀：委派一多，光看名字分不出哪条是深算、哪条是侦察。
  assert.equal(spec.label, 't1 改 X')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '把 X 改掉' }])
  assert.deepEqual(spec.request.agentOptions, PRIMARY)
  assert.equal(spec.request.cwd, 'D:/work/beta')
  assert.equal(spec.request.parent, agent)
  assert.equal('signal' in spec, false, '没有 signal 时不该塞一个 undefined 进去')

  // 探测收到的正是路由本身，含 reasoningEffort。
  assert.deepEqual(harness.probed, [PRIMARY])

  dispose()
  assert.equal(registered.length, 0)
})

test('正常路径：缺省 cwd 用调用方会话目录解析 pack', async () => {
  const harness = makeHarness()
  const { agent, registered } = makeAgent('D:\\work\\alpha')

  registerTierTool(agent, harness.deps)
  await settle()
  harness.started.length = 0

  const result = await executeOf(registered, 'tier1', {}, { agent })
  assert.equal(result.kind, 'activation')
  assert.equal(harness.resolvedCalls.at(-1), 'D:\\work\\alpha')
  assert.equal('cwd' in harness.started[0].request, false, '没给 cwd 时不传，让宿主自己继承')
})

test('正常路径：tier 不在 pack 里时返回错误结果，不启动', async () => {
  const harness = makeHarness()
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier4', {}, { agent })

  assert.equal(result.kind, 'error')
  assert.match(result.message, /tier4/)
  assert.match(result.message, /tier1/)
  assert.equal(harness.started.length, 0)
})

/* ------------------------------------------------------------------ *
 * 备选前进（spec §6.2：只有确定性失败才换下一条）
 * ------------------------------------------------------------------ */

test('探测同步抛错：换下一条路由，用备选启动', async () => {
  const harness = makeHarness({
    probe: (selection) => {
      if (selection.model === 'deepseek-chat') throw new Error('额度耗尽')
    },
  })
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier1', {}, { agent })

  assert.equal(result.kind, 'activation')
  assert.deepEqual(harness.probed.map((selection) => selection.model), ['deepseek-chat', 'deepseek-reasoner'])
  assert.deepEqual(harness.started[0].request.agentOptions, FALLBACK)
  assert.ok(harness.warnings.some((message) => /额度耗尽/.test(message)), '失败要留一条 warn')
})

test('探测异步 reject：同样算确定性失败并前进', async () => {
  const harness = makeHarness({
    probe: (selection) => (selection.model === 'deepseek-chat' ? Promise.reject(new Error('适配器未注册')) : undefined),
  })
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier1', {}, { agent })

  assert.equal(result.kind, 'activation')
  assert.deepEqual(harness.started[0].request.agentOptions, FALLBACK)
})

test('全部探测失败：返回错误结果不抛，文本点名试过的每条路由', async () => {
  const harness = makeHarness({
    probe: () => {
      throw new Error('模型不存在')
    },
  })
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier1', {}, { agent })

  assert.equal(result.kind, 'error')
  assert.equal(harness.started.length, 0)
  assert.match(result.message, /deepseek\/deepseek-chat/)
  assert.match(result.message, /deepseek\/deepseek-reasoner/)
  assert.match(result.message, /All 2 routes/)
  assert.ok(harness.warnings.length > 0)
})

test('启动失败：不换备选重试，直接返回错误结果', async () => {
  const harness = makeHarness({ startError: new Error('父 agent 不匹配') })
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier1', {}, { agent })

  assert.equal(result.kind, 'error')
  assert.match(result.message, /failed to start/)
  assert.equal(harness.started.length, 1, '子任务失败不重跑，也不换模型')
})

test('启动返回里没有 childId：当作启动失败，不抛异常', async () => {
  const harness = makeHarness({ childId: null })
  const { agent, registered } = makeAgent()

  registerTierTool(agent, harness.deps)
  const result = await executeOf(registered, 'tier1', {}, { agent })

  assert.equal(result.kind, 'error')
  assert.match(result.message, /childId/)
})

/* ------------------------------------------------------------------ *
 * 能力探测（spec §6.4 前三格）
 * ------------------------------------------------------------------ */

test('能力不足：subagents 缺失时返回 null 且不注册', () => {
  const harness = makeHarness()
  const { agent, registered } = makeAgent()
  const deps = { ...harness.deps, subagents: undefined }

  assert.equal(registerTierTool(agent, deps), null)
  assert.deepEqual(registered, [])

  const support = probeSupport(deps)
  assert.equal(support.subagents, false)
  assert.equal(support.agentOptions, false)
  assert.match(support.reason, /subagents/)
})

test('能力不足：startActivation 不是函数时返回 null', () => {
  const harness = makeHarness({ subagentsReplace: { startActivation: 'not-a-function' } })
  const { agent, registered } = makeAgent()

  assert.equal(registerTierTool(agent, harness.deps), null)
  assert.deepEqual(registered, [])
  assert.match(probeSupport(harness.deps).reason, /startActivation/)
})

test('能力不足：provider 不支持 agentOptions 时返回 null', () => {
  const harness = makeHarness({
    subagentsReplace: { getProvider: (name) => ({ name, capabilities: { agentOptions: false } }) },
  })
  const { agent, registered } = makeAgent()

  assert.equal(registerTierTool(agent, harness.deps), null)
  assert.deepEqual(registered, [])
  const support = probeSupport(harness.deps)
  assert.equal(support.subagents, true)
  assert.equal(support.agentOptions, false)
  assert.match(support.reason, /agentOptions/)
})

test('能力不足：provider 不存在时返回 null', () => {
  const harness = makeHarness({ subagentsReplace: { getProvider: () => undefined } })
  const { agent, registered } = makeAgent()

  assert.equal(registerTierTool(agent, harness.deps), null)
  assert.deepEqual(registered, [])
  assert.match(probeSupport(harness.deps).reason, /spawn/)
})

test('能力探测自身抛错：probeSupport 不抛，registerTierTool 返回 null', () => {
  const harness = makeHarness({
    subagentsReplace: {
      getProvider: () => {
        throw new Error('provider 表坏了')
      },
    },
  })
  const { agent, registered } = makeAgent()

  const support = probeSupport(harness.deps)
  assert.equal(support.agentOptions, false)
  assert.match(support.reason, /provider 表坏了/)

  assert.equal(registerTierTool(agent, harness.deps), null)
  assert.deepEqual(registered, [])
})

test('注册抛错：返回 null 而不是半个工具', () => {
  const harness = makeHarness()
  const registered = []
  const agent = {
    ctx: {
      get: () => ({
        register() {
          throw new Error('重名')
        },
      }),
    },
    session: { header: { cwd: 'D:\\work\\alpha' } },
  }

  assert.equal(registerTierTool(agent, harness.deps), null)
  assert.deepEqual(registered, [])
  assert.ok(harness.warnings.some((message) => /重名/.test(message)))
})

/* ------------------------------------------------------------------ *
 * 描述与枚举（spec §6.3）
 * ------------------------------------------------------------------ */

test('describeTiers：只列配了首选的档，档名取 pack 里的显示名', () => {
  const text = describeTiers(resolvedWith({ tier2: { name: 'Quick', primary: PRIMARY, fallbacks: [] } }))
  assert.equal(typeof text, 'string')
  assert.match(text, /tier2 \(Quick\)/)
  assert.doesNotMatch(text, /tier1/)
  assert.match(text, /subagent_fork/)
})

test('describeTiers：没有可用档时返回 null', () => {
  assert.equal(describeTiers(resolvedWith({})), null)
  assert.equal(describeTiers(undefined), null)
  assert.equal(describeTiers({ id: 'broken', pack: {}, source: 'builtin', brokenBinding: false, warnings: [] }), null)
})

test('注册后刷新：tier 枚举与描述收敛到该 agent 的实际 pack', async () => {
  const harness = makeHarness({
    tiers: {
      tier1: TIER1,
      tier3: { name: 'Deep', primary: { provider: 'deepseek', model: 'deepseek-chat' }, fallbacks: [] },
    },
  })
  const { agent, registered } = makeAgent('D:\\work\\alpha')

  registerTierTool(agent, harness.deps)
  const definition = registered[0]
  assert.equal(definition.parameters.properties.tier.enum.length, 4, '刷新前先用出厂四档表')

  await settle()

  assert.deepEqual(definition.parameters.properties.tier.enum, ['tier1', 'tier3'])
  assert.match(definition.description, /tier3 \(Deep\)/)
  assert.equal(harness.resolvedCalls.at(-1), 'D:\\work\\alpha')
})

test('注销：dispose 之后工具从作用域移除，重复 dispose 不抛', () => {
  const harness = makeHarness()
  const { agent, registered } = makeAgent()

  const dispose = registerTierTool(agent, harness.deps)
  dispose()
  assert.equal(registered.length, 0)
  dispose()
  assert.equal(registered.length, 0)
})

test('注册全程不抛：取不到 tools 服务时返回 null', () => {
  const harness = makeHarness()
  assert.equal(registerTierTool({ ctx: { get: () => undefined } }, harness.deps), null)
  assert.equal(registerTierTool({}, harness.deps), null)
  assert.equal(registerTierTool(undefined, harness.deps), null)
})
