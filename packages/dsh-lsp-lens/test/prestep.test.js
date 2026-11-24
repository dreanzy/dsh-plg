import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, shellCwd } from '../lib/index.js'

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

test('pre-step 在没有消息工厂时不抛，原样返回决策', async () => {
  const { handlers } = harness({ diagnostics: async () => ({ diagnostics: [{ severity: 1, message: 'x' }] }) })
  const handler = handlers.get('agent/pre-step')
  const decision = await handler({ agent: {}, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.messages, [])
})

test('git 差分把受支持文件登记为脏并尝试诊断', async () => {
  let spawned = 0
  const subprocess = {
    spawn: () => {
      spawned += 1
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: ' M src/a.ts\0' }) } } }
    },
  }
  const { handlers } = harness({
    subprocess,
    diagnostics: async () => ({ diagnostics: [] }),
    jobs: undefined,
  })
  const post = handlers.get('tools/post-execute')
  const shell = await post({ name: 'bash', arguments: { workdir: '/repo' } }, { isError: false, value: { kind: 'foreground' } }, async () => ({ kind: 'accept' }))
  assert.equal(shell.kind, 'accept')
  const pre = handlers.get('agent/pre-step')
  await pre({ agent: {}, turn: 2, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(spawned, 1)
})
