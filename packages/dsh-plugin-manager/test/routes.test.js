import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleApply, handleGlobal, handleWorkspace, parseCommands } from '../lib/routes.js'

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
  const home = await mkdtemp(join(tmpdir(), 'dpm-routes-'))
  process.env['DSH_HOME'] = home
  // 测试机器的真 profile 不该被后台扫描拖进来。
  delete process.env['DSH_PROFILE_DIR']
  await mkdir(join(home, 'plugin-manager'), { recursive: true })
  return home
}

test('parseCommands 拒绝非法形状', () => {
  assert.equal(parseCommands(undefined).ok, false)
  assert.equal(parseCommands([]).ok, false)
  assert.equal(parseCommands([{ op: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'item', layer: 'global', name: 'x', value: 'yes' }]).ok, false)
  assert.equal(parseCommands([{ op: 'item', layer: 'x', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'assign', name: 'x', groupId: 5 }]).ok, false)
  // 批量里只要有一条坏，整批拒绝：半懂地写一半比拒掉更糟。
  assert.equal(
    parseCommands([{ op: 'item', layer: 'global', name: 'a', value: false }, { op: 'createGroup' }]).ok,
    false,
  )
})

test('parseCommands 接受每种合法命令', () => {
  const parsed = parseCommands([
    { op: 'item', layer: 'global', name: 'plug-a', value: false },
    { op: 'item', layer: 'workspace', name: 'plug-b', value: null },
    { op: 'group', layer: 'global', groupId: 'g1', value: true },
    { op: 'assign', name: 'plug-a', groupId: null },
    { op: 'createGroup', name: '新组' },
    { op: 'renameGroup', groupId: 'g1', name: '改名' },
    { op: 'deleteGroup', groupId: 'g1' },
    { op: 'showSidebarEntry', value: false },
  ])
  assert.equal(parsed.ok, true)
  // 数目断言是刻意的：新增一种命令却忘了登记进 OPS 白名单时，它会被当成未知操作拒掉。
  assert.equal(parsed.commands.length, 8)
})

test('全局面板列出插件行，工具数取实测清单', async () => {
  await freshHome()
  const view = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(view.ok, true)

  const byName = new Map(view.value.plugins.map((row) => [row.pkg, row]))
  assert.equal(byName.get('plug-a').tools, 1)
  assert.equal(byName.get('plug-a').sections, 1)
  assert.equal(byName.get('plug-a').sectionChars, 120)
  assert.equal(byName.get('plug-a').sectionKnown, true)
  assert.equal(byName.get('plug-a').origin, 'profile')
  assert.equal(byName.get('@deepseek-ai/dsh-thing').origin, 'official')
  // toolVolume 按 schemas(scope) 实测长度折算，不是目录里的静态数。
  assert.ok(byName.get('plug-a').toolVolume > 0)
  assert.equal(view.value.pending, false)
  assert.deepEqual(view.value.support, { restrict: true, promptFilter: true })
  // 行序与加载顺序无关。
  assert.deepEqual(
    view.value.plugins.map((row) => row.pkg),
    ['@deepseek-ai/dsh-thing', 'plug-a'],
  )
})

test('全局项级停用反映到 open 与 itemGlobal，工作区层不参与', async () => {
  const home = await freshHome()
  await writeFile(
    join(home, 'plugin-manager', 'global.json'),
    JSON.stringify({ items: { 'plug-a': false } }, null, 2) + NEWLINE,
  )
  const view = await handleGlobal(fakeCtx(), deps({ catalog: feedFor(catalogFor(defaultPlugins)) }))
  assert.equal(view.ok, true)

  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, false)
  assert.equal(row.openGlobal, false)
  assert.equal(row.itemGlobal, false)
  assert.equal(row.itemWorkspace, null)

  const other = view.value.plugins.find((entry) => entry.pkg === '@deepseek-ai/dsh-thing')
  assert.equal(other.open, true)
})

test('范围外包名保留不删，且不出现在插件行里', async () => {
  const home = await freshHome()
  await writeFile(
    join(home, 'plugin-manager', 'global.json'),
    JSON.stringify({ items: { 'ghost-pkg': false, 'plug-a': false } }, null, 2) + NEWLINE,
  )
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
    { commands: [{ op: 'item', layer: 'global', name: 'plug-a', value: false }] },
    options,
  )
  assert.equal(first.ok, true)
  const second = await handleApply(
    ctx,
    { commands: [{ op: 'item', layer: 'global', name: 'plug-b', value: false }] },
    options,
  )
  assert.equal(second.ok, true)

  const onDisk = JSON.parse(await readFile(join(home, 'plugin-manager', 'global.json'), 'utf8'))
  assert.deepEqual(onDisk.items, { 'plug-a': false, 'plug-b': false })
})

test('apply 的非法命令整批拒绝且不落盘', async () => {
  const home = await freshHome()
  const result = await handleApply(fakeCtx(), { commands: [{ op: 'item' }] }, deps())
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  const exists = await readFile(join(home, 'plugin-manager', 'global.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
})

test('工作区命令缺少 sessionId 时拒绝，且不落盘', async () => {
  const home = await freshHome()
  const result = await handleApply(
    fakeCtx(),
    { commands: [{ op: 'item', layer: 'workspace', name: 'plug-a', value: false }] },
    deps(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-session')
  const exists = await readFile(join(home, 'plugin-manager', 'global.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
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
    { commands: [{ op: 'item', layer: 'global', name: 'plug-a', value: false }] },
    deps({
      reapply: async () => {
        throw new Error('boom')
      },
    }),
  )
  assert.equal(result.ok, true)
})

test('工作区视图带 cwd、policyPath 与 stuck', async () => {
  const home = await freshHome()
  const cwd = await mkdtemp(join(tmpdir(), 'dpm-ws-'))
  await mkdir(join(cwd, '.dsh'), { recursive: true })
  await writeFile(
    join(cwd, '.dsh', 'plugin-manager.json'),
    JSON.stringify({ items: { 'plug-a': false } }, null, 2) + NEWLINE,
  )

  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd } } }
  const ctx = fakeCtx(fakeTools(), { agents: { get: () => agent } })
  const view = await handleWorkspace(
    ctx,
    { sessionId: 'session-1' },
    deps({ catalog: feedFor(catalogFor(defaultPlugins)), stuck: () => ['alpha'] }),
  )

  assert.equal(view.ok, true)
  assert.equal(view.value.cwd, cwd)
  assert.equal(view.value.policyPath, join(cwd, '.dsh', 'plugin-manager.json'))
  assert.equal(view.value.live, true)
  assert.deepEqual(view.value.stuck, ['alpha'])
  assert.equal(view.value.workspace.items['plug-a'], false)
  const row = view.value.plugins.find((entry) => entry.pkg === 'plug-a')
  assert.equal(row.open, false)
  assert.equal(row.itemWorkspace, false)
  assert.equal(row.itemGlobal, null)
  assert.ok(home.length > 0)
})
