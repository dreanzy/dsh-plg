import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilities } from '../lib/capabilities.js'

/**
 * 宿主的支持面。
 *
 * 复现的坑：restrict 是否可用被记在一个 flag 里，面板与装配各拿一份结论，于是同一个
 * 事实要在三处拼；一旦取不到就误报支持，面板不标红、用户以为已经生效。
 */

test('确认支持之后不再回退，即使后来探测失败', () => {
  let broken = false
  const capabilities = createCapabilities(
    () => {
      if (broken) throw new Error('service unavailable')
      return { restrict: () => undefined }
    },
    () => undefined,
  )
  assert.equal(capabilities.support().restrict, true)
  capabilities.noteRestrict(true)
  broken = true
  assert.equal(capabilities.support().restrict, true, '一旦确认支持就不能翻回 false')
})

test('取不到就按不支持显示，不误报', () => {
  const capabilities = createCapabilities(() => undefined, () => undefined)
  assert.deepEqual(capabilities.support(), { restrict: false, promptFilter: false })
  const throwing = createCapabilities(() => {
    throw new Error('service unavailable')
  }, () => undefined)
  assert.equal(throwing.support().restrict, false)
})

test('装配事件的订阅结论独立记录', () => {
  const capabilities = createCapabilities(() => undefined, () => undefined)
  capabilities.notePromptFilter(true)
  assert.deepEqual(capabilities.support(), { restrict: false, promptFilter: true })
})

test('同一条降级只提示一次', () => {
  const messages = []
  const capabilities = createCapabilities(() => undefined, (message) => messages.push(message))
  capabilities.warnOnce('policy-read', '读取失败')
  capabilities.warnOnce('policy-read', '读取失败')
  capabilities.warnOnce('no-tools', '取不到 tools')
  assert.deepEqual(messages, ['读取失败', '取不到 tools'])
})
