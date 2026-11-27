/**
 * 面板渲染测试的共享脚手架。
 *
 * 仓库没有 DOM 环境，也不打算为几条断言引入 jsdom：面板是手写单文件、只 `require('react')`，
 * 用假 React 把元素树建出来，再遍历断言，就足以覆盖「这一行显示成什么」这类回归。
 *
 * 三个包各抄一份是新的重复——这份脚手架本身就是被抄出来的第三份。
 *
 * 用法：
 *   import { loadPanel, walk, pressedLabelOfRow, orderOfRows } from '../../../scripts/test-helpers/panel.mjs'
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * 假 React。
 *
 * `createElement` 返回普通对象而不是 null：断言要看 props 与 children，返回 null 就什么都看不到。
 * 其余 hook 一律取「同步、无状态」的语义——测试只渲染一次，不需要重渲染。
 *
 * `initialStates` 按出现顺序覆盖 `useState` 的初值。组件内部的选中项（例如分包页的
 * `selected`）测试没法从外面设，只能这样注入；不覆盖时一律用组件自己的初值。
 */
export function makeReact(initialStates = [], options = {}) {
  let seen = 0
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    /**
     * `runEffects` 打开时先执行一次回调。
     *
     * 延迟执行的代码里引用未声明的变量，不跑就永远看不见——mcp 的 `requestSeq`
     * 除了在 useEffect 里被引用，也在一层 `useCallback` 的 `load` 里。
     * 返回值仍是原函数：`useCallback` 的语义不能变。
     */
    useCallback: options.runEffects === true
      ? (fn) => {
          try {
            const out = fn()
            if (out && typeof out.then === "function") out.catch(() => undefined)
          } catch (error) {
            if (error && error.name === "ReferenceError") throw error
          }
          return fn
        }
      : (fn) => fn,
    // `runEffects` 打开时同步执行一次回调：延迟执行的代码里引用未声明的变量，
    // 假 React 不跑就永远看不见（mcp 的 requestSeq 就是这么漏到用户面前的）。
    useEffect: options.runEffects === true
      ? (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : undefined }
      : () => undefined,
    useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
    useState: (initial) => {
      const index = seen
      seen += 1
      return [index < initialStates.length ? initialStates[index] : initial, () => undefined]
    },
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (_subscribe, read) => read(),
  }
}

/**
 * 把 client.js 装进假宿主，返回 factory 的结果（`apply` 与 `__internals` 都在里面）。
 *
 * `platform` 必须显式给：沙箱里没有 `process` 时 `isWindows()` 恒为 false，而
 * `normalizeCwd` 在 Windows 下要转小写——那条分支在测试里永远走不到。
 */
export function loadClient(clientUrl, options = {}) {
  const platform = options.platform ?? 'win32'
  const initialStates = options.initialStates ?? []
  const captured = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => captured.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
    process: { platform },
    // 打开 effects 时组件会真的发请求；给它一个不发网络的桩。
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, value: {} }) }),
  }
  vm.runInNewContext(readFileSync(clientUrl, 'utf8'), sandbox, { filename: 'client.js' })
  if (captured.length !== 1) throw new Error('模块必须通过 __ModuleLoader__.load 注册一次')
  const entry = captured[0]
  if (typeof entry.factory !== 'function') throw new Error('模块缺少 factory')
  const react = makeReact(initialStates, { runEffects: options.runEffects === true })
  const mod = entry.factory((name) => {
    if (name === 'react') return react
    throw new Error('工厂请求了未提供的模块：' + String(name))
  })
  if (typeof mod.apply !== 'function') throw new Error('factory 的返回值缺少 apply')
  return mod
}

/** 只取 `__internals`：渲染断言用它。 */
export function loadPanel(clientUrl, options = {}) {
  const mod = loadClient(clientUrl, options)
  if (!mod.__internals) throw new Error('factory 缺少 __internals 测试出口')
  return mod.__internals
}

/**
 * 深度遍历渲染树。
 *
 * 函数组件必须就地展开：`h(TriState, ...)` 只是一个元素描述，按钮在它返回的树里。
 * 先 visit 再展开——行本身可能就是函数组件（mcp 的 RowLine），它的 key 在展开前那一层。
 */
export function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  if (typeof node.type === 'function') {
    walk(node.type(node.props || {}), visit)
    return
  }
  walk(node.props ? node.props.children : null, visit)
}

/** 找到 key 为 `name` 的那一行，返回它子树里所有 button。 */
export function buttonsOfRow(tree, name) {
  let row = null
  walk(tree, (node) => {
    if (row === null && node.props && node.props.key === name) row = node
  })
  if (row === null) throw new Error('没找到行：' + name)
  const buttons = []
  walk(row, (node) => {
    if (node.type === 'button') buttons.push(node)
  })
  return buttons
}

/** 三态里被按下的那个标签（「开」/「关」/「跟随」）；没有按下项返回 null。 */
export function pressedLabel(buttons) {
  for (const button of buttons) {
    if (button.props['aria-pressed'] === true) {
      const children = button.props.children
      return Array.isArray(children) ? children.join('') : String(children)
    }
  }
  return null
}

/** 一行当前显示成什么。 */
export function pressedLabelOfRow(tree, name) {
  return pressedLabel(buttonsOfRow(tree, name))
}

/** 这些 key 在渲染树里出现的先后顺序（去重，只留给定的那些）。 */
export function orderOfRows(tree, names) {
  const order = []
  walk(tree, (node) => {
    const key = node.props ? node.props.key : undefined
    if (typeof key === 'string' && names.includes(key) && order.indexOf(key) < 0) order.push(key)
  })
  return order
}
