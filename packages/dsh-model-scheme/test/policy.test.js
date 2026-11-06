import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BUILTIN_SCHEME_ID,
  parsePromptOverrides,
  parseSchemeStore,
  serializePromptOverrides,
  serializeSchemeStore,
} from '../lib/scheme.js'
import {
  applyCommands,
  globalPromptsPath,
  globalSchemePath,
  loadState,
  resolve,
  workspaceSchemePath,
} from '../lib/policy.js'

/**
 * 硬隔离：本文件全程不碰真实的 ~/.dsh。
 *
 * 每个用例都显式传 `options.home`；这里再把 DSH_HOME 指到临时目录兜底，
 * 保证漏传时也只是落到临时目录。默认路径那条用例断言的正是这个兜底值。
 */
const sandboxHome = await mkdtemp(join(tmpdir(), 'model-scheme-home-'))
process.env.DSH_HOME = sandboxHome

/** 真实 home 下的落点，只用来证明整轮测试没有创建它们。 */
const realSchemeFile = join(homedir(), '.dsh', 'model-scheme', 'schemes.json')
const realSchemeFileExisted = existsSync(realSchemeFile)
const realPromptsFile = join(homedir(), '.dsh', 'model-scheme', 'prompts.json')
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

async function tempRoot(prefix = 'model-scheme-test-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function writeAt(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function seedGlobal(home, value) {
  await writeAt(globalSchemePath({ home }), JSON.stringify(value, null, 2) + '\n')
}

async function seedBinding(cwd, value) {
  await writeAt(workspaceSchemePath(cwd), JSON.stringify(value, null, 2) + '\n')
}

async function readGlobal(home) {
  return await readFile(globalSchemePath({ home }), 'utf8')
}

/* ------------------------------------------------------------------ *
 * 求值链（spec §4 / §9-1）
 * ------------------------------------------------------------------ */

test('求值链：工作区绑定指向存在的方案则用它', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': MINIMAL, 'local-one': STANDARD } })
  await seedBinding(cwd, { version: 1, schemeId: 'local-one' })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, 'local-one')
  assert.equal(resolved.source, 'workspace')
  assert.equal(resolved.brokenBinding, false)
  assert.deepEqual(resolved.warnings, [])
})

test('求值链：绑定指向已删方案则回落全局，warning 含被删 id', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': STANDARD } })
  await seedBinding(cwd, { version: 1, schemeId: 'ghost' })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, 'global-one')
  assert.equal(resolved.source, 'global')
  assert.equal(resolved.brokenBinding, true)
  assert.equal(resolved.warnings.length, 1)
  assert.match(resolved.warnings[0], /ghost/)
  assert.match(resolved.warnings[0], /已不存在/)

  // 绑定失效只报不修：文件里仍留着那个 id，重建同名方案即自动恢复。
  assert.deepEqual(JSON.parse(await readFile(workspaceSchemePath(cwd), 'utf8')), { version: 1, schemeId: 'ghost' })
})

test('求值链：工作区没有绑定则用全局默认', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': STANDARD } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, 'global-one')
  assert.equal(resolved.source, 'global')
  assert.equal(resolved.brokenBinding, false)
  assert.deepEqual(resolved.warnings, [])
})

test('求值链：两层都没有记录则用出厂方案', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, BUILTIN_SCHEME_ID)
  assert.equal(resolved.source, 'builtin')
  assert.deepEqual(resolved.scheme.tiers, {})
  assert.equal(resolved.scheme.session, undefined)
  assert.deepEqual(resolved.warnings, [])
})

test('求值链：全局文件坏 JSON 回落出厂方案且不抛', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await writeAt(globalSchemePath({ home }), '{ "schemes": ')

  const state = await loadState(cwd, { home })
  const resolved = resolve(state, cwd)
  assert.equal(resolved.id, BUILTIN_SCHEME_ID)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /不是合法 JSON/)
})

test('求值链：工作区文件坏 JSON 回落全局且不抛', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': STANDARD } })
  await writeAt(workspaceSchemePath(cwd), 'not json at all')

  const state = await loadState(cwd, { home })
  const resolved = resolve(state, cwd)
  assert.equal(resolved.id, 'global-one')
  assert.equal(resolved.source, 'global')
  assert.equal(resolved.brokenBinding, false)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /不是合法 JSON/)
})

test('求值链：全局默认指向已删方案则回落出厂', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'gone', schemes: { 'global-one': STANDARD } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, BUILTIN_SCHEME_ID)
  assert.equal(resolved.source, 'builtin')
  assert.equal(resolved.warnings.length, 1)
  assert.match(resolved.warnings[0], /gone/)
})

test('求值链：cwd 为 null 时只有全局层', async () => {
  const home = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': STANDARD } })

  const state = await loadState(null, { home })
  assert.deepEqual(state.workspace, {})
  assert.equal(resolve(state).id, 'global-one')
})

test('求值链：工作区绑定写成 builtin 时直接取出厂方案', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'global-one', schemes: { 'global-one': STANDARD } })
  await seedBinding(cwd, { version: 1, schemeId: 'builtin' })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.equal(resolved.id, BUILTIN_SCHEME_ID)
  assert.equal(resolved.source, 'builtin')
})

/* ------------------------------------------------------------------ *
 * 解析与校验
 * ------------------------------------------------------------------ */

test('解析：首选与每条备选各自带 reasoningEffort', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await seedGlobal(home, { version: 1, defaultSchemeId: 'standard', schemes: { standard: STANDARD } })

  const resolved = resolve(await loadState(cwd, { home }), cwd)
  assert.deepEqual(resolved.scheme.session, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  const tier = resolved.scheme.tiers.tier1
  assert.equal(tier.primary.reasoningEffort, 'low')
  assert.equal(tier.fallbacks.length, 1)
  assert.equal(tier.fallbacks[0].reasoningEffort, 'low')
})

test('解析：未知档 id 被忽略并留 warning', () => {
  const parsed = parseSchemeStore(JSON.stringify({
    version: 1,
    schemes: { standard: { name: '标准', tiers: { tier9: { primary: ROUTE, fallbacks: [] } } } },
  }))
  assert.equal(parsed.value.schemes.standard.tiers.tier9, undefined)
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0], /tier9/)
})

test('解析：没有可用的首选路由则整档被忽略并留 warning', () => {
  const parsed = parseSchemeStore(JSON.stringify({
    version: 1,
    schemes: { standard: { name: '标准', tiers: { tier1: { name: '侦察', fallbacks: [ROUTE] } } } },
  }))
  assert.deepEqual(parsed.value.schemes.standard.tiers, {})
  assert.ok(parsed.warnings.some((warning) => warning.includes('primary')))
})

test('解析：路由缺 provider 时该条被忽略', () => {
  const parsed = parseSchemeStore(JSON.stringify({
    version: 1,
    schemes: {
      standard: {
        name: '标准',
        tiers: { tier2: { primary: ROUTE, fallbacks: [{ model: 'orphan' }] } },
      },
    },
  }))
  assert.deepEqual(parsed.value.schemes.standard.tiers.tier2.fallbacks, [])
  assert.ok(parsed.warnings.some((warning) => warning.includes('provider')))
})

test('解析：坏 reasoningEffort 降级为跟随模型默认', () => {
  const parsed = parseSchemeStore(JSON.stringify({
    version: 1,
    schemes: { standard: { name: '标准', tiers: { tier3: { primary: { ...ROUTE, reasoningEffort: 42 } } } } },
  }))
  assert.equal(parsed.value.schemes.standard.tiers.tier3.primary.reasoningEffort, undefined)
  assert.ok(parsed.warnings.some((warning) => warning.includes('reasoningEffort')))
})

test('解析：文件里不能定义出厂方案', () => {
  const parsed = parseSchemeStore(JSON.stringify({ version: 1, schemes: { builtin: { name: '假的', tiers: {} } } }))
  assert.equal(parsed.value.schemes[BUILTIN_SCHEME_ID], undefined)
  assert.ok(parsed.warnings.some((warning) => warning.includes(BUILTIN_SCHEME_ID)))
})

test('解析：缺 name 用 id 当显示名', () => {
  const parsed = parseSchemeStore(JSON.stringify({ version: 1, schemes: { standard: { tiers: {} } } }))
  assert.equal(parsed.value.schemes.standard.name, 'standard')
  assert.ok(parsed.warnings.length > 0)
})

test('解析：空文本等价于没有这一层，不报 warning', () => {
  const parsed = parseSchemeStore('')
  assert.deepEqual(parsed.value, { schemes: {} })
  assert.deepEqual(parsed.warnings, [])
})

test('序列化：方案按 id 排序，同内容字节稳定', () => {
  const store = {
    schemes: { zebra: MINIMAL, alpha: STANDARD },
    defaultSchemeId: 'alpha',
  }
  const first = serializeSchemeStore(store)
  const second = serializeSchemeStore(store)
  assert.equal(first, second)
  assert.ok(first.indexOf('alpha') < first.indexOf('zebra'))
  assert.ok(first.endsWith('\n'))
})

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

test('写入：putScheme 后能读回同一份方案', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }], { home })

  const state = await loadState(null, { home })
  assert.deepEqual(state.global.schemes.standard, STANDARD)
})

test('写入：deleteScheme 只删方案，不动 defaultSchemeId', async () => {
  const home = await tempRoot()
  await applyCommands(null, [
    { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
    { op: 'setDefaultScheme', schemeId: 'standard' },
  ], { home })

  const state = await applyCommands(null, [{ op: 'deleteScheme', schemeId: 'standard' }], { home })
  assert.equal(state.global.schemes.standard, undefined)
  assert.equal(state.global.defaultSchemeId, 'standard')

  // 悬空的默认值不再报错，只是降级成出厂方案。
  const resolved = resolve(state)
  assert.equal(resolved.id, BUILTIN_SCHEME_ID)
  assert.match(resolved.warnings[0], /standard/)
})

test('写入：拒绝删除与覆盖出厂方案', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }], { home })
  const before = await readGlobal(home)

  const state = await applyCommands(null, [
    { op: 'deleteScheme', schemeId: BUILTIN_SCHEME_ID },
    { op: 'putScheme', schemeId: BUILTIN_SCHEME_ID, scheme: { name: '顶替', tiers: {} } },
  ], { home })

  assert.equal(await readGlobal(home), before)
  assert.ok(state.warnings.some((warning) => warning.includes('不可删除')))
  assert.ok(state.warnings.some((warning) => warning.includes('不可覆盖')))
  assert.notEqual(resolve(state).scheme.name, '顶替')
})

test('写入：绑定与解绑，解绑删键而不是写 null', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(cwd, [
    { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
    { op: 'bindWorkspace', schemeId: 'standard' },
  ], { home })

  assert.equal((await loadState(cwd, { home })).workspace.schemeId, 'standard')
  assert.equal(resolve(await loadState(cwd, { home }), cwd).id, 'standard')

  await applyCommands(cwd, [{ op: 'bindWorkspace', schemeId: null }], { home })
  const text = await readFile(workspaceSchemePath(cwd), 'utf8')
  assert.equal(text.includes('schemeId'), false)
  assert.deepEqual(JSON.parse(text), { version: 1 })
})

test('写入：绑定出厂方案归一化成未绑定', async () => {
  // 工作区只有两种状态：单独指定某个方案，或不指定、落到全局。
  // 出厂方案是全局层的取值，不是目录能直接指向的目标。
  const home = await tempRoot()
  const cwd = await tempRoot()
  await applyCommands(cwd, [{ op: 'bindWorkspace', schemeId: BUILTIN_SCHEME_ID }], { home })

  const text = await readFile(workspaceSchemePath(cwd), 'utf8')
  assert.equal(text.includes('schemeId'), false, '不应在磁盘上留下指向出厂方案的绑定')
  assert.deepEqual(JSON.parse(text), { version: 1 })
  assert.equal(resolve(await loadState(cwd, { home }), cwd).source, 'builtin')
})

test('写入：工作区命令缺 cwd 直接抛错', async () => {
  const home = await tempRoot()
  await assert.rejects(
    () => applyCommands(null, [{ op: 'bindWorkspace', schemeId: 'standard' }], { home }),
    /缺少工作目录/,
  )
})

test('写入：幂等，同一批命令跑两次字节相同', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const commands = [
    { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
    { op: 'setDefaultScheme', schemeId: 'standard' },
    { op: 'bindWorkspace', schemeId: 'standard' },
  ]
  await applyCommands(cwd, commands, { home })
  const first = await readGlobal(home)
  const firstBinding = await readFile(workspaceSchemePath(cwd), 'utf8')

  await applyCommands(cwd, commands, { home })
  assert.equal(await readGlobal(home), first)
  assert.equal(await readFile(workspaceSchemePath(cwd), 'utf8'), firstBinding)
})

test('写入：可交换，同一批命令换个顺序结果相同', async () => {
  const commands = [
    { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
    { op: 'putScheme', schemeId: 'minimal', scheme: MINIMAL },
    { op: 'setDefaultScheme', schemeId: 'standard' },
  ]

  const homeA = await tempRoot()
  await applyCommands(null, commands, { home: homeA })
  const homeB = await tempRoot()
  await applyCommands(null, [...commands].reverse(), { home: homeB })

  assert.equal(await readGlobal(homeA), await readGlobal(homeB))
})

test('写入：坏输入走 warning 而不是异常', async () => {
  const home = await tempRoot()
  await writeAt(globalSchemePath({ home }), '{ broken')

  const state = await applyCommands(null, [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }], { home })
  assert.ok(state.warnings.some((warning) => warning.includes('不是合法 JSON')))
  assert.deepEqual(state.global.schemes.standard, STANDARD)
})

test('写入：目录 0700、文件 0600', { skip: process.platform === 'win32' ? 'Windows 不保留 POSIX mode' : false }, async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }], { home })

  const file = globalSchemePath({ home })
  const fileStat = await stat(file)
  const dirStat = await stat(dirname(file))
  assert.equal(fileStat.mode & 0o777, 0o600)
  assert.equal(dirStat.mode & 0o777, 0o700)
})

/* ------------------------------------------------------------------ *
 * 提示词覆盖（spec §6.3.1）
 * ------------------------------------------------------------------ */

async function seedPrompts(home, value) {
  await writeAt(globalPromptsPath({ home }), JSON.stringify(value, null, 2) + '\n')
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

test('提示词：只改提示词不创建方案文件', async () => {
  const home = await tempRoot()
  await applyCommands(null, [{ op: 'putPrompts', delegation: '自定义' }], { home })
  assert.equal(existsSync(globalSchemePath({ home })), false)
  assert.equal(existsSync(globalPromptsPath({ home })), true)
})

test('提示词：policy 侧对空串宽容（warning、不落盘），严格拒绝在路由层', async () => {
  const home = await tempRoot()
  const state = await applyCommands(null, [{ op: 'putPrompts', delegation: '  ' }], { home })

  assert.ok(state.warnings.some((warning) => warning.includes('不能为空串')))
  assert.equal(state.prompts.delegation, undefined)
  assert.equal(JSON.parse(await readFile(globalPromptsPath({ home }), 'utf8')).delegation, undefined)
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
  const first = await readFile(globalPromptsPath({ home }), 'utf8')
  await applyCommands(null, commands, { home })
  assert.equal(await readFile(globalPromptsPath({ home }), 'utf8'), first)
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
 * 路径与隔离
 * ------------------------------------------------------------------ */

test('路径：默认全局路径落在 DSH home 下，注入时落在注入根下', async () => {
  const home = await tempRoot()
  assert.equal(globalSchemePath(), join(sandboxHome, 'model-scheme', 'schemes.json'))
  assert.equal(globalSchemePath({ home }), join(home, 'model-scheme', 'schemes.json'))
  assert.equal(globalPromptsPath(), join(sandboxHome, 'model-scheme', 'prompts.json'))
  assert.equal(globalPromptsPath({ home }), join(home, 'model-scheme', 'prompts.json'))
  assert.equal(workspaceSchemePath('C:\\work'), join('C:\\work', '.dsh', 'model-scheme.json'))
})

test('隔离：整轮测试没有在真实 home 下创建方案或提示词文件', () => {
  assert.equal(existsSync(realSchemeFile), realSchemeFileExisted)
  assert.equal(existsSync(realPromptsFile), realPromptsFileExisted)
})
