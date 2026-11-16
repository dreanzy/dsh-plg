import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewText, transact, writableReason } from '../lib/store.js'

/**
 * 写事务的测试面。
 *
 * 复现的 bug：四份 `transact` 的签名、返回值与失败约定各不相同，其中 plugin 的试算
 * 不判坏文件——真写拒绝、预览却显示一个「全部重置」的假视图。骨架收进 core 后，
 * 失败一律走返回值，试算与真写共用同一条前置判定。
 */

async function tempFile(name = 'state.json') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-core-store-'))
  return { dir, path: join(dir, name) }
}

test('文件不存在时按空基线写入', async () => {
  const { path } = await tempFile()
  const result = await transact(path, 'state.json', () => '{"a":1}')
  assert.deepEqual(result, { ok: true, next: '{"a":1}' })
  assert.equal(await readFile(path, 'utf8'), '{"a":1}')
})

test('mutate 返回 null 时不落盘，也不凭空建空文件', async () => {
  const { path } = await tempFile()
  const result = await transact(path, 'state.json', () => null)
  assert.deepEqual(result, { ok: true, next: null })
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
})

test('mutate 抛错时整批不写，原因进返回值', async () => {
  const { path } = await tempFile()
  await writeFile(path, '{"a":1}', 'utf8')
  const result = await transact(path, 'state.json', () => {
    throw new Error('未知 pack')
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^state\.json 未写入：Error: 未知 pack$/)
  assert.equal(await readFile(path, 'utf8'), '{"a":1}', '原文件必须一字不动')
})

test('坏 JSON 拒绝覆盖，原文件字节不变', async () => {
  const { path } = await tempFile()
  await writeFile(path, '{ 坏掉', 'utf8')
  const result = await transact(path, 'state.json', () => '{"a":2}')
  assert.equal(result.ok, false)
  assert.match(result.reason, /不是合法 JSON，已拒写以免覆盖/)
  assert.equal(await readFile(path, 'utf8'), '{ 坏掉')
})

test('顶层不是对象同样拒写', async () => {
  const { path } = await tempFile()
  await writeFile(path, '[1,2]', 'utf8')
  const result = await transact(path, 'state.json', () => '{"a":2}')
  assert.equal(result.ok, false)
  assert.match(result.reason, /顶层不是对象/)
})

test('父目录不存在时自己建，不因 mkdir 失败而放弃', async () => {
  const { dir } = await tempFile()
  const path = join(dir, 'nested', 'deep', 'state.json')
  const result = await transact(path, 'state.json', () => '{"a":1}')
  assert.deepEqual(result, { ok: true, next: '{"a":1}' })
  assert.equal(await readFile(path, 'utf8'), '{"a":1}')
})

test('父目录被同名文件占住时返回失败，不抛', async () => {
  const { dir } = await tempFile()
  const blocker = join(dir, 'blocked')
  await writeFile(blocker, 'x', 'utf8')
  const result = await transact(join(blocker, 'state.json'), 'state.json', () => '{"a":1}')
  assert.equal(result.ok, false)
  assert.match(result.reason, /无法创建所在目录/)
})

test('writableReason：空文件可写，坏 JSON 与顶层非对象给出原因', () => {
  assert.equal(writableReason(undefined), null)
  assert.equal(writableReason(''), null)
  assert.equal(writableReason('   '), null)
  assert.equal(writableReason('{"a":1}'), null)
  assert.equal(writableReason('{ 坏掉'), '不是合法 JSON')
  assert.equal(writableReason('[1]'), '顶层不是对象')
  assert.equal(writableReason('null'), '顶层不是对象')
})

test('试算与真写对坏文件给出同一个结论', async () => {
  const { path } = await tempFile()
  await writeFile(path, '{ 坏掉', 'utf8')
  const mutate = () => '{"a":2}'
  const preview = await previewText(path, 'state.json', mutate)
  const written = await transact(path, 'state.json', mutate)
  assert.equal(preview.ok, false)
  assert.equal(written.ok, false)
  assert.equal(preview.ok === false && written.ok === false, true)
  assert.equal(await readFile(path, 'utf8'), '{ 坏掉', '试算不落盘，真写也拒绝')
})

test('试算不写盘：文件保持原样', async () => {
  const { path } = await tempFile()
  await writeFile(path, '{"a":1}', 'utf8')
  const result = await previewText(path, 'state.json', () => '{"a":2}')
  assert.deepEqual(result, { ok: true, next: '{"a":2}' })
  assert.equal(await readFile(path, 'utf8'), '{"a":1}')
})

test('试算的 mutate 抛错时沿用原文，原因进返回值', async () => {
  const { path } = await tempFile()
  await writeFile(path, '{"a":1}', 'utf8')
  const result = await previewText(path, 'state.json', () => {
    throw new Error('未知 pack')
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^state\.json 更新失败：Error: 未知 pack$/)
})

test('试算读失败时返回失败，不抛', async () => {
  // 目标路径是个目录：readFile 抛 EISDIR，不是 ENOENT，所以 readText 会把它抛出来。
  const { dir } = await tempFile()
  const path = join(dir, 'state.json')
  await mkdir(path)
  const result = await previewText(path, 'state.json', () => '{"a":1}')
  assert.equal(result.ok, false)
  assert.match(result.reason, /读取失败/)
})
