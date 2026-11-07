import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleApply, handleGlobal, handleWorkspace, parseCommands } from '../lib/routes.js'
import { createScopeSnapshot } from '../lib/snapshot.js'
import { loadState } from '../lib/store.js'
import { normalizeCwd } from '../lib/policy.js'

/**
 * 本文件按 pack 语义重写。主要变化：
 * - 旧 `{ op: 'item', layer }` / `{ op: 'group', layer }` → `packItem` / `packGroup`；
 * - 旧「工作区命令需要 sessionId」→ 新 `bind` 自带 cwd，写入不再依赖会话，
 *   sessionId 只决定 apply 返回哪种视图；
 * - 落盘位置从 `skill-manager/global.json` 换成 `packs/skill/packs.json`。
 */

const rows = [
  { name: 'alpha', description: 'a', provider: 'filesystem', source: 'custom', path: '/x/alpha/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'beta', description: 'b', provider: 'filesystem', source: 'custom', path: '/x/beta/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'cordis-x', description: 'c', provider: 'filesystem', source: 'custom', path: '/p/node_modules/@deepseek-ai/pkg/skills/cordis-x/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
]

function fakeSkills(list = rows) {
  return {
    async snapshot() {
      return { skills: list, complete: true }
    },
    async get(name) {
      return { content: `body of ${name}` }
    },
    register() {
      return () => {}
    },
  }
}

function fakeCtx(skills) {
  return {
    get: (name) => (name === 'skills' ? skills : undefined),
    logger: { warn() {} },
  }
}

/**
 * 路由依赖：一份真实的快照（读真实策略文件）+ 可覆盖的落地回调。
 *
 * 每个用例建一份新的，避免上一条用例的缓存影响下一条。
 */
function depsWith(skills, overrides = {}) {
  const snapshot = createScopeSnapshot({
    loadPolicy: (cwd) => loadState(cwd),
    readInventory: async (cwd, scope) => {
      const request = {}
      if (cwd !== null && cwd !== '') request.cwd = cwd
      if (scope !== undefined) request.scope = scope
      const result = await skills.snapshot(request)
      return { rows: result.skills, complete: result.complete }
    },
  })
  return { snapshot, reapply: async () => {}, stuck: () => [], ...overrides }
}

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsk-routes-'))
  process.env['DSH_HOME'] = home
  await mkdir(join(home, 'packs', 'skill'), { recursive: true })
  return home
}

function packsFile(home) {
  return join(home, 'packs', 'skill', 'packs.json')
}

function workspacesFile(home) {
  return join(home, 'packs', 'skill', 'workspaces.json')
}

async function writePacks(home, packs, ui = {}) {
  await writeFile(
    packsFile(home),
    `${JSON.stringify(
      {
        version: 1,
        ui: {
          showOfficialSkills: false,
          showChip: true,
          defaultTab: 'groups',
          ...ui,
        },
        packs,
      },
      null,
      2,
    )}\n`,
  )
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function fileExists(path) {
  return readFile(path, 'utf8').then(
    () => true,
    () => false,
  )
}

test('parseCommands 拒绝非法形状', () => {
  assert.equal(parseCommands(undefined).ok, false)
  assert.equal(parseCommands([]).ok, false)
  assert.equal(parseCommands([{ op: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'item', layer: 'global', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'packItem', packId: 'default', name: 'x', value: 'yes' }]).ok, false)
  assert.equal(parseCommands([{ op: 'packItem', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'bind', cwd: '', packId: null }]).ok, false)
  assert.equal(parseCommands([{ op: 'bind', cwd: 'D:/x', packId: 3 }]).ok, false)
  assert.equal(parseCommands([{ op: 'defaultTab', value: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'assign', name: 'x', groupId: 5 }]).ok, false)
  // 已废弃：侧栏入口不再注册，命令必须被拒，而不是静默忽略。
  assert.equal(parseCommands([{ op: 'showSidebarEntry', value: false }]).ok, false)
})

test('parseCommands 接受每种合法命令', () => {
  const parsed = parseCommands([
    { op: 'packItem', packId: 'default', name: 'alpha', value: false },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: null },
    { op: 'createPack', name: '新包' },
    { op: 'renamePack', packId: 'p1', name: '改名' },
    { op: 'deletePack', packId: 'p1' },
    { op: 'bind', cwd: 'D:/proj', packId: 'p1' },
    { op: 'bind', cwd: 'D:/proj', packId: null },
    { op: 'assign', name: 'alpha', groupId: null },
    { op: 'createGroup', name: '新组' },
    { op: 'renameGroup', groupId: 'g1', name: '改名' },
    { op: 'deleteGroup', groupId: 'g1' },
    { op: 'showOfficialSkills', value: true },
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
    { op: 'defaultTab', value: 'workspace' },
  ])
  assert.equal(parsed.ok, true)
  // 这条数目断言是刻意的：新增一种命令却忘了登记进 OPS 白名单时，
  // 它会被当成未知操作拒掉，而只测「合法输入仍合法」是发现不了的。
  assert.equal(parsed.commands.length, 15)
})

test('全局面板默认不列官方技能，打开开关后列出', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())

  const deps = depsWith(fakeSkills())
  const off = await handleGlobal(ctx, deps)
  assert.equal(off.ok, true)
  assert.deepEqual(off.value.skills.map((row) => row.name), ['alpha', 'beta'])
  assert.equal(off.value.packs.length, 1)
  assert.equal(off.value.packs[0].id, 'default')
  assert.equal(off.value.packs[0].builtin, true)

  await writePacks(home, { default: { name: 'default' } }, { showOfficialSkills: true })
  const on = await handleGlobal(ctx, deps)
  assert.deepEqual(on.value.skills.map((row) => row.name), ['alpha', 'beta', 'cordis-x'])
  assert.equal(on.value.skills[2].official, true)
})

test('default pack 关掉的项在行里体现为 openGlobal=false 且来源是 default', async () => {
  const home = await freshHome()
  await writePacks(home, { default: { name: 'default', items: { alpha: false } } })
  const view = await handleGlobal(fakeCtx(fakeSkills()), depsWith(fakeSkills()))
  const alpha = view.value.skills.find((row) => row.name === 'alpha')
  assert.equal(alpha.openGlobal, false)
  assert.equal(alpha.itemGlobal, false)
  assert.equal(alpha.decidedBy, 'default')
  assert.equal(alpha.decidedVia, 'item')
})

test('apply 写盘后返回新状态，且意图不互相覆盖', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = depsWith(fakeSkills())

  const first = await handleApply(
    ctx,
    { commands: [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }] },
    deps,
  )
  assert.equal(first.ok, true)

  const second = await handleApply(
    ctx,
    { commands: [{ op: 'packItem', packId: 'default', name: 'beta', value: false }] },
    deps,
  )
  assert.equal(second.ok, true)

  const onDisk = await readJson(packsFile(home))
  assert.deepEqual(onDisk.packs.default.items, { alpha: false, beta: false })
  assert.equal(Object.keys(onDisk.packs).includes('default'), true)
})

test('createPack / renamePack / deletePack 走通，default 不可删、不可改名', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = depsWith(fakeSkills())

  const created = await handleApply(ctx, { commands: [{ op: 'createPack', name: '工作' }] }, deps)
  assert.equal(created.ok, true)
  const book = await readJson(packsFile(home))
  const id = Object.keys(book.packs).find((key) => key !== 'default')
  assert.equal(typeof id, 'string')
  assert.equal(book.packs[id].name, '工作')

  const renamed = await handleApply(ctx, { commands: [{ op: 'renamePack', packId: id, name: '工作二' }] }, deps)
  assert.equal(renamed.ok, true)
  assert.equal((await readJson(packsFile(home))).packs[id].name, '工作二')

  const refusedRename = await handleApply(
    ctx,
    { commands: [{ op: 'renamePack', packId: 'default', name: 'x' }] },
    deps,
  )
  assert.equal(refusedRename.ok, false)
  assert.match(refusedRename.error.message, /默认 pack 不可改名/)

  const refusedDelete = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'default' }] }, deps)
  assert.equal(refusedDelete.ok, false)
  assert.match(refusedDelete.error.message, /默认 pack 不可删除/)
  assert.equal(Object.keys((await readJson(packsFile(home))).packs).includes('default'), true)

  const deleted = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: id }] }, deps)
  assert.equal(deleted.ok, true)
  assert.deepEqual(Object.keys((await readJson(packsFile(home))).packs), ['default'])
})

test('bind 写入规范化后的 cwd，bind null 解除绑定', async () => {
  const home = await freshHome()
  await writePacks(home, {
    default: { name: 'default' },
    p1: { name: '一', items: { alpha: false } },
  })
  const ctx = fakeCtx(fakeSkills())
  const deps = depsWith(fakeSkills())
  const cwd = 'D:\\Proj\\Sub\\'
  const key = normalizeCwd(cwd)

  const bound = await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: 'p1' }] }, deps)
  assert.equal(bound.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, { [key]: 'p1' })

  const unbound = await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: null }] }, deps)
  assert.equal(unbound.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, {})
})

test('bind 未知 pack 被拒，且不写 workspaces.json', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const result = await handleApply(
    ctx,
    { commands: [{ op: 'bind', cwd: 'D:/proj', packId: 'missing' }] },
    depsWith(fakeSkills()),
  )
  assert.equal(result.ok, false)
  assert.match(result.error.message, /未知 pack/)
  assert.equal(await fileExists(workspacesFile(home)), false)
})

test('deletePack 清掉指向它的绑定', async () => {
  const home = await freshHome()
  await writePacks(home, {
    default: { name: 'default' },
    p1: { name: '一' },
  })
  const ctx = fakeCtx(fakeSkills())
  const deps = depsWith(fakeSkills())
  const cwd = 'D:/proj'
  await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: 'p1' }] }, deps)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, { [normalizeCwd(cwd)]: 'p1' })

  const deleted = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'p1' }] }, deps)
  assert.equal(deleted.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, {})
})

test('不存在的会话不再阻断写入（原「工作区命令缺少 sessionId」用例的新语义）', async () => {
  // 旧语义：工作区命令必须带 sessionId，否则拒绝且不落盘。
  // 新语义：绑定命令自带 cwd，写入不依赖会话；sessionId 只影响返回的视图。
  const home = await freshHome()
  const result = await handleApply(
    fakeCtx(fakeSkills()),
    { sessionId: 'no-such-session', commands: [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }] },
    depsWith(fakeSkills()),
  )
  assert.equal(result.ok, true)
  assert.deepEqual((await readJson(packsFile(home))).packs.default.items, { alpha: false })
})

test('reapply 失败不会把已成功的写入报成失败', async () => {
  await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = depsWith(fakeSkills(), {
    reapply: async () => {
      throw new Error('boom')
    },
  })
  const result = await handleApply(
    ctx,
    { commands: [{ op: 'packItem', packId: 'default', name: 'alpha', value: false }] },
    deps,
  )
  assert.equal(result.ok, true)
})

test('全局面板优先用请求带来的会话', async () => {
  await freshHome()
  const skills = fakeSkills()
  const seen = []
  const snapshot = createScopeSnapshot({
    loadPolicy: (cwd) => loadState(cwd),
    readInventory: async (cwd, scope) => {
      seen.push({ cwd, scope })
      const result = await skills.snapshot({})
      return { rows: result.skills, complete: result.complete }
    },
  })
  const agent = {
    id: 's2',
    session: { id: 's2', header: { cwd: 'D:/proj-b' } },
    ctx: { get: () => undefined },
  }
  const ctx = {
    get: (name) => {
      if (name === 'skills') return skills
      if (name === 'agents') return { list: () => [agent], get: (id) => (id === 's2' ? agent : undefined) }
      return undefined
    },
    logger: { warn() {} },
  }
  const view = await handleGlobal(ctx, { snapshot, reapply: async () => {}, stuck: () => [] }, 's2')
  assert.equal(view.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cwd, 'D:/proj-b')
  assert.equal(seen[0].scope, agent)
})

test('工作区视图返回绑定与每项的来源 pack', async () => {
  const home = await freshHome()
  const cwd = 'D:/proj-b'
  await writePacks(home, {
    default: { name: 'default' },
    p1: { name: '一', items: { alpha: false }, groups: {} },
  })
  await writeFile(
    workspacesFile(home),
    `${JSON.stringify({ version: 1, bindings: { [normalizeCwd(cwd)]: 'p1' }, extra: [] })}\n`,
  )

  const skills = fakeSkills()
  const agent = {
    id: 's2',
    session: { id: 's2', header: { cwd } },
    ctx: { get: () => undefined },
  }
  const ctx = {
    get: (name) => {
      if (name === 'skills') return skills
      if (name === 'agents') return { list: () => [agent], get: (id) => (id === 's2' ? agent : undefined) }
      return undefined
    },
    logger: { warn() {} },
  }
  const view = await handleWorkspace(ctx, { sessionId: 's2' }, depsWith(skills))
  assert.equal(view.ok, true)
  assert.equal(view.value.binding, 'p1')
  assert.equal(view.value.packId, 'p1')
  assert.equal(view.value.packName, '一')

  const alpha = view.value.skills.find((row) => row.name === 'alpha')
  assert.equal(alpha.open, false)
  assert.equal(alpha.decidedBy, 'p1')
  assert.equal(alpha.decidedVia, 'item')
  // default 里没有这条决定，所以旧的「全局」视图字段仍是 true。
  assert.equal(alpha.openGlobal, true)
  assert.equal(alpha.itemGlobal, null)

  const beta = view.value.skills.find((row) => row.name === 'beta')
  assert.equal(beta.open, true)
  assert.equal(beta.decidedBy, 'default')
  assert.equal(beta.decidedVia, 'builtin')
})

test('第三方 scoped 包的来源标签带包名', async () => {
  await freshHome()
  const scoped = [
    {
      name: 'x',
      description: 'd',
      provider: 'filesystem',
      source: 'custom',
      path: '/p/node_modules/@acme/tool/skills/x/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: true },
    },
  ]
  const skills = fakeSkills(scoped)
  const view = await handleGlobal(fakeCtx(skills), depsWith(skills))
  assert.equal(view.value.skills[0].origin, '@acme/tool')
})
