import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, groupOf, sessionKeyOf, shellCwd } from '../lib/index.js'

const agent = { session: { header: { id: 'prestep-test', cwd: '/repo' } } }

function harness(options = {}) {
  const handlers = new Map()
  const tools = new Map()
  if (options.diagnostics !== undefined) tools.set('lsp_diagnostics', { execute: options.diagnostics })
  const ctx = {
    tools: { get: (name) => tools.get(name) },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    effect: (factory) => { factory() },
    logger: { warn: () => {} },
    get: (name) => { if (name === 'jobs' && options.jobs !== undefined) return options.jobs; throw new Error('service not found') },
    subprocess: options.subprocess,
  }
  apply(ctx, options.config)
  return { handlers }
}

test('shellCwd 依次取 workdir、返回 cwd、会话目录、工作区根', () => {
  assert.equal(shellCwd({ arguments: { workdir: '/a' } }, undefined), '/a')
  assert.equal(shellCwd({ arguments: {} }, { cwd: '/b' }), '/b')
  assert.equal(shellCwd({ agent: { session: { header: { cwd: '/s' } } } }, undefined), '/s')
  assert.equal(shellCwd({ workspace: { root: '/c' } }, undefined), '/c')
  assert.equal(shellCwd(undefined, undefined), null)
})

test('sessionKeyOf 优先会话 id，缺失退回会话目录，都没有就 null', () => {
  assert.equal(sessionKeyOf({ session: { header: { id: 'sid', cwd: '/w' } } }), 'sid')
  assert.equal(sessionKeyOf({ session: { header: { cwd: '/w' } } }), '/w')
  assert.equal(sessionKeyOf(undefined), null)
})

test('groupOf 按扩展名分组', () => {
  assert.equal(groupOf('a.TS'), '.ts')
  assert.equal(groupOf('noext'), '')
})

test('pre-step 在没有消息工厂时不抛，原样返回决策', async () => {
  const { handlers } = harness({ diagnostics: async () => ({ diagnostics: [{ severity: 1, message: 'x' }] }) })
  const handler = handlers.get('agent/pre-step')
  const decision = await handler({ agent, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.messages, [])
})

test('git 差分把受支持文件登记为脏并发起诊断', async () => {
  let statusRuns = 0
  const subprocess = {
    spawn: (request) => {
      const isRevParse = request.argv.includes('rev-parse')
      if (!isRevParse) statusRuns += 1
      const text = isRevParse ? '/repo' : ' M src/a.ts\0'
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text }) } } }
    },
  }
  const { handlers } = harness({
    subprocess,
    diagnostics: async () => ({ diagnostics: [] }),
    jobs: undefined,
  })
  const post = handlers.get('tools/post-execute')
  const shell = await post({ name: 'bash', arguments: { workdir: '/repo' }, agent }, { isError: false, value: { kind: 'foreground' } }, async () => ({ kind: 'accept' }))
  assert.equal(shell.kind, 'accept')
  const pre = handlers.get('agent/pre-step')
  await pre({ agent, turn: 2, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(statusRuns, 1)
})
