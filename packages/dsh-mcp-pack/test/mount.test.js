import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountConfig, mountMcpServer } from '../lib/mount.js'

const stdioDef = { transport: 'stdio', command: 'node', args: ['-e', 'x'], env: { A: '1' }, cwd: '' }
const httpDef = { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp', headers: { H: '1' } }

test('mountConfig 翻出宿主 Config 的形状', () => {
  const stdio = mountConfig('srv', stdioDef)
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.serverName, 'srv')
  assert.deepEqual(stdio.args, ['-e', 'x'])
  assert.deepEqual(stdio.env, { A: '1' })

  const http = mountConfig('srv', httpDef)
  assert.equal(http.transport, 'streamable-http')
  assert.equal(http.url, 'http://127.0.0.1:8080/mcp')
  assert.deepEqual(http.headers, { H: '1' })
})

test('挂载把模块的 apply/inject 交给宿主并保留配置', () => {
  const calls = []
  const host = { plugin: (plugin, config) => { calls.push({ plugin, config }); return { dispose: () => calls.push({ disposed: true }) } } }
  const apply = () => {}
  const handle = mountMcpServer(host, { name: 'mcp-client', inject: ['tools'], apply }, 'srv', stdioDef)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].plugin.apply, apply)
  assert.deepEqual(calls[0].plugin.inject, ['tools'])
  assert.equal(calls[0].config.serverName, 'srv')
  assert.equal(handle.serverName, 'srv')
})

test('dispose 转调宿主的 dispose', () => {
  let disposed = 0
  const host = { plugin: () => ({ dispose: () => { disposed += 1 } }) }
  const handle = mountMcpServer(host, { apply: () => {} }, 'srv', httpDef)
  handle.dispose()
  assert.equal(disposed, 1)
})

test('dispose 抛错不冒泡', () => {
  const host = { plugin: () => ({ dispose: () => { throw new Error('boom') } }) }
  const handle = mountMcpServer(host, { apply: () => {} }, 'srv', httpDef)
  assert.doesNotThrow(() => handle.dispose())
})

test('模块缺 apply 时明确报错', () => {
  const host = { plugin: () => ({}) }
  assert.throws(() => mountMcpServer(host, {}, 'srv', httpDef), /缺少 apply/u)
})
