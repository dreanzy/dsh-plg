import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 会话根必须覆盖临时目录：发起诊断前会按根过滤，根缺失的条目一律丢弃。
const agent = { session: { header: { id: 'plugin-test', cwd: tmpdir() } } }

function harness(options) {
  const handlers = new Map()
  const tools = new Map()
  if (options.diagnostics !== undefined) tools.set('lsp_diagnostics', { execute: options.diagnostics })
  const ctx = {
    tools: { get: (name) => tools.get(name) },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    effect: (factory) => { factory() },
    logger: { warn: () => {} },
    get: () => { throw new Error('service not found') },
  }
  apply(ctx, options.config)
  return { handlers }
}

async function runPost(handlers, exec, result) {
  const handler = handlers.get('tools/post-execute')
  let nextCalled = 0
  const decision = await handler(exec, result, async () => { nextCalled += 1; return { kind: 'accept', content: [{ type: 'text', text: 'original' }] } })
  return { decision, nextCalled }
}

test('写入类工具只登记，不阻塞返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-'))
  const file = join(dir, 'a.ts')
  await writeFile(file, 'const a = 1\n')
  const { handlers } = harness({ diagnostics: async () => ({ diagnostics: [{ severity: 1, message: 'unused' }] }) })
  const { decision, nextCalled } = await runPost(handlers, { name: 'write', arguments: { file_path: file }, agent }, { isError: false, content: [{ type: 'text', text: 'original' }] })
  assert.equal(nextCalled, 1)
  assert.equal(decision.content.length, 1)
  assert.equal(decision.content[0].text, 'original')
})

test('非写入工具不改结果', async () => {
  const { handlers } = harness({ diagnostics: async () => ({ diagnostics: [{ severity: 1, message: 'x' }] }) })
  const { decision } = await runPost(handlers, { name: 'read', arguments: { file_path: 'a.ts' }, agent }, { isError: false })
  assert.equal(decision.content.length, 1)
})

test('同一版本在 pre-step 只诊断一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-'))
  const file = join(dir, 'c.ts')
  await writeFile(file, 'x\n')
  let calls = 0
  const { handlers } = harness({ diagnostics: async () => { calls += 1; return { diagnostics: [] } } })
  await runPost(handlers, { name: 'write', arguments: { file_path: file }, agent }, { isError: false })
  await runPost(handlers, { name: 'write', arguments: { file_path: file }, agent }, { isError: false })
  const pre = handlers.get('agent/pre-step')
  await pre({ agent, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.equal(calls, 1)
  await pre({ agent, turn: 1, step: 2 }, async () => ({ kind: 'accept', messages: [] }))
  await pre({ agent, turn: 1, step: 3 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.equal(calls, 1, '落定过的版本不再发起诊断')
})

test('不受支持的扩展名不触发诊断', async () => {
  const { handlers } = harness({ diagnostics: async () => { throw new Error('must not run') } })
  const { decision } = await runPost(handlers, { name: 'write', arguments: { file_path: 'notes.md' }, agent }, { isError: false })
  assert.equal(decision.content.length, 1)
})

test('错误结果不登记', async () => {
  const { handlers } = harness({ diagnostics: async () => { throw new Error('must not run') } })
  const { decision } = await runPost(handlers, { name: 'write', arguments: { file_path: 'a.ts' }, agent }, { isError: true })
  assert.equal(decision.content.length, 1)
})
