import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { applyCommands, groupsPath, loadState, packsPath, previewCommands, workspacesPath } from '../lib/store.js'
import { normalizeCwd } from '../lib/policy.js'

/**
 * 落盘用例。
 *
 * 三个状态文件：`packs.json`、`groups.json`、`workspaces.json`，
 * 都落在 `$DSH_HOME/packs/skill/`。
 */

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsk-store-'))
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
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('三个状态文件落在 $DSH_HOME/packs/skill/ 下', async () => {
  const home = await freshHome()
  assert.equal(packsPath(), join(home, 'packs', 'skill', 'packs.json'))
  assert.equal(groupsPath(), join(home, 'packs', 'skill', 'groups.json'))
  assert.equal(workspacesPath(), join(home, 'packs', 'skill', 'workspaces.json'))
})

test('createPack 写盘时永远保留 default，并按 id 排序', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const onDisk = JSON.parse(await readFile(packsPath()))
  assert.deepEqual(Object.keys(onDisk.packs), ['default', 'p1'])
  assert.equal(onDisk.packs.default.name, '默认')
  assert.equal(onDisk.packs.p1.name, '工作')
  assert.deepEqual(onDisk.ui, {
    showOfficialSkills: false,
    showChip: true,
    defaultTab: 'groups',
  })
})

test('packItem / packGroup 的三态：null 删键回到跟随', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'alpha', value: false },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: true },
  ])
  let state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, { alpha: false })
  assert.deepEqual(state.packs.packs.default.groups, { g1: true })

  await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'alpha', value: null },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: null },
  ])
  state = await loadState(null)
  assert.deepEqual(state.packs.packs.default.items, {})
  assert.deepEqual(state.packs.packs.default.groups, {})
})

/**
 * 被拒的意图不再抛：写失败统一降级成返回值里的 warning，调用方（路由）据此仍
 * 返回 ok: true 与最新状态。断言从「rejects」改成「warnings 里出现该失败」。
 */
test('默认 pack 不可删除、不可改名；未知 pack 的写入被拒', async () => {
  await freshHome()
  const deleted = await applyCommands(null, [{ op: 'deletePack', packId: 'default' }])
  assert.match(deleted.warnings.join('\n'), /默认 pack 不可删除/)

  const renamed = await applyCommands(null, [{ op: 'renamePack', packId: 'default', name: 'x' }])
  assert.match(renamed.warnings.join('\n'), /默认 pack 不可改名/)

  const missing = await applyCommands(null, [{ op: 'packItem', packId: 'missing', name: 'alpha', value: false }])
  assert.match(missing.warnings.join('\n'), /未知 pack/)
  // 三次都没写进去：文件仍然不存在。
  assert.equal(await fileExists(packsPath()), false)
})

test('bind 与 bind null：绑定键是规范化后的 cwd', async () => {
  await freshHome()
  const cwd = 'D:\\Proj\\Sub\\'
  const key = normalizeCwd(cwd)
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  const created = await loadState(null)
  const id = Object.keys(created.packs.packs).find((packId) => packId !== 'default')
  assert.equal(typeof id, 'string')

  const bound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: id }])
  assert.equal(bound.binding, id)
  assert.equal(bound.packId, id)
  assert.equal(bound.pack?.name, '工作')
  assert.deepEqual(JSON.parse(await readFile(workspacesPath())).bindings, { [key]: id })

  const unbound = await applyCommands(cwd, [{ op: 'bind', cwd, packId: null }])
  assert.equal(unbound.binding, null)
  assert.equal(unbound.packId, 'default')
  assert.equal(unbound.pack, null)
  assert.deepEqual(JSON.parse(await readFile(workspacesPath())).bindings, {})
})

test('删除 pack 后悬空绑定按 default 求值，读取不抛错', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: {
      default: { name: 'default', items: { alpha: false } },
      p1: { name: '一', items: { alpha: true } },
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
  assert.deepEqual(JSON.parse(await readFile(workspacesPath())).bindings, {})
  assert.deepEqual(Object.keys(JSON.parse(await readFile(packsPath())).packs), ['default'])
})

test('ui 命令写入 packs.json', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
    { op: 'showOfficialSkills', value: true },
  ])
  const onDisk = JSON.parse(await readFile(packsPath()))
  assert.deepEqual(onDisk.ui, {
    showOfficialSkills: true,
    showChip: false,
    defaultTab: 'packs',
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

test('旧版的 extra 读时忽略，下次写盘就消失', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(workspacesPath(), {
    version: 1,
    bindings: {},
    extra: ['D:\\Extra\\'],
  })
  await applyCommands(cwd, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  const onDisk = JSON.parse(await readFile(workspacesPath()))
  assert.equal('extra' in onDisk, false)
  assert.deepEqual(onDisk.bindings, { [normalizeCwd(cwd)]: 'p1' })
})

test('删除分组会清掉所有 pack 里该组的开关', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'createGroup', name: '一组' },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: false },
  ])
  assert.deepEqual(JSON.parse(await readFile(groupsPath())).groups, [{ id: 'g1', name: '一组' }])

  await applyCommands(null, [{ op: 'deleteGroup', groupId: 'g1' }])
  // 空的 groups 表不落键：序列化只在有内容时写这一层。
  assert.equal(JSON.parse(await readFile(packsPath())).packs.default.groups, undefined)
  assert.deepEqual(JSON.parse(await readFile(groupsPath())).groups, [])
})

test('packs.json 内容坏掉时拒写，原文件字节不变', async () => {
  const home = await freshHome()
  await mkdir(join(home, 'packs', 'skill'), { recursive: true })

  // 坏 JSON：解析会得到空名册，写回去等于抹掉用户已有的全部决定。
  const broken = '{ "version": 1, "packs": '
  await writeFile(packsPath(), broken)
  const state = await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }])
  assert.equal(await readFile(packsPath(), 'utf8'), broken)
  assert.match(state.warnings.join('\n'), /packs\.json 不是合法 JSON，已拒绝写入/)

  // 顶层不是对象：同样拒写。
  const notObject = '[]\n'
  await writeFile(packsPath(), notObject)
  const top = await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }])
  assert.equal(await readFile(packsPath(), 'utf8'), notObject)
  assert.match(top.warnings.join('\n'), /packs\.json 顶层不是对象，已拒绝写入/)
})

test('packs.json 读不出来（非 ENOENT）时跳过写入，不覆盖也不新建', async () => {
  await freshHome()
  // 让路径成为一个目录：readFile 抛 EISDIR，不是 ENOENT。
  await mkdir(packsPath(), { recursive: true })
  const state = await applyCommands(null, [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }])
  assert.match(state.warnings.join('\n'), /读取 packs\.json 失败，本次未写入/)
  // 路径还是那个目录：既没被覆盖成文件，也没在别处凭空造一份。
  assert.equal((await stat(packsPath())).isDirectory(), true)
})

test('成功路径的落盘字节不变：两空格、键排序、结尾换行', async () => {
  await freshHome()
  const state = await applyCommands(null, [
    { op: 'packItem', packId: 'default', name: 'beta', value: false },
    { op: 'packItem', packId: 'default', name: 'alpha', value: true },
  ])
  assert.deepEqual(state.warnings, [])
  assert.equal(
    await readFile(packsPath(), 'utf8'),
    [
      '{',
      '  "version": 1,',
      '  "ui": {',
      '    "showOfficialSkills": false,',
      '    "showChip": true,',
      '    "defaultTab": "groups"',
      '  },',
      '  "packs": {',
      '    "default": {',
      '      "name": "默认",',
      '      "items": {',
      '        "alpha": true,',
      '        "beta": false',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
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

  const state = await previewCommands(null, [{ op: 'packItem', packId: 'p1', name: 'alpha', value: false }])
  assert.deepEqual(state.warnings, [])
  assert.equal(state.packs.packs['p1'].items['alpha'], false)
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

/**
 * 重名守卫。
 *
 * 分组 id 与名字脱钩，两张同名分组在名册里区分不开；写入前拦住比重名落盘后再找要便宜。
 * 整份文件这次不应用，与其它非法命令同一口径。
 */
test('同名分组不会被重复创建：整份 groups.json 这次不应用', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createGroup', name: '前端' }])
  const before = await readFile(groupsPath(), 'utf8')

  const state = await applyCommands(null, [{ op: 'createGroup', name: '前端' }])
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /分组名已存在/)
  assert.equal(await readFile(groupsPath(), 'utf8'), before)
})

test('renameGroup 撞上已有名字同样被拒', async () => {
  await freshHome()
  await applyCommands(null, [
    { op: 'createGroup', name: 'A' },
    { op: 'createGroup', name: 'B' },
  ])
  const groups = JSON.parse(await readFile(groupsPath(), 'utf8')).groups
  const b = groups.find((group) => group.name === 'B')

  const state = await applyCommands(null, [{ op: 'renameGroup', groupId: b.id, name: 'A' }])
  assert.match(state.warnings.join('\n'), /分组名已存在/)
})

test('previewCommands 的绑定命令按试算后的 pack 名册判定目标', async () => {  await freshHome()
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
