import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryServerName, isMcpEntry, isSuppressed, release, suppress } from '../lib/suppress.js'

/** 有一层原型 getter 的 entry 替身：与宿主的 Entry 同形。 */
class Entry {
  constructor(options, fiber = null) {
    this.options = options
    this.fiber = fiber
  }
  get disabled() {
    return Boolean(this.options.disabled)
  }
}

const mcp = (serverName, extra = {}) => ({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName }, ...extra })

test('识别 MCP 行与 serverName', () => {
  assert.equal(isMcpEntry(new Entry(mcp('joplin'))), true)
  assert.equal(entryServerName(new Entry(mcp('joplin'))), 'joplin')
  assert.equal(isMcpEntry(new Entry({ name: 'other' })), false)
  assert.equal(entryServerName(new Entry({ name: 'other' })), null)
  assert.equal(entryServerName(new Entry({ name: '@deepseek-ai/dsh-mcp-client', config: {} })), null)
})

test('suppress 遮蔽原型 getter 并处置 fiber', () => {
  let disposed = 0
  const entry = new Entry(mcp('a'), { dispose: () => { disposed += 1 } })
  assert.equal(entry.disabled, false)
  assert.equal(suppress(entry), true)
  assert.equal(entry.disabled, true)
  assert.equal(isSuppressed(entry), true)
  assert.equal(disposed, 1)
})

test('重复 suppress 是幂等的', () => {
  const entry = new Entry(mcp('a'), { dispose: () => {} })
  suppress(entry)
  assert.equal(suppress(entry), false)
})

test('release 撤掉遮蔽并调 update，不写 disabled: true', async () => {
  const calls = []
  const entry = new Entry(mcp('a'))
  entry.update = async (options, create, force) => { calls.push({ options, create, force }) }
  suppress(entry)
  assert.equal(entry.disabled, true)
  await release(entry)
  assert.equal(entry.disabled, false)
  assert.equal(isSuppressed(entry), false)
  assert.deepEqual(calls, [{ options: { disabled: false }, create: false, force: true }])
})

test('没被遮蔽时 release 什么都不做', async () => {
  let called = 0
  const entry = new Entry(mcp('a'))
  entry.update = async () => { called += 1 }
  await release(entry)
  assert.equal(called, 0)
})

test('fiber 处置抛错不会冒泡', () => {
  const entry = new Entry(mcp('a'), { dispose: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => suppress(entry))
  assert.equal(entry.disabled, true)
})
