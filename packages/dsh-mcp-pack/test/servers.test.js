import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_OWNED,
  parseOwned,
  parseServerDef,
  readOwned,
  removeServer,
  serializeOwned,
  updateOwned,
  upsertServer,
} from '../lib/servers.js'

test('stdio 与 http 定义都能解析', () => {
  const stdio = parseServerDef({ transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } })
  assert.equal(stdio.command, 'npx')
  assert.deepEqual(stdio.args, ['-y', 'x'])
  assert.deepEqual(stdio.env, { A: '1' })
  const http = parseServerDef({ transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' })
  assert.equal(http.transport, 'streamable-http')
})

test('定义不完整时返回 null', () => {
  assert.equal(parseServerDef({ transport: 'stdio' }), null)
  assert.equal(parseServerDef({ transport: 'streamable-http', url: 'not a url' }), null)
  assert.equal(parseServerDef({ transport: 'grpc' }), null)
  assert.equal(parseServerDef(null), null)
})

test('名字不合规的条目被跳过并给 warning', () => {
  const parsed = parseOwned(JSON.stringify({ version: 1, servers: { 'bad name!': { transport: 'stdio', command: 'x' } } }))
  assert.deepEqual(Object.keys(parsed.value.servers), [])
  assert.equal(parsed.warnings.length, 1)
})

test('坏 JSON 与未知版本都降级为空', () => {
  assert.deepEqual(parseOwned('{oops').value.servers, {})
  assert.deepEqual(parseOwned(JSON.stringify({ version: 9, servers: {} })).value.servers, {})
})

test('序列化后能再解析回来，且名字有序', () => {
  const owned = { version: 1, servers: {
    b: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' },
    a: { transport: 'streamable-http', url: 'http://x/y', headers: {} },
  } }
  const text = serializeOwned(owned)
  assert.deepEqual(Object.keys(parseOwned(text).value.servers), ['a', 'b'])
  assert.equal(serializeOwned(parseOwned(text).value), text)
})

test('upsert 与 remove 幂等', () => {
  const def = { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' }
  const one = upsertServer(EMPTY_OWNED, 'x', def)
  assert.deepEqual(Object.keys(one.servers), ['x'])
  assert.deepEqual(removeServer(one, 'x').servers, {})
  assert.deepEqual(removeServer(EMPTY_OWNED, 'nope').servers, {})
  assert.throws(() => upsertServer(EMPTY_OWNED, 'bad name', def), /不合法/u)
})

test('updateOwned 写盘后可读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-servers-'))
  try {
    const def = { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp', headers: {} }
    const written = await updateOwned(dir, (current) => upsertServer(current, 'unity', def))
    assert.deepEqual(Object.keys(written.servers), ['unity'])
    const reread = await readOwned(dir)
    assert.equal(reread.value.servers['unity'].transport, 'streamable-http')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
