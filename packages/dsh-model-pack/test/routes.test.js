import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROUTES,
  handleApply,
  handleRead,
  toResponse,
  wrapHandler,
} from '../lib/routes.js'
import {
  applyCommands,
  loadState,
  packsPath,
  promptsPath,
  resolve,
  workspacesPath,
} from '../lib/policy.js'
import { BUILTIN_PROMPT, resolvePrompt } from '../lib/prompt.js'
import { DEFAULT_PACK_ID, normalizeCwd } from '../lib/pack.js'

/**
 * 路由测试走**真的 policy 函数**：注入的 deps 只是把临时 home 绑进闭包。
 *
 * 这样「apply 后 read 能读回」断言的是磁盘上的真文件，不是替身的内存状态；
 * 只有「异常必须变成 internal 信封」这类用例才故意注入抛错的替身。
 *
 * 刻意不设 DSH_HOME：policy 的默认路径归 policy.test.js 断言，这里全程显式传 home，
 * 免得两个文件在 --test-isolation=none 下互相覆盖环境变量。
 */

/** 真实 home 下的落点，只用来证明整轮测试没有创建它。 */
const realPacksFile = join(homedir(), '.dsh', 'packs', 'model', 'packs.json')
const realPacksFileExisted = existsSync(realPacksFile)

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

const STANDARD = {
  name: '标准',
  session: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  tiers: {
    tier1: {
      name: '侦察',
      primary: ROUTE,
      fallbacks: [{ provider: 'deepseek', model: 'deepseek-reasoner' }],
    },
  },
}

async function tempRoot(prefix = 'model-pack-routes-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** 路由 deps：真 policy + 显式 home；logger 收集 warn 供断言。 */
function depsFor(home, overrides = {}) {
  const warnings = []
  const deps = {
    loadState: (cwd) => loadState(cwd, { home }),
    applyCommands: (cwd, commands) => applyCommands(cwd, commands, { home }),
    resolve: (state, cwd) => resolve(state, cwd),
    resolvePrompt: (overrides) => resolvePrompt(overrides),
    builtinPrompt: () => BUILTIN_PROMPT,
    support: () => ({ subagents: true, restrict: true }),
    lastError: () => undefined,
    logger: { warn: (message) => warnings.push(message) },
    ...overrides,
  }
  return { deps, warnings }
}

/* ------------------------------------------------------------------ *
 * 路径与信封
 * ------------------------------------------------------------------ */

test('路径：两条路由都在 /api/model-pack/ 前缀下', () => {
  assert.deepEqual(ROUTES, {
    read: '/api/model-pack/read',
    apply: '/api/model-pack/apply',
  })
})

test('信封：成功带 data，失败带 error.code 与 message', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const ok = await handleRead(deps, null)
  assert.equal(ok.ok, true)
  assert.equal(typeof ok.data, 'object')

  const bad = await handleApply(deps, { commands: [{ op: 'nope' }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')
  assert.ok(bad.error.message.length > 0)
})

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

test('read：无文件时返回出厂内置，空 body 合法', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleRead(deps, null)
  assert.equal(result.ok, true)
  assert.equal(result.data.resolved.id, DEFAULT_PACK_ID)
  assert.equal(result.data.resolved.source, 'builtin')
  assert.deepEqual(Object.keys(result.data.state.packs.packs), [DEFAULT_PACK_ID])
  assert.deepEqual(result.data.state.bindings, { bindings: {}, extra: [] })
  assert.deepEqual(result.data.support, { subagents: true, restrict: true })
  assert.equal(result.data.lastError, null)

  // 空对象 body 与 null 等价（都不回读任何工作区绑定）。
  const emptyBody = await handleRead(deps, {})
  assert.equal(emptyBody.ok, true)
  assert.equal(emptyBody.data.state.binding, null)
})

test('read：cwd 缺省与空白串都不回读绑定', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const blank = await handleRead(deps, { cwd: '   ' })
  assert.equal(blank.ok, true)
  assert.equal(blank.data.state.binding, null)
})

test('read：cwd 不是字符串返回 bad-request', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleRead(deps, { cwd: 42 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.match(result.error.message, /cwd/)
})

/* ------------------------------------------------------------------ *
 * apply / 读回
 * ------------------------------------------------------------------ */

test('apply：写入 pack 并绑定后 read 能读回', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  const written = await handleApply(deps, {
    cwd,
    commands: [
      { op: 'putPack', packId: 'standard', pack: STANDARD },
      { op: 'bind', cwd, packId: 'standard' },
    ],
  })
  assert.equal(written.ok, true)
  assert.equal(written.data.resolved.id, 'standard')
  assert.equal(written.data.resolved.source, 'workspace')
  assert.deepEqual(written.data.state.packs.packs.standard, STANDARD)

  // 落盘了才算数：read 重新读文件。
  const read = await handleRead(deps, { cwd })
  assert.equal(read.ok, true)
  assert.equal(read.data.resolved.id, 'standard')
  assert.equal(read.data.resolved.source, 'workspace')
  assert.equal(read.data.resolved.brokenBinding, false)
  assert.deepEqual(read.data.state.bindings.bindings, { [normalizeCwd(cwd)]: 'standard' })
})

test('apply：bind 自带 cwd，body 不带 cwd 也能写入', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  const written = await handleApply(deps, {
    commands: [
      { op: 'putPack', packId: 'standard', pack: STANDARD },
      { op: 'bind', cwd, packId: 'standard' },
    ],
  })
  assert.equal(written.ok, true)
  // 回读上下文是全局视图，但绑定确实落盘了。
  assert.equal(written.data.state.binding, null)
  assert.deepEqual(written.data.state.bindings.bindings, { [normalizeCwd(cwd)]: 'standard' })

  const read = await handleRead(deps, { cwd })
  assert.equal(read.data.resolved.id, 'standard')
})

test('apply：bind 传 null 解除绑定，回落到 default', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    cwd,
    commands: [
      { op: 'putPack', packId: 'standard', pack: STANDARD },
      { op: 'bind', cwd, packId: 'standard' },
    ],
  })
  const unbound = await handleApply(deps, { cwd, commands: [{ op: 'bind', cwd, packId: null }] })
  assert.equal(unbound.ok, true)
  // packs.json 里已经写了 default，所以来源是 default 而不是内置。
  assert.equal(unbound.data.resolved.source, 'default')
  assert.deepEqual(unbound.data.state.bindings.bindings, {})
})

test('apply：悬空绑定降级到 default 并留 warning', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    cwd,
    commands: [
      { op: 'putPack', packId: 'standard', pack: STANDARD },
      { op: 'bind', cwd, packId: 'standard' },
      { op: 'deletePack', packId: 'standard' },
    ],
  })
  const read = await handleRead(deps, { cwd })
  assert.equal(read.ok, true)
  assert.equal(read.data.resolved.id, DEFAULT_PACK_ID)
  assert.equal(read.data.resolved.brokenBinding, false, '删除时顺手清了绑定，不该再报悬空')
})

test('apply：createPack / renamePack / deletePack 走通', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const created = await handleApply(deps, { commands: [{ op: 'createPack', name: '前端' }] })
  assert.equal(created.ok, true)
  assert.equal(created.data.state.packs.packs.p1.name, '前端')

  const renamed = await handleApply(deps, { commands: [{ op: 'renamePack', packId: 'p1', name: '前端组' }] })
  assert.equal(renamed.data.state.packs.packs.p1.name, '前端组')

  const deleted = await handleApply(deps, { commands: [{ op: 'deletePack', packId: 'p1' }] })
  assert.equal(deleted.data.state.packs.packs.p1, undefined)
})

test('apply：default 不可删除、不可改名，走 warning 而不是错误信封', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleApply(deps, {
    commands: [
      { op: 'deletePack', packId: DEFAULT_PACK_ID },
      { op: 'renamePack', packId: DEFAULT_PACK_ID, name: '顶替' },
    ],
  })
  // 形状合法、语义被 policy 拒绝：路由不把它当错误，面板靠 warnings 显示。
  assert.equal(result.ok, true)
  assert.ok(result.data.state.warnings.some((warning) => warning.includes('不可删除')))
  assert.ok(result.data.state.warnings.some((warning) => warning.includes('不可改名')))
  assert.equal(result.data.state.packs.packs.default.name, '默认')
})

test('apply：packSession 与 packTier 编辑 pack 内容', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, { commands: [{ op: 'createPack', name: '前端' }] })
  const written = await handleApply(deps, {
    commands: [
      { op: 'packSession', packId: 'p1', session: ROUTE },
      { op: 'packTier', packId: 'p1', tierId: 'tier2', tier: { name: '速办', primary: ROUTE, fallbacks: [] } },
    ],
  })
  assert.equal(written.ok, true)
  assert.deepEqual(written.data.state.packs.packs.p1.session, ROUTE)
  assert.deepEqual(written.data.state.packs.packs.p1.tiers.tier2, {
    name: '速办',
    primary: ROUTE,
    fallbacks: [],
  })

  const cleared = await handleApply(deps, {
    commands: [
      { op: 'packSession', packId: 'p1', session: null },
      { op: 'packTier', packId: 'p1', tierId: 'tier2', tier: null },
    ],
  })
  assert.equal(cleared.data.state.packs.packs.p1.session, undefined)
  assert.deepEqual(cleared.data.state.packs.packs.p1.tiers, {})
})

test('apply：addExtra 与 removeExtra 维护手动添加的路径', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  const added = await handleApply(deps, { commands: [{ op: 'addExtra', cwd }] })
  assert.deepEqual(added.data.state.bindings.extra, [normalizeCwd(cwd)])

  const removed = await handleApply(deps, { commands: [{ op: 'removeExtra', cwd }] })
  assert.deepEqual(removed.data.state.bindings.extra, [])
})

test('apply：showChip 与 defaultTab 落在 ui 段', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const written = await handleApply(deps, {
    commands: [
      { op: 'showChip', value: false },
      { op: 'defaultTab', value: 'packs' },
    ],
  })
  assert.deepEqual(written.data.state.ui, { showChip: false, defaultTab: 'packs' })
})

/* ------------------------------------------------------------------ *
 * bad-request：拒绝整批，不部分写入
 * ------------------------------------------------------------------ */

test('apply：未知命令返回 bad-request 并指出第几条，不写入', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleApply(deps, {
    commands: [
      { op: 'putPack', packId: 'standard', pack: STANDARD },
      { op: 'launchMissiles', packId: 'standard' },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.match(result.error.message, /commands\[1\]/)

  // 第一条合法但整批拒绝：不做部分写入。
  assert.equal(existsSync(packsPath({ home })), false)
})

test('apply：拦截整批时连合法项也没生效', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [
      { op: 'showChip', value: false },
      { op: 'deletePack', packId: 7 },
    ],
  })
  const read = await handleRead(deps, null)
  assert.equal(read.ok, true)
  assert.equal(read.data.state.ui.showChip, true)
})

test('apply：坏形状逐条指出下标', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const cases = [
    { commands: [{ op: 'putPack', packId: 'standard' }], match: /commands\[0\]\.pack 必须是对象/ },
    { commands: [{ op: 'putPack', packId: '', pack: STANDARD }], match: /commands\[0\]\.packId/ },
    { commands: [{ op: 'deletePack' }], match: /commands\[0\]\.packId/ },
    { commands: [{ op: 'createPack', name: '  ' }], match: /commands\[0\]\.name/ },
    { commands: [{ op: 'packTier', packId: 'p1', tierId: 'tier9', tier: null }], match: /tierId/ },
    { commands: [{ op: 'packTier', packId: 'p1', tierId: 'tier1', tier: 'x' }], match: /tier 必须是对象或 null/ },
    { commands: [{ op: 'packSession', packId: 'p1', session: 'x' }], match: /session 必须是对象或 null/ },
    { commands: [{ op: 'bind', cwd: '', packId: null }], match: /commands\[0\]\.cwd/ },
    { commands: [{ op: 'bind', cwd: 'C:\\work', packId: 1 }], match: /packId/ },
    { commands: [{ op: 'addExtra' }], match: /commands\[0\]\.cwd/ },
    { commands: [{ op: 'showChip', value: 'yes' }], match: /value 必须是布尔/ },
    { commands: [{ op: 'defaultTab', value: 'groups' }], match: /packs、workspace 或 prompts/ },
    { commands: ['nope'], match: /commands\[0\] 不是对象/ },
    { commands: 'nope', match: /必须是数组/ },
    { commands: [], match: /不能为空/ },
  ]

  for (const entry of cases) {
    const result = await handleApply(deps, { cwd: 'C:\\work', commands: entry.commands })
    assert.equal(result.ok, false, JSON.stringify(entry.commands))
    assert.equal(result.error.code, 'bad-request')
    assert.match(result.error.message, entry.match)
  }
  assert.equal(existsSync(packsPath({ home })), false)
})

/* ------------------------------------------------------------------ *
 * 提示词覆盖（spec §6.3.1）
 * ------------------------------------------------------------------ */

test('read：prompts 给出生效值、内置值与覆盖原样', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleRead(deps, null)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.prompts.effective, {
    delegation: BUILTIN_PROMPT.delegation,
    tiers: BUILTIN_PROMPT.tiers,
  })
  assert.deepEqual(result.data.prompts.builtin, {
    delegation: BUILTIN_PROMPT.delegation,
    tiers: BUILTIN_PROMPT.tiers,
  })
  // 没有覆盖文件时覆盖是空的：UI 据此显示「跟随内置」。
  assert.equal(result.data.prompts.overrides.delegation, undefined)
  assert.deepEqual(result.data.prompts.overrides.tiers, {})
})

test('apply：putPrompts 写入后 read 的生效值变化，内置值不动', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const written = await handleApply(deps, {
    commands: [{ op: 'putPrompts', delegation: '自定义编排段' }],
  })
  assert.equal(written.ok, true)
  assert.equal(written.data.prompts.effective.delegation, '自定义编排段')
  assert.equal(written.data.prompts.builtin.delegation, BUILTIN_PROMPT.delegation)
  assert.equal(written.data.prompts.overrides.delegation, '自定义编排段')

  const read = await handleRead(deps, null)
  assert.equal(read.ok, true)
  assert.equal(read.data.prompts.effective.delegation, '自定义编排段')
  assert.equal(read.data.prompts.effective.tiers.tier1.label, BUILTIN_PROMPT.tiers.tier1.label)

  // 落盘在提示词文件，不是 pack 文件。
  assert.equal(existsSync(promptsPath({ home })), true)
  assert.equal(existsSync(packsPath({ home })), false)
})

test('apply：putPrompts 只改一档，其余走内置', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [{ op: 'putPrompts', tiers: { tier2: { label: '快办' } } }],
  })
  const read = await handleRead(deps, null)
  assert.equal(read.ok, true)
  assert.equal(read.data.prompts.effective.tiers.tier2.label, '快办')
  assert.equal(read.data.prompts.effective.tiers.tier2.text, BUILTIN_PROMPT.tiers.tier2.text)
  assert.equal(read.data.prompts.effective.tiers.tier1.label, BUILTIN_PROMPT.tiers.tier1.label)
  assert.equal(read.data.prompts.effective.delegation, BUILTIN_PROMPT.delegation)
  assert.deepEqual(read.data.prompts.overrides.tiers, { tier2: { label: '快办' } })
})

test('apply：resetPrompts 单键恢复内置，其余覆盖保留', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [
      {
        op: 'putPrompts',
        delegation: '临时编排',
        tiers: { tier1: { label: '探路' } },
      },
    ],
  })
  const reset = await handleApply(deps, { commands: [{ op: 'resetPrompts', keys: ['delegation'] }] })
  assert.equal(reset.ok, true)
  assert.equal(reset.data.prompts.effective.delegation, BUILTIN_PROMPT.delegation)
  assert.equal(reset.data.prompts.effective.tiers.tier1.label, '探路')
})

test('apply：resetPrompts 不传 keys 时全部恢复内置', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [
      {
        op: 'putPrompts',
        delegation: '临时编排',
        tiers: { tier1: { label: '探路', text: '只找位置' } },
      },
    ],
  })
  const reset = await handleApply(deps, { commands: [{ op: 'resetPrompts' }] })
  assert.equal(reset.ok, true)
  assert.deepEqual(reset.data.prompts.effective, {
    delegation: BUILTIN_PROMPT.delegation,
    tiers: BUILTIN_PROMPT.tiers,
  })
  assert.deepEqual(reset.data.prompts.overrides.tiers, {})
})

test('apply：提示词空串被拒，返回 bad-request 且不写文件', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const cases = [
    { commands: [{ op: 'putPrompts', delegation: '' }], match: /delegation 不能为空串/ },
    { commands: [{ op: 'putPrompts', delegation: '   ' }], match: /delegation 不能为空串/ },
    { commands: [{ op: 'putPrompts', tiers: { tier1: { text: '' } } }], match: /tier1\.text 不能为空串/ },
    { commands: [{ op: 'putPrompts', tiers: { tier1: { label: '  ' } } }], match: /tier1\.label 不能为空串/ },
  ]

  for (const entry of cases) {
    const result = await handleApply(deps, { commands: entry.commands })
    assert.equal(result.ok, false, JSON.stringify(entry.commands))
    assert.equal(result.error.code, 'bad-request')
    assert.match(result.error.message, entry.match)
  }
  assert.equal(existsSync(promptsPath({ home })), false)
})

test('apply：提示词命令的坏形状逐条拒绝', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const cases = [
    { commands: [{ op: 'putPrompts' }], match: /至少需要 delegation 或 tiers/ },
    { commands: [{ op: 'putPrompts', tiers: [] }], match: /tiers 必须是对象/ },
    { commands: [{ op: 'putPrompts', tiers: { tier9: { label: 'x' } } }], match: /不存在的档 id/ },
    { commands: [{ op: 'putPrompts', tiers: { tier1: 'x' } }], match: /必须是对象或 null/ },
    { commands: [{ op: 'putPrompts', tiers: { tier1: { label: 7 } } }], match: /必须是非空字符串或 null/ },
    { commands: [{ op: 'resetPrompts', keys: [] }], match: /不能为空数组/ },
    { commands: [{ op: 'resetPrompts', keys: ['nope'] }], match: /不是已知的键/ },
    { commands: [{ op: 'resetPrompts', keys: 'delegation' }], match: /必须是字符串数组/ },
    { commands: [{ op: 'resetPrompts', keys: [7] }], match: /必须是字符串/ },
  ]

  for (const entry of cases) {
    const result = await handleApply(deps, { commands: entry.commands })
    assert.equal(result.ok, false, JSON.stringify(entry.commands))
    assert.equal(result.error.code, 'bad-request')
    assert.match(result.error.message, entry.match)
  }
  assert.equal(existsSync(promptsPath({ home })), false)
})

test('apply：putPrompts 传 null 等于删键，恢复内置', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [{ op: 'putPrompts', delegation: '临时编排', tiers: { tier3: { label: '深改' } } }],
  })
  const cleared = await handleApply(deps, {
    commands: [{ op: 'putPrompts', delegation: null, tiers: { tier3: null } }],
  })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.data.prompts.effective.delegation, BUILTIN_PROMPT.delegation)
  assert.equal(cleared.data.prompts.effective.tiers.tier3.label, BUILTIN_PROMPT.tiers.tier3.label)
  assert.deepEqual(cleared.data.prompts.overrides.tiers, {})
})

/* ------------------------------------------------------------------ *
 * 异常一律 internal，不抛
 * ------------------------------------------------------------------ */

test('read：loadState 抛错转成 internal 信封，不抛', async () => {
  const home = await tempRoot()
  const { deps, warnings } = depsFor(home, {
    loadState: async () => {
      throw new Error('disk on fire')
    },
  })

  const result = await handleRead(deps, null)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /disk on fire/)
  assert.equal(warnings.length, 1)
})

test('apply：applyCommands 抛错转成 internal 信封，不写坏文件', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home, {
    applyCommands: async () => {
      throw new Error('locked')
    },
  })

  const result = await handleApply(deps, {
    commands: [{ op: 'putPack', packId: 'standard', pack: STANDARD }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /locked/)
})


/* ------------------------------------------------------------------ *
 * HTTP 面：恒 200
 * ------------------------------------------------------------------ */

test('wrapHandler：空体按 null 处理，状态码 200', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)
  const fetch = wrapHandler((body) => handleRead(deps, body))

  const response = await fetch(new Request('http://127.0.0.1/api/model-pack/read', { method: 'POST' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.resolved.id, DEFAULT_PACK_ID)
})

test('wrapHandler：非 JSON body 与处理器异常都返回 200 + 信封', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const badJson = wrapHandler((body) => handleRead(deps, body))
  const first = await badJson(new Request('http://127.0.0.1/x', { method: 'POST', body: 'not json' }))
  assert.equal(first.status, 200)
  assert.equal((await first.json()).ok, true)

  const throwing = wrapHandler(async () => {
    throw new Error('handler boom')
  })
  const second = await throwing(new Request('http://127.0.0.1/x', { method: 'POST' }))
  assert.equal(second.status, 200)
  const envelope = await second.json()
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'internal')
  assert.match(envelope.error.message, /handler boom/)
})

test('toResponse：错误信封同样是 200', () => {
  const response = toResponse({ ok: false, error: { code: 'bad-request', message: 'x' } })
  assert.equal(response.status, 200)
})

/* ------------------------------------------------------------------ *
 * 隔离
 * ------------------------------------------------------------------ */

test('隔离：整轮测试没有在真实 home 下创建 pack 文件', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)
  await handleRead(deps, null)
  await handleApply(deps, { commands: [{ op: 'putPack', packId: 'standard', pack: STANDARD }] })

  assert.equal(existsSync(realPacksFile), realPacksFileExisted)
  assert.equal(existsSync(workspacesPath({ home })), false)
})
