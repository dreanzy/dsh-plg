import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from '../lib/index.js'
import { INVENTORY_SECTION } from '../lib/inventory-section.js'

// apply 会异步读策略文件；不隔离开就会读到跑测试的人自己的 $DSH_HOME。
process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'dmp-plugin-'))

const MCP = '@deepseek-ai/dsh-mcp-client'

function fakeLoader(entries) {
  return { *entries() { for (const entry of entries) yield entry } }
}

function mcpEntry({ id, serverName, command = 'npx' }) {
  return {
    options: { id, name: MCP, config: { transport: 'stdio', serverName, command } },
    parent: { tree: { filename: 'D:\\p\\mcp.cordis.yml' } },
  }
}

function fakeCtx(services) {
  const sections = []
  const routes = []
  const effects = []
  const warns = []
  return {
    sections,
    routes,
    effects,
    warns,
    get: (key) => services[key],
    inject: (_names, callback) => { callback() },
    effect: (callback) => { effects.push(callback()) },
    logger: { info() {}, warn: (message) => warns.push(message) },
  }
}

const systemPrompt = {
  section: (spec) => { systemPrompt.__sections.push(spec); return () => {} },
  __sections: [],
  getSectionOrder: (key) => (key === 'MCP_SERVERS' ? 3100 : undefined),
}

function connection() {
  return { fetch: { register: (spec) => { connection.__routes.push(spec); return () => {} } } }
}
connection.__routes = []

test('插件声明', () => {
  assert.equal(name, 'dsh-mcp-pack')
  assert.deepEqual([...inject], ['loader'])
})

test('apply 注册五条路由，且不在 root 上注册名册段', () => {
  systemPrompt.__sections.length = 0
  connection.__routes.length = 0
  const ctx = fakeCtx({ loader: fakeLoader([mcpEntry({ id: 'a', serverName: 'playwright' })]), systemPrompt, connection: connection() })
  apply(ctx)
  // root 段故意不注册：宿主禁止同层同名段重复注册，root 段会让每个 agent 的段都冲突。
  const section = systemPrompt.__sections.find((spec) => spec.name === INVENTORY_SECTION)
  assert.equal(section, undefined, 'root 段不该被注册')
  const paths = connection.__routes.map((spec) => spec.path).sort()
  assert.deepEqual(paths, [
    '/api/mcp-pack/apply',
    '/api/mcp-pack/diag',
    '/api/mcp-pack/global',
    '/api/mcp-pack/servers',
    '/api/mcp-pack/workspace',
  ])
})

/** 轮询等待条件成立：首次重算要读盘，固定等待在不同机器上不稳。 */
async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

test('没有 systemPrompt 时不抛错，只 warn', () => {
  const ctx = fakeCtx({ loader: fakeLoader([]), connection: connection() })
  assert.doesNotThrow(() => apply(ctx))
})

test('没有 connection 时不抛错', () => {
  const ctx = fakeCtx({ loader: fakeLoader([]), systemPrompt })
  assert.doesNotThrow(() => apply(ctx))
})