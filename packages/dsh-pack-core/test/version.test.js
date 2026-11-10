import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORE_VERSION } from '../lib/index.js'

/**
 * 骨架包的第一条用例。
 *
 * 它守的不是版本号，而是「这个包能被 ESM 正常加载」：四个插件将来都从这里 import，
 * 解析链一断，四个包会一起起不来，而错误会发生在各自包的加载阶段，很难定位到这里。
 */
test('骨架包可以被 ESM 加载', () => {
  assert.equal(typeof CORE_VERSION, 'string')
  assert.match(CORE_VERSION, /^\d+\.\d+\.\d+$/)
})
