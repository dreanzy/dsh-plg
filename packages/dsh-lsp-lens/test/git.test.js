import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinPath, parsePorcelainZ, readCollected } from '../lib/git.js'

test('解析普通变更与未跟踪文件', () => {
  const out = ' M src/a.ts\0?? src/b.ts\0'
  assert.deepEqual(parsePorcelainZ(out), ['src/a.ts', 'src/b.ts'])
})

test('重命名条目跳过原路径 token', () => {
  const out = 'R  new.ts\0old.ts\0?? keep.ts\0'
  assert.deepEqual(parsePorcelainZ(out), ['new.ts', 'keep.ts'])
})

test('空输出与残缺 token 返回空数组', () => {
  assert.deepEqual(parsePorcelainZ(''), [])
  assert.deepEqual(parsePorcelainZ('\0\0'), [])
})

test('joinPath 统一分隔符', () => {
  assert.equal(joinPath('D:\\repo\\', 'src/a.ts'), 'D:/repo/src/a.ts')
  assert.equal(joinPath('/repo', './src/b.ts'), '/repo/src/b.ts')
})

test('readCollected 读取 readFrom 文本', () => {
  const handle = { collected: { stdout: { readFrom: () => ({ text: 'ok' }) } } }
  assert.equal(readCollected(handle), 'ok')
  assert.equal(readCollected({}), '')
  assert.equal(readCollected(null), '')
})
