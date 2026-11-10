import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'
import { createScopeSnapshot } from '../lib/snapshot.js'

// hooks 自建的快照会读策略文件；不隔离开就会读到跑测试的人自己的 $DSH_HOME。
process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'dmp-hooks-'))

const MCP = '@deepseek-ai/dsh-mcp-client'

function fakePool() {
  const state = { released: [] }
  return {
    state,
    pool: {
      async acquire(key) {
        return { key, connection: { key, listTools: async () => [], callTool: async () => ({}), close: async () => {} }, tools: [] }
      },
      release(handle) { state.released.push(handle.key) },
      size: () => 0,
      keys: () => [],
      closeAll: async () => {},
    },
  }
}

function fakeEventContext() {
  const listeners = new Map()
  const warns = []
  return {
    listeners,
    warns,
    context: {
      get: () => undefined,
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      logger: { warn: (message) => warns.push(message) },
    },
    emit(event, payload) {
      const listener = listeners.get(event)
      return listener === undefined ? undefined : listener(payload)
    },
  }
}

function fakeAgent(id, cwd, sections) {
  return {
    id,
    session: { header: { cwd } },
    ctx: {
      get: (key) => (key === 'systemPrompt'
        ? {
            getSectionOrder: () => 3100,
            section: (spec) => {
              sections.push(spec)
              return () => { spec.__disposed = true }
            },
          }
        : undefined),
    },
  }
}

const scan = () => ({ rows: [], complete: true, warnings: [] })

test('agent/created 在该 agent 的 ctx 上注册名册段', async () => {
  const evented = fakeEventContext()
  const { pool } = fakePool()
  const hooks = installHooks({ context: evented.context, pool, scan })
  const sections = []
  const agent = fakeAgent('a1', 'D:/proj', sections)
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'mcp-manager:on-demand')
  assert.equal(typeof sections[0].text, 'function')
  hooks.dispose()
})

test('重复 created 释放旧段', async () => {
  const evented = fakeEventContext()
  const hooks = installHooks({ context: evented.context, pool: fakePool().pool, scan, shieldedServers: async () => [] })
  const sections = []
  const agent = fakeAgent('a1', 'D:/proj', sections)
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sections.length, 2)
  assert.equal(sections[0].__disposed, true)
  hooks.dispose()
})

test('agent/disposed 释放段与加载', async () => {
  const evented = fakeEventContext()
  const poolState = fakePool()
  const hooks = installHooks({ context: evented.context, pool: poolState.pool, scan, shieldedServers: async () => [] })
  const sections = []
  const agent = fakeAgent('a1', 'D:/proj', sections)
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  evented.emit('agent/disposed', { agent })
  assert.equal(sections[0].__disposed, true)
  hooks.dispose()
})

test('没有 cwd 的会话被跳过且不抛错', async () => {
  const evented = fakeEventContext()
  const hooks = installHooks({ context: evented.context, pool: fakePool().pool, scan, shieldedServers: async () => [] })
  const sections = []
  const agent = fakeAgent('a1', '', sections)
  await assert.doesNotReject(async () => { await evented.emit('agent/created', { agent }) })
  assert.equal(sections.length, 0)
  hooks.dispose()
})

test('dispose 后不再响应事件', async () => {
  const evented = fakeEventContext()
  const hooks = installHooks({ context: evented.context, pool: fakePool().pool, scan, shieldedServers: async () => [] })
  hooks.dispose()
  assert.equal(evented.listeners.size, 0)
})

test('scan 抛错只 warn 不冒泡', async () => {
  const evented = fakeEventContext()
  const hooks = installHooks({
    context: evented.context,
    pool: fakePool().pool,
    scan: () => { throw new Error('scan boom') },
    shieldedServers: async () => [],
  })
  const sections = []
  const agent = fakeAgent('a1', 'D:/proj', sections)
  await assert.doesNotReject(async () => { await evented.emit('agent/created', { agent }) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sections.length, 0)
  assert.ok(evented.warns.length >= 1)
  hooks.dispose()
})
test('shieldedServers 命中时按前缀算出 deny 并调用 restrict', async () => {
  const evented = fakeEventContext()
  const restrictions = []
  const denials = []
  const tools = {
    view: () => ({
      restrictableNames: [
        'mcp__joplin__search',
        'mcp__joplin__read',
        'mcp__unity__batch',
        'web_search',
      ],
    }),
    restrict: (filter) => {
      restrictions.push(filter)
      return () => denials.push('lifted')
    },
  }
  const agent = {
    id: 'a1',
    session: { header: { cwd: 'D:/proj' } },
    ctx: {
      get: (key) => {
        if (key === 'tools') return tools
        if (key === 'systemPrompt') return { getSectionOrder: () => 3100, section: () => () => {} }
        return undefined
      },
    },
  }
  const hooks = installHooks({
    context: evented.context,
    pool: fakePool().pool,
    scan,
    shieldedServers: async () => ['joplin'],
  })
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(restrictions.length, 1)
  assert.deepEqual([...restrictions[0].deny], ['mcp__joplin__read', 'mcp__joplin__search'])
  evented.emit('agent/disposed', { agent })
  assert.deepEqual(denials, ['lifted'])
  hooks.dispose()
})

test('并发重算不会丢掉段句柄', async () => {
  const evented = fakeEventContext()
  const registered = new Set()
  const agent = {
    id: 'a1',
    session: { header: { cwd: 'D:/proj' } },
    ctx: {
      get: (key) => (key === 'systemPrompt'
        ? {
            getSectionOrder: () => 3100,
            section: (spec) => {
              if (registered.has(spec.name)) throw new Error('already registered in this scope')
              registered.add(spec.name)
              return () => { registered.delete(spec.name) }
            },
          }
        : undefined),
    },
  }
  let shields = 0
  const hooks = installHooks({
    context: evented.context,
    pool: fakePool().pool,
    scan,
    shieldedServers: async () => {
      shields += 1
      if (shields === 2) await new Promise((resolve) => setTimeout(resolve, 20))
      return []
    },
  })
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await Promise.all([hooks.reconcileAll(), hooks.reconcileAll()])
  assert.equal(hooks.stats().agents[0].hasSection, true)
  assert.equal(hooks.stats().agents[0].sectionError, null)
  assert.deepEqual([...registered], ['mcp-manager:on-demand'])
  hooks.dispose()
})

test('没有要罩的 server 时不调用 restrict', async () => {
  const evented = fakeEventContext()
  let calls = 0
  const tools = { view: () => ({ restrictableNames: ['mcp__x__y'] }), restrict: () => { calls += 1; return () => {} } }
  const agent = {
    id: 'a1',
    session: { header: { cwd: 'D:/proj' } },
    ctx: { get: (key) => (key === 'tools' ? tools : key === 'systemPrompt' ? { getSectionOrder: () => 3100, section: () => () => {} } : undefined) },
  }
  const hooks = installHooks({ context: evented.context, pool: fakePool().pool, scan, shieldedServers: async () => [] })
  await evented.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(calls, 0)
  hooks.dispose()
})

// 用户症状：派发子代理后，主会话的 `mcp_call` 报 unknown or disabled MCP server。
// 子代理与父会话同 cwd，子会话结束若按 cwd 全清快照，父会话的 `target()` 就读不到缓存。
test('子 agent 销毁后，同 cwd 的父会话仍能解析 MCP 目标', async () => {
  const row = {
    rowKey: 'own:unityMCP',
    serverName: 'unityMCP',
    transport: 'streamable-http',
    definition: 'http://127.0.0.1:8080/mcp',
    source: 'managed',
    sourcePath: null,
    owned: true,
    declaredDisabled: false,
    entryId: 'managed:unityMCP',
    config: { transport: 'streamable-http', serverName: 'unityMCP', url: 'http://127.0.0.1:8080/mcp' },
  }
  const defaultPack = { name: 'default', groups: {}, rows: { 'own:unityMCP': { enabled: false, mode: 'lazy' } } }
  const workPack = { name: 'p2', groups: {}, rows: { 'own:unityMCP': { enabled: true } } }
  const policy = {
    packs: { packs: { default: defaultPack, p2: workPack } },
    ui: { showChip: true, defaultTab: 'groups' },
    binding: 'p2',
    packId: 'p2',
    pack: workPack,
    groups: { groups: [], assignments: {} },
    bindings: { bindings: {} },
    warnings: [],
  }
  const snapshot = createScopeSnapshot({
    scan: () => ({ rows: [row], complete: true, warnings: [] }),
    load: async () => ({ policy, owned: { version: 1, servers: {} }, warnings: [] }),
    fingerprint: async () => '0',
  })

  const evented = fakeEventContext()
  const hooks = installHooks({
    context: evented.context,
    pool: fakePool().pool,
    scan,
    snapshot,
    shieldedServers: async () => [],
  })
  const parent = { id: 'parent-1', session: { header: { cwd: 'D:/proj' } } }
  const child = { id: 'child-1', session: { header: { cwd: 'D:/proj' } } }
  await evented.emit('agent/created', { agent: parent })
  await evented.emit('agent/created', { agent: child })
  assert.notEqual(hooks.scopeOf(parent).inventory.target('unityMCP'), null)

  evented.emit('agent/disposed', { agent: child })

  assert.notEqual(hooks.scopeOf(parent).inventory.target('unityMCP'), null)
  assert.equal(hooks.scopeOf(child), null)
  hooks.dispose()
})
