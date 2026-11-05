import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanRows, OWNED_INCLUDE_FILE, MCP_CLIENT_MODULE } from '../lib/inventory.js'

function entry({ id, config, file, disabled = false }) {
  const tree = file === undefined ? {} : { filename: file }
  return { options: { id, name: MCP_CLIENT_MODULE, config, disabled }, parent: { tree } }
}

function loaderOf(entries) {
  return { *entries() { for (const item of entries) yield item } }
}

const stdio = { transport: 'stdio', serverName: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] }
const http = { transport: 'streamable-http', serverName: 'gitlab', url: 'https://example.test/mcp' }

test('识别 stdio 与 streamable-http 两种配置', () => {
  const scan = scanRows(loaderOf([
    entry({ id: 'a', config: stdio, file: 'C:/p/mcp.cordis.yml' }),
    entry({ id: 'b', config: http }),
  ]))
  assert.equal(scan.complete, true)
  assert.equal(scan.rows.length, 2)
  const playwright = scan.rows.find((row) => row.serverName === 'playwright')
  assert.equal(playwright.transport, 'stdio')
  assert.equal(playwright.definition, 'npx -y @playwright/mcp')
  assert.equal(playwright.source, 'mcp.cordis.yml')
  assert.equal(playwright.owned, false)
  assert.equal(playwright.rowKey, 'global:playwright')
  const gitlab = scan.rows.find((row) => row.serverName === 'gitlab')
  assert.equal(gitlab.source, 'profile')
  assert.equal(gitlab.sourcePath, null)
})

test('托管的 include 文件里的行标记为 owned', () => {
  const scan = scanRows(loaderOf([entry({ id: 'own', config: stdio, file: '/w/.dsh/' + OWNED_INCLUDE_FILE })]))
  assert.equal(scan.rows[0].owned, true)
  assert.equal(scan.rows[0].rowKey, 'own:playwright')
})

test('非 mcp-client 的 entry 被忽略', () => {
  const scan = scanRows(loaderOf([
    { options: { id: 'x', name: '@deepseek-ai/dsh-tools' }, parent: {} },
    entry({ id: 'a', config: stdio }),
  ]))
  assert.equal(scan.rows.length, 1)
})

test('形状不认识的配置跳过并给出 warning', () => {
  const scan = scanRows(loaderOf([entry({ id: 'bad', config: { transport: 'stdio' } })]))
  assert.equal(scan.rows.length, 0)
  assert.equal(scan.warnings.length, 1)
})

test('重复的 serverName 只保留第一行', () => {
  const scan = scanRows(loaderOf([entry({ id: 'a', config: stdio }), entry({ id: 'b', config: stdio })]))
  assert.equal(scan.rows.length, 1)
  assert.match(scan.warnings[0], /重复的 serverName/u)
})

test('declaredDisabled 读声明而不是闸门状态', () => {
  const scan = scanRows(loaderOf([entry({ id: 'a', config: stdio, disabled: true })]))
  assert.equal(scan.rows[0].declaredDisabled, true)
})

test('没有 loader.entries 时 complete 为 false', () => {
  const scan = scanRows({})
  assert.equal(scan.complete, false)
  assert.equal(scan.rows.length, 0)
})
