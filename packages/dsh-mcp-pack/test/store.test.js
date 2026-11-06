import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeCwd } from '../lib/policy.js'
import {
  applyCommands,
  groupsPath,
  legacyGlobalPath,
  legacyRowsPath,
  legacyWorkspacePath,
  loadState,
  packsPath,
  workspacesPath,
} from '../lib/store.js'

/**
 * 落盘与兼容读的用例。
 *
 * 旧实现把策略落在 `$DSH_HOME/mcp-manager/` 与 `<cwd>/.dsh/mcp-manager.json`；
 * 新实现三份都落在 `$DSH_HOME/packs/mcp/`：`packs.json`、`groups.json`、
 * `workspaces.json`。工作区目录下不再产生任何状态文件。
 */

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dmp-store-'))
  process.env['DSH_HOME'] = home
  return home
}

async function fileExists(path) {
  return readFile(path, 'utf8').then(
    () => true,
    () => false,
  )
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('三个状态文件落在 $DSH_HOME/packs/mcp/ 下', async () => {
  const home = await freshHome()
  assert.equal(packsPath(), join(home, 'packs', 'mcp', 'packs.json'))
  assert.equal(groupsPath(), join(home, 'packs', 'mcp', 'groups.json'))
  assert.equal(workspacesPath(), join(home, 'packs', 'mcp', 'workspaces.json'))
})

test('createPack 写盘时永远保留 default，并按 id 排序', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const onDisk = await readJson(packsPath())
  assert.deepEqual(Object.keys(onDisk.packs), ['default', 'p1'])
  assert.equal(onDisk.packs.default.name, 'default')
  assert.equal(onDisk.packs.p1.name, '工作')
  assert.deepEqual(onDisk.ui, { showChip: true, defaultTab: 'groups' })
})

test('packRow 的三态：null 删该字段回到跟随，其余字段不动', async () => {
  await freshHome()
  await applyCommands(null, [
    {
      op: 'packRow',
      packId: 'default',
      rowKey: 'global:a',
      patch: { enabled: false, mode: 'lazy', tools: ['read_*'], description: '浏览器' },
    },
  ])
  let state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows['global:a'], {
    enabled: false,
    mode: 'lazy',
    tools: ['read_*'],
    description: '浏览器',
  })

  await applyCommands(null, [{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { enabled: null } }])
  state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows['global:a'], {
    mode: 'lazy',
    tools: ['read_*'],
    description: '浏览器',
  })

  // 四个字段全删掉后整条行消失，不留空对象冒充覆盖。
  await applyCommands(null, [
    { op: 'packRow', packId: 'default', rowKey: 'global:a', patch: { mode: null, tools: null, description: null } },
  ])
  state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows, {})

  // 空补丁是无操作，不新建行。
  await applyCommands(null, [{ op: 'packRow', packId: 'default', rowKey: 'global:a', patch: {} }])
  assert.deepEqual((await loadState(null)).packs.packs.default.rows, {})
})

test('packGroup 的三态：null 删键回到跟随', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'packGroup', packId: 'default', groupId: 'g1', value: false }])
  assert.deepEqual((await loadState(null)).packs.packs.default.groups, { g1: false })
  await applyCommands(null, [{ op: 'packGroup', packId: 'default', groupId: 'g1', value: null }])
  assert.deepEqual((await loadState(null)).packs.packs.default.groups, {})
})

test('default pack 不可删除、不可改名；未知 pack 的写入被拒；重名被拒', async () => {
  await freshHome()
  await assert.rejects(applyCommands(null, [{ op: 'deletePack', packId: 'default' }]), /default pack 不可删除/u)
  await assert.rejects(applyCommands(null, [{ op: 'renamePack', packId: 'default', name: 'x' }]), /default pack 不可改名/u)
  await assert.rejects(
    applyCommands(null, [{ op: 'packRow', packId: 'missing', rowKey: 'global:a', patch: { enabled: false } }]),
    /未知 pack/u,
  )
  await applyCommands(null, [{ op: 'createPack', name: '一' }])
  await assert.rejects(applyCommands(null, [{ op: 'createPack', name: '一' }]), /已存在/u)
  await applyCommands(null, [{ op: 'renamePack', packId: 'p1', name: '二' }])
  assert.equal((await loadState(null)).packs.packs.p1.name, '二')
})

test('bind 与 bind null：绑定键是规范化后的 cwd', async () => {
  await freshHome()
  const cwd = 'D:\\Proj\\Sub\\'
  const key = normalizeCwd(cwd)
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])

  const bound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  assert.equal(bound.binding, 'p1')
  assert.equal(bound.packId, 'p1')
  assert.equal(bound.pack.name, '工作')
  assert.deepEqual((await readJson(workspacesPath())).bindings, { [key]: 'p1' })

  const unbound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: null }])
  assert.equal(unbound.binding, null)
  assert.equal(unbound.packId, 'default')
  assert.equal(unbound.pack, null)
  assert.deepEqual((await readJson(workspacesPath())).bindings, {})
})

test('binding 指向未知 pack 时按 default 求值，读取不抛错', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: {
      default: { name: 'default', rows: { 'global:a': { enabled: false } } },
      p1: { name: '一', rows: { 'global:a': { enabled: true } } },
    },
  })
  // 手工制造悬空绑定：p1 已被删、workspaces.json 还指着它。
  await writeJson(workspacesPath(), { version: 1, bindings: { [normalizeCwd(cwd)]: 'p1-gone' }, extra: [] })
  const state = await loadState(cwd)
  assert.equal(state.binding, 'p1-gone')
  assert.equal(state.packId, 'default')
  assert.equal(state.pack, null)

  // 再写一次绑定，不应把悬空键当成错误。
  const after = await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  assert.equal(after.packId, 'p1')
  assert.equal(after.pack.name, '一')
})

test('删除 pack 会清掉指向它的绑定', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  await applyCommands(cwd, [{ op: 'deletePack', packId: 'p1' }])
  assert.deepEqual((await readJson(workspacesPath())).bindings, {})
  assert.deepEqual(Object.keys((await readJson(packsPath())).packs), ['default'])
  assert.equal((await loadState(cwd)).packId, 'default')
})

test('ui 命令写入 packs.json', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
  ])
  assert.deepEqual((await readJson(packsPath())).ui, { showChip: false, defaultTab: 'packs' })
})

test('组的新增、改名、指派与删除', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createGroup', name: '浏览器' }])
  await applyCommands(null, [{ op: 'createGroup', name: '本地' }])
  let state = await loadState(null)
  assert.deepEqual(state.groups.groups, [
    { id: 'g1', name: '浏览器' },
    { id: 'g2', name: '本地' },
  ])

  await applyCommands(null, [{ op: 'renameGroup', groupId: 'g2', name: '本机' }])
  state = await loadState(null)
  assert.equal(state.groups.groups[1].name, '本机')

  await applyCommands(null, [{ op: 'assign', rowKey: 'global:a', groupId: 'g1' }])
  assert.deepEqual((await loadState(null)).groups.assignments, { 'global:a': 'g1' })

  await applyCommands(null, [{ op: 'assign', rowKey: 'global:a', groupId: null }])
  assert.deepEqual((await loadState(null)).groups.assignments, {})

  await applyCommands(null, [{ op: 'assign', rowKey: 'global:a', groupId: 'g1' }])
  await applyCommands(null, [{ op: 'deleteGroup', groupId: 'g1' }])
  state = await loadState(null)
  assert.deepEqual(state.groups.groups.map((group) => group.id), ['g2'])
  // 成员回到未分组。
  assert.deepEqual(state.groups.assignments, {})

  await assert.rejects(applyCommands(null, [{ op: 'assign', rowKey: 'global:a', groupId: 'g9' }]), /未知分组/u)
  await assert.rejects(applyCommands(null, [{ op: 'deleteGroup', groupId: 'g9' }]), /未知分组/u)
})

test('兼容读：旧 global.json 映射成 default，且读取不写新文件', async () => {
  await freshHome()
  await writeJson(legacyGlobalPath(), {
    version: 1,
    rows: { 'global:a': { enabled: false, mode: 'lazy' } },
    // `showSidebarEntry` 已废弃：旧文件里残留这个键时忽略，不报错。
    settings: { showSidebarEntry: false },
  })
  const state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows, { 'global:a': { enabled: false, mode: 'lazy' } })
  assert.deepEqual(state.ui, { showChip: true, defaultTab: 'groups' })
  assert.equal(await fileExists(packsPath()), false)
  assert.equal(await fileExists(groupsPath()), false)
  assert.equal(await fileExists(workspacesPath()), false)
})

test('兼容读：更早的 rows.json 也能读', async () => {
  await freshHome()
  await writeJson(legacyRowsPath(), { version: 1, rows: { 'own:x': { enabled: false } } })
  const state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows, { 'own:x': { enabled: false } })
  assert.equal(await fileExists(packsPath()), false)
})

test('新文件存在时不再读旧文件', async () => {
  await freshHome()
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: { default: { name: 'default', rows: { 'global:a': { enabled: true } } } },
  })
  await writeJson(legacyGlobalPath(), { version: 1, rows: { 'global:a': { enabled: false } } })
  const state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.rows, { 'global:a': { enabled: true } })
})

test('兼容读：旧工作区层在内存里合成 pack 并绑定到该 cwd，不写盘', async () => {
  await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dmp-ws-'))
  await writeJson(legacyWorkspacePath(cwd), {
    version: 1,
    rows: { 'global:a': { enabled: false } },
  })
  const state = await loadState(cwd)
  const key = normalizeCwd(cwd)
  assert.equal(state.binding, 'legacy')
  assert.equal(state.packId, 'legacy')
  assert.equal(state.pack.name, key.split('/').pop())
  assert.deepEqual(state.pack.rows, { 'global:a': { enabled: false } })
  assert.deepEqual(state.bindings.bindings, { [key]: 'legacy' })
  assert.equal(await fileExists(workspacesPath()), false)
  assert.equal(await fileExists(packsPath()), false)
})

test('兼容读不写盘：连读多次也不产生任何新文件', async () => {
  const home = await freshHome()
  await writeJson(legacyGlobalPath(), { version: 1, rows: { 'global:a': { enabled: false } } })
  await loadState(null)
  await loadState('D:/other')
  await loadState(null)
  const written = await readdir(join(home, 'packs')).catch(() => [])
  assert.deepEqual(
    written.filter((name) => name.endsWith('.json')),
    [],
  )
})

test('兼容读之后第一次保存承接旧决定，不从空策略起写', async () => {
  await freshHome()
  await writeJson(legacyGlobalPath(), { version: 1, rows: { 'global:a': { enabled: false } } })
  await applyCommands(null, [
    { op: 'packRow', packId: 'default', rowKey: 'global:b', patch: { enabled: false } },
  ])
  const onDisk = await readJson(packsPath())
  assert.deepEqual(onDisk.packs.default.rows, {
    'global:a': { enabled: false },
    'global:b': { enabled: false },
  })
})

test('没有新绑定文件时，deletePack 不会凭空创建 workspaces.json', async () => {
  await freshHome()
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: { default: { name: 'default' }, p1: { name: '一' } },
  })
  await applyCommands(null, [{ op: 'deletePack', packId: 'p1' }])
  assert.equal(await fileExists(workspacesPath()), false)
})

test('绑定表解析出的 extra 原样保留，写回时不清空', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(workspacesPath(), { version: 1, bindings: {}, extra: ['D:\\Extra\\'] })
  await applyCommands(cwd, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  const onDisk = await readJson(workspacesPath())
  assert.deepEqual(onDisk.extra, [normalizeCwd('D:\\Extra\\')])
  assert.deepEqual(onDisk.bindings, { [normalizeCwd(cwd)]: 'p1' })
})

test('addExtra / removeExtra：规范化、去重、与 bindings 互不影响', async () => {
  await freshHome()
  const a = normalizeCwd('D:\\Extra\\')
  const b = normalizeCwd('E:/other')
  await applyCommands(null, [{ op: 'addExtra', cwd: 'D:\\Extra\\' }])
  await applyCommands(null, [{ op: 'addExtra', cwd: a }])
  let onDisk = await readJson(workspacesPath())
  assert.deepEqual(onDisk.extra, [a])
  assert.deepEqual(onDisk.bindings, {})
  await applyCommands(null, [{ op: 'addExtra', cwd: 'E:/other' }])
  onDisk = await readJson(workspacesPath())
  assert.deepEqual([...onDisk.extra].sort(), [a, b].sort())
  await applyCommands(null, [{ op: 'removeExtra', cwd: a }])
  onDisk = await readJson(workspacesPath())
  assert.deepEqual(onDisk.extra, [b])
})
