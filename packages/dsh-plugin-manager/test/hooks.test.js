import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'

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

async function makeWorkspace({ global: globalPolicy, workspace, groups } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dpm-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dpm-ws-'))
  process.env['DSH_HOME'] = home
  await mkdir(join(home, 'plugin-manager'), { recursive: true })
  await writeFile(
    join(home, 'plugin-manager', 'global.json'),
    JSON.stringify(globalPolicy ?? {}, null, 2) + NEWLINE,
  )
  if (groups !== undefined) {
    await writeFile(join(home, 'plugin-manager', 'groups.json'), JSON.stringify(groups, null, 2) + NEWLINE)
  }
  if (workspace !== undefined) {
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh', 'plugin-manager.json'), JSON.stringify(workspace, null, 2) + NEWLINE)
  }
  return { home, cwd }
}

function agentFor(cwd, tools) {
  return {
    id: 'agent-1',
    ctx: { get: (name) => (name === 'tools' ? tools : undefined) },
    session: { id: 'session-1', header: { cwd } },
  }
}

test('没有被停用的插件时绝不调用 restrict', async () => {
  const { cwd } = await makeWorkspace({ global: {} })
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  // 宿主把空 deny 当成「配置物化错了」并抛错，所以这条分支必须一次都不进。
  assert.deepEqual(tools.calls, [])
})

test('停用插件后它的工具进 deny 掩码，别的插件不受影响', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [['alpha']])
  assert.deepEqual([...tools.denied], ['alpha'])
  assert.equal(tools.denied.has('beta'), false)
})

test('工作区层停用只影响该工作区', async () => {
  const { cwd } = await makeWorkspace({ global: {}, workspace: { items: { 'plug-b': false } } })
  const tools = fakeTools()
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [['beta']])
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
  const tools = fakeTools(withRunCode)
  const ctx = fakeCtx()
  installHooks(ctx, { catalog: feedFor(catalogFor(plugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })

  assert.deepEqual(tools.calls, [])
})

test('waterfall 剔除被停用插件的段，保留其他段', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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

test('宿主没有 restrict 时不施加也不抛错，只 warn 一次', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: { read: () => null, load: async () => catalogFor(defaultPlugins) } })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  await hooks.reapply()

  assert.deepEqual(tools.calls, [])
  assert.equal(ctx.warnings.filter((line) => line.includes('目录尚未就绪')).length, 1)
})

test('隐藏集变化后 reapply 释放旧限制并重建', async () => {
  const { home, cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
  const tools = fakeTools()
  const ctx = fakeCtx()
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await ctx.emit('agent/created', { agent: agentFor(cwd, tools) })
  assert.deepEqual([...tools.denied], ['alpha'])

  await writeFile(
    join(home, 'plugin-manager', 'global.json'),
    JSON.stringify({ items: { 'plug-b': false } }, null, 2) + NEWLINE,
  )
  await hooks.reapply()

  assert.deepEqual(tools.calls, [['alpha'], ['beta']])
  assert.deepEqual([...tools.denied], ['beta'])

  await writeFile(join(home, 'plugin-manager', 'global.json'), JSON.stringify({ items: {} }, null, 2) + NEWLINE)
  await hooks.reapply()

  // 一条都不剩时必须释放旧掩码，绝不能拿空数组去调 restrict。
  assert.equal(tools.calls.length, 2)
  assert.deepEqual([...tools.denied], [])
})

test('隐藏集没变化时 reapply 不重建限制', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { 'plug-a': false } } })
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

test('没有任何 agent 时 bootstrap 不报错', async () => {
  await makeWorkspace({ global: {} })
  const ctx = fakeCtx({ agents: { list: () => [] } })
  const hooks = installHooks(ctx, { catalog: feedFor(catalogFor(defaultPlugins)) })

  await hooks.bootstrap()
  assert.deepEqual(hooks.stuck(), [])
})
