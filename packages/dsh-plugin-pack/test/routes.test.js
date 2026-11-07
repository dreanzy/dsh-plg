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
    { op: 'addExtra', cwd: 'D:/proj' },
    { op: 'removeExtra', cwd: 'D:/proj' },
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
  assert.equal(parsed.commands.length, 17)
})

test('全局面板默认不列官方插件，打开开关后才列', async () => {
  await freshHome()
  const off = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(off.ok, true)
  const hidden = off.value.plugins.map((row) => row.pkg)
  assert.ok(hidden.indexOf('plug-a') >= 0)
  assert.equal(hidden.indexOf('@deepseek-ai/dsh-thing'), -1)

  await writeJson(packsFile(process.env['DSH_HOME']), { version: 1, ui: { showOfficialPlugins: true }, packs: {} })
  const on = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
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
  assert.deepEqual(on.value.bindings, { bindings: {}, extra: [] })
  assert.deepEqual(on.value.ui, { showOfficialPlugins: true, showChip: true, defaultTab: 'groups' })
})

test('default pack 项级停用反映到 open、openGlobal 与来源', async () => {
  const home = await freshHome()
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: { default: { name: 'default', items: { 'plug-a': false } } },
  })
  const view = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(view.ok, true)

  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, false)
  assert.equal(row.openGlobal, false)
  assert.equal(row.itemGlobal, false)
  assert.equal(row.itemWorkspace, null)
  assert.equal(row.decidedBy, 'default')
  assert.equal(row.decidedVia, 'item')

  const other = view.value.plugins.find((entry) => entry.pkg === '@deepseek-ai/dsh-thing')
  assert.equal(other.open, true)
})

test('范围外包名保留不删，且不出现在插件行里', async () => {
  const home = await freshHome()
  await writeJson(packsFile(home), {
    version: 1,
    ui: { showOfficialPlugins: true },
    packs: { default: { name: 'default', items: { 'ghost-pkg': false, 'plug-a': false } } },
  })
  const view = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
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
  const first = await handleGlobal(fakeCtx(), deps({ catalog: feed }))
  assert.equal(first.ok, true)
  assert.equal(first.value.pending, true)
  assert.equal(started, 1)
  assert.deepEqual(first.value.plugins, [])

  // 扫描仍在进行：第二个请求复用同一个后台任务，不再扫一遍。
  const second = await handleGlobal(fakeCtx(), deps({ catalog: feed }))
  assert.equal(second.value.pending, true)
  assert.equal(started, 1)

  settle()
  await new Promise((resolve) => setImmediate(resolve))

  const third = await handleGlobal(fakeCtx(), deps({ catalog: feed }))
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

  const refusedRename = await handleApply(
    ctx,
    { commands: [{ op: 'renamePack', packId: 'default', name: 'x' }] },
    options,
  )
  assert.equal(refusedRename.ok, false)
  assert.match(refusedRename.error.message, /default pack 不可改名/)

  const refusedDelete = await handleApply(ctx, { commands: [{ op: 'deletePack', packId: 'default' }] }, options)
  assert.equal(refusedDelete.ok, false)
  assert.match(refusedDelete.error.message, /default pack 不可删除/)

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
  assert.equal(result.ok, false)
  assert.match(result.error.message, /未知 pack/)
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
    extra: [],
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

  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, false)
  assert.equal(row.itemWorkspace, false)
  assert.equal(row.itemGlobal, null)
  // default 里没有这条决定，所以「全局」视图字段仍是开。
  assert.equal(row.openGlobal, true)
  assert.equal(row.decidedBy, 'p1')
  assert.equal(row.decidedVia, 'item')

  const beta = view.value.plugins.find((entry) => entry.pkg === '@deepseek-ai/dsh-thing')
  assert.equal(beta.open, true)
  assert.equal(beta.decidedBy, 'default')
  assert.equal(beta.decidedVia, 'builtin')
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
    extra: [],
  })

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(ctx, { sessionId: 'session-1' }, deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))

  assert.equal(view.ok, true)
  assert.equal(view.value.binding, 'p1-gone')
  assert.equal(view.value.packId, 'default')
  assert.equal(view.value.packName, 'default')
  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, false)
  assert.equal(row.decidedBy, 'default')
})
