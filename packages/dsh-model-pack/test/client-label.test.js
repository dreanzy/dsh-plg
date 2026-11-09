import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 客户端插件里「模型位 pack 名」的回归测试。
 *
 * 这是一处**纯浏览器**逻辑，没有可注入的接缝：唯一能驱动它的办法是替掉
 * `window.__ModuleLoader__`、React 与 fetch，然后直接调用 apply。
 * 复现的 bug：改了工作区绑定之后，composer 的模型位一直显示旧 pack 名，
 * 必须整页刷新——缓存只补新目录，已缓存的目录永不重读，且缓存变化不会通知渲染。
 *
 * 全程不碰真实宿主：fetch 是假的，目录列表是假的，定时器手动触发。
 */

/** 原始的全局对象：用例结束后原样放回，避免污染同进程里的其他测试。 */
const saved = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  document: globalThis.document,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

const CLIENT = new URL('../client/client.js', import.meta.url)
/** 每个用例换一个 URL，让 ESM 重新执行为该用例初始化。 */
let importCounter = 0

/** 一个 fake 宿主：只有一个目录、一个会话，read 的返回值可随时替换。 */
async function bootClient() {
  const reads = []
  /** 服务端此刻的答案：read 路由的完整信封数据（`resolved` 在里面）。 */
  const server = { data: { resolved: { id: 'pack-a', pack: { id: 'pack-a', name: 'alpha' } } } }

  globalThis.fetch = async (path, init) => {
    const body = JSON.parse((init && init.body) || '{}')
    reads.push(body.cwd)
    return { status: 200, json: async () => ({ ok: true, data: server.data }) }
  }

  /** 渲染次数：每次订阅被通知就 +1，用来断言「变了才重渲染」。 */
  const rendered = { count: 0 }
  const elements = []
  const h = (type, props, ...children) => {
    const node = { type, props: props || {}, children: children.flat() }
    elements.push(node)
    return node
  }
  const fakeReact = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: () => {
      throw new Error('渲染期不该用到 useState')
    },
    useEffect: () => {
      throw new Error('渲染期不该用到 useEffect')
    },
    useMemo: () => {
      throw new Error('渲染期不该用到 useMemo')
    },
    useCallback: () => {
      throw new Error('渲染期不该用到 useCallback')
    },
    useRef: () => {
      throw new Error('渲染期不该用到 useRef')
    },
    // 真订阅：订阅函数就是本模块自己的 signal，通知到就算一次重渲染。
    useSyncExternalStore: (subscribe, read) => {
      subscribe(() => {
        rendered.count += 1
      })
      return read()
    },
  }

  const registered = {}
  let factory = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (options) => {
        factory = options.factory
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }

  const timers = []
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms })
    return timers.length
  }
  globalThis.clearInterval = () => {}

  // 每次带不同的 query 重新加载：模块级状态（缓存、信号）必须按用例全新，
  // 而 ESM 按 URL 缓存，去掉 query 会让第二个用例复用第一个的缓存和定时器。
  importCounter += 1
  await import(CLIENT.href + '?boot=' + importCounter)
  assert.equal(typeof factory, 'function', 'client 模块没有通过 __ModuleLoader__ 暴露 factory')
  const mod = factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('未知的 require：' + name)
  })

  const listeners = new Map()
  const ctx = {
    remote: {
      session: {
        list: async () => ({ ok: true, value: { items: [{ sessionId: 's1', cwd: 'D:/proj' }] } }),
        modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
      },
    },
    get(name) {
      return name === 'remote.session' ? this.remote.session : undefined
    },
    on(event, cb) {
      listeners.set(event, cb)
      return () => {}
    },
    effect(cb) {
      return cb()
    },
    slots: {
      inject(name, cb) {
        try {
          cb()
        } catch {
          // 组件没渲染，注册失败与断言无关。
        }
      },
      register(spec, component) {
        registered[spec.name] = component
        return () => {}
      },
    },
  }
  mod.apply(ctx)

  const label = registered['conversation.input.model.label']
  assert.equal(typeof label, 'function', '模型位标签没有注册')

  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.children || [])
  }
  const view = () => textOf(label({ model: { name: 'gpt-6.1-sol' }, placement: 'trigger', sessionId: 's1' }))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

  return {
    reads,
    rendered,
    server,
    view,
    tick,
    /** 手动跑一次 60 秒定时轮询。 */
    poll() {
      const timer = timers[timers.length - 1]
      assert.ok(timer, '没有注册定时重读')
      timer.fn()
      return tick()
    },
    reset() {
      Object.assign(globalThis, saved)
    },
  }
}

test('绑定改了之后，轮询会让模型位的 pack 名跟着变', async () => {
  const client = await bootClient()
  try {
    await client.tick()
    assert.equal(client.view(), 'alpha | gpt-6.1-sol')

    client.server.data = { resolved: { id: 'pack-b', pack: { id: 'pack-b', name: 'beta' } } }
    assert.equal(client.view(), 'alpha | gpt-6.1-sol', '缓存没刷新前仍是旧名字')

    await client.poll()
    assert.equal(client.view(), 'beta | gpt-6.1-sol', '轮询之后仍是旧名字：已缓存的目录没有被重读')
  } finally {
    client.reset()
  }
})

test('缓存内容没变时不发重渲染信号', async () => {
  const client = await bootClient()
  try {
    await client.tick()
    // 先渲染一次：订阅来自组件渲染，不渲染就没有人听信号。
    assert.equal(client.view(), 'alpha | gpt-6.1-sol')
    const before = client.rendered.count

    await client.poll()
    assert.equal(client.rendered.count, before, '内容没变却通知了渲染')

    client.server.data = { resolved: { id: 'pack-b', pack: { id: 'pack-b', name: 'beta' } } }
    await client.poll()
    assert.ok(client.rendered.count > before, '内容变了却没通知渲染')
  } finally {
    client.reset()
  }
})
