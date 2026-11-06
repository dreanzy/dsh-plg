import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, dirname, join } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  applyCommands,
  groupsPath,
  legacyGlobalPath,
  legacyGroupsPath,
  legacyWorkspacePath,
  loadState,
  packsPath,
  workspacesPath,
} from '../lib/store.js'
import { normalizeCwd } from '../lib/policy.js'

/**
 * 落盘与兼容读的用例。
 *
 * 旧实现有两个策略文件（全局层 + 工作区层）落 `$DSH_HOME/plugin-manager/`；
 * 新实现有三个，都落在 `$DSH_HOME/packs/plugin/`：`packs.json`、`groups.json`、
 * `workspaces.json`。工作区目录下不再产生任何状态文件。
 */

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dpp-store-'))
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

test('三个状态文件落在 $DSH_HOME/packs/plugin/ 下', async () => {
  const home = await freshHome()
  assert.equal(packsPath(), join(home, 'packs', 'plugin', 'packs.json'))
  assert.equal(groupsPath(), join(home, 'packs', 'plugin', 'groups.json'))
  assert.equal(workspacesPath(), join(home, 'packs', 'plugin', 'workspaces.json'))
})

test('createPack 写盘时永远保留 default，并按 id 排序', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const onDisk = await readJson(packsPath())
  assert.deepEqual(Object.keys(onDisk.packs), ['default', 'p1'])
  assert.equal(onDisk.packs.default.name, 'default')
  assert.equal(onDisk.packs.p1.name, '工作')
  assert.deepEqual(onDisk.ui, { showOfficialPlugins: false, showChip: true, defaultTab: 'groups' })
})

test('packItem / packGroup 的三态：null 删键回到跟随', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'plug-a', value: false },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: true },
  ])
  let state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, { 'plug-a': false })
  assert.deepEqual(state.packs.packs.default.groups, { g1: true })

  await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'plug-a', value: null },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: null },
  ])
  state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, {})
  assert.deepEqual(state.packs.packs.default.groups, {})
})

test('default pack 不可删除、不可改名；未知 pack 的写入被拒', async () => {
  await freshHome()
  await assert.rejects(applyCommands(null, [{ op: 'deletePack', packId: 'default' }]), /default pack 不可删除/)
  await assert.rejects(applyCommands(null, [{ op: 'renamePack', packId: 'default', name: 'x' }]), /default pack 不可改名/)
  await assert.rejects(
    applyCommands(null, [{ op: 'packItem', packId: 'missing', name: 'plug-a', value: false }]),
    /未知 pack/,
  )
})

test('bind 与 bind null：绑定键是规范化后的 cwd', async () => {
  await freshHome()
  const cwd = 'D:\\Proj\\Sub\\'
  const key = normalizeCwd(cwd)
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])

  const bound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  assert.equal(bound.binding, 'p1')
  assert.equal(bound.packId, 'p1')
  assert.equal(bound.pack?.name, '工作')
  assert.deepEqual((await readJson(workspacesPath())).bindings, { [key]: 'p1' })

  const unbound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: null }])
  assert.equal(unbound.binding, null)
  assert.equal(unbound.packId, 'default')
  assert.equal(unbound.pack, null)
  assert.deepEqual((await readJson(workspacesPath())).bindings, {})
})

test('删除 pack 后悬空绑定按 default 求值，读取不抛错', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: {
      default: { name: 'default', items: { 'plug-a': false } },
      p1: { name: '一', items: { 'plug-a': true } },
    },
  })
  // 手工制造悬空绑定：p1 已被删、workspaces.json 还指着它。
  await writeJson(workspacesPath(), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1-gone' },
    extra: [],
  })
  const state = await loadState(cwd)
  assert.equal(state.binding, 'p1-gone')
  assert.equal(state.packId, 'default')
  assert.equal(state.pack, null)

  // 再写一次绑定，不应把悬空键当成错误。
  const after = await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  assert.equal(after.packId, 'p1')
  assert.equal(after.pack?.name, '一')
})

test('删除 pack 会清掉指向它的绑定', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  await applyCommands(cwd, [{ op: 'deletePack', packId: 'p1' }])
  assert.deepEqual((await readJson(workspacesPath())).bindings, {})
  assert.deepEqual(Object.keys((await readJson(packsPath())).packs), ['default'])
})

test('ui 命令写入 packs.json', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
  ])
  assert.deepEqual((await readJson(packsPath())).ui, { showOfficialPlugins: false, showChip: false, defaultTab: 'packs' })
})

test('兼容读：旧 global.json 映射成 default，且读取不写新文件', async () => {
  await freshHome()
  await writeJson(legacyGlobalPath(), {
    items: { 'plug-a': false },
    groups: { g1: true },
    // `showSidebarEntry` 已废弃：旧文件里残留这个键时忽略，不报错。
    ui: { showSidebarEntry: false },
  })
  const state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, { 'plug-a': false })
  assert.deepEqual(state.packs.packs.default.groups, { g1: true })
  assert.deepEqual(state.ui, { showOfficialPlugins: false, showChip: true, defaultTab: 'groups' })
  assert.equal(await fileExists(packsPath()), false)
  assert.equal(await fileExists(workspacesPath()), false)
})

test('兼容读：旧 groups.json 映射成组注册表，且读取不写新文件', async () => {
  await freshHome()
  await writeJson(legacyGroupsPath(), {
    groups: [{ id: 'g1', name: '一组' }],
    assignments: { 'plug-a': 'g1' },
  })
  const state = await loadState(null)
  assert.deepEqual(state.groups.groups, [{ id: 'g1', name: '一组' }])
  assert.deepEqual(state.groups.assignments, { 'plug-a': 'g1' })
  assert.equal(await fileExists(groupsPath()), false)
})

test('兼容读：旧工作区层在内存里合成 pack 并绑定到该 cwd，不写盘', async () => {
  await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(legacyWorkspacePath(cwd), { items: { 'plug-a': false }, groups: { g1: true } })
  const state = await loadState(cwd)
  const key = normalizeCwd(cwd)
  assert.equal(state.binding, 'legacy')
  assert.equal(state.packId, 'legacy')
  assert.deepEqual(state.pack?.items, { 'plug-a': false })
  assert.deepEqual(state.pack?.groups, { g1: true })
  assert.equal(state.pack?.name, basename(key))
  assert.deepEqual(state.bindings.bindings, { [key]: 'legacy' })
  assert.equal(await fileExists(workspacesPath()), false)
  assert.equal(await fileExists(packsPath()), false)
})

test('新文件存在时不再读旧文件', async () => {
  await freshHome()
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: { default: { name: 'default', items: { 'plug-a': true } } },
  })
  await writeJson(legacyGlobalPath(), { items: { 'plug-a': false } })
  const state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, { 'plug-a': true })
})

test('兼容读之后第一次保存承接旧决定，不从空策略起写', async () => {
  await freshHome()
  await writeJson(legacyGlobalPath(), { items: { 'plug-a': false } })
  await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'plug-b', value: false }])
  const onDisk = await readJson(packsPath())
  assert.deepEqual(onDisk.packs.default.items, { 'plug-a': false, 'plug-b': false })
})

test('兼容读之后第一次组写入同样承接旧组定义', async () => {
  await freshHome()
  await writeJson(legacyGroupsPath(), {
    groups: [{ id: 'g1', name: '一组' }],
    assignments: { 'plug-a': 'g1' },
  })
  await applyCommands(null, [{ op: 'createGroup', name: '二组' }])
  const onDisk = await readJson(groupsPath())
  assert.deepEqual(onDisk.groups, [
    { id: 'g1', name: '一组' },
    { id: 'g2', name: '二组' },
  ])
  assert.deepEqual(onDisk.assignments, { 'plug-a': 'g1' })
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
  await writeJson(workspacesPath(), {
    version: 1,
    bindings: {},
    extra: ['D:\\Extra\\'],
  })
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
