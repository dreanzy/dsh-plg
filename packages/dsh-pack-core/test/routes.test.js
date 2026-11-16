import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFetchFace, registerRoutes, toResponse, wrap } from '../lib/routes.js'

/**
 * 路由注册骨架的测试面。
 *
 * 复现的 bug：四份 `wrap` / `toResponse` 各写一遍，而「HTTP 恒 200、信封 code
 * 一致」这条不变式没有任何测试守护——mcp 的原型链 op 报 `internal` 而不是
 * `bad-request` 就是这么漏掉的。
 */

function requestOf(body) {
  return new Request('http://localhost/api/x', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('toResponse 恒为 200，带 no-store', async () => {
  const response = toResponse({ ok: true, value: 1 })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true, value: 1 })
})

test('toResponse 对错误信封同样是 200', async () => {
  const response = toResponse({ ok: false, error: { code: 'bad-request', message: '坏了' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'bad-request', message: '坏了' } })
})

test('wrap 把 body 解析成对象传给 handler', async () => {
  const handler = wrap(async (body) => ({ ok: true, value: body }))
  const response = await handler(requestOf({ a: 1 }))
  assert.deepEqual(await response.json(), { ok: true, value: { a: 1 } })
})

test('wrap 对空体传 null，不报错', async () => {
  const handler = wrap(async (body) => ({ ok: true, value: body }))
  const response = await handler(requestOf(undefined))
  assert.deepEqual(await response.json(), { ok: true, value: null })
})

test('wrap 对坏 JSON 传 null，不报错', async () => {
  const handler = wrap(async (body) => ({ ok: true, value: body }))
  const request = new Request('http://localhost/api/x', { method: 'POST', body: '{ 坏掉' })
  const response = await handler(request)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, value: null })
})

test('wrap 对数组 body 传 null：顶层必须是对象', async () => {
  const handler = wrap(async (body) => ({ ok: true, value: body }))
  const response = await handler(requestOf([1, 2]))
  assert.deepEqual(await response.json(), { ok: true, value: null })
})

test('wrap 把 handler 的异常转成 internal 信封，状态仍是 200', async () => {
  const handler = wrap(async () => {
    throw new Error('boom')
  })
  const response = await handler(requestOf({}))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'internal')
  assert.match(body.error.message, /路由处理失败：Error: boom/)
})

test('readFetchFace：服务缺失、没有 fetch、没有 register 都返回 null', () => {
  assert.equal(readFetchFace({ get: () => undefined }), null)
  assert.equal(readFetchFace({ get: () => null }), null)
  assert.equal(readFetchFace({ get: () => ({}) }), null)
  assert.equal(readFetchFace({ get: () => ({ fetch: {} }) }), null)
  assert.equal(readFetchFace({ get: () => ({ fetch: { register: 1 } }) }), null)
})

test('readFetchFace：ctx.get 抛错时返回 null，不逃逸', () => {
  assert.equal(
    readFetchFace({
      get() {
        throw new Error('service unavailable')
      },
    }),
    null,
  )
})

test('readFetchFace：拿到 register 后转调，this 绑定到 fetch 面', () => {
  const calls = []
  const fetchFace = {
    register(spec) {
      calls.push(spec)
      return () => undefined
    },
  }
  const face = readFetchFace({ get: () => ({ fetch: fetchFace }) })
  assert.notEqual(face, null)
  face.register({ path: '/api/x', methods: ['POST'], requestBody: 'buffered', fetch: async () => new Response() })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/x')
})

test('registerRoutes 按表注册，返回的 dispose 逐个释放', () => {
  const registered = []
  const disposed = []
  const face = {
    register(spec) {
      registered.push(spec.path)
      return () => disposed.push(spec.path)
    },
  }
  const dispose = registerRoutes(
    face,
    { a: '/api/a', b: '/api/b' },
    { a: async () => ({ ok: true, value: 1 }), b: async () => ({ ok: true, value: 2 }) },
    () => assert.fail('不该有注册失败'),
  )
  assert.deepEqual(registered, ['/api/a', '/api/b'])
  dispose()
  assert.deepEqual(disposed, ['/api/a', '/api/b'])
})

test('registerRoutes 单条注册失败只回调，继续注册剩下的', () => {
  const registered = []
  const failures = []
  const face = {
    register(spec) {
      if (spec.path === '/api/b') throw new Error('boom')
      registered.push(spec.path)
      return () => undefined
    },
  }
  registerRoutes(
    face,
    { a: '/api/a', b: '/api/b', c: '/api/c' },
    { a: async () => ({ ok: true, value: 1 }), b: async () => ({ ok: true, value: 2 }), c: async () => ({ ok: true, value: 3 }) },
    (path, error) => failures.push([path, String(error)]),
  )
  assert.deepEqual(registered, ['/api/a', '/api/c'])
  assert.equal(failures.length, 1)
  assert.equal(failures[0][0], '/api/b')
})

test('registerRoutes 的 dispose 对抛错与返回 Promise 的 disposer 都不逃逸', () => {
  const face = {
    register(spec) {
      if (spec.path === '/api/a') {
        return () => {
          throw new Error('sync boom')
        }
      }
      return () => Promise.reject(new Error('async boom'))
    },
  }
  const dispose = registerRoutes(
    face,
    { a: '/api/a', b: '/api/b' },
    { a: async () => ({ ok: true, value: 1 }), b: async () => ({ ok: true, value: 2 }) },
    () => undefined,
  )
  assert.doesNotThrow(() => dispose())
})

test('registerRoutes 对没有 handler 的键静默跳过', () => {
  const registered = []
  const face = {
    register(spec) {
      registered.push(spec.path)
      return () => undefined
    },
  }
  registerRoutes(face, { a: '/api/a', b: '/api/b' }, { a: async () => ({ ok: true, value: 1 }) }, () => undefined)
  assert.deepEqual(registered, ['/api/a'])
})
