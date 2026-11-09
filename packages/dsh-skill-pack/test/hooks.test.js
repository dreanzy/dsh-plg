import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'
import { normalizeCwd } from '../lib/policy.js'

/** 造一个宿主 ctx 的最小替身，能手动 emit 事件。 */
function fakeCtx() {
  const listeners = new Map()
  const warnings = []
  const ctx = {
    warnings,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(callback) {
      return callback()
    },
    get() {
      return undefined
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    async emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        await listener(payload)
      }
    },
    /** 同步派发，模拟宿主在 register 内部同步发 skills/change。 */
    emitSync(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        void listener(payload)
      }
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
  return ctx
}

function fakeSkills(rows, options = {}) {
  const registered = []
  const state = { complete: options.complete ?? true }
  const skills = {
    registered,
    state,
    async snapshot() {
      return { skills: rows, complete: state.complete }
    },
    async get(name) {
      return { content: `body of ${name}` }
    },
    register(skill) {
      registered.push(skill)
      // 宿主 register 会同步触发 skills/change：这正是自反馈环的闭合点。
      for (const listener of skills.changeListeners ?? []) void listener({})
      return () => {
        const index = registered.indexOf(skill)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    changeListeners: [],
  }
  return skills
}

function emptyPack(name = '默认') {
  return { name, items: {}, groups: {} }
}

/**
 * 建一套 `$DSH_HOME/packs/skill/` 三件套。
 *
 * 旧用例写的是 `skill-manager/global.json` + `<cwd>/.dsh/skill-manager.json`；
 * 本文件按新落盘位置重写，`bind` 简写用来把当前 cwd 绑到某个 pack。
 */
async function makeWorkspace(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsk-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsk-ws-'))
  process.env['DSH_HOME'] = home
  const stateDir = join(home, 'packs', 'skill')
  await mkdir(stateDir, { recursive: true })

  const packs = options.packs ?? { default: emptyPack() }
  await writeFile(
    join(stateDir, 'packs.json'),
    `${JSON.stringify(
      {
        version: 1,
        ui: {
          showOfficialSkills: false,
          showChip: true,
          defaultTab: 'groups',
          ...(options.ui ?? {}),
        },
        packs,
      },
      null,
      2,
    )}\n`,
  )
  if (options.groups !== undefined) {
    await writeFile(join(stateDir, 'groups.json'), `${JSON.stringify(options.groups, null, 2)}\n`)
  }
  const bindings = { ...(options.bindings ?? {}) }
  if (options.bind !== undefined) bindings[normalizeCwd(cwd)] = options.bind
  await writeFile(
    join(stateDir, 'workspaces.json'),
    `${JSON.stringify({ version: 1, bindings, extra: [] }, null, 2)}\n`,
  )
  return { home, cwd, stateDir }
}

function agentFor(cwd, skills, id = 'agent-1') {
  return {
    id,
    ctx: { get: (name) => (name === 'skills' ? skills : undefined) },
    session: { id: 'session-' + id, header: { cwd } },
  }
}

const rows = [
  { name: 'alpha', description: 'a', provider: 'filesystem', source: 'custom', path: '/x/alpha/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'beta', description: 'b', provider: 'filesystem', source: 'custom', path: '/x/beta/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
]

test('default pack 项级关掉的 skill 会被注册遮蔽副本（原「全局项级」用例）', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 1)
  assert.equal(skills.registered[0].name, 'alpha')
  assert.equal(skills.registered[0].invocation.modelInvocable, false)
  assert.equal(skills.registered[0].invocation.userInvocable, false)
  assert.equal(skills.registered[0].content, '')
})

test('绑定 pack 的组级关掉会遮蔽组内成员（原「工作区组级」用例）', async () => {
  const { cwd } = await makeWorkspace({
    packs: {
      default: emptyPack(),
      p1: { name: '一组', items: {}, groups: { g1: false } },
    },
    groups: { groups: [{ id: 'g1', name: '一组' }], assignments: { beta: 'g1' } },
    bind: 'p1',
  })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.deepEqual(
    skills.registered.map((skill) => skill.name),
    ['beta'],
  )
})

test('绑定只影响自己的工作区，别的 cwd 仍按 default 求值', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsk-home-'))
  const boundCwd = await mkdtemp(join(tmpdir(), 'dsk-ws-a-'))
  const freeCwd = await mkdtemp(join(tmpdir(), 'dsk-ws-b-'))
  process.env['DSH_HOME'] = home
  const stateDir = join(home, 'packs', 'skill')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, 'packs.json'),
    `${JSON.stringify({
      version: 1,
      ui: {},
      packs: {
        default: emptyPack(),
        p1: { name: '一组', items: { beta: false }, groups: {} },
      },
    })}\n`,
  )
  await writeFile(
    join(stateDir, 'workspaces.json'),
    `${JSON.stringify({ version: 1, bindings: { [normalizeCwd(boundCwd)]: 'p1' }, extra: [] })}\n`,
  )

  const boundSkills = fakeSkills(rows)
  const freeSkills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(boundCwd, boundSkills, 'agent-a') })
  await ctx.emit('agent/created', { agent: agentFor(freeCwd, freeSkills, 'agent-b') })

  assert.deepEqual(boundSkills.registered.map((skill) => skill.name), ['beta'])
  assert.equal(freeSkills.registered.length, 0)
})

test('清单不完整时不动任何遮蔽', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows, { complete: false })
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 0)
  assert.equal(
    ctx.warnings.some((line) => line.includes('清单不完整')),
    true,
  )
})

test('落地期间由 register 同步发出的 skills/change 不会重入', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false, beta: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)
  // 把宿主会同步派发的 skills/change 接到 ctx 的监听器上。
  skills.changeListeners = [(payload) => ctx.emitSync('skills/change', payload)]

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 2)
})

test('dev 会话建立后保存策略，reapply 让新决定生效', async () => {
  const { cwd, stateDir } = await makeWorkspace({ packs: { default: emptyPack() } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  const hooks = installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })
  assert.equal(skills.registered.length, 0)

  await writeFile(
    join(stateDir, 'packs.json'),
    `${JSON.stringify({ version: 1, ui: {}, packs: { default: { name: 'default', items: { beta: false }, groups: {} } } }, null, 2)}\n`,
  )
  await hooks.reapply()
  assert.deepEqual(
    skills.registered.map((skill) => skill.name),
    ['beta'],
  )

  await writeFile(
    join(stateDir, 'packs.json'),
    `${JSON.stringify({ version: 1, ui: {}, packs: { default: emptyPack() } }, null, 2)}\n`,
  )
  await hooks.reapply()
  assert.equal(skills.registered.length, 0)
})

test('多个会话的重新落地并发执行', async () => {
  const { cwd } = await makeWorkspace({ packs: { default: emptyPack() } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  const value = {
    rows,
    complete: true,
    hidden: [],
    policy: {
      packs: { packs: { default: emptyPack() } },
      ui: { showOfficialSkills: false, showChip: true, defaultTab: 'groups' },
      binding: null,
      packId: 'default',
      pack: null,
      groups: { groups: [], assignments: {} },
      bindings: { bindings: {}, extra: [] },
      warnings: [],
    },
    warnings: [],
  }
  let active = 0
  let peak = 0
  const snapshot = {
    async refresh() {
      active += 1
      peak = Math.max(peak, active)
      // 让出事件循环：串行实现下峰值只能是 1。
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return value
    },
    invalidate() {},
  }
  const hooks = installHooks(ctx, { snapshot })
  await ctx.emit('agent/created', { agent: agentFor(cwd, skills, 'agent-1') })
  await ctx.emit('agent/created', { agent: agentFor(cwd, skills, 'agent-2') })

  peak = 0
  await hooks.reapply()
  assert.equal(peak, 2)
  assert.equal(skills.registered.length, 0)
})

test('同名项在别的插件先注册时报告关不掉', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  // 复验时 alpha 依旧 modelInvocable：模拟同层 first-wins 落败。
  skills.snapshot = async () => ({ skills: rows, complete: true })
  const ctx = fakeCtx()
  const hooks = installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.deepEqual(hooks.stuck(), ['alpha'])
})

test('遮蔽副本不读正文：skills.get 一次都不调', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  let reads = 0
  skills.get = async () => {
    reads += 1
    throw new Error('遮蔽不该读正文')
  }
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(reads, 0)
  assert.equal(skills.registered.length, 1)
  assert.equal(skills.registered[0].content, '')
})

test('只落了 modelInvocable 也算关不掉', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  // 复验时 alpha 只丢了 modelInvocable：模拟同层把 userInvocable 抢了回去。
  skills.snapshot = async () => ({
    skills: [{ ...rows[0], invocation: { modelInvocable: false, userInvocable: true } }, rows[1]],
    complete: true,
  })
  const ctx = fakeCtx()
  const hooks = installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.deepEqual(hooks.stuck(), ['alpha'])
})

test('官方 skill 与自定义 skill 走同一条遮蔽规则', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { 'cordis-x': false }, groups: {} } },
  })
  const official = {
    name: 'cordis-x',
    description: 'c',
    provider: 'filesystem',
    source: 'custom',
    path: '/p/node_modules/@deepseek-ai/pkg/skills/cordis-x/SKILL.md',
    invocation: { modelInvocable: true, userInvocable: true },
  }
  const skills = fakeSkills([...rows, official])
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 1)
  assert.equal(skills.registered[0].name, 'cordis-x')
  assert.deepEqual(skills.registered[0].invocation, { modelInvocable: false, userInvocable: false })
})

test('agent/disposed 释放遮蔽副本并摘掉状态', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  const agent = agentFor(cwd, skills)
  await ctx.emit('agent/created', { agent })
  assert.equal(skills.registered.length, 1)

  ctx.emitSync('agent/disposed', { agent })
  assert.equal(skills.registered.length, 0)
})

test('落地期间到达的清单变化会在结束后补跑一次', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false, gamma: false }, groups: {} } },
  })
  const gamma = {
    name: 'gamma',
    description: 'g',
    provider: 'filesystem',
    source: 'custom',
    path: '/x/gamma/SKILL.md',
    invocation: { modelInvocable: true, userInvocable: true },
  }
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)
  // 注册遮蔽的那一刻，模拟另一个进程装了一个已被告知要关掉的新 skill。
  const register = skills.register
  skills.register = (skill) => {
    const dispose = register.call(skills, skill)
    if (skill.name === 'alpha') {
      skills.snapshot = async () => ({ skills: [...rows, gamma], complete: true })
      ctx.emitSync('skills/change', {})
    }
    return dispose
  }

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })
  // 补跑是异步发起的。
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(
    skills.registered.map((skill) => skill.name).sort(),
    ['alpha', 'gamma'],
  )
})

test('同一 agent id 再次 created 会先释放旧遮蔽', async () => {
  const { cwd } = await makeWorkspace({
    packs: { default: { name: 'default', items: { alpha: false }, groups: {} } },
  })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)
  const agent = agentFor(cwd, skills)

  await ctx.emit('agent/created', { agent })
  assert.equal(skills.registered.length, 1)
  await ctx.emit('agent/created', { agent })
  assert.equal(skills.registered.length, 1)
})

test('agent/disposed 打掉该目录的求值缓存', async () => {
  const { cwd } = await makeWorkspace({ packs: { default: emptyPack() } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  const invalidated = []
  const value = { rows, complete: true, hidden: [], policy: {}, warnings: [] }
  const snapshot = {
    async refresh() {
      return value
    },
    invalidate(target) {
      invalidated.push(target)
    },
  }
  installHooks(ctx, { snapshot })
  const agent = agentFor(cwd, skills)

  await ctx.emit('agent/created', { agent })
  ctx.emitSync('agent/disposed', { agent })
  assert.deepEqual(invalidated, [cwd])
})
