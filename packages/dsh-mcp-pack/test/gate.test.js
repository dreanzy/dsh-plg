import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../lib/gate.js'

const MCP = '@deepseek-ai/dsh-mcp-client'

/** 一条 MCP entry 替身：与宿主 Entry 同形（原型 getter + 自有属性遮蔽）。 */
class Entry {
  constructor(serverName) {
    this.options = { name: MCP, config: { serverName } }
    this.fiber = { dispose: () => {} }
    this.updated = []
  }
  get disabled() {
    return Boolean(this.options.disabled)
  }
  async update(options) {
    this.updated.push(options)
  }
}

function gateWith(entries, mountOf) {
  const loader = { entries: () => entries }
  const warnings = []
  const gate = createGate({
    context: {
      get: (key) => (key === 'loader' ? loader : undefined),
      on: () => () => {},
      logger: { warn: (message) => warnings.push(message) },
    },
    mountOf,
  })
  return { gate, warnings, entries }
}

test('启用且 eager 的行被恢复挂载', async () => {
  const entry = new Entry('srv')
  const { gate } = gateWith([entry], () => ({ enabled: true, mode: 'eager' }))
  await gate.reconcile()
  assert.equal(entry.disabled, false)
})

test('禁用但 eager 的行必须被摘掉：只看 mode 会漏', async () => {
  const entry = new Entry('srv')
  const { gate } = gateWith([entry], () => ({ enabled: false, mode: 'eager' }))
  await gate.reconcile()
  assert.equal(entry.disabled, true, '工作区禁用的 eager 行不得挂载')
})

test('启用但 dynamic 的行被摘掉', async () => {
  const entry = new Entry('srv')
  const { gate } = gateWith([entry], () => ({ enabled: true, mode: 'dynamic' }))
  await gate.reconcile()
  assert.equal(entry.disabled, true)
})

test('策略未就绪（null）时保持现状', async () => {
  const entry = new Entry('srv')
  const { gate } = gateWith([entry], () => null)
  await gate.reconcile()
  assert.equal(entry.disabled, false, '未就绪时不得动用户的 server')
})
