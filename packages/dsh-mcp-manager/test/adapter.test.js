import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadAdapters, probeAdapters } from '../lib/adapter.js'

/**
 * 模拟宿主的 loader.internal.import：它内部读 `this.getOrCreateModuleJob`，
 * 所以解构后单独调用会炸。这个替身就是为固定这一点写的。
 */
function fakeLoader(modules) {
  const internal = {
    getOrCreateModuleJob() { return 'job' },
    async import(name) {
      if (this.getOrCreateModuleJob() === undefined) throw new Error('lost this')
      const found = modules[name]
      if (found === undefined) throw new Error('no module ' + name)
      return found
    },
  }
  return { internal }
}

test('loadAdapters 保住接收者并返回两个适配器', async () => {
  const defineTool = () => 'tool'
  const createMcpToolDefinition = () => 'definition'
  const loader = fakeLoader({
    '@deepseek-ai/dsh-tools': { defineTool },
    '@deepseek-ai/dsh-mcp-client': { createMcpToolDefinition },
  })
  const adapters = await loadAdapters(loader, 'file:///p/')
  assert.equal(adapters.defineTool, defineTool)
  assert.equal(adapters.createMcpToolDefinition, createMcpToolDefinition)
})

test('probeAdapters 报告成功', async () => {
  const loader = fakeLoader({
    '@deepseek-ai/dsh-tools': { defineTool: () => {} },
    '@deepseek-ai/dsh-mcp-client': { createMcpToolDefinition: () => {} },
  })
  const probe = await probeAdapters(loader, 'file:///p/')
  assert.equal(probe.ok, true)
  assert.equal(probe.error, null)
})

test('probeAdapters 在丢 this 时报错而不是静默失败', async () => {
  const internal = {
    async import() {
      // 故意访问 this：模拟宿主实现
      return this.getOrCreateModuleJob()
    },
  }
  const probe = await probeAdapters({ internal }, undefined)
  assert.equal(probe.ok, false)
  assert.match(String(probe.error), /getOrCreateModuleJob/u)
})

test('缺 defineTool 时 probe 报具体原因', async () => {
  const loader = fakeLoader({
    '@deepseek-ai/dsh-tools': {},
    '@deepseek-ai/dsh-mcp-client': { createMcpToolDefinition: () => {} },
  })
  const probe = await probeAdapters(loader)
  assert.equal(probe.ok, false)
  assert.equal(probe.defineTool, false)
  assert.match(String(probe.error), /defineTool/u)
})

test('没有 internal.import 时给出可读错误', async () => {
  await assert.rejects(() => loadAdapters({}, undefined), /internal\.import/u)
  const probe = await probeAdapters({}, undefined)
  assert.equal(probe.ok, false)
})
