import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  applyCommands,
  groupsPath,
  loadState,
  packsPath,
  previewCommands,
  workspacesPath,
} from '../lib/store.js'
import { createResolver, defaultPackOf, normalizeCwd } from '../lib/policy.js'

/**
 * 落盘用例。
 *
 * 三个策略文件都落在 `$DSH_HOME/packs/plugin/`：`packs.json`、`groups.json`、
 * `workspaces.json`。工作区目录下不产生任何状态文件。
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
  assert.equal(onDisk.packs.default.name, '默认')
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

test('默认 pack 不可删除、不可改名；未知 pack 的写入被拒', async () => {
  await freshHome()
  // 写入失败不抛错：说明进 warnings，且这一批不落盘。
  const deleted = await applyCommands(null, [{ op: 'deletePack', packId: 'default' }])
  assert.ok(deleted.warnings.some((line) => line.includes('默认 pack 不可删除')))
  const renamed = await applyCommands(null, [{ op: 'renamePack', packId: 'default', name: 'x' }])
  assert.ok(renamed.warnings.some((line) => line.includes('默认 pack 不可改名')))
  const missing = await applyCommands(null, [{ op: 'packItem', packId: 'missing', name: 'plug-a', value: false }])
  assert.ok(missing.warnings.some((line) => line.includes('未知 pack')))
  assert.equal(await fileExists(packsPath()), false)
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

test('删组会清掉各 pack 里的组开关：重建的同 id 不继承旧决定', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createGroup', name: '旧组' }])
  await applyCommands(null, [{ op: 'assign', name: 'plug-a', groupId: 'g1' }])
  await applyCommands(null, [{ op: 'packGroup', packId: 'default', groupId: 'g1', value: false }])

  await applyCommands(null, [{ op: 'deleteGroup', groupId: 'g1' }])
  // 组开关是残留在 packs.json 里的，删组必须连带清掉。
  assert.deepEqual((await readJson(packsPath())).packs.default.groups ?? {}, {})

  // 分组 id 从 length + 1 起算，删掉编号最大的组后会被复用；正因如此，残留必须清。
  await applyCommands(null, [{ op: 'createGroup', name: '新组' }])
  let state = await loadState(null)
  assert.equal(state.groups.groups[0].id, 'g1')
  await applyCommands(null, [{ op: 'assign', name: 'plug-b', groupId: 'g1' }])

  state = await loadState(null)
  const resolver = createResolver({
    pack: null,
    defaultPack: defaultPackOf(state.packs),
    groups: state.groups,
  })
  // 新组里的无关插件必须是开的：旧组的 false 不许漏进来。
  assert.equal(resolver.isOpen('plug-b'), true)
})

test('ui 命令写入 packs.json', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
  ])
  assert.deepEqual((await readJson(packsPath())).ui, { showOfficialPlugins: false, showChip: false, defaultTab: 'packs' })
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

test('旧版的 extra 读时忽略，下次写盘就消失', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(workspacesPath(), {
    version: 1,
    bindings: {},
    extra: ['D:\\Extra\\'],
  })
  await applyCommands(cwd, [{ op: 'createPack', name: '工作' }])
  // 读侧完全不提这件事：面板上不该常驻一条「extra 已废弃」的告警。
  const state = await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  assert.deepEqual(
    state.warnings.filter((line) => line.includes('extra')),
    [],
  )
  const onDisk = await readJson(workspacesPath())
  assert.equal('extra' in onDisk, false)
  assert.deepEqual(onDisk.bindings, { [normalizeCwd(cwd)]: 'p1' })
})

/**
 * 防覆盖默认：写之前的三种坏情况各留一条。
 *
 * 这三条的共同点都不是「报错」，而是**什么都不做**——拒写之后磁盘上必须还是原来那份，
 * 读写失败的说明只能出现在返回状态的 warnings 里。
 */

const NEWLINE = String.fromCharCode(10)

function goldenPacks() {
  return [
    '{',
    '  "version": 1,',
    '  "ui": {',
    '    "showOfficialPlugins": false,',
    '    "showChip": true,',
    '    "defaultTab": "groups"',
    '  },',
    '  "packs": {',
    '    "default": {',
    '      "name": "默认",',
    '      "items": {',
    '        "a": true,',
    '        "b": false',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join(NEWLINE)
}

test('成功路径输出逐字节不变：键序、缩进、结尾换行都不动', async () => {
  await freshHome()
  const commands = [
    { op: 'packItem', packId: 'default', name: 'b', value: false },
    { op: 'packItem', packId: 'default', name: 'a', value: true },
  ]
  await applyCommands(null, commands)
  const first = await readFile(packsPath(), 'utf8')
  assert.equal(first, goldenPacks())

  await applyCommands(null, commands)
  assert.equal(await readFile(packsPath(), 'utf8'), first)
})

test('内容坏掉时拒写：原文件字节不变，warnings 说明原因', async () => {
  await freshHome()
  await mkdir(dirname(packsPath()), { recursive: true })

  const truncated = '{ "version": 1, "packs": { "default": '
  await writeFile(packsPath(), truncated)
  const state = await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  assert.ok(state.warnings.some((line) => line.includes('拒写')))
  assert.equal(await readFile(packsPath(), 'utf8'), truncated)
  // 解析降级出的空名册绝不能被写回去。
  assert.equal(state.packs.packs.p1, undefined)

  const notObject = '[1, 2]'
  await writeFile(packsPath(), notObject)
  const second = await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  assert.ok(second.warnings.some((line) => line.includes('顶层不是对象')))
  assert.equal(await readFile(packsPath(), 'utf8'), notObject)
})

test('非 ENOENT 的读失败跳过写入，不覆盖也不凭空建文件', async () => {
  await freshHome()
  // 目录顶替文件：readFile 报 EISDIR，正是「读不出来」的那类失败。
  await mkdir(packsPath(), { recursive: true })
  const state = await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  assert.ok(state.warnings.some((line) => line.includes('读取失败')))
  assert.equal((await stat(packsPath())).isDirectory(), true)
})

/**
 * 试算：面板的待保存改动靠它渲染「改了之后是什么样」。
 *
 * 与真写共用同一条应用规则，区别只有一个：不落盘。
 */
test('previewCommands 返回应用后的视图，但不写任何文件', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const packsBefore = await readFile(packsPath(), 'utf8')

  const state = await previewCommands(null, [{ op: 'packItem', packId: 'p1', name: 'plug-a', value: false }])
  assert.deepEqual(state.warnings, [])
  assert.equal(state.packs.packs['p1'].items['plug-a'], false)
  // 磁盘上仍是原样：试算不许有副作用。
  assert.equal(await readFile(packsPath(), 'utf8'), packsBefore)
})

test('previewCommands 里的非法命令只记 warning，不抛也不改视图', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const state = await previewCommands(null, [{ op: 'renamePack', packId: 'default', name: '别名的默认' }])
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /默认 pack 不可改名/)
  // 视图按「这批命令没生效」渲染：名字还是原名。
  assert.equal(state.packs.packs['default'].name, '默认')
})

test('previewCommands 的绑定命令按试算后的 pack 名册判定目标', async () => {
  await freshHome()
  const cwd = 'D:/work/repo'
  // 同一批里先建 pack 再绑：真写与试算都必须认这一批里的新 pack。
  const state = await previewCommands(cwd, [
    { op: 'createPack', name: '新包' },
    { op: 'bind', cwd: cwd, packId: 'p1' },
  ])
  assert.deepEqual(state.warnings, [])
  assert.equal(state.binding, 'p1')
  assert.equal(state.packId, 'p1')
})

test('previewCommands 混入一次真写后视图不变：试算不碰盘', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const before = await readFile(packsPath(), 'utf8')
  await previewCommands(null, [{ op: 'deletePack', packId: 'p1' }])
  assert.equal(await readFile(packsPath(), 'utf8'), before)
  const state = await loadState(null)
  assert.deepEqual(Object.keys(state.packs.packs), ['default', 'p1'])
})