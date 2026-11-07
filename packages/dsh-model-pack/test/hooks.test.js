import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'

/**
 * 替身约定（照 tools.test.js）：
 * - `ctx.get` 是一个只认几张表的小服务容器，插件有没有偷偷用别的服务立刻暴露；
 * - listener 由用例手动触发，不跑真宿主；
 * - `logger.warn` 只收集不打印，失败路径据此断言「只 warn 不抛」；
 * - 每个 agent 替身记录 select / register / restrict / section 四组调用，
 *   外加 dispose 的调用顺序。
 */

/** 一张带会话路由与 tier1 的 pack：hooks 的默认 fixture。 */
const STANDARD = {
  name: '标准',
  session: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  tiers: {
    tier1: {
      name: '侦察',
      primary: { provider: 'deepseek', model: 'deepseek-chat' },
      fallbacks: [],
    },
  },
}

/** 有会话路由但没有档位的 pack：`subagent_tier` 不该出现。 */
const SESSION_ONLY = {
  name: '只有会话路由',
  session: { provider: 'deepseek', model: 'deepseek-reasoner' },
  tiers: {},
}

/** 出厂内容放在 packs.default：未绑定工作区时它就是生效值。 */
async function makeWorkspace(pack = STANDARD) {
  const root = await mkdtemp(join(tmpdir(), 'model-pack-hooks-'))
  const home = join(root, 'home')
  const cwd = join(root, 'ws')
  await mkdir(join(home, 'packs', 'model'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(home, 'packs', 'model', 'packs.json'),
    JSON.stringify({ version: 1, packs: { default: pack } }, null, 2),
  )
  return { root, home, cwd, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function makeContext({ subagents, llm, agents } = {}) {
  const listeners = new Map()
  const warnings = []
  const services = new Map()
  if (subagents !== undefined) services.set('subagents', subagents)
  if (llm !== undefined) services.set('llm', llm)
  if (agents !== undefined) services.set('agents', agents)

  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect() {
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
  }
  return { ctx, listeners, warnings, services }
}

function makeSubagents() {
  return {
    startActivation: async () => ({ childId: 'child-1' }),
    getProvider: (name) => ({ name, capabilities: { agentOptions: true } }),
  }
}

function makeAgent({ cwd, origin, events, registerError, selectError, subagents = makeSubagents(), llm } = {}) {
  const calls = { select: [], register: [], restrict: [], section: [], disposed: [] }

  const header = {}
  if (cwd !== undefined) header.cwd = cwd
  if (origin !== undefined) header.origin = origin

  const session = {
    id: 'session-1',
    header,
    snapshotEvents: () => events ?? [],
  }

  const tools = {
    register(definition) {
      if (registerError !== undefined) throw registerError
      calls.register.push(definition)
      return () => calls.disposed.push('tool')
    },
    restrict(filter) {
      calls.restrict.push(filter)
      return () => calls.disposed.push('restrict')
    },
  }

  const systemPrompt = {
    section(section) {
      calls.section.push(section)
      return () => calls.disposed.push('section')
    },
  }

  const agent = {
    id: 'agent-1',
    session,
    model: {
      current: () => ({ provider: 'default', model: 'default' }),
      select(selection) {
        if (selectError !== undefined) throw selectError
        calls.select.push(selection)
      },
    },
    // subagents / llm 只挂在 **agent 作用域**（delegation 组属于 preset），
    // 根 ctx 上没有——插件必须从 agent.ctx 取，替身也照这个形状给。
    ctx: {
      get: (name) => {
        if (name === 'tools') return tools
        if (name === 'systemPrompt') return systemPrompt
        if (name === 'subagents') return subagents ?? undefined
        if (name === 'llm') return llm ?? undefined
        return undefined
      },
    },
  }

  return { agent, calls }
}

async function fire(listeners, event, payload) {
  const listener = listeners.get(event)
  assert.equal(typeof listener, 'function', '应当订阅了 ' + event)
  await listener(payload)
}

/** 让注册后的异步描述刷新跑完，避免它落进下一条用例的输出。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function install({ ctx, home }) {
  return installHooks(ctx, { home })
}

/* ------------------------------------------------------------------ *
 * 事件过滤（spec §6.1 前三步：零动作）
 * ------------------------------------------------------------------ */

test('source 不是 startup：恢复的会话不改模型，但工具与段要重新挂', async (t) => {
  // 工具与段注册在 agent 作用域上，agent 重建后旧注册随旧 agent 一起消失。
  // 只在 startup 时挂，会让恢复出来的会话只有模型、没有 subagent_tier，
  // 模型于是只能去调官方 subagent。
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'resume' })

  assert.deepEqual(calls.select, [], '恢复的会话不该被工作区绑定改写模型')
  assert.equal(calls.register.length, 1, '工具必须重新注册')
  assert.equal(calls.restrict.length, 1, '官方 subagent 要重新屏蔽')
  assert.equal(calls.section.length, 1, '委派段要重新注入')
})

test('origin 为 subagent：零动作，不与父级捕获打架', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd, origin: 'subagent' })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })

  assert.deepEqual(calls.select, [])
  assert.deepEqual(calls.register, [])
  assert.deepEqual(calls.restrict, [])
  assert.deepEqual(calls.section, [])
})

test('没有 cwd：零动作，连 pack 都不读', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({})

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })

  assert.deepEqual(calls.select, [])
  assert.deepEqual(calls.register, [])
  assert.deepEqual(calls.restrict, [])
  assert.deepEqual(calls.section, [])
})

/* ------------------------------------------------------------------ *
 * 会话路由（spec §6.1 第 1 步）
 * ------------------------------------------------------------------ */

test('正常路径：select 参数与 pack 里的会话路由逐字段相等', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.equal(calls.select.length, 1)
  assert.deepEqual(calls.select[0], { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
})

test('已跑过请求：不再 select，但工具与段照常', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({
    cwd: ws.cwd,
    events: [{ type: 'request/header', data: { config: { provider: 'other', model: 'by-flag' } } }],
  })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.deepEqual(calls.select, [], '已经发过请求的会话不能被工作区绑定覆盖')
  assert.equal(calls.register.length, 1)
  assert.equal(calls.restrict.length, 1)
  assert.equal(calls.section.length, 1)
})

test('创建期写入的初始 model/selection 不阻止 select', async (t) => {
  // 宿主的真实创建序列：session → permission/preset → sandbox/mode → approval/policy
  // → model/selection → subagent/model-selection-policy。把这条 initial selection
  // 当成「用户已选」会让 pack 对每个新会话都不生效，而老会话看起来正常。
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({
    cwd: ws.cwd,
    events: [
      { type: 'session' },
      { type: 'permission/preset' },
      { type: 'subagent/model-selection-policy' },
      { type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    ],
  })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.equal(calls.select.length, 1, '创建期的初始选择不是用户选择，pack 必须生效')
})

test('会话里只有别的类型事件：仍按 pack select', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd, events: [{ type: 'user/message' }] })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.equal(calls.select.length, 1)
})

/* ------------------------------------------------------------------ *
 * 注册顺序（spec §6.1 的硬约束）
 * ------------------------------------------------------------------ */

test('注册成功：restrict 与 section 各一次，deny 只含 subagent', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.equal(calls.register.length, 1)
  assert.equal(calls.register[0].name, 'subagent_tier')

  assert.equal(calls.restrict.length, 1)
  assert.deepEqual(calls.restrict[0], { deny: ['subagent'] })

  assert.equal(calls.section.length, 1)
  assert.equal(calls.section[0].name, 'model-pack.delegation')
  assert.match(calls.section[0].text, /subagent_tier/)
  assert.equal(typeof calls.section[0].order, 'number')
})

test('registerTierTool 返回 null：restrict 未调用、section 未注入', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  // tools.register 抛错 → registerTierTool 吞掉并返回 null。restrict 与 section 都还在，
  // 所以这里能证明「注册不成就既不 deny 也不注入」，而不是因为取不到服务才没调用。
  const { agent, calls } = makeAgent({ cwd: ws.cwd, registerError: new Error('重名') })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.deepEqual(calls.restrict, [])
  assert.deepEqual(calls.section, [])
  assert.equal(calls.select.length, 1, '会话路由不受档位注册影响')
})

test('pack 没有可用档位：不注册、不 deny、不注入段', async (t) => {
  const ws = await makeWorkspace(SESSION_ONLY)
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.deepEqual(calls.register, [])
  assert.deepEqual(calls.restrict, [])
  assert.deepEqual(calls.section, [])
  assert.equal(calls.select.length, 1, '没有档位不影响会话路由')
})

test('subagents 服务缺失：不注册、不 deny、不注入段', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext()
  const { agent, calls } = makeAgent({ cwd: ws.cwd, subagents: null })

  const hooks = install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.deepEqual(calls.register, [])
  assert.deepEqual(calls.restrict, [])
  assert.deepEqual(calls.section, [])
  assert.equal(hooks.support().subagents, false)
})

test('同一 agent 重复 created：第二次不再施加', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  assert.equal(calls.register.length, 1, '第二次 created 不该再注册一遍')
  assert.equal(calls.restrict.length, 1)
  assert.equal(calls.section.length, 1)
})

/* ------------------------------------------------------------------ *
 * 释放
 * ------------------------------------------------------------------ */

test('agent/disposed：工具、限制、段三个 disposer 全部调用', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()
  assert.deepEqual(calls.disposed, [], '会话还在时不许释放')

  await fire(listeners, 'agent/disposed', { agent })
  assert.deepEqual(calls.disposed, ['tool', 'restrict', 'section'])
})

/* ------------------------------------------------------------------ *
 * 失败兜底与补施加
 * ------------------------------------------------------------------ */

test('施加过程中抛错：不冒泡，lastError 带原始错误文本', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners, warnings } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd, selectError: new Error('选择被拒绝') })

  const hooks = install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })

  assert.deepEqual(calls.select, [], 'select 自己抛了，没有记进调用表')
  assert.match(hooks.lastError() ?? '', /选择被拒绝/)
  assert.ok(warnings.some((message) => /选择被拒绝/.test(message)))
})

test('bootstrap：已有会话补工具与段，但不碰会话路由', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { agent, calls } = makeAgent({ cwd: ws.cwd })
  const { ctx } = makeContext({ subagents: makeSubagents(), agents: { list: () => [agent] } })

  const hooks = install({ ctx, home: ws.home })
  await hooks.bootstrap()
  await settle()

  assert.deepEqual(calls.select, [], '老会话的模型是用户的选择，插件无权改写')
  assert.equal(calls.register.length, 1)
  assert.equal(calls.restrict.length, 1)
  assert.equal(calls.section.length, 1)
})

test('bootstrap：没有 agents 服务时静默返回', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx } = makeContext({ subagents: makeSubagents() })

  const hooks = install({ ctx, home: ws.home })
  await hooks.bootstrap()
})

test('stopAll：退订事件并释放全部登记项，重复调用不抛', async (t) => {
  const ws = await makeWorkspace()
  t.after(ws.cleanup)
  const { ctx, listeners } = makeContext({ subagents: makeSubagents() })
  const { agent, calls } = makeAgent({ cwd: ws.cwd })

  const hooks = install({ ctx, home: ws.home })
  await fire(listeners, 'agent/created', { agent, source: 'startup' })
  await settle()

  hooks.stopAll()
  assert.deepEqual(calls.disposed, ['tool', 'restrict', 'section'])
  assert.equal(listeners.has('agent/created'), false)
  hooks.stopAll()
})
