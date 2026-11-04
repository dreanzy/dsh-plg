import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../lib/hooks.js'

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

async function makeWorkspace({ global: globalPolicy, workspace, groups } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsm-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsm-ws-'))
  process.env['DSH_HOME'] = home
  await mkdir(join(home, 'skill-manager'), { recursive: true })
  await writeFile(join(home, 'skill-manager', 'global.json'), `${JSON.stringify(globalPolicy ?? {}, null, 2)}\n`)
  if (groups !== undefined) {
    await writeFile(join(home, 'skill-manager', 'groups.json'), `${JSON.stringify(groups, null, 2)}\n`)
  }
  if (workspace !== undefined) {
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(join(cwd, '.dsh', 'skill-manager.json'), `${JSON.stringify(workspace, null, 2)}\n`)
  }
  return { home, cwd }
}

function agentFor(cwd, skills) {
  return {
    id: 'agent-1',
    ctx: { get: (name) => (name === 'skills' ? skills : undefined) },
    session: { id: 'session-1', header: { cwd } },
  }
}

const rows = [
  { name: 'alpha', description: 'a', provider: 'filesystem', source: 'custom', path: '/x/alpha/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'beta', description: 'b', provider: 'filesystem', source: 'custom', path: '/x/beta/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
]

test('全局项级关掉的 skill 会被注册遮蔽副本', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { alpha: false } } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 1)
  assert.equal(skills.registered[0].name, 'alpha')
  assert.equal(skills.registered[0].invocation.modelInvocable, false)
  assert.equal(skills.registered[0].invocation.userInvocable, true)
  assert.equal(skills.registered[0].content, 'body of alpha')
})

test('工作区组级关掉会遮蔽组内成员', async () => {
  const { cwd } = await makeWorkspace({
    groups: { groups: [{ id: 'g1', name: '一组' }], assignments: { beta: 'g1' } },
    workspace: { groups: { g1: false } },
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

test('清单不完整时不动任何遮蔽', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { alpha: false } } })
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
  const { cwd } = await makeWorkspace({ global: { items: { alpha: false, beta: false } } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)
  // 把宿主会同步派发的 skills/change 接到 ctx 的监听器上。
  skills.changeListeners = [(payload) => ctx.emitSync('skills/change', payload)]

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.equal(skills.registered.length, 2)
})

test('dev 会话建立后保存策略，reapply 让新决定生效', async () => {
  const { cwd } = await makeWorkspace({ global: {} })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  const hooks = installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })
  assert.equal(skills.registered.length, 0)

  await writeFile(
    join(process.env['DSH_HOME'], 'skill-manager', 'global.json'),
    `${JSON.stringify({ items: { beta: false } }, null, 2)}\n`,
  )
  await hooks.reapply()
  assert.deepEqual(
    skills.registered.map((skill) => skill.name),
    ['beta'],
  )

  await writeFile(
    join(process.env['DSH_HOME'], 'skill-manager', 'global.json'),
    `${JSON.stringify({ items: {} }, null, 2)}\n`,
  )
  await hooks.reapply()
  assert.equal(skills.registered.length, 0)
})

test('同名项在别的插件先注册时报告关不掉', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { alpha: false } } })
  const skills = fakeSkills(rows)
  // 复验时 alpha 依旧 modelInvocable：模拟同层 first-wins 落败。
  skills.snapshot = async () => ({ skills: rows, complete: true })
  const ctx = fakeCtx()
  const hooks = installHooks(ctx)

  await ctx.emit('agent/created', { agent: agentFor(cwd, skills) })

  assert.deepEqual(hooks.stuck(), ['alpha'])
})

test('agent/disposed 释放遮蔽副本并摘掉状态', async () => {
  const { cwd } = await makeWorkspace({ global: { items: { alpha: false } } })
  const skills = fakeSkills(rows)
  const ctx = fakeCtx()
  installHooks(ctx)

  const agent = agentFor(cwd, skills)
  await ctx.emit('agent/created', { agent })
  assert.equal(skills.registered.length, 1)

  ctx.emitSync('agent/disposed', { agent })
  assert.equal(skills.registered.length, 0)
})
