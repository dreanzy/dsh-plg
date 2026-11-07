import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createScopeSnapshot } from '../lib/snapshot.js'
import { scanRows } from '../lib/inventory.js'
import { normalizeCwd } from '../lib/policy.js'
import { readOwned } from '../lib/servers.js'
import { loadState } from '../lib/store.js'
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
      return undefined
    },
    logger: { warn() {} },
  }
}

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dmp-mcp-routes-'))
  process.env['DSH_HOME'] = home
  return home
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function packsFile(packs, ui = {}) {
  return { version: 1, ui, packs }
}

function workspacesFile(bindings, extra = []) {
  return { version: 1, bindings, extra }
}

function makeSnapshot(entries) {
  return createScopeSnapshot({
    scan: () => scanRows({ entries: () => entries }),
    load: async (cwd) => {
      const policy = await loadState(cwd)
      const owned = await readOwned()
      return { policy, owned: owned.value, warnings: owned.warnings }
    },
  })
}

function deps(entries, afterWrite) {
  const snapshot = makeSnapshot(entries)
  return { snapshot, afterWrite }
}

test('全局视图列出 Loader 行与托管行，并给出三份策略路径', async () => {
  const home = await freshHome()
  await writeJson(join(home, 'packs', 'mcp', 'servers.json'), {
    version: 1,
    servers: { managed1: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } },
  })
  const entries = [mcpEntry('a'), plainEntry('@deepseek-ai/dsh-tool-bash')]
  const view = await handleGlobal(fakeCtx(entries), deps(entries))
  assert.equal(view.ok, true)
  assert.equal(view.value.complete, true)
  assert.deepEqual(view.value.rows.map((row) => row.serverName).sort(), ['a', 'managed1'])
  const managed = view.value.rows.find((row) => row.serverName === 'managed1')
  assert.equal(managed.owned, true)
  assert.equal(managed.source, 'managed')
  assert.match(view.value.paths.packs, /packs[\\/]mcp[\\/]packs\.json$/u)
  assert.match(view.value.paths.groups, /groups\.json$/u)
  assert.match(view.value.paths.workspaces, /workspaces\.json$/u)
  assert.match(view.value.paths.servers, /servers\.json$/u)
  // 全局视图只按 default 求值：绑定与 pack 名册依然原样给出来。
  assert.equal(view.value.binding, null)
  assert.equal(view.value.packId, 'default')
  assert.deepEqual(view.value.packs.map((pack) => pack.id), ['default'])
  assert.equal(view.value.packs[0].builtin, true)
  // 全局视图没有绑定 pack：生效值与「只按 default 求值」的那一份必然相同。
  const row = view.value.rows.find((item) => item.serverName === 'a')
  assert.equal(row.open, true)
  assert.equal(row.openGlobal, true)
  assert.equal(row.itemWorkspace, null)
  assert.equal(row.itemGlobal, null)
  assert.equal(row.decidedBy, 'default')
  assert.equal(row.decidedVia, 'builtin')
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

test('工作区视图按该会话绑定的 pack 求值', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dmp-ws-'))
  await writeJson(
    join(home, 'packs', 'mcp', 'packs.json'),
    packsFile({
      default: { name: 'default', rows: { 'global:a': { mode: 'lazy' } } },
      p1: { name: '工作', rows: { 'global:a': { enabled: false } } },
    }),
  )
  await writeJson(join(home, 'packs', 'mcp', 'workspaces.json'), workspacesFile({ [normalizeCwd(cwd)]: 'p1' }))
  const agent = { id: 's1', session: { header: { cwd } } }
  const agents = { list: () => [agent], get: (id) => (id === 's1' ? agent : undefined) }
  const entries = [mcpEntry('a')]
  const view = await handleWorkspace(fakeCtx(entries, agents), { sessionId: 's1' }, deps(entries))
  assert.equal(view.ok, true)
  assert.equal(view.value.cwd, cwd)
  assert.equal(view.value.live, true)
  assert.equal(view.value.binding, 'p1')
  assert.equal(view.value.packId, 'p1')
  assert.equal(view.value.packName, '工作')
  const row = view.value.rows[0]
  assert.equal(row.open, false)
  assert.equal(row.decidedBy, 'p1')
  assert.equal(row.decidedVia, 'item')
  assert.equal(row.itemWorkspace, false)
  assert.equal(row.itemGlobal, null)
  // mode 在绑定 pack 里没记录，跟随 default。
  assert.equal(row.mode, 'lazy')
  assert.equal(row.openGlobal, true)
  assert.deepEqual(row.packEntry, { enabled: false })
  assert.deepEqual(row.defaultEntry, { mode: 'lazy' })
})

test('悬空绑定按 default 求值并原样报出绑定 id', async () => {
  await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dmp-ws-'))
  await writeJson(
    join(process.env['DSH_HOME'], 'packs', 'mcp', 'workspaces.json'),
    workspacesFile({ [normalizeCwd(cwd)]: 'p1-gone' }),
  )
  const agent = { id: 's1', session: { header: { cwd } } }
  const agents = { list: () => [agent], get: (id) => (id === 's1' ? agent : undefined) }
  const entries = [mcpEntry('a')]
  const view = await handleWorkspace(fakeCtx(entries, agents), { sessionId: 's1' }, deps(entries))
  assert.equal(view.ok, true)
  assert.equal(view.value.binding, 'p1-gone')
  assert.equal(view.value.packId, 'default')
  assert.equal(view.value.packName, '默认')
  assert.equal(view.value.rows[0].packEntry, null)
})

test('行视图的三种来源：pack 记录、default 记录、跟随到内置缺省', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dmp-ws-'))
  await writeJson(
    join(home, 'packs', 'mcp', 'packs.json'),
    packsFile({
      default: { name: 'default', rows: { 'global:b': { enabled: false }, 'global:c': { mode: 'lazy' } } },
      p1: { name: '工作', rows: { 'global:a': { enabled: false } } },
    }),
  )
  await writeJson(join(home, 'packs', 'mcp', 'groups.json'), { version: 1, groups: [], assignments: {} })
  await writeJson(join(home, 'packs', 'mcp', 'workspaces.json'), workspacesFile({ [normalizeCwd(cwd)]: 'p1' }))
  const agent = { id: 's1', session: { header: { cwd } } }
  const agents = { list: () => [agent], get: (id) => (id === 's1' ? agent : undefined) }
  const entries = [mcpEntry('a'), mcpEntry('b'), mcpEntry('c')]
  const view = await handleWorkspace(fakeCtx(entries, agents), { sessionId: 's1' }, deps(entries))
  assert.equal(view.ok, true)
  const byName = Object.fromEntries(view.value.rows.map((row) => [row.serverName, row]))

  const fromPack = byName['a']
  assert.equal(fromPack.open, false)
  assert.equal(fromPack.itemWorkspace, false)
  assert.equal(fromPack.itemGlobal, null)
  assert.equal(fromPack.decidedBy, 'p1')
  assert.equal(fromPack.decidedVia, 'item')

  const fromDefault = byName['b']
  assert.equal(fromDefault.open, false)
  assert.equal(fromDefault.itemWorkspace, null)
  assert.equal(fromDefault.itemGlobal, false)
  assert.equal(fromDefault.decidedBy, 'default')
  assert.equal(fromDefault.decidedVia, 'item')

  const fromBuiltin = byName['c']
  assert.equal(fromBuiltin.open, true)
  assert.equal(fromBuiltin.openGlobal, true)
  assert.equal(fromBuiltin.itemWorkspace, null)
  assert.equal(fromBuiltin.itemGlobal, null)
  assert.equal(fromBuiltin.decidedBy, 'default')
  assert.equal(fromBuiltin.decidedVia, 'builtin')
  // mode 只读 default，与 enabled 来自哪一层无关。
  assert.equal(fromBuiltin.mode, 'lazy')
})

test('悬空分组在视图里按未分组处理', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dmp-ws-'))
  // 组已被删，但 pack 里留着它的旧开关、assignments 里留着旧引用：
  // 两处都是悬空数据，求值必须当未分组，不能被遗留开关关掉。
  await writeJson(join(home, 'packs', 'mcp', 'packs.json'), packsFile({ default: { name: 'default', groups: { 'g-gone': false } } }))
  await writeJson(join(home, 'packs', 'mcp', 'groups.json'), {
    version: 1,
    groups: [],
    assignments: { 'global:a': 'g-gone' },
  })
  await writeJson(join(home, 'packs', 'mcp', 'workspaces.json'), workspacesFile({ [normalizeCwd(cwd)]: 'p1' }))
  const agent = { id: 's1', session: { header: { cwd } } }
  const agents = { list: () => [agent], get: (id) => (id === 's1' ? agent : undefined) }
  const entries = [mcpEntry('a')]
  const view = await handleWorkspace(fakeCtx(entries, agents), { sessionId: 's1' }, deps(entries))
  assert.equal(view.ok, true)
  const row = view.value.rows[0]
  assert.equal(row.groupId, null)
  assert.equal(row.open, true)
  assert.equal(row.decidedVia, 'builtin')
})

test('apply 写入后视图立即反映新值，且落在 packs.json', async () => {
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
    {
      commands: [
        { op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: false } },
      ],
    },
    d,
  )
  assert.equal(first.ok, true)
  assert.equal(writes, 1)
  assert.equal(first.value.rows[0].open, false)

  const onDisk = await readJson(join(home, 'packs', 'mcp', 'packs.json'))
  assert.deepEqual(onDisk.packs.default.rows['global:a'], { enabled: false })

  const second = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: true } }] },
    d,
  )
  assert.equal(second.value.rows[0].open, true)
})

test('packRow 的 null 表示回到跟随，与写 false 是两件事', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const d = deps(entries)
  await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: false } }] },
    d,
  )
  const cleared = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: null } }] },
    d,
  )
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.rows[0].open, true)
  const onDisk = await readJson(join(home, 'packs', 'mcp', 'packs.json'))
  // 没有行就整个 rows 段都不写，不留空对象。
  assert.equal(onDisk.packs.default.rows, undefined)
})

test('组级只影响 enabled，不影响 mode', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const d = deps(entries)
  const applied = await handleApply(
    fakeCtx(entries),
    {
      commands: [
        { op: 'createGroup', name: '本地' },
        { op: 'assign', rowKey: 'global:a', groupId: 'g1' },
        { op: 'packGroup', packId: 'default', groupId: 'g1', value: false },
        { op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { mode: 'eager' } },
      ],
    },
    d,
  )
  assert.equal(applied.ok, true)
  const row = applied.value.rows[0]
  assert.equal(row.open, false)
  assert.equal(row.decidedBy, 'default')
  assert.equal(row.decidedVia, 'group')
  assert.equal(row.mode, 'eager')
  assert.equal(row.groupId, 'g1')
  assert.deepEqual((await readJson(join(home, 'packs', 'mcp', 'packs.json'))).packs.default.groups, { g1: false })
})

test('bind 不依赖 sessionId，写入后可读回该工作区的绑定', async () => {
  const home = await freshHome()
  const cwd = 'D:/proj/bound'
  const entries = [mcpEntry('a')]
  const d = deps(entries)
  const created = await handleApply(fakeCtx(entries), { commands: [{ op: 'createPack', name: '工作' }] }, d)
  assert.equal(created.ok, true)
  const bound = await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'bind', cwd, packId: 'p1' }] },
    d,
  )
  assert.equal(bound.ok, true)
  const onDisk = await readJson(join(home, 'packs', 'mcp', 'workspaces.json'))
  assert.deepEqual(onDisk.bindings, { [normalizeCwd(cwd)]: 'p1' })
})

test('apply 遇到未知会话时报错且不落盘', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const result = await handleApply(
    fakeCtx(entries),
    { sessionId: 'nope', commands: [{ op: 'showChip', value: false }] },
    deps(entries),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-session')
  const exists = await readFile(join(home, 'packs', 'mcp', 'packs.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
})

test('坏命令整批拒绝，一条都不写', async () => {
  const home = await freshHome()
  const entries = [mcpEntry('a')]
  const d = deps(entries)
  const result = await handleApply(
    fakeCtx(entries),
    {
      commands: [
        { op: 'showChip', value: false },
        { op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { mode: 'bogus' } },
      ],
    },
    d,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  const exists = await readFile(join(home, 'packs', 'mcp', 'packs.json'), 'utf8').then(
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

test('托管定义可增可删，删除后各 pack 里的行键一并清掉', async () => {
  const home = await freshHome()
  const entries = []
  const added = await handleServers(
    fakeCtx(entries),
    { op: 'upsert', name: 's1', def: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } },
    {},
  )
  assert.equal(added.ok, true)
  assert.equal(Object.keys(added.value.servers).includes('s1'), true)

  const d = deps(entries)
  await handleApply(
    fakeCtx(entries),
    { commands: [{ op: 'packRow', packId: 'default', rowKey: 'own:s1', patch: { enabled: false } }] },
    d,
  )
  const before = await readJson(join(home, 'packs', 'mcp', 'packs.json'))
  assert.deepEqual(before.packs.default.rows['own:s1'], { enabled: false })

  const removed = await handleServers(fakeCtx(entries), { op: 'remove', name: 's1' }, {})
  assert.equal(removed.ok, true)
  assert.equal(Object.keys(removed.value.servers).includes('s1'), false)

  const after = await readJson(join(home, 'packs', 'mcp', 'packs.json'))
  assert.equal(after.packs.default?.rows?.['own:s1'], undefined)
})

test('parseCommands 收下全部合法 op', () => {
  const parsed = parseCommands([
    { op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: false, mode: null } },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: true },
    { op: 'createPack', name: '一' },
    { op: 'renamePack', packId: 'p1', name: '二' },
    { op: 'deletePack', packId: 'p1' },
    { op: 'bind', cwd: 'D:/p', packId: null },
    { op: 'addExtra', cwd: 'D:/q' },
    { op: 'removeExtra', cwd: 'D:/q' },
    { op: 'assign', rowKey: 'global:a', groupId: 'g1' },
    { op: 'createGroup', name: '本地' },
    { op: 'renameGroup', groupId: 'g1', name: '远程' },
    { op: 'deleteGroup', groupId: 'g1' },
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'workspace' },
  ])
  assert.equal(parsed.ok, true)
  assert.equal(parsed.commands.length, 14)
  assert.deepEqual(parsed.commands[0].patch, { enabled: false, mode: null })
  assert.equal(parsed.commands[5].packId, null)
})

test('parseCommands 对坏条目拒绝整批', () => {
  assert.equal(parseCommands('nope').ok, false)
  assert.equal(parseCommands([]).ok, false)
  assert.equal(parseCommands([null]).ok, false)
  assert.equal(parseCommands([{ op: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'showChip', value: 'no' }]).ok, false)
  assert.equal(parseCommands([{ op: 'defaultTab', value: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { tools: [1] } }]).ok, false)
  assert.equal(parseCommands([{ op: 'bind', cwd: '', packId: null }]).ok, false)
  assert.equal(parseCommands([{ op: 'assign', rowKey: 'global:a', groupId: 3 }]).ok, false)
  assert.equal(parseCommands([{ op: 'packGroup', packId: 'default', groupId: 'g1', value: 'yes' }]).ok, false)
})
