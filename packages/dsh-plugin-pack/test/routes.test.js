import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleApply, handleGlobal, handleWorkspace, parseCommands } from '../lib/routes.js'
import { normalizeCwd } from '../lib/policy.js'

const NEWLINE = String.fromCharCode(10)

const rows = [
  { name: 'alpha', description: 'a', parameters: { type: 'object' } },
  { name: 'beta', description: 'b', parameters: { type: 'object' } },
]

function fakeTools(list = rows) {
  return {
    definitions: () => list,
    schemas: () => list.map((row) => ({ name: row.name, description: row.description, parameters: row.parameters })),
    get: (name) => list.find((row) => row.name === name),
    restrict: () => () => {},
  }
}

function fakeCtx(tools = fakeTools(), options = {}) {
  return {
    get: (name) => {
      if (name === 'tools') return tools
      if (name === 'agents') return options.agents
      return undefined
    },
    logger: { warn() {} },
  }
}

function deps(overrides = {}) {
  return {
    reapply: async () => {},
    stuck: () => [],
    support: () => ({ restrict: true, promptFilter: true }),
    ...overrides,
  }
}

function catalogFor(plugins) {
  return { key: 'test-key', plugins, orphanTools: [], orphanSections: [] }
}

const defaultPlugins = [
  {
    pkg: 'plug-a',
    tools: ['alpha'],
    sections: ['alpha-section'],
    toolVolume: 12,
    sectionChars: 120,
    toolsKnown: true,
    sectionsKnown: true,
  },
  {
    pkg: '@deepseek-ai/dsh-thing',
    tools: ['beta'],
    sections: [],
    toolVolume: 8,
    sectionChars: 0,
    toolsKnown: true,
    sectionsKnown: true,
  },
]

function feedFor(catalog) {
  return { read: () => catalog, load: async () => catalog }
}

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dpp-routes-'))
  process.env['DSH_HOME'] = home
  // 测试机器的真 profile 不该被后台扫描拖进来。
  delete process.env['DSH_PROFILE_DIR']
  return home
}

function packsFile(home) {
  return join(home, 'packs', 'plugin', 'packs.json')
}

function workspacesFile(home) {
  return join(home, 'packs', 'plugin', 'workspaces.json')
}

function groupsFile(home) {
  return join(home, 'packs', 'plugin', 'groups.json')
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}${NEWLINE}`)
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
  // 旧的两层命令已废弃：`item` / `group` / `showSidebarEntry` 必须被拒，而不是静默忽略。
  assert.equal(parseCommands([{ op: 'item', layer: 'global', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'group', layer: 'global', groupId: 'g1', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'showSidebarEntry', value: false }]).ok, false)
  assert.equal(parseCommands([{ op: 'packItem', packId: 'default', name: 'x', value: 'yes' }]).ok, false)
  assert.equal(parseCommands([{ op: 'packItem', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'bind', cwd: '', packId: null }]).ok, false)
  assert.equal(parseCommands([{ op: 'bind', cwd: 'D:/x', packId: 3 }]).ok, false)
  assert.equal(parseCommands([{ op: 'defaultTab', value: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'assign', name: 'x', groupId: 5 }]).ok, false)
  // 已废弃：手动添加/移除工作区目录的能力整个移除，命令同样必须被拒。
  assert.equal(parseCommands([{ op: 'addExtra', cwd: 'D:/x' }]).ok, false)
  assert.equal(parseCommands([{ op: 'removeExtra', cwd: 'D:/x' }]).ok, false)
  // 批量里只要有一条坏，整批拒绝：半懂地写一半比拒掉更糟。
  assert.equal(
    parseCommands([{ op: 'packItem', packId: 'default', name: 'a', value: false }, { op: 'createGroup' }]).ok,
    false,
  )
})

test('parseCommands 接受每种合法命令', () => {
  const parsed = parseCommands([
    { op: 'packItem', packId: 'default', name: 'plug-a', value: false },
    { op: 'packGroup', packId: 'default', groupId: 'g1', value: null },
    { op: 'createPack', name: '新包' },
    { op: 'renamePack', packId: 'p1', name: '改名' },
    { op: 'deletePack', packId: 'p1' },
    { op: 'bind', cwd: 'D:/proj', packId: 'p1' },
    { op: 'bind', cwd: 'D:/proj', packId: null },
    { op: 'assign', name: 'plug-a', groupId: null },
    { op: 'createGroup', name: '新组' },
    { op: 'renameGroup', groupId: 'g1', name: '改名' },
    { op: 'deleteGroup', groupId: 'g1' },
    { op: 'showOfficialPlugins', value: true },
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
    { op: 'defaultTab', value: 'workspace' },
  ])
  assert.equal(parsed.ok, true)
  // 这条数目断言是刻意的：新增一种命令却忘了登记进 OPS 白名单时，
  // 它会被当成未知操作拒掉，而只测「合法输入仍合法」是发现不了的。
  assert.equal(parsed.commands.length, 15)
})

test('全局面板默认不列官方插件，打开开关后才列', async () => {
  await freshHome()
  const off = await handleGlobal(fakeCtx(), null, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(off.ok, true)
  const hidden = off.value.plugins.map((row) => row.pkg)
  assert.ok(hidden.indexOf('plug-a') >= 0)
  assert.equal(hidden.indexOf('@deepseek-ai/dsh-thing'), -1)

  await writeJson(packsFile(process.env['DSH_HOME']), { version: 1, ui: { showOfficialPlugins: true }, packs: {} })
  const on = await handleGlobal(fakeCtx(), null, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(on.ok, true)

  const byName = new Map(on.value.plugins.map((row) => [row.pkg, row]))
  assert.equal(byName.get('plug-a').tools, 1)
  assert.equal(byName.get('plug-a').sections, 1)
  assert.equal(byName.get('plug-a').sectionChars, 120)
  assert.equal(byName.get('plug-a').sectionKnown, true)
  assert.equal(byName.get('plug-a').origin, 'profile')
  assert.equal(byName.get('@deepseek-ai/dsh-thing').origin, 'official')
  // toolVolume 按 schemas(scope) 实测长度折算，不是目录里的静态数。
  assert.ok(byName.get('plug-a').toolVolume > 0)
  assert.equal(on.value.pending, false)
  assert.deepEqual(on.value.support, { restrict: true, promptFilter: true })
  // 行序与加载顺序无关。
  assert.deepEqual(
    on.value.plugins.map((row) => row.pkg),
    ['@deepseek-ai/dsh-thing', 'plug-a'],
  )
  // 没有任何 pack 文件时，只有内置 default 一个 pack。
  assert.deepEqual(
    on.value.packs.map((pack) => pack.id),
    ['default'],
  )
  assert.equal(on.value.packs[0].builtin, true)
  assert.deepEqual(on.value.bindings, { bindings: {} })
  assert.deepEqual(on.value.ui, { showOfficialPlugins: true, showChip: true, defaultTab: 'groups' })
})

test('全局面板带 sessionId 时用该会话的 scope 读工具清单', async () => {
  const home = await freshHome()
  // 打开官方开关，两行都在，才分得清 scope 用的是哪一个。
  await writeJson(packsFile(home), { version: 1, ui: { showOfficialPlugins: true }, packs: {} })
  // 两个 scope 看到不同的工具集：并行安全地证明服务端用的是哪一个。
  const sessionAgent = {
    id: 'agent-live',
    session: { id: 'session-live', header: { cwd: '/w' } },
  }
  const firstAgent = { id: 'agent-first', session: { id: 'session-first', header: { cwd: '/w2' } } }
  const alphaOnly = [{ name: 'alpha', description: 'a', parameters: { type: 'object' } }]
  const betaOnly = [{ name: 'beta', description: 'b', parameters: { type: 'object' } }]
  const scoped = {
    definitions: (scope) => (scope === sessionAgent ? alphaOnly : betaOnly),
    schemas: (scope) => (scope === sessionAgent ? alphaOnly : betaOnly),
    get: () => undefined,
    restrict: () => () => {},
  }
  const ctx = fakeCtx(scoped, {
    agents: {
      get: (id) => (id === 'session-live' ? sessionAgent : undefined),
      list: () => [firstAgent],
    },
  })

  const view = await handleGlobal(
    ctx,
    { sessionId: 'session-live' },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)) }),
  )
  assert.equal(view.ok, true)
  const byName = new Map(view.value.plugins.map((row) => [row.pkg, row]))
  // plug-a 声明 alpha：用的是 sessionId 那个 agent 的 scope，不是 list()[0]。
  assert.equal(byName.get('plug-a').tools, 1)
  assert.equal(byName.get('@deepseek-ai/dsh-thing').tools, 0)
  // 归属数不按可见性裁剪：看不见不等于没归属。
  assert.equal(byName.get('@deepseek-ai/dsh-thing').owned, 1)
})

test('范围外包名保留不删，且不出现在插件行里', async () => {
  const home = await freshHome()
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: { default: { name: 'default', items: { 'ghost-pkg': false, 'plug-a': false } } },
  })
  const view = await handleGlobal(fakeCtx(), null, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(view.ok, true)

  assert.deepEqual(view.value.outOfScope, ['ghost-pkg'])
  assert.equal(
    view.value.plugins.some((row) => row.pkg === 'ghost-pkg'),
    false,
  )
})

test('目录未就绪时请求不等扫描：返回 pending 并挂后台，期间不重复发起', async () => {
  await freshHome()
  // 这个用例关心的是 pending 与复用，不是官方过滤：先把开关打开，保持两行。
  await writeJson(packsFile(process.env['DSH_HOME']), { version: 1, ui: { showOfficialPlugins: true }, packs: {} })
  let current = null
  let started = 0
  let settle
  const feed = {
    read: () => current,
    load: () => {
      started += 1
      return new Promise((resolve) => {
        settle = () => {
          current = catalogFor(defaultPlugins)
          resolve(current)
        }
      })
    },
  }

  // 若请求路径里 await 了扫描，这个调用会一直挂住（settle 还没被调用）。
  const first = await handleGlobal(fakeCtx(), null, deps({ catalog: feed }))
  assert.equal(first.ok, true)
  assert.equal(first.value.pending, true)
  assert.equal(started, 1)
  assert.deepEqual(first.value.plugins, [])

  // 扫描仍在进行：第二个请求复用同一个后台任务，不再扫一遍。
  const second = await handleGlobal(fakeCtx(), null, deps({ catalog: feed }))
  assert.equal(second.value.pending, true)
  assert.equal(started, 1)

  settle()
  await new Promise((resolve) => setImmediate(resolve))

  const third = await handleGlobal(fakeCtx(), null, deps({ catalog: feed }))
  assert.equal(third.value.pending, false)
  assert.equal(third.value.plugins.length, 2)
})

test('apply 写盘后返回新状态，且意图不互相覆盖', async () => {
  const home = await freshHome()
  const ctx = fakeCtx()
  const options = deps({ catalog: feedFor(catalogFor(defaultPlugins)) })

  const first = await handleApply(
    ctx,
    { commands: [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }] },
    options,
  )
  assert.equal(first.ok, true)
  const second = await handleApply(
    ctx,
    { commands: [{ op: 'packItem', packId: 'default', name: 'plug-b', value: false }] },
    options,
  )
  assert.equal(second.ok, true)

  const onDisk = await readJson(packsFile(home))
  assert.deepEqual(onDisk.packs.default.items, { 'plug-a': false, 'plug-b': false })
})

test('createPack / renamePack / deletePack 走通，default 不可删、不可改名', async () => {
  const home = await freshHome()
  const ctx = fakeCtx()
  const options = deps({ catalog: feedFor(catalogFor(defaultPlugins)) })

  const created = await handleApply(ctx, { commands: [{ op: 'createPack', name: '工作' }] }, options)
  assert.equal(created.ok, true)
  const book = await readJson(packsFile(home))
  assert.equal(book.packs.p1.name, '工作')

  const renamed = await handleApply(ctx, { commands: [{ op: 'renamePack', packId: 'p1', name: '工作二' }] }, options)
  assert.equal(renamed.ok, true)
  assert.equal((await readJson(packsFile(home))).packs.p1.name, '工作二')

  // 写入被拒不是协议错误：仍是 ok，失败说明在视图的 warnings 里。
  const refusedRename = await handleApply(
    ctx,
    { commands: [{ op: 'renamePack', packId: 'default', name: 'x' }] },
    options,
  )
  assert.equal(refusedRename.ok, true)
  assert.ok(refusedRename.value.warnings.some((line) => line.includes('默认 pack 不可改名')))
  assert.equal((await readJson(packsFile(home))).packs.default.name, '默认')

  const refusedDelete = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'default' }] }, options)
  assert.equal(refusedDelete.ok, true)
  assert.ok(refusedDelete.value.warnings.some((line) => line.includes('默认 pack 不可删除')))

  const deleted = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'p1' }] }, options)
  assert.equal(deleted.ok, true)
  assert.deepEqual(Object.keys((await readJson(packsFile(home))).packs), ['default'])
})

test('apply 的非法命令整批拒绝且不落盘', async () => {
  const home = await freshHome()
  const result = await handleApply(fakeCtx(), { commands: [{ op: 'packItem' }] }, deps())
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.equal(await fileExists(packsFile(home)), false)
})

test('bind 写入规范化后的 cwd，bind null 解除绑定', async () => {
  const home = await freshHome()
  const ctx = fakeCtx()
  const options = deps({ catalog: feedFor(catalogFor(defaultPlugins)) })
  await handleApply(ctx, { commands: [{ op: 'createPack', name: '工作' }] }, options)
  const cwd = 'D:\\Proj\\Sub\\'
  const key = normalizeCwd(cwd)

  const bound = await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: 'p1' }] }, options)
  assert.equal(bound.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, { [key]: 'p1' })

  const unbound = await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: null }] }, options)
  assert.equal(unbound.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, {})
})

test('bind 未知 pack 被拒，且不写 workspaces.json', async () => {
  const home = await freshHome()
  const result = await handleApply(
    fakeCtx(),
    { commands: [{ op: 'bind', cwd: 'D:/proj', packId: 'missing' }] },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)) }),
  )
  assert.equal(result.ok, true)
  assert.ok(result.value.warnings.some((line) => line.includes('未知 pack')))
  assert.equal(await fileExists(workspacesFile(home)), false)
})

test('deletePack 清掉指向它的绑定', async () => {
  const home = await freshHome()
  const ctx = fakeCtx()
  const options = deps({ catalog: feedFor(catalogFor(defaultPlugins)) })
  await handleApply(ctx, { commands: [{ op: 'createPack', name: '工作' }] }, options)
  const cwd = 'D:/proj'
  await handleApply(ctx, { commands: [{ op: 'bind', cwd, packId: 'p1' }] }, options)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, { [normalizeCwd(cwd)]: 'p1' })

  const deleted = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'p1' }] }, options)
  assert.equal(deleted.ok, true)
  assert.deepEqual((await readJson(workspacesFile(home))).bindings, {})
})

test('不存在的会话不再阻断写入（原「工作区命令缺少 sessionId」用例的新语义）', async () => {
  // 旧语义：工作区层命令必须带 sessionId，否则拒绝且不落盘。
  // 新语义：绑定命令自带 cwd，写入不依赖会话；sessionId 只影响返回的视图。
  const home = await freshHome()
  const result = await handleApply(
    fakeCtx(),
    {
      sessionId: 'no-such-session',
      commands: [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }],
    },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)) }),
  )
  assert.equal(result.ok, true)
  assert.deepEqual((await readJson(packsFile(home))).packs.default.items, { 'plug-a': false })
})

test('未知会话的工作区读取报 unknown-session', async () => {
  await freshHome()
  const result = await handleWorkspace(fakeCtx(), { sessionId: 'nope' }, deps())
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-session')
})

test('reapply 失败不会把已成功的写入报成失败', async () => {
  await freshHome()
  const result = await handleApply(
    fakeCtx(),
    { commands: [{ op: 'packItem', packId: 'default', name: 'plug-a', value: false }] },
    deps({
      catalog: feedFor(catalogFor(defaultPlugins)),
      reapply: async () => {
        throw new Error('boom')
      },
    }),
  )
  assert.equal(result.ok, true)
})

test('工作区视图带 cwd、绑定、生效 pack 名与 stuck', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: {
      default: { name: 'default' },
      p1: { name: '工作', items: { 'plug-a': false } },
    },
  })
  await writeJson(workspacesFile(home), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1' },
  })

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(
    ctx,
    { sessionId: 'session-1' },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)), stuck: () => ['alpha'] }),
  )

  assert.equal(view.ok, true)
  assert.equal(view.value.cwd, cwd)
  assert.equal(view.value.binding, 'p1')
  assert.equal(view.value.packId, 'p1')
  assert.equal(view.value.packName, '工作')
  assert.equal(view.value.live, true)
  assert.deepEqual(view.value.stuck, ['alpha'])
  assert.deepEqual(
    view.value.plugins.map((entry) => entry.pkg),
    ['@deepseek-ai/dsh-thing', 'plug-a'],
  )

  // 行上的求值字段由宿主算：p1 项级关掉 plug-a，另一行两层都没有记录。
  const byPkg = new Map(view.value.plugins.map((row) => [row.pkg, row]))
  const overridden = byPkg.get('plug-a')
  assert.deepEqual(
    [overridden.open, overridden.itemWorkspace, overridden.itemGlobal, overridden.decidedBy, overridden.decidedVia],
    [false, false, null, 'p1', 'item'],
  )
  // 跟随到内置缺省：两层都没有记录，值是「开」。
  const builtin = byPkg.get('@deepseek-ai/dsh-thing')
  assert.deepEqual(
    [builtin.open, builtin.itemWorkspace, builtin.itemGlobal, builtin.decidedBy, builtin.decidedVia],
    [true, null, null, 'default', 'builtin'],
  )
  assert.equal(builtin.groupId, null)
})

test('组级覆盖落在 pack 的组记录上，decidedVia 是 group', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: {
      default: { name: 'default' },
      p1: { name: '工作', groups: { g1: false } },
    },
  })
  await writeJson(workspacesFile(home), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1' },
  })
  await writeJson(groupsFile(home), {
    version: 1,
    groups: [{ id: 'g1', name: '组一' }],
    assignments: { 'plug-a': 'g1' },
  })

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(ctx, { sessionId: 'session-1' }, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))

  assert.equal(view.ok, true)
  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.deepEqual([row.open, row.itemWorkspace, row.itemGlobal], [false, null, null])
  assert.deepEqual([row.decidedBy, row.decidedVia, row.groupId], ['p1', 'group', 'g1'])
})

test('pack 没有记录时跟到 default 的项级记录', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: {
      default: { name: 'default', items: { 'plug-a': false } },
      p1: { name: '工作' },
    },
  })
  await writeJson(workspacesFile(home), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1' },
  })

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(ctx, { sessionId: 'session-1' }, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))

  assert.equal(view.ok, true)
  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  // itemWorkspace 是 null（这一层没记录），itemGlobal 保留 default 的那条。
  assert.deepEqual([row.open, row.itemWorkspace, row.itemGlobal], [false, null, false])
  assert.deepEqual([row.decidedBy, row.decidedVia], ['default', 'item'])
})

test('目录残缺时 open 为 null，但仍保留两层原始记录', async () => {
  await freshHome()
  await writeJson(packsFile(process.env['DSH_HOME']), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: { default: { name: 'default', items: { 'plug-a': false } } },
  })
  const catalog = { ...catalogFor(defaultPlugins), complete: false }
  const view = await handleGlobal(fakeCtx(), null, deps({ catalog: feedFor(catalog) }))

  assert.equal(view.ok, true)
  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, null)
  assert.equal(row.itemWorkspace, null)
  assert.equal(row.itemGlobal, false)
  assert.deepEqual([row.decidedBy, row.decidedVia], ['default', 'item'])
})

test('悬空绑定在工作区视图里退回 default，binding 仍保留原始 id', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: { default: { name: 'default', items: { 'plug-a': false } } },
  })
  await writeJson(workspacesFile(home), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'p1-gone' },
  })

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(ctx, { sessionId: 'session-1' }, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))

  assert.equal(view.ok, true)
  assert.equal(view.value.binding, 'p1-gone')
  assert.equal(view.value.packId, 'default')
  assert.equal(view.value.packName, '默认')
  assert.deepEqual(
    view.value.plugins.map((entry) => entry.pkg),
    ['@deepseek-ai/dsh-thing', 'plug-a'],
  )
})

test('apply 带 dryRun 时返回试算视图、不落盘、也不重新施加', async () => {
  const home = await freshHome()
  await writeJson(packsFile(home), { version: 1, ui: {}, packs: { default: { name: 'default' } } })
  const before = await readFile(packsFile(home), 'utf8')
  let reapplied = 0

  const result = await handleApply(
    fakeCtx(),
    { commands: [{ op: 'createPack', name: '工作' }], dryRun: true },
    deps({
      catalog: feedFor(catalogFor(defaultPlugins)),
      reapply: async () => {
        reapplied += 1
      },
    }),
  )

  assert.equal(result.ok, true)
  // 试算视图里已经多出这张 pack——面板就是拿它渲染「改了之后」。
  assert.deepEqual(
    result.value.packs.map((pack) => pack.id),
    ['default', 'p1'],
  )
  assert.equal(result.value.packs[1].name, '工作')
  // 盘上必须一字不动，也不该触发重新施加：保存才会做那两件事。
  assert.equal(await readFile(packsFile(home), 'utf8'), before)
  assert.equal(reapplied, 0)
})

test('dryRun 的绑定预览走工作区视图，绑定本身不落盘', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpp-ws-'))
  await writeJson(packsFile(home), {
    version: 1,
    ui: {},
    packs: { default: { name: 'default' }, p1: { name: '工作' } },
  })
  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })

  const result = await handleApply(
    ctx,
    { sessionId: 'session-1', commands: [{ op: 'bind', cwd: cwd, packId: 'p1' }], dryRun: true },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)) }),
  )

  assert.equal(result.ok, true)
  // 视图按试算后的状态渲染：chip 弹层靠这几个字段显示「换过去会是什么样」。
  assert.equal(result.value.binding, 'p1')
  assert.equal(result.value.packId, 'p1')
  assert.equal(result.value.packName, '工作')
  assert.equal(await fileExists(workspacesFile(home)), false)
})

test('同一个 dryRun 请求连发两次结果一致：命令是绝对状态，试算可重放', async () => {
  const home = await freshHome()
  await writeJson(packsFile(home), { version: 1, ui: {}, packs: { default: { name: 'default' } } })
  const ctx = fakeCtx()
  const withCatalog = deps({ catalog: feedFor(catalogFor(defaultPlugins)) })
  const body = { commands: [{ op: 'createPack', name: '工作' }], dryRun: true }

  const first = await handleApply(ctx, body, withCatalog)
  const second = await handleApply(ctx, body, withCatalog)
  assert.deepEqual(second.value.packs, first.value.packs)
  assert.deepEqual(Object.keys((await readJson(packsFile(home))).packs), ['default'])
})