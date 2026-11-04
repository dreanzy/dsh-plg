import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../lib/index.js'

function capture() {
  const lines = []
  const ctx = { logger: () => ({ info: (m) => lines.push(m) }) }
  return { ctx, lines }
}

test('apply logs the default greeting', () => {
  const { ctx, lines } = capture()
  apply(ctx)
  assert.deepEqual(lines, ['loaded'])
})

test('apply honours a configured greeting', () => {
  const { ctx, lines } = capture()
  apply(ctx, { greeting: 'hi' })
  assert.deepEqual(lines, ['hi'])
})

test('plugin name matches the entry id', () => {
  assert.equal(name, 'dsh-plugin-example')
})
