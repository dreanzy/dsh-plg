import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readText, storePaths } from '../lib/index.js'

/**
 * 状态文件的位置与读法。
 *
 * 路径原先在四个包里各拼一次，拼错一个字母就把状态落到别人的目录——那种错误在界面上
 * 表现为「我刚存的设置不见了」，很难追回到一行字符串。
 */

test('三份状态文件按包名分目录，文件名固定', () => {
  const paths = storePaths('plugin')
  assert.equal(paths.packs(), paths.file('packs.json'))
  assert.match(paths.packs(), /packs[\\/]plugin[\\/]packs\.json$/)
  assert.match(paths.groups(), /groups\.json$/)
  assert.match(paths.workspaces(), /workspaces\.json$/)
})

test('不同包名的路径互不相交', () => {
  assert.notEqual(storePaths('mcp').packs(), storePaths('skill').packs())
  assert.notEqual(storePaths('mcp').file('diag.json'), storePaths('mcp').packs())
})

test('readText：文件不存在返回 undefined，存在则原样读出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-core-store-'))
  assert.equal(await readText(join(dir, 'missing.json')), undefined)
  const file = join(dir, 'x.json')
  await writeFile(file, '{"a":1}', 'utf8')
  assert.equal(await readText(file), '{"a":1}')
})
