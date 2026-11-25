import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(diagnostics) {
  const handlers = new Map()
  const tools = new Map([['lsp_diagnostics', { execute: diagnostics }]])
  const ctx = {
    tools: { get: (name) => tools.get(name) },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    effect: (factory) => { factory() },
    logger: { warn: () => {} },
    get: () => { throw new Error('service not found') },
  }
  apply(ctx, {})
  return handlers
}

test('脏表按会话隔离：别的会话取不走', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-sess-'))
  const file = join(dir, 'a.ts')
  await writeFile(file, 'x\n')
  const asked = []
  const handlers = harness(async (args) => { asked.push(args.file_path); return { diagnostics: [] } })
  const a = { session: { header: { id: 'session-a', cwd: dir } } }
  const b = { session: { header: { id: 'session-b', cwd: dir } } }
  const post = handlers.get('tools/post-execute')
  await post({ name: 'write', arguments: { file_path: file }, agent: a }, { isError: false }, async () => ({ kind: 'accept' }))
  const pre = handlers.get('agent/pre-step')
  await pre({ agent: b, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.deepEqual(asked, [], '别的会话不该取走这条脏文件')
  await pre({ agent: a, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.equal(asked.length, 1, '只有标脏的那个会话取走')
})

test('观测候选按会话根分流：根外丢弃，根内并入', async () => {
  const asked = []
  const handlers = harness(async (args) => { asked.push(args.file_path); return { diagnostics: [] } })
  const observed = handlers.get('fs/observed')
  const pre = handlers.get('agent/pre-step')
  const agent = { session: { header: { id: 'root-test', cwd: 'C:/inside' } } }
  observed({ displayPath: 'C:/outside/a.ts' }, { kind: 'present', version: 'v1' })
  await pre({ agent, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.deepEqual(asked, [], '根外不该发起诊断')
  observed({ displayPath: 'C:/inside/b.ts' }, { kind: 'present', version: 'v1' })
  await pre({ agent, turn: 1, step: 2 }, async () => ({ kind: 'accept', messages: [] }))
  await sleep(20)
  assert.deepEqual(asked, ['C:/inside/b.ts'])
})
