import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

/**
 * 装配层用例。
 *
 * 这一层是「插件装不上就整个会话创建失败」的那一层，此前零覆盖。
 * 只测降级路径：正常路径由各模块自己的用例覆盖。
 */

function fakeCtx(overrides = {}) {
  const warnings = []
  const registered = []
  const disposers = []
  const ctx = {
    warnings,
    registered,
    get(key) {
      if (overrides.get !== undefined) return overrides.get(key)
      return undefined
    },
    inject(_names, callback) {
      callback()
      return () => {}
    },
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    ...overrides.ctx,
  }
  return ctx
}

test('插件名与 inject 声明稳定', () => {
  assert.equal(name, 'model-pack')
  assert.deepEqual([...inject], ['tools'])
})

test('ctx.get 抛错时 apply 不抛，只 warn', () => {
  const ctx = fakeCtx({
    get: () => {
      throw new Error('service unavailable')
    },
  })
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(ctx.warnings.length > 0, '必须留一条 warn')
})

test('connection 服务缺失时不注册路由，也不抛', () => {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.registered.length, 0, '没有 connection 就不该注册任何路由')
})

test('connection.fetch.register 抛错时只 warn', () => {
  const ctx = fakeCtx({
    get: (key) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: () => {
              throw new Error('register rejected')
            },
          },
        }
      }
      return undefined
    },
  })
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(ctx.warnings.some((w) => w.includes('注册路由失败')), '必须记一条注册失败')
})

test('connection 正常时注册两条路由', () => {
  const specs = []
  const ctx = fakeCtx({
    get: (key) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (spec) => {
              specs.push(spec)
              return () => {}
            },
          },
        }
      }
      return undefined
    },
  })
  apply(ctx)
  assert.equal(specs.length, 2, 'read 与 apply 两条')
  assert.deepEqual(specs.map((s) => s.path).sort(), ['/api/model-pack/apply', '/api/model-pack/read'])
})
