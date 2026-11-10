import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_PACK_ID,
  normalizeCwd,
  parsePromptOverrides,
  parsePacks,
  serializeBindings,
  serializePacks,
  serializePromptOverrides,
} from '../lib/pack.js'
import {
  applyCommands,
  loadState,
  packsPath,
  previewCommands,
  promptsPath,
  resolve,
  workspacesPath,
} from '../lib/policy.js'

/**
 * 硬隔离：本文件全程不碰真实的 ~/.dsh。
 *
 * 每个用例都显式传 `options.home`；这里再把 DSH_HOME 指到临时目录兜底，
 * 保证漏传时也只是落到临时目录。默认路径那条用例断言的正是这个兜底值。
 */
const sandboxHome = await mkdtemp(join(tmpdir(), 'model-pack-home-'))
process.env.DSH_HOME = sandboxHome

/** 真实 home 下的落点，只用来证明整轮测试没有创建它们。 */
const realPacksFile = join(homedir(), '.dsh', 'packs', 'model', 'packs.json')
const realPacksFileExisted = existsSync(realPacksFile)
const realPromptsFile = join(homedir(), '.dsh', 'packs', 'model', 'prompts.json')
const realPromptsFileExisted = existsSync(realPromptsFile)

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

const STANDARD = {
  name: '标准',
  session: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  tiers: {
    tier1: {
      name: '侦察',
      primary: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
      fallbacks: [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low' }],
    },
  },
}

const MINIMAL = { name: '极简', tiers: {} }

async function tempRoot(prefix = 'model-pack-test-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function writeAt(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

async function seedPacks(home, value) {
  await writeAt(packsPath({ home }), json(value))
}

async function seedWorkspaces(home, value) {
  await writeAt(workspacesPath({ home }), json(value))
}

async function readPacks(home) {
  return JSON.parse(await readFile(packsPath({ home }), 'utf8'))
}

async function readWorkspaces(home) {
  return JSON.parse(await readFile(workspacesPath({ home }), 'utf8'))
}

/* ------------------------------------------------------------------ *
 * 求值链：绑定的 pack → default → 出厂内置
 * ------------------------------------------------------------------ */

test('求值链：工作区绑定指向存在的 pack 则用它', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: MINIMAL, standard: STANDARD } })
  await seedWorkspaces(home, { version: 1, bindings: { [normalizeCwd(cwd)]: 'standard' } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, 'standard')
  assert.equal(resolved.source, 'workspace')
  assert.equal(resolved.brokenBinding, false)
  assert.deepEqual(resolved.warnings, [])
  assert.deepEqual(resolved.pack, STANDARD)
})

test('求值链：绑定指向已删 pack 则降级到 default，warning 含被删 id', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: STANDARD } })
  await seedWorkspaces(home, { version: 1, bindings: { [normalizeCwd(cwd)]: 'ghost' } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, DEFAULT_PACK_ID)
  assert.equal(resolved.source, 'default')
  assert.equal(resolved.brokenBinding, true)
  assert.equal(resolved.warnings.length, 1)
  assert.match(resolved.warnings[0], /ghost/)
  assert.match(resolved.warnings[0], /已不存在/)

  // 绑定失效只报不修：文件里仍留着那个 id，重建同名 pack 即自动恢复。
  assert.deepEqual(await readWorkspaces(home), {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'ghost' },
  })
})

test('求值链：工作区没有绑定则用 default pack', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: STANDARD } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, DEFAULT_PACK_ID)
  assert.equal(resolved.source, 'default')
  assert.equal(resolved.brokenBinding, false)
  assert.deepEqual(resolved.warnings, [])
  assert.deepEqual(resolved.pack, STANDARD)
})

test('求值链：什么文件都没有则用出厂内置', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, DEFAULT_PACK_ID)
  assert.equal(resolved.source, 'builtin')
  assert.deepEqual(resolved.pack.tiers, {})
  assert.equal(resolved.pack.session, undefined)
  assert.equal(resolved.pack.name, '默认')
  assert.deepEqual(resolved.warnings, [])
})

test('求值链：显式绑定 default 与未绑定等价', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: STANDARD } })
  await seedWorkspaces(home, { version: 1, bindings: { [normalizeCwd(cwd)]: 'default' } })

  const state = await loadState(cwd, { home })
  assert.equal(state.binding, 'default')
  assert.equal(state.pack, null)
  const resolved = resolve(state, cwd)
  assert.equal(resolved.source, 'default')
  assert.equal(resolved.brokenBinding, false)
})

test('求值链：packs.json 坏 JSON 回落出厂内置且不抛', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await writeAt(packsPath({ home }), '{ "packs": ')

  const state = await loadState(cwd, { home })
  const resolved = resolve(state, cwd)
  assert.equal(resolved.source, 'builtin')
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /不是合法 JSON/)
})

test('求值链：workspaces.json 坏 JSON 回落 default 且不抛', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: STANDARD } })
  await writeAt(workspacesPath({ home }), 'not json at all')

  const state = await loadState(cwd, { home })
  const resolved = resolve(state, cwd)
  assert.equal(resolved.source, 'default')
  assert.equal(resolved.brokenBinding, false)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /不是合法 JSON/)
})

test('求值链：cwd 为 null 时没有绑定', async () => {
  const home = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: STANDARD, standard: STANDARD } })

  const state = await loadState(null, { home })
  assert.equal(state.binding, null)
  assert.equal(state.pack, null)
  assert.equal(resolve(state).source, 'default')
  assert.deepEqual(state.bindings, { bindings: {} })
})

test('求值链：default 可编辑，内容直接生效', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, {
    version: 1,
    packs: { default: { name: '默认', session: ROUTE, tiers: {} } },
  })
  await seedWorkspaces(home, { version: 1, bindings: { [normalizeCwd(cwd)]: 'standard' } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.deepEqual(resolved.pack.session, ROUTE)
  assert.equal(resolved.source, 'default')
})

/* ------------------------------------------------------------------ *
 * 解析与校验
 * ------------------------------------------------------------------ */

test('解析：首选与每条备选各自带 reasoningEffort', () => {
  const parsed = parsePacks(json({ version: 1, packs: { default: MINIMAL, standard: STANDARD } }))
  const pack = parsed.value.book.packs.standard
  assert.deepEqual(pack.session, STANDARD.session)
  assert.equal(pack.tiers.tier1.primary.reasoningEffort, 'low')
  assert.equal(pack.tiers.tier1.fallbacks.length, 1)
  assert.equal(pack.tiers.tier1.fallbacks[0].reasoningEffort, 'low')
})

test('解析：未知档 id 被忽略并留 warning', () => {
  const parsed = parsePacks(json({
    version: 1,
    packs: { standard: { name: '标准', tiers: { tier9: { primary: ROUTE, fallbacks: [] } } } },
  }))
  assert.equal(parsed.value.book.packs.standard.tiers.tier9, undefined)
  assert.ok(parsed.warnings.some((warning) => warning.includes('tier9')))
})

test('解析：没有可用的首选路由则整档被忽略并留 warning', () => {
  const parsed = parsePacks(json({
    version: 1,
    packs: { standard: { name: '标准', tiers: { tier1: { name: '侦察', fallbacks: [ROUTE] } } } },
  }))
  assert.deepEqual(parsed.value.book.packs.standard.tiers, {})
  assert.ok(parsed.warnings.some((warning) => warning.includes('primary')))
})

test('解析：路由缺 provider 时该条被忽略', () => {
  const parsed = parsePacks(json({
    version: 1,
    packs: { standard: { name: '标准', tiers: { tier2: { primary: ROUTE, fallbacks: [{ model: 'orphan' }] } } } },
  }))
  assert.deepEqual(parsed.value.book.packs.standard.tiers.tier2.fallbacks, [])
  assert.ok(parsed.warnings.some((warning) => warning.includes('provider')))
})

test('解析：坏 reasoningEffort 降级为跟随模型默认', () => {
  const parsed = parsePacks(json({
    version: 1,
    packs: { standard: { name: '标准', tiers: { tier3: { primary: { ...ROUTE, reasoningEffort: 42 } } } } },
  }))
  assert.equal(parsed.value.book.packs.standard.tiers.tier3.primary.reasoningEffort, undefined)
  assert.ok(parsed.warnings.some((warning) => warning.includes('reasoningEffort')))
})

test('解析：缺 default 时补出厂内容并留 warning', () => {
  const parsed = parsePacks(json({ version: 1, packs: { standard: STANDARD } }))
  assert.deepEqual(parsed.value.book.packs.default, { name: '默认', tiers: {} })
  assert.equal(parsed.value.defaultFromFile, false)
  assert.ok(parsed.warnings.some((warning) => warning.includes('default')))
})

test('解析：缺 name 用 id 当显示名', () => {
  const parsed = parsePacks(json({ version: 1, packs: { standard: { tiers: {} } } }))
  assert.equal(parsed.value.book.packs.standard.name, 'standard')
  assert.ok(parsed.warnings.length > 0)
})

test('解析：default 缺 name 用出厂名', () => {
  const parsed = parsePacks(json({ version: 1, packs: { default: { tiers: {} } } }))
  assert.equal(parsed.value.book.packs.default.name, '默认')
})

test('解析：ui 缺省与未知键', () => {
  const parsed = parsePacks(json({ version: 1, packs: { default: MINIMAL } }))
  assert.deepEqual(parsed.value.ui, { showChip: true, defaultTab: 'packs' })

  const withUnknown = parsePacks(json({
    version: 1,
    ui: { showSidebarEntry: true, defaultTab: 'packs' },
    packs: { default: MINIMAL },
  }))
  assert.deepEqual(withUnknown.value.ui, { showChip: true, defaultTab: 'packs' })
  assert.deepEqual(withUnknown.warnings, [])
})

test('解析：空文本等价于没有这一层，不报 warning', () => {
  const parsed = parsePacks('')
  assert.deepEqual(parsed.value.book.packs, { default: { name: '默认', tiers: {} } })
  assert.deepEqual(parsed.warnings, [])
})

test('序列化：pack 按 id 排序，同内容字节稳定', () => {
  const book = { packs: { zebra: MINIMAL, alpha: STANDARD, default: MINIMAL } }
  const ui = { showChip: false, defaultTab: 'packs' }
  const first = serializePacks(book, ui)
  const second = serializePacks(book, ui)
  assert.equal(first, second)
  assert.ok(first.indexOf('alpha') < first.indexOf('zebra'))
  assert.ok(first.endsWith('\n'))
  const parsed = JSON.parse(first)
  assert.equal(parsed.version, 1)
  assert.deepEqual(parsed.ui, ui)
  assert.deepEqual(Object.keys(parsed.packs), ['alpha', 'default', 'zebra'])
})

test('序列化：绑定键排序，只写 bindings', () => {
  const text = serializeBindings({ bindings: { 'c:/b': 'p2', 'c:/a': 'p1' } })
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed.bindings), ['c:/a', 'c:/b'])
  // `extra` 能力已删除：旧字段不再写回，下次写盘即自然消失。
  assert.equal('extra' in parsed, false)
  assert.ok(text.endsWith('\n'))
})

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

test('写入：createPack 造出空档 pack，id 与名字脱钩', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }], { home })

  const packs = (await readPacks(home)).packs
  assert.deepEqual(packs.p1, { name: '前端', tiers: {} })
  assert.ok(packs.default !== undefined)
})

test('写入：createPack 重名与空名都被忽略', async () => {
  const home = await tempRoot()
  const state = await applyCommands(null, [
    { op: 'createPack', name: '前端' },
    { op: 'createPack', name: '前端' },
    { op: 'createPack', name: '  ' },
  ], { home })

  const packs = (await readPacks(home)).packs
  assert.equal(Object.keys(packs).length, 2)
  assert.ok(state.warnings.some((warning) => warning.includes('已存在')))
  assert.ok(state.warnings.some((warning) => warning.includes('不能为空')))
})

test('写入：renamePack 改显示名，id 不动', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }], { home })
  await applyCommands(null, [{ op: 'renamePack', packId: 'p1', name: '前端组' }], { home })

  const packs = (await readPacks(home)).packs
  assert.equal(packs.p1.name, '前端组')
})

test('写入：default 不可删除、不可改名', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }], { home })
  const before = await readFile(packsPath({ home }), 'utf8')

  const state = await applyCommands(null, [
    { op: 'deletePack', packId: DEFAULT_PACK_ID },
    { op: 'renamePack', packId: DEFAULT_PACK_ID, name: '顶替' },
  ], { home })

  assert.equal(await readFile(packsPath({ home }), 'utf8'), before)
  assert.ok(state.warnings.some((warning) => warning.includes('不可删除')))
  assert.ok(state.warnings.some((warning) => warning.includes('不可改名')))
  assert.equal((await readPacks(home)).packs.default.name, '默认')
})

test('写入：deletePack 删 pack 并清掉指向它的绑定', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }], { home })
  await applyCommands(null, [{ op: 'bind', cwd, packId: 'p1' }], { home })
  assert.equal((await readWorkspaces(home)).bindings[normalizeCwd(cwd)], 'p1')

  const state = await applyCommands(null, [{ op: 'deletePack', packId: 'p1' }], { home })
  assert.equal((await readPacks(home)).packs.p1, undefined)
  assert.equal((await readWorkspaces(home)).bindings[normalizeCwd(cwd)], undefined)
  // 绑定被清掉后回落到 default（文件里写了 default，所以来源是 default 而不是内置）。
  assert.equal(resolve(state, cwd).source, 'default')
})

test('写入：putPack 后能读回同一份 pack', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: STANDARD }], { home })

  const state = await loadState(null, { home })
  assert.deepEqual(state.packs.packs.standard, STANDARD)
})

test('写入：putPack 写 default 时显示名仍是出厂名', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{
    op: 'putPack',
    packId: DEFAULT_PACK_ID,
    pack: { name: '想改个名', session: ROUTE, tiers: {} },
  }], { home })

  const packs = (await readPacks(home)).packs
  assert.equal(packs.default.name, '默认')
  assert.deepEqual(packs.default.session, ROUTE)
})

test('写入：packSession 设置与清空会话路由', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: MINIMAL }], { home })
  await applyCommands(null, [{ op: 'packSession', packId: 'standard', session: ROUTE }], { home })
  assert.deepEqual((await readPacks(home)).packs.standard.session, ROUTE)

  await applyCommands(null, [{ op: 'packSession', packId: 'standard', session: null }], { home })
  assert.equal((await readPacks(home)).packs.standard.session, undefined)
  assert.equal((await readPacks(home)).packs.standard.name, '极简')
})

test('写入：packTier 设置与删除单档', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: MINIMAL }], { home })
  const tier = { name: '攻坚', primary: ROUTE, fallbacks: [] }

  await applyCommands(null, [{ op: 'packTier', packId: 'standard', tierId: 'tier3', tier }], { home })
  assert.deepEqual((await readPacks(home)).packs.standard.tiers.tier3, tier)

  await applyCommands(null, [{ op: 'packTier', packId: 'standard', tierId: 'tier3', tier: null }], { home })
  assert.deepEqual((await readPacks(home)).packs.standard.tiers, {})
})

test('写入：bind 自带 cwd，解绑删键而不是写 null', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: STANDARD }], { home })

  // 注意：applyCommands 的第一个参数（回读上下文）是 null，绑定仍然靠命令自带的 cwd。
  await applyCommands(null, [{ op: 'bind', cwd, packId: 'standard' }], { home })
  assert.equal((await readWorkspaces(home)).bindings[normalizeCwd(cwd)], 'standard')
  assert.equal(resolve(await loadState(cwd, { home }), cwd).id, 'standard')

  await applyCommands(null, [{ op: 'bind', cwd, packId: null }], { home })
  const written = await readWorkspaces(home)
  assert.deepEqual(written.bindings, {})
  assert.equal(JSON.stringify(written).includes('null'), false)
})

test('写入：bind 到 default 归一化成解绑', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(null, [{ op: 'bind', cwd, packId: DEFAULT_PACK_ID }], { home })

  // 文件可能根本没被创建（无变化不落盘），创建了也必须没有该键。
  assert.equal(existsSync(workspacesPath({ home })), false)
  assert.equal(resolve(await loadState(cwd, { home }), cwd).source, 'builtin')
})

test('兼容：旧 workspaces.json 里的 extra 被忽略，且不产生 warning', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedPacks(home, { version: 1, packs: { default: MINIMAL, standard: STANDARD } })
  await seedWorkspaces(home, {
    version: 1,
    bindings: { [normalizeCwd(cwd)]: 'standard' },
    // 旧版本手动添加的目录。这条能力已经删除：读时直接忽略，不报、不迁移。
    extra: [normalizeCwd(cwd), 'C:\\work\\gone'],
  })

  const state = await loadState(cwd, { home })
  assert.deepEqual(state.bindings, { bindings: { [normalizeCwd(cwd)]: 'standard' } })
  assert.deepEqual(state.warnings, [])
  assert.equal(resolve(state, cwd).id, 'standard')

  // 下一次写盘自然清掉旧字段：不做迁移，也不为它保留一条写入分支。
  await applyCommands(null, [{ op: 'bind', cwd, packId: null }], { home })
  const written = await readWorkspaces(home)
  assert.equal('extra' in written, false)
  assert.deepEqual(written.bindings, {})
})

/* ------------------------------------------------------------------ *
 * 试算（dryRun）：与真写共用应用规则，但不落盘
 * ------------------------------------------------------------------ */

test('试算：应用在内存里，返回同一份视图且不创建任何文件', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const commands = [
    { op: 'createPack', name: '前端' },
    { op: 'putPack', packId: 'standard', pack: STANDARD },
    { op: 'bind', cwd, packId: 'standard' },
  ]

  const preview = await previewCommands(cwd, commands, { home })
  assert.equal(preview.packs.packs.p1.name, '前端')
  assert.deepEqual(preview.packs.packs.standard, STANDARD)
  assert.equal(preview.binding, 'standard')
  assert.equal(resolve(preview, cwd).id, 'standard')

  // 试算不落盘：三份文件一个都没建。
  assert.equal(existsSync(packsPath({ home })), false)
  assert.equal(existsSync(workspacesPath({ home })), false)
  assert.equal(existsSync(promptsPath({ home })), false)

  // 真写后重读同一份视图：两条路径共用应用规则，形状不会漂移。
  const written = await applyCommands(cwd, commands, { home })
  assert.deepEqual(written.packs, preview.packs)
  assert.deepEqual(written.bindings, preview.bindings)
  assert.deepEqual(written.prompts, preview.prompts)
  assert.equal(written.binding, preview.binding)
})

test('试算：非法命令只记 warning，合法命令仍然生效', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(null, [{ op: 'createPack', name: '前端' }], { home })
  const before = await readFile(packsPath({ home }), 'utf8')

  const preview = await previewCommands(cwd, [
    { op: 'renamePack', packId: 'ghost', name: '不存在' },
    { op: 'packTier', packId: 'p1', tierId: 'tier2', tier: { name: '速办', primary: ROUTE, fallbacks: [] } },
  ], { home })

  // 坏命令只留说明；同时的那条合法命令照样进视图。
  assert.ok(preview.warnings.some((warning) => warning.includes('ghost')))
  assert.equal(preview.packs.packs.p1.tiers.tier2.name, '速办')
  // 文件一个字节都没动。
  assert.equal(await readFile(packsPath({ home }), 'utf8'), before)
})

test('试算：提示词也走同一条路径，且不写 prompts.json', async () => {
  const home = await tempRoot()
  const preview = await previewCommands(null, [{ op: 'putPrompts', delegation: '试算编排' }], { home })

  assert.equal(preview.prompts.delegation, '试算编排')
  assert.equal(existsSync(promptsPath({ home })), false)
})

test('写入：showChip 与 defaultTab 落在 packs.json 的 ui 段', async () => {
  const home = await tempRoot()
  await applyCommands(null, [
    { op: 'showChip', value: false },
    { op: 'defaultTab', value: 'packs' },
  ], { home })

  assert.deepEqual((await readPacks(home)).ui, { showChip: false, defaultTab: 'packs' })
})

test('写入：幂等，同一批命令跑两次字节相同', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const commands = [
    { op: 'putPack', packId: 'standard', pack: STANDARD },
    { op: 'createPack', name: '前端' },
    { op: 'bind', cwd, packId: 'standard' },
    { op: 'showChip', value: false },
  ]
  await applyCommands(null, commands, { home })
  const firstPacks = await readFile(packsPath({ home }), 'utf8')
  const firstWorkspaces = await readFile(workspacesPath({ home }), 'utf8')

  await applyCommands(null, commands, { home })
  assert.equal(await readFile(packsPath({ home }), 'utf8'), firstPacks)
  assert.equal(await readFile(workspacesPath({ home }), 'utf8'), firstWorkspaces)
})

test('写入：可交换，同一批命令换个顺序结果相同', async () => {
  const commands = [
    { op: 'putPack', packId: 'standard', pack: STANDARD },
    { op: 'putPack', packId: 'minimal', pack: MINIMAL },
    { op: 'createPack', name: '前端' },
  ]

  const homeA = await tempRoot()
  await applyCommands(null, commands, { home: homeA })
  const homeB = await tempRoot()
  await applyCommands(null, [...commands].reverse(), { home: homeB })

  assert.equal(await readFile(packsPath({ home: homeA }), 'utf8'), await readFile(packsPath({ home: homeB }), 'utf8'))
})

test('写入：坏输入走 warning 且拒写，不是异常', async () => {
  const home = await tempRoot()
  // 读侧回落是兜底，写侧不能跟着回落：拿空名册覆盖手改坏的文件，没有撤回办法。
  await writeAt(packsPath({ home }), '{ broken')

  const state = await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: STANDARD }], { home })
  assert.ok(state.warnings.some((warning) => warning.includes('不是合法 JSON')))
  assert.equal(await readFile(packsPath({ home }), 'utf8'), '{ broken')
  assert.equal(state.packs.packs.standard, undefined)
})

test('写入：目录 0700、文件 0600', { skip: process.platform === 'win32' ? 'Windows 不保留 POSIX mode' : false }, async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: STANDARD }], { home })

  const file = packsPath({ home })
  const fileStat = await stat(file)
  const dirStat = await stat(dirname(file))
  assert.equal(fileStat.mode & 0o777, 0o600)
  assert.equal(dirStat.mode & 0o777, 0o700)
})

test('写入：只写提示词不创建 packs.json 与 workspaces.json', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPrompts', delegation: '自定义' }], { home })
  assert.equal(existsSync(packsPath({ home })), false)
  assert.equal(existsSync(workspacesPath({ home })), false)
  assert.equal(existsSync(promptsPath({ home })), true)
})

/* ------------------------------------------------------------------ *
 * 提示词覆盖（spec §6.3.1）
 * ------------------------------------------------------------------ */

async function seedPrompts(home, value) {
  await writeAt(promptsPath({ home }), json(value))
}

test('提示词：没有文件时覆盖为空，不报 warning', async () => {
  const home = await tempRoot()
  const state = await loadState(null, { home })
  assert.deepEqual(state.prompts, { tiers: {} })
  assert.deepEqual(state.warnings, [])
})

test('提示词：读文件时逐键进入覆盖，空串按缺省', async () => {
  const home = await tempRoot()
  await seedPrompts(home, {
    version: 1,
    delegation: '自定义',
    tiers: { tier1: { label: '探路', text: '' } },
  })

  const state = await loadState(null, { home })
  assert.equal(state.prompts.delegation, '自定义')
  assert.deepEqual(state.prompts.tiers, { tier1: { label: '探路' } })
  assert.ok(state.warnings.some((warning) => warning.includes('tier1.text')))
})

test('提示词：putPrompts 写入后能读回同一份覆盖', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{
    op: 'putPrompts',
    delegation: '自定义',
    tiers: { tier2: { label: '快办', text: '小改动' } },
  }], { home })

  const state = await loadState(null, { home })
  assert.equal(state.prompts.delegation, '自定义')
  assert.deepEqual(state.prompts.tiers, { tier2: { label: '快办', text: '小改动' } })
})

test('提示词：policy 侧对空串宽容（warning、不落盘），严格拒绝在路由层', async () => {
  const home = await tempRoot()
  const state = await applyCommands(null, [{ op: 'putPrompts', delegation: '  ' }], { home })

  assert.ok(state.warnings.some((warning) => warning.includes('不能为空串')))
  assert.equal(state.prompts.delegation, undefined)
  assert.equal(JSON.parse(await readFile(promptsPath({ home }), 'utf8')).delegation, undefined)
})

test('提示词：resetPrompts 单键与全部', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{
    op: 'putPrompts',
    delegation: '自定义',
    tiers: { tier1: { label: '探路' }, tier2: { label: '快办' } },
  }], { home })

  await applyCommands(null, [{ op: 'resetPrompts', keys: ['delegation'] }], { home })
  let state = await loadState(null, { home })
  assert.equal(state.prompts.delegation, undefined)
  assert.deepEqual(Object.keys(state.prompts.tiers).sort(), ['tier1', 'tier2'])

  // 不传 keys = 全部恢复内置。
  await applyCommands(null, [{ op: 'resetPrompts' }], { home })
  state = await loadState(null, { home })
  assert.deepEqual(state.prompts, { tiers: {} })
})

test('提示词：putPrompts 是绝对状态，同一批命令跑两次字节相同', async () => {
  const home = await tempRoot()
  const commands = [{ op: 'putPrompts', delegation: '自定义', tiers: { tier3: { label: '深改' } } }]
  await applyCommands(null, commands, { home })
  const first = await readFile(promptsPath({ home }), 'utf8')
  await applyCommands(null, commands, { home })
  assert.equal(await readFile(promptsPath({ home }), 'utf8'), first)
})

test('提示词：序列化稳定，空覆盖不写空档', () => {
  const overrides = {
    delegation: '自定义',
    tiers: { tier4: { text: '原因不明' }, tier1: { label: '' } },
  }
  const first = serializePromptOverrides(overrides)
  assert.equal(first, serializePromptOverrides(overrides))
  assert.ok(first.endsWith('\n'))

  const parsed = JSON.parse(first)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.tiers.tier1, undefined)
  assert.deepEqual(parsed.tiers.tier4, { text: '原因不明' })
})

test('提示词：坏 JSON 走 warning 不抛', () => {
  const parsed = parsePromptOverrides('{ broken')
  assert.deepEqual(parsed.value, { tiers: {} })
  assert.ok(parsed.warnings.some((warning) => warning.includes('不是合法 JSON')))
})

/* ------------------------------------------------------------------ *
 * 工作区键
 * ------------------------------------------------------------------ */

test('normalizeCwd：反斜杠、尾斜杠、空白与盘符根', () => {
  assert.equal(normalizeCwd(null), null)
  assert.equal(normalizeCwd('   '), null)
  assert.equal(normalizeCwd('/usr/local/'), '/usr/local')
  assert.equal(normalizeCwd('/'), '/')

  const win = normalizeCwd('D:\\Work\\Alpha\\')
  if (process.platform === 'win32') {
    // Windows：盘符、大小写、反斜杠都归一到同一个键。
    assert.equal(win, 'd:/work/alpha')
    assert.equal(normalizeCwd('C:\\'), 'c:/')
    assert.equal(normalizeCwd('d:/work/alpha'), 'd:/work/alpha')
  } else {
    // 其余平台不做小写化：目录名大小写敏感。
    assert.equal(win, 'D:/Work/Alpha')
  }
})

test('normalizeCwd：同一目录的不同写法落到同一个绑定键', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(null, [{ op: 'putPack', packId: 'standard', pack: STANDARD }], { home })

  const variant = process.platform === 'win32' ? cwd.replace(/\//gu, '\\') + '\\' : cwd + '/'
  await applyCommands(null, [{ op: 'bind', cwd: variant, packId: 'standard' }], { home })

  const written = await readWorkspaces(home)
  assert.deepEqual(Object.keys(written.bindings), [normalizeCwd(cwd)])
})

/* ------------------------------------------------------------------ *
 * 路径与隔离
 * ------------------------------------------------------------------ */

test('路径：默认落在 DSH home 下，注入时落在注入根下', async () => {
  const home = await tempRoot()
  assert.equal(packsPath(), join(sandboxHome, 'packs', 'model', 'packs.json'))
  assert.equal(packsPath({ home }), join(home, 'packs', 'model', 'packs.json'))
  assert.equal(promptsPath(), join(sandboxHome, 'packs', 'model', 'prompts.json'))
  assert.equal(promptsPath({ home }), join(home, 'packs', 'model', 'prompts.json'))
  assert.equal(workspacesPath(), join(sandboxHome, 'packs', 'model', 'workspaces.json'))
})

test('隔离：整轮测试没有在真实 home 下创建 pack 或提示词文件', () => {
  assert.equal(existsSync(realPacksFile), realPacksFileExisted)
  assert.equal(existsSync(realPromptsFile), realPromptsFileExisted)
})
