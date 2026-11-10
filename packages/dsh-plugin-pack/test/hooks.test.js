import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'
import { applyCommands, packsPath, workspacesPath } from '../lib/store.js'
import { normalizeCwd } from '../lib/policy.js'

const NEWLINE = String.fromCharCode(10)

/** 造一个宿主 ctx 的最小替身，能手动 emit，也能拿到某个事件的监听器。 */
function fakeCtx(options = {}) {
  const listeners = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(callback) {
      return callback()
    },
    get(name) {
      if (name === 'tools') return options.rootTools
      if (name === 'agents') return options.agents
      return undefined
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    async emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) await listener(...args)
    },
    listener(event) {
      return (listeners.get(event) ?? [])[0]
    },
  }
  return ctx
}

const rows = [
  { name: 'alpha', description: 'a', parameters: { type: 'object' } },
  { name: 'beta', description: 'b', parameters: { type: 'object' } },
]

/**
 * 假 tools 服务。
 *
 * definitions() 会真的扣掉已 deny 的名字：宿主就是这样表现限制的，复验那一步
 * 只有在这种「限制立即反映到视图」的假对象上才测得出来。
 */
function fakeTools(list = rows, options = {}) {
  const calls = []
  const denied = new Set()
  const tools = {
    calls,
    denied,
    definitions() {
      return list.filter((row) => !denied.has(row.name))
    },
    schemas() {
      return list.map((row) => ({ name: row.name, description: row.description, parameters: row.parameters }))
    },
    get(name) {
      return list.find((row) => row.name === name)
    },
  }
  if (options.noRestrict !== true) {
    tools.restrict = (filter) => {
      calls.push([...filter.deny])
      for (const name of filter.deny) denied.add(name)
      return () => {
        for (const name of filter.deny) denied.delete(name)
      }
    }
  }
  return tools
}

/** 一份固定的归属表：两个插件各有一个工具与一个段。 */
function catalogFor(plugins) {
  return {
    key: 'test-key',
    plugins,
    orphanTools: [],
    orphanSections: [],
  }
}

const defaultPlugins = [
  {
    pkg: 'plug-a',
    tools: ['alpha'],
    sections: ['alpha-section'],
    toolVolume: 12,
    sectionChars: 120,
    toolsKnown: true,
    sectionsKnown: true,
  },
  {
    pkg: 'plug-b',
    tools: ['beta'],
    sections: ['beta-section'],
    toolVolume: 8,
    sectionChars: 80,
    toolsKnown: true,
    sectionsKnown: true,
  },
]

function feedFor(catalog) {
  return { read: () => catalog, load: async () => catalog }
}

/**
 * 造一份全新的 home 与工作区目录。
 *
 * 只设 `$DSH_HOME`，**不写任何策略文件**：策略由用例用 `applyCommands` 写，
 * 这样断言的就是新语义（pack 求值），而不是旧的两层文件。
 */
async function makeWorkspace() {
  const home = await mkdtemp(join(tmpdir(), 'dpp-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  process.env['DSH_HOME'] = home
  return { home, cwd }
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + NEWLINE)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function agentFor(cwd, tools) {
  return {
    id: 'agent-1',
    ctx: { get: (name) => (name === 'tools' ? tools : undefined) },
    session: { id: 'session-1', header: { cwd } },
  }
}

test('没有被停用的插件时绝不调用 restrict', async () => {
  const { cwd } = await makeWorkspace()
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  // 宿主把空 deny 当成「配置物化错了」并抛错，所以这条分支必须一次都不进。
  assert.deepEqual(tools.calls, [])
})

test('停用插件后它的工具进 deny 掩码，别的插件不受影响', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [['alpha']])
  assert.deepEqual([...tools.denied], ['alpha'])
  assert.equal(tools.denied.has('beta'), false)
})

test('候选名也进 deny 掩码：结构认不出的注册形态照样能关掉', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-w', value: false }])
  const tools = fakeTools([{ name: 'wrapped_tool', description: 'w', parameters: { type: 'object' } }])
  const plugin = {
    pkg: 'plug-w',
    tools: [],
    names: ['wrapped_tool'],
    sections: [],
    toolVolume: 0,
    sectionChars: 0,
    toolsKnown: true,
    sectionsKnown: true,
  }
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor([plugin])) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  // 停在 tools 空、只靠 names 的包上，掩码必须来自候选名。
  assert.deepEqual(tools.calls, [['wrapped_tool']])
})

test('两个包都写过的候选名不归属任何人：不会被误关', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-x', value: false }])
  const tools = fakeTools([{ name: 'dup_tool', description: 'd', parameters: { type: 'object' } }])
  const make = (pkg) => ({
    pkg,
    tools: [],
    names: ['dup_tool'],
    sections: [],
    toolVolume: 0,
    sectionChars: 0,
    toolsKnown: true,
    sectionsKnown: true,
  })
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor([make('plug-x'), make('plug-y')])) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [])
  assert.equal(tools.denied.size, 0)
})

test('候选名不在当前清单里就不进掩码（旧缓存不会误关已卸载的工具）', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-z', value: false }])
  // 候选里只有一个已经不存在的名字：可见清单为空，掩码也必须为空。
  const tools = fakeTools([])
  const plugin = {
    pkg: 'plug-z',
    tools: [],
    names: ['gone_tool'],
    sections: [],
    toolVolume: 0,
    sectionChars: 0,
    toolsKnown: true,
    sectionsKnown: true,
  }
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor([plugin])) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [])
})

test('绑定 pack 的停用只影响该工作区', async () => {
  const { cwd, home } = await makeWorkspace()
  const other = await mkdtemp(join(tmpdir(), 'dpp-ws2-'))
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [
    { op: 'packItem', packId: 'p1', name: 'plug-b', value: false },
    { op: 'bind', cwd, packId: 'p1' },
  ])
  assert.ok(home.length > 0)

  const bound = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })
  await ctx.emit('agent/created', { agent: agentFor(cwd, bound) })
  assert.deepEqual(bound.calls, [['beta']])

  // default 里没有这条决定，别的工作区照常全开。
  const idle = fakeTools()
  const ctx2 = fakeCtx()
  installHooks(ctx2, { catalog: feedFor(catalogFor(defaultPlugins)) })
  await ctx2.emit('agent/created', {
    agent: {
      id: 'agent-2',
      ctx: { get: (name) => (name === 'tools' ? idle : undefined) },
      session: { id: 'session-2', header: { cwd: other } },
    },
  })
  assert.deepEqual(idle.calls, [])
})

test('绑定悬空（指向已删除的 pack）时按 default 求值', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  // 手工制造悬空绑定：p1 不存在。
  await writeJson(workspacesPath(), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1-gone' },
  })

  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })
  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [['alpha']])
})

test('停用插件里只有 run_code 时不施加限制：宿主对它是整批拒绝', async () => {
  const withRunCode = [
    { name: 'alpha', description: 'a', parameters: { type: 'object' } },
    { name: 'run_code', description: 'r', parameters: { type: 'object' } },
  ]
  const plugins = [
    {
      pkg: 'plug-a',
      tools: ['run_code'],
      sections: [],
      toolVolume: 1,
      sectionChars: 0,
      toolsKnown: true,
      sectionsKnown: true,
    },
  ]
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools(withRunCode)
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(plugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [])
})

test('waterfall 剔除被停用插件的段，保留其他段', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  const agent = agentFor(cwd, tools)
  await ctx.emit('agent/created', { agent })

  const assemble = ctx.listener('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')

  const payload = {
    sections: [
      { name: 'alpha-section', text: 'A' },
      { name: 'beta-section', text: 'B' },
      { name: 'other', text: 'C' },
    ],
    contexts: [],
    variables: {},
  }
  let nextCalls = 0
  const result = await assemble(payload, { scope: agent }, async () => {
    nextCalls += 1
    return payload
  })

  // next 必须被调用：吞掉它等于把后续监听器与 fallback 一起短路。
  assert.equal(nextCalls, 1)
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['beta-section', 'other'],
  )
})

test('waterfall 只按段名精确匹配，不做前缀猜测', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  const agent = agentFor(cwd, tools)
  await ctx.emit('agent/created', { agent })

  const assemble = ctx.listener('system-prompt/assemble')
  const payload = {
    sections: [{ name: 'alpha-section-extra', text: 'X' }, { name: 'other', text: 'C' }],
    contexts: [],
    variables: {},
  }
  const result = await assemble(payload, { scope: agent }, async () => payload)

  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['alpha-section-extra', 'other'],
  )
})

test('scope 身份未命中且 id 也查不到时不动段', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  const assemble = ctx.listener('system-prompt/assemble')
  const payload = {
    sections: [{ name: 'alpha-section', text: 'A' }, { name: 'other', text: 'C' }],
    contexts: [],
    variables: {},
  }
  const result = await assemble(payload, { scope: { id: 'nobody', session: { id: 'nobody' } } }, async () => payload)

  // 两条都没命中就不动：宁可放开，也不要误删。
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['alpha-section', 'other'],
  )
})

test('scope 身份未命中时按 session id 回退命中', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  const assemble = ctx.listener('system-prompt/assemble')
  const payload = {
    sections: [{ name: 'alpha-section', text: 'A' }, { name: 'other', text: 'C' }],
    contexts: [],
    variables: {},
  }
  const result = await assemble(payload, { scope: { session: { id: 'session-1' } } }, async () => payload)

  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['other'],
  )
})

test('宿主拒绝未知工具名时剔除后重试，并把它报成 stuck', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])

  const visible = [...rows, { name: 'gamma', description: 'g', parameters: { type: 'object' } }]
  const denied = new Set()
  let calls = 0
  const tools = {
    definitions() {
      return visible.filter((row) => !denied.has(row.name))
    },
    schemas() {
      return visible.map((row) => ({ name: row.name, description: row.description, parameters: row.parameters }))
    },
    restrict(filter) {
      calls += 1
      if (calls === 1) {
        // 宿主的真实形状：整批拒绝，只把不认识的名字放在引号里。
        throw new Error('tools.restrict() names unknown global tool "alpha"; known global tools: beta')
      }
      for (const name of filter.deny) denied.add(name)
      return () => {
        for (const name of filter.deny) denied.delete(name)
      }
    },
  }
  const plugins = [
    {
      pkg: 'plug-a',
      tools: ['alpha', 'gamma'],
      sections: [],
      toolVolume: 1,
      sectionChars: 0,
      toolsKnown: true,
      sectionsKnown: true,
    },
  ]
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(plugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  // 第一次整批失败，剔掉 alpha 后第二次成功：其余工具照样关闭。
  assert.equal(calls, 2)
  assert.deepEqual([...denied], ['gamma'])
  // alpha 关不掉，必须进 stuck 让面板标红，而不是静默失效。
  assert.deepEqual(hooks.stuck(), ['alpha'])
})

test('waterfall 下游返回新数组时，剔除仍然生效', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  const agent = agentFor(cwd, tools)
  await ctx.emit('agent/created', { agent })

  const assemble = ctx.listener('system-prompt/assemble')
  const payload = {
    sections: [{ name: 'alpha-section', text: 'A' }, { name: 'beta-section', text: 'B' }],
    contexts: [],
    variables: {},
  }
  // 有的下游监听器会返回一份新的 assembly：只改 payload 的那次过滤会被丢掉。
  const result = await assemble(payload, { scope: agent }, async () => ({
    sections: [{ name: 'alpha-section', text: 'A' }, { name: 'beta-section', text: 'B' }],
    contexts: [],
    variables: {},
  }))

  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['beta-section'],
  )
})

test('宿主没有 restrict 时不施加也不抛错，只 warn 一次', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools(rows, { noRestrict: true })
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  await hooks.reapply()

  const unsupported = ctx.warnings.filter((line) => line.includes('不支持'))
  assert.equal(unsupported.length, 1)
  assert.deepEqual(hooks.support(), { restrict: false, promptFilter: true })
})

test('插件目录未就绪时本轮不动，只 warn 一次', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: { read: () => null, load: async () => catalogFor(defaultPlugins) } })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  await hooks.reapply()

  assert.deepEqual(tools.calls, [])
  assert.equal(ctx.warnings.filter((line) => line.includes('目录尚未就绪')).length, 1)
})

test('隐藏集变化后 reapply 释放旧限制并重建', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  assert.deepEqual([...tools.denied], ['alpha'])

  await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'plug-a', value: null },
    { op: 'packItem', packId: 'default', name: 'plug-b', value: false },
  ])
  await hooks.reapply()

  assert.deepEqual(tools.calls, [['alpha'], ['beta']])
  assert.deepEqual([...tools.denied], ['beta'])

  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-b', value: null }])
  await hooks.reapply()

  // 一条都不剩时必须释放旧掩码，绝不能拿空数组去调 restrict。
  assert.equal(tools.calls.length, 2)
  assert.deepEqual([...tools.denied], [])
})

test('隐藏集没变化时 reapply 不重建限制', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  await hooks.reapply()
  await hooks.reapply()

  // 每次重建都会让宿主重算可见集合，进而使 KV Cache 从第一个 scheme token 起失效。
  assert.equal(tools.calls.length, 1)
})

test('agent/disposed 释放限制并摘掉状态', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  const agent = agentFor(cwd, tools)
  await ctx.emit('agent/created', { agent })
  assert.deepEqual([...tools.denied], ['alpha'])

  await ctx.emit('agent/disposed', { agent })
  assert.deepEqual([...tools.denied], [])

  await hooks.reapply()
  assert.equal(tools.calls.length, 1)
})

test('同一 agent 再装配一次：上一轮的限制先被释放', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  const agent = agentFor(cwd, tools)
  await ctx.emit('agent/created', { agent })
  assert.deepEqual([...tools.denied], ['alpha'])

  // 重新打开 plug-a，同一 id 再装配。计划变空；上一轮没释放的话掩码会永远留着。
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: true }])
  await ctx.emit('agent/created', { agent })
  assert.deepEqual([...tools.denied], [])
  assert.deepEqual(tools.calls, [['alpha']])
})

test('agent/created 负载形状不符只 warn，不抛', async () => {
  await makeWorkspace()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  // 这个监听器抛错会让会话创建失败，是仓库红线。
  await assert.doesNotReject(() => ctx.emit('agent/created', { agent: null }))
  assert.equal(ctx.warnings.length, 1)
})

test('没有任何 agent 时 bootstrap 不报错', async () => {
  await makeWorkspace()
  const ctx = fakeCtx({ agents: { list: () => [] } })
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await hooks.bootstrap()
  assert.deepEqual(hooks.stuck(), [])
})

test('策略写入后 packs.json 落在新路径，工作区目录下不产生文件', async () => {
  const { cwd } = await makeWorkspace()
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }])
  assert.deepEqual((await readJson(packsPath())).packs.default.items, { 'plug-a': false })
  const exists = await readFile(join(cwd, '.dsh', 'plugin-manager.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
})
