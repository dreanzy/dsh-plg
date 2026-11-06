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
  handleReset,
  handleSupport,
  toResponse,
  wrapHandler,
} from '../lib/routes.js'
import {
  applyCommands,
  globalPromptsPath,
  globalSchemePath,
  loadState,
  resolve,
  workspaceSchemePath,
} from '../lib/policy.js'
import { BUILTIN_PROMPT, resolvePrompt } from '../lib/prompt.js'
import { BUILTIN_SCHEME_ID } from '../lib/scheme.js'

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
const realSchemeFile = join(homedir(), '.dsh', 'model-scheme', 'schemes.json')
const realSchemeFileExisted = existsSync(realSchemeFile)

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

async function tempRoot(prefix = 'model-scheme-routes-') {
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

test('路径：四条路由都在 /api/model-scheme/ 前缀下', () => {
  assert.deepEqual(ROUTES, {
    read: '/api/model-scheme/read',
    apply: '/api/model-scheme/apply',
    support: '/api/model-scheme/support',
    reset: '/api/model-scheme/reset',
  })
})

test('reset：缺 sessionId 返回 bad-request，不调用宿主', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)
  const result = await handleReset(deps, null)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
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

test('read：无文件时返回出厂方案，空 body 合法', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleRead(deps, null)
  assert.equal(result.ok, true)
  assert.equal(result.data.resolved.id, BUILTIN_SCHEME_ID)
  assert.equal(result.data.resolved.source, 'builtin')
  assert.deepEqual(result.data.state.global.schemes, {})
  assert.deepEqual(result.data.state.workspace, {})
  assert.deepEqual(result.data.support, { subagents: true, restrict: true })
  assert.equal(result.data.lastError, null)

  // 空对象 body 与 null 等价（都只看全局层）。
  const emptyBody = await handleRead(deps, {})
  assert.equal(emptyBody.ok, true)
  assert.deepEqual(emptyBody.data.state.workspace, {})
})

test('read：cwd 缺省与空白串都只看全局层', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const blank = await handleRead(deps, { cwd: '   ' })
  assert.equal(blank.ok, true)
  assert.deepEqual(blank.data.state.workspace, {})
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

test('apply：写入方案后 read 能读回', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  const written = await handleApply(deps, {
    cwd,
    commands: [
      { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
      { op: 'setDefaultScheme', schemeId: 'standard' },
      { op: 'bindWorkspace', schemeId: 'standard' },
    ],
  })
  assert.equal(written.ok, true)
  assert.equal(written.data.resolved.id, 'standard')
  assert.equal(written.data.resolved.source, 'workspace')
  assert.deepEqual(written.data.state.global.schemes.standard, STANDARD)

  // 落盘了才算数：read 重新读文件。
  const read = await handleRead(deps, { cwd })
  assert.equal(read.ok, true)
  assert.equal(read.data.resolved.id, 'standard')
  assert.equal(read.data.resolved.source, 'workspace')
  assert.equal(read.data.resolved.brokenBinding, false)
  assert.deepEqual(read.data.state.workspace, { schemeId: 'standard' })
  assert.deepEqual(read.data.state.global.schemes.standard, STANDARD)
})

test('apply：解绑后 read 回落全局默认', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    cwd,
    commands: [
      { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
      { op: 'setDefaultScheme', schemeId: 'standard' },
      { op: 'bindWorkspace', schemeId: 'standard' },
    ],
  })
  const unbound = await handleApply(deps, { cwd, commands: [{ op: 'bindWorkspace', schemeId: null }] })
  assert.equal(unbound.ok, true)
  assert.equal(unbound.data.resolved.source, 'global')
  assert.deepEqual(unbound.data.state.workspace, {})
})

/* ------------------------------------------------------------------ *
 * missing-cwd / bad-request：拒绝整批，不部分写入
 * ------------------------------------------------------------------ */

test('apply：缺 cwd 的工作区命令返回 missing-cwd，且不写任何文件', async () => {
  const home = await tempRoot()
  const cwd = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleApply(deps, {
    commands: [
      { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
      { op: 'bindWorkspace', schemeId: 'standard' },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'missing-cwd')
  assert.match(result.error.message, /cwd/)

  // 整批拒绝：全局方案也没有落盘。
  assert.equal(existsSync(globalSchemePath({ home })), false)
  assert.equal(existsSync(workspaceSchemePath(cwd)), false)
})

test('apply：未知命令返回 bad-request 并指出第几条，不写入', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleApply(deps, {
    commands: [
      { op: 'putScheme', schemeId: 'standard', scheme: STANDARD },
      { op: 'launchMissiles', schemeId: 'standard' },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.match(result.error.message, /commands\[1\]/)

  // 第一条合法但整批拒绝：不做部分写入。
  assert.equal(existsSync(globalSchemePath({ home })), false)
})

test('apply：拦截整批时连合法项也没生效', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  await handleApply(deps, {
    commands: [
      { op: 'setDefaultScheme', schemeId: 'standard' },
      { op: 'deleteScheme', schemeId: 7 },
    ],
  })
  const read = await handleRead(deps, null)
  assert.equal(read.ok, true)
  assert.equal(read.data.state.global.defaultSchemeId, undefined)
})

test('apply：坏形状逐条指出下标', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const cases = [
    { commands: [{ op: 'putScheme', schemeId: 'standard' }], match: /commands\[0\]\.scheme/ },
    { commands: [{ op: 'putScheme', schemeId: '', scheme: STANDARD }], match: /commands\[0\]\.schemeId/ },
    { commands: [{ op: 'deleteScheme' }], match: /commands\[0\]\.schemeId/ },
    { commands: [{ op: 'bindWorkspace', schemeId: 1 }], match: /commands\[0\]\.schemeId/ },
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
  assert.equal(existsSync(globalSchemePath({ home })), false)
})

test('apply：坏配置走 warning 而不是错误信封', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)

  const result = await handleApply(deps, {
    commands: [{ op: 'deleteScheme', schemeId: BUILTIN_SCHEME_ID }],
  })
  // 形状合法、语义被 policy 拒绝：路由不把它当错误，面板靠 warnings 显示。
  assert.equal(result.ok, true)
  assert.ok(result.data.state.warnings.some((warning) => warning.includes('不可删除')))
  assert.equal(result.data.state.global.schemes[BUILTIN_SCHEME_ID], undefined)
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

  // 落盘在提示词文件，不是方案文件。
  assert.equal(existsSync(globalPromptsPath({ home })), true)
  assert.equal(existsSync(globalSchemePath({ home })), false)
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
  assert.equal(existsSync(globalPromptsPath({ home })), false)
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
  assert.equal(existsSync(globalPromptsPath({ home })), false)
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
    commands: [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /locked/)
})

test('support：探测结果与 lastError 原样透传', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home, {
    support: () => ({ subagents: false, restrict: true, reason: 'subagents 服务未注册' }),
    lastError: () => '注册 subagent_tier 失败',
  })

  const result = await handleSupport(deps, null)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.support, {
    subagents: false,
    restrict: true,
    reason: 'subagents 服务未注册',
  })
  assert.equal(result.data.lastError, '注册 subagent_tier 失败')
})

test('support：探测抛错也返回 internal 信封', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home, {
    support: () => {
      throw new Error('probe failed')
    },
  })

  const result = await handleSupport(deps, null)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
})

/* ------------------------------------------------------------------ *
 * HTTP 面：恒 200
 * ------------------------------------------------------------------ */

test('wrapHandler：空体按 null 处理，状态码 200', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)
  const fetch = wrapHandler((body) => handleRead(deps, body))

  const response = await fetch(new Request('http://127.0.0.1/api/model-scheme/read', { method: 'POST' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.resolved.id, BUILTIN_SCHEME_ID)
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

test('隔离：整轮测试没有在真实 home 下创建方案文件', async () => {
  const home = await tempRoot()
  const { deps } = depsFor(home)
  await handleRead(deps, null)
  await handleApply(deps, { commands: [{ op: 'putScheme', schemeId: 'standard', scheme: STANDARD }] })

  assert.equal(existsSync(realSchemeFile), realSchemeFileExisted)
})
