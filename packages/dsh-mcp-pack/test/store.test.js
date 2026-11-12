import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_NAMES, normalizeCwd } from '../lib/policy.js'
import {
  applyCommands,
  groupsPath,
  loadState,
  packsPath,
  previewCommands,
  workspacesPath,
} from '../lib/store.js'

/**
 * 落盘用例。
 *
 * 三份状态都落在 `$DSH_HOME/packs/mcp/`：`packs.json`、`groups.json`、
 * `workspaces.json`。工作区目录下不产生任何状态文件。
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

/** 写失败不再抛：断言那件事出现在 warnings 里。 */
function warnedAbout(state, pattern) {
  assert.equal(
    state.warnings.some((line) => pattern.test(line)),
    true,
    'warnings 里没有 ' + String(pattern) + '：' + state.warnings.join('；'),
  )
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
  assert.equal(onDisk.packs.default.name, '默认')
  assert.equal(onDisk.packs.p1.name, '工作')
  assert.deepEqual(onDisk.ui, { showChip: true, defaultTab: 'groups' })
})

test('duplicatePack 深拷贝 rows 与 groups，副本与原 pack 再无关联', async () => {
  await freshHome()
  // 前置校验按写盘前的名册判 packId，所以先建包再改内容，不能同批。
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(null, [
    { op: 'packGroup', packId: 'p1', groupId: 'g1', value: true },
    {
      op: 'packRow',
      packId: 'p1',
      rowKey: 'global:a',
      patch: { enabled: false, mode: 'lazy', tools: ['read_*'], description: '浏览器' },
    },
  ])

  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1' }])
  const onDisk = await readJson(packsPath())
  assert.equal(onDisk.packs.p2.name, '工作 2', '缺省名是原名 + 空格 + 序号')
  assert.deepEqual(onDisk.packs.p2.groups, { g1: true })
  assert.deepEqual(onDisk.packs.p2.rows['global:a'], {
    enabled: false,
    mode: 'lazy',
    tools: ['read_*'],
    description: '浏览器',
  })

  // 改副本不动原 pack：这是「副本」与「跟随」的分界。
  await applyCommands(null, [{ op: 'packRow', packId: 'p2', rowKey: 'global:a', patch: { mode: 'eager' } }])
  const after = await readJson(packsPath())
  assert.equal(after.packs.p1.rows['global:a'].mode, 'lazy')
  assert.equal(after.packs.p2.rows['global:a'].mode, 'eager')
})

test('duplicatePack 深拷贝 tools 数组：改副本的数组不动原 pack', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(null, [{ op: 'packRow', packId: 'p1', rowKey: 'global:a', patch: { tools: ['read_*'] } }])
  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1' }])
  await applyCommands(null, [{ op: 'packRow', packId: 'p2', rowKey: 'global:a', patch: { tools: ['write_*'] } }])

  const after = await readJson(packsPath())
  assert.deepEqual(after.packs.p1.rows['global:a'].tools, ['read_*'])
  assert.deepEqual(after.packs.p2.rows['global:a'].tools, ['write_*'])
})

test('duplicatePack 序号避让，不做尾部数字识别', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }])
  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1' }])
  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1' }])
  const onDisk = await readJson(packsPath())
  const names = Object.values(onDisk.packs).map((pack) => pack.name).sort()
  assert.deepEqual(names, ['前端', '前端 2', '前端 3', '默认'].sort())

  // 「前端 2」的副本叫「前端 2 2」：规则只有一条，可预测。
  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p2' }])
  const after = await readJson(packsPath())
  assert.ok(Object.values(after.packs).some((pack) => pack.name === '前端 2 2'))
})

test('duplicatePack 可从 default 复制，副本不带绑定', async () => {
  const home = await freshHome()
  const cwd = join(home, 'ws')
  await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd: cwd, packId: 'p1' }])

  await applyCommands(null, [{ op: 'duplicatePack', packId: 'default' }])
  const onDisk = await readJson(packsPath())
  const copyId = Object.keys(onDisk.packs).find((id) => id !== 'default' && id !== 'p1')
  assert.equal(onDisk.packs[copyId].name, '默认 2')
  // 绑定表原样：副本没有目录，复制不会把任何工作区切过去。
  const state = await loadState(cwd)
  assert.equal(state.bindings.bindings[normalizeCwd(cwd)], 'p1')
  assert.equal(Object.values(state.bindings.bindings).includes(copyId), false)
})

test('duplicatePack 源不存在、显式重名都被拒绝并留 warning', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }])
  const before = await readFile(packsPath(), 'utf8')

  // 本包的语义是「一条抛错整批中断」，所以两条命令各发一次，各验一条 warning。
  warnedAbout(await applyCommands(null, [{ op: 'duplicatePack', packId: 'ghost' }]), /未知 pack/u)
  assert.equal(await readFile(packsPath(), 'utf8'), before)

  warnedAbout(await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1', name: '前端' }]), /已存在/u)
  assert.equal(await readFile(packsPath(), 'utf8'), before)
})

test('duplicatePack 显式名字照用，不追加序号', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }])
  await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1', name: '后端' }])
  const onDisk = await readJson(packsPath())
  assert.ok(Object.values(onDisk.packs).some((pack) => pack.name === '后端'))
})

test('pack 数达上限时新建与复制都拒绝，不静默丢配置', async () => {
  await freshHome()
  const packs = {}
  for (let index = 1; index < MAX_NAMES; index += 1) {
    packs['p' + String(index)] = { name: 'pack' + String(index), groups: {}, rows: {} }
  }
  packs['default'] = { name: '默认', groups: {}, rows: {} }
  await writeJson(packsPath(), { version: 1, ui: { showChip: true, defaultTab: 'groups' }, packs: packs })

  // 一条抛错整批中断，所以两条命令各发一次。
  warnedAbout(await applyCommands(null, [{ op: 'createPack', name: '再来一个' }]), /上限/u)
  warnedAbout(await applyCommands(null, [{ op: 'duplicatePack', packId: 'p1' }]), /上限/u)
  assert.equal(Object.keys((await readJson(packsPath())).packs).length, MAX_NAMES)
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

test('默认 pack 不可删除、不可改名；未知 pack 的写入被拒；重名被拒', async () => {
  await freshHome()
  warnedAbout(await applyCommands(null, [{ op: 'deletePack', packId: 'default' }]), /默认 pack 不可删除/u)
  warnedAbout(await applyCommands(null, [{ op: 'renamePack', packId: 'default', name: 'x' }]), /默认 pack 不可改名/u)
  warnedAbout(
    await applyCommands(null, [{ op: 'packRow', packId: 'missing', rowKey: 'global:a', patch: { enabled: false } }]),
    /未知 pack/u,
  )
  await applyCommands(null, [{ op: 'createPack', name: '一' }])
  warnedAbout(await applyCommands(null, [{ op: 'createPack', name: '一' }]), /已存在/u)
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
  await writeJson(workspacesPath(), { version: 1, bindings: { [normalizeCwd(cwd)]: 'p1-gone' } })
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

  warnedAbout(await applyCommands(null, [{ op: 'assign', rowKey: 'global:a', groupId: 'g9' }]), /未知分组/u)
  warnedAbout(await applyCommands(null, [{ op: 'deleteGroup', groupId: 'g9' }]), /未知分组/u)
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

test('旧文件里的 extra 读时忽略、不报警，下次写盘自然消失', async () => {
  await freshHome()
  const cwd = 'D:/proj'
  await writeJson(workspacesPath(), { version: 1, bindings: {}, extra: ['D:\\Extra\\'] })
  // 手写一份带 extra 的旧文件，读侧既不能报错，也不能把它当成绑定。
  const before = await loadState(cwd)
  assert.deepEqual(before.warnings, [])
  assert.deepEqual(before.bindings, { bindings: {} })

  await applyCommands(cwd, [{ op: 'createPack', name: '工作' }])
  await applyCommands(cwd, [{ op: 'bind', cwd, packId: 'p1' }])
  const onDisk = await readJson(workspacesPath())
  assert.deepEqual(onDisk.bindings, { [normalizeCwd(cwd)]: 'p1' })
  assert.equal('extra' in onDisk, false)
})

test('坏 packs.json 拒绝覆盖，原文件保持', async () => {
  await freshHome()
  await mkdir(dirname(packsPath()), { recursive: true })
  const broken = '{ oops'
  await writeFile(packsPath(), broken)
  warnedAbout(await applyCommands(null, [{ op: 'showChip', value: false }]), /拒绝覆盖/u)
  assert.equal(await readFile(packsPath(), 'utf8'), broken)
})

test('一批命令里有非法 bind 时一个文件都不写', async () => {
  await freshHome()
  await writeJson(packsPath(), {
    version: 1,
    ui: {},
    packs: { default: { name: '默认' }, p1: { name: '一' } },
  })
  warnedAbout(
    await applyCommands(null, [
      { op: 'packRow', packId: 'p1', rowKey: 'global:a', patch: { mode: 'lazy' } },
      { op: 'bind', cwd: 'D:/x', packId: 'nope' },
    ]),
    /未知 pack/u,
  )
  const onDisk = await readJson(packsPath())
  assert.equal(onDisk.packs.p1.rows, undefined)
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

  const state = await previewCommands(null, [{ op: 'packRow', packId: 'p1', rowKey: 'global:a', patch: { enabled: false } }])
  assert.deepEqual(state.warnings, [])
  assert.deepEqual(state.packs.packs['p1'].rows['global:a'], { enabled: false })
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
  assert.equal(await fileExists(workspacesPath()), false)
})

/**
 * 重名守卫。
 *
 * 分组 id 与名字脱钩，两张同名分组在名册里区分不开；写入前拦住比重名落盘后再找要便宜。
 * 整份文件这次不应用，与其它非法命令同一口径。
 */
test('同名分组不会被重复创建：整份 groups.json 这次不应用', async () => {
  await freshHome()
  await applyCommands(null, [{ op: 'createGroup', name: '浏览器' }])
  const before = await readFile(groupsPath(), 'utf8')

  const state = await applyCommands(null, [{ op: 'createGroup', name: '浏览器' }])
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
  const groups = (await readJson(groupsPath())).groups
  const b = groups.find((group) => group.name === 'B')

  const state = await applyCommands(null, [{ op: 'renameGroup', groupId: b.id, name: 'A' }])
  assert.match(state.warnings.join('\n'), /分组名已存在/)
})

test('顶层不是对象的 packs.json 也拒写，原文件逐字节不变', async () => {
  await freshHome()
  await mkdir(dirname(packsPath()), { recursive: true })
  const broken = '[1, 2]\n'
  await writeFile(packsPath(), broken)
  warnedAbout(await applyCommands(null, [{ op: 'showChip', value: false }]), /顶层不是对象/u)
  assert.deepEqual(await readFile(packsPath()), Buffer.from(broken))
})

test('非 ENOENT 的读取失败跳过写入，不当成文件不存在', async () => {
  await freshHome()
  // 目录占位：readFile 报 EISDIR，既不是 ENOENT，也不能被当成空文件。
  await mkdir(packsPath(), { recursive: true })
  const state = await applyCommands(null, [{ op: 'showChip', value: false }])
  warnedAbout(state, /读取失败/u)
  assert.equal((await stat(packsPath())).isDirectory(), true)
  // 状态照样给出来：按缺省继续，面板不会整页报错。
  assert.equal(state.packs.packs.default.name, '默认')
})

test('成功路径的落盘字节与既有序列化逐字节一致', async () => {
  await freshHome()
  const state = await applyCommands(null, [{ op: 'createPack', name: '工作' }])
  assert.deepEqual(state.warnings, [])
  // 键序、两空格缩进、结尾换行都是既有序列化的输出：动它就是给每次保存制造 git 差异。
  const expected = [
    '{',
    '  "version": 1,',
    '  "ui": {',
    '    "showChip": true,',
    '    "defaultTab": "groups"',
    '  },',
    '  "packs": {',
    '    "default": {',
    '      "name": "默认"',
    '    },',
    '    "p1": {',
    '      "name": "工作"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')
  assert.equal(await readFile(packsPath(), 'utf8'), expected)
})
