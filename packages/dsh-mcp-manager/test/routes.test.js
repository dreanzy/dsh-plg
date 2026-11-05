import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScopeSnapshot } from '../lib/snapshot.js'
import { scanRows } from '../lib/inventory.js'
import { loadLayers } from '../lib/store.js'
import { readOwned } from '../lib/servers.js'
import { handleApply, handleGlobal, handleServers, handleWorkspace, parseCommands } from '../lib/routes.js'

const MCP = '@deepseek-ai/dsh-mcp-client'

/** 一条 mcp-client 的 Loader 行。不清 shape 的话 scanRows 会整行跳过。 */
function mcpEntry(serverName, config = {}) {
  return {
    options: {
      name: MCP,
      id: 'mcp-' + serverName,
      config: { transport: 'stdio', serverName, command: 'node', args: ['x.js'], ...config },
    },
    parent: { tree: { filename: '/profile/cordis.patch.yml' } },
  }
}

function plainEntry(name) {
  return { options: { name, id: 'other' }, parent: { tree: { filename: '/profile/cordis.patch.yml' } } }
}

function fakeCtx(entries, agents = null) {
  return {
    get: (name) => {
      if (name === 'loader') return { entries: () => entries }
      if (name === 'agents') return agents ?? { list: () => [], get: () => undefined }
      if (name === 'tools') return undefined
      return undefined
    },
    logger: { warn() {} },
  }
}

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsm-mcp-routes-'))
  process.env['DSH_HOME'] = home
  await mkdir(join(home, 'mcp-manager'), { recursive: true })
  return home
}

function makeSnapshot(entries) {
  return createScopeSnapshot({
    scan: () => scanRows({ entries: () => entries }),
    load: async (cwd) => {
      const layers = await loadLayers({ cwd })
      const owned = await readOwned()
      return {
        global: layers.global,
        workspace: layers.workspace,
        owned: owned.value,
        warnings: [...layers.warnings, ...owned.warnings],
      }
    },
  })
}

function deps(entries, afterWrite) {
  const snapshot = makeSnapshot(entries)
  return { snapshot, afterWrite }
}

test('全局视图列出 Loader 行与托管行', async () => {
  const home = await freshHome()
  await writeFile(
    join(home, 'mcp-manager', 'servers.json'),
    JSON.stringify({ version: 1, servers: { managed1: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } } }),
  )
  const entries = [mcpEntry('a'), plainEntry('@deepseek-ai/dsh-tool-bash')]
  const view = await handleGlobal(fakeCtx(entries), deps(entries))
  assert.equal(view.ok, true)
  assert.equal(view.value.complete, true)
  assert.deepEqual(view.value.rows.map((row) => row.serverName).sort(), ['a', 'managed1'])
  const owned = view.value.rows.find((row) => row.serverName === 'managed1')
  assert.equal(owned.owned, true)
  assert.equal(owned.source, 'managed')
  assert.match(view.value.paths.global, /global\.json$/u)
  assert.equal(view.value.paths.workspace, null)
})

test('没有 loader 时返回 internal 错误', async () => {
  await freshHome()
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const view = await handleGlobal(ctx, deps([]))
  assert.equal(view.ok, false)
  assert.equal(view.error.code, 'internal')
})

test('工作区视图缺少 sessionId 时拒绝', async () => {
  await freshHome()
  const view = await handleWorkspace(fakeCtx([]), {}, deps([]))
  assert.equal(view.ok, false)
  assert.equal(view.error.code, 'bad-request')
})

test('工作区视图解析不出会话时拒绝', async () => {
  await freshHome()
  const view = await handleWorkspace(fakeCtx([]), { sessionId: 'missing' }, deps([]))
  assert.equal(view.ok, false)
  assert.equal(view.error.code, 'unknown-session')
})

test('工作区视图按该会话的 cwd 求值', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dsm-mcp-ws-'))
  await mkdir(join(cwd, '.dsh'), { recursive: true })
  await writeFile(
    join(cwd, '.dsh', 'mcp-manager.json'),
    JSON.stringify({ version: 1, rows: { 'global:a': { enabled: false } } }),
  )
  const agent = { id: 's1', session: { header: { cwd } } }
  const agents = { list: () => [agent], get: (id) => (id === 's1' ? agent : undefined) }
  const entries = [mcpEntry('a')]
  const view = await handleWorkspace(fakeCtx(entries, agents), { sessionId: 's1' }, deps(entries))
  assert.equal(view.ok, true)
  assert.equal(view.value.cwd, cwd)
  assert.equal(view.value.live, true)
  assert.equal(view.value.rows[0].resolved.enabled, false)
  assert.equal(view.value.rows[0].resolved.from, 'workspace')
})

test('apply 写入后视图立即反映新值', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const d = deps(entries)
  let writes = 0
  d.afterWrite = async () => {
    writes += 1
    await d.snapshot.refresh(null)
  }
  const first = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'enabled', layer: 'global', rowKey: 'global:a', value: false }] },
    d,
  )
  assert.equal(first.ok, true)
  assert.equal(writes, 1)
  assert.equal(first.value.rows[0].resolved.enabled, false)

  const onDisk = JSON.parse(await readFile(join(home, 'mcp-manager', 'global.json'), 'utf8'))
  assert.deepEqual(onDisk.rows['global:a'], { enabled: false })

  const second = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'enabled', layer: 'global', rowKey: 'global:a', value: true }] },
    d,
  )
  assert.equal(second.value.rows[0].resolved.enabled, true)
})

test('工作区命令缺少 sessionId 时拒绝且不落盘', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const result = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'enabled', layer: 'workspace', rowKey: 'global:a', value: false }] },
    deps(entries),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  const exists = await readFile(join(home, 'mcp-manager', 'global.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
})

test('托管定义与 Loader 行重名时拒绝新增', async () => {
  await freshHome()
  const entries = [mcpEntry('a')]
  const result = await handleServers(
    fakeCtx(entries),
    { op: 'upsert', name: 'a', def: { transport: 'stdio', command: 'node', args: [] } },
    {},
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
})

test('托管定义可增可删，删除后策略键一并清掉', async () => {
  const home = await freshHome()
  const entries = []
  const added = await handleServers(
    fakeCtx(entries),
    { op: 'upsert', name: 's1', def: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } },
    {},
  )
  assert.equal(added.ok, true)
  assert.equal(Object.keys(added.value.servers).includes('s1'), true)

  await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'enabled', layer: 'global', rowKey: 'own:s1', value: false }] },
    deps(entries),
  )
  const before = JSON.parse(await readFile(join(home, 'mcp-manager', 'global.json'), 'utf8'))
  assert.deepEqual(before.rows['own:s1'], { enabled: false })

  const removed = await handleServers(fakeCtx(entries), { op: 'remove', name: 's1' }, {})
  assert.equal(removed.ok, true)
  assert.equal(Object.keys(removed.value.servers).includes('s1'), false)

  const after = JSON.parse(await readFile(join(home, 'mcp-manager', 'global.json'), 'utf8'))
  assert.equal(after.rows['own:s1'], undefined)
})

test('parseCommands 跳过坏条目并记 warning', () => {
  const warnings = []
  const commands = parseCommands(
    [
      { op: 'enabled', layer: 'global', rowKey: 'global:a', value: false },
      null,
      { op: 'mode', layer: 'global', rowKey: 'global:a', value: 'bogus' },
      { op: 'nope' },
      { op: 'showSidebarEntry', value: true },
    ],
    warnings,
  )
  assert.equal(commands.length, 2)
  assert.equal(commands[0].op, 'enabled')
  assert.equal(commands[1].op, 'showSidebarEntry')
  assert.equal(warnings.length, 3)
})
