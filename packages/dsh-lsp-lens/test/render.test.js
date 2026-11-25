import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDiagnostic, isPending, renderFeedback } from '../lib/render.js'

const error = { severity: 1, message: 'unused variable', line: 4, source: 'ts' }
const warning = { severity: 2, message: 'shadowed name', line: 9 }

test('severity 1 是待处理，其余是告知', () => {
  assert.equal(isPending(error), true)
  assert.equal(isPending(warning), false)
})

test('formatDiagnostic 带行号与来源', () => {
  assert.equal(formatDiagnostic(error), '  L4: [error] unused variable (ts)')
})

test('空输入返回空串', () => {
  assert.equal(renderFeedback([]), '')
  assert.equal(renderFeedback([{ path: 'a.ts', diagnostics: [] }]), '')
})

test('有待处理错误时带收尾指令', () => {
  const text = renderFeedback([{ path: 'a.ts', diagnostics: [error] }])
  assert.match(text, /🔴 Pending/)
  assert.match(text, /Address pending errors before reporting the task as done/)
  assert.match(text, /not a user request/)
})

test('未确认分两档：超时与调用失败', () => {
  const timeout = renderFeedback([{ path: 'a.ts', diagnostics: [], unconfirmed: true, reason: 'timeout' }])
  assert.match(timeout, /timed out/)
  assert.match(timeout, /not clean/)
  const failed = renderFeedback([{ path: 'a.ts', diagnostics: [], unconfirmed: true, reason: 'failed' }])
  assert.match(failed, /unavailable/)
  assert.match(failed, /not clean|not checked/)
  assert.doesNotMatch(failed, /timed out/)
})

test('文件数与字符数都受预算约束', () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ path: 'f' + index + '.ts', diagnostics: [error] }))
  const text = renderFeedback(many, { maxFiles: 2, maxCharsPerFile: 40 })
  assert.match(text, /3 more file\(s\)/)
  assert.match(text, /more/)
  assert.doesNotMatch(text, /f3\.ts/)
})
