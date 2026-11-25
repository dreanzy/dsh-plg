import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const agent = { session: { header: { id: 'budget-test', cwd: tmpdir() } } }

function harness(config, diagnostics) {
  const handlers = new Map()
  const tools = new Map([['lsp_diagnostics', { execute: diagnostics }]])
  const ctx = {
    tools: { get: (name) => tools.get(name) },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    effect: (factory) => { factory() },
    logger: { warn: () => {} },
    get: () => { throw new Error('service not found') },
  }
  apply(ctx, config)
  return handlers
}

async function markFiles(handlers, files) {
  const post = handlers.get('tools/post-execute')
  for (const file of files) {
    await post({ name: 'write', arguments: { file_path: file }, agent }, { isError: false }, async () => ({ kind: 'accept' }))
  }
}

test('同扩展名一次飞一个，跨步推进且不阻塞 pre-step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-budget-'))
  const files = []
  for (const name of ['a', 'b', 'c']) {
    const file = join(dir, name + '.ts')
    await writeFile(file, 'x\n')
    files.push(file)
  }
  let calls = 0
  const handlers = harness({ maxFilesPerStep: 3 }, async () => {
    calls += 1
    await sleep(30)
    return { diagnostics: [] }
  })
  await markFiles(handlers, files)
  const pre = handlers.get('agent/pre-step')
  await pre({ agent, turn: 1, step: 1 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(calls, 1, '同扩展名只飞一个，其余留在脏表')
  await sleep(60)
  await pre({ agent, turn: 1, step: 2 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(calls, 2, '第二步结算并推进下一个')
  await sleep(60)
  await pre({ agent, turn: 1, step: 3 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(calls, 3, '最后一份也会被处理')
})
