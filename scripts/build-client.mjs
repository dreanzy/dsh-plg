#!/usr/bin/env node
/**
 * 把面板共享层与各包的业务面拼成一份 `client.js`。
 *
 * 为什么是文本拼接而不是打包器：宿主用 `require('react')` 提供 React，产物必须是能被
 * `window.__ModuleLoader__.load` 原样吞下的单文件。引入 esbuild 只为把两份手写 JS 接起来，
 * 换来的是一套新配置与新的失败方式（见 ADR-0017）。
 *
 * 两个占位符：
 * - `__PREFIX__` → CSS 类名前缀，等于包目录名（`dsh-skill-pack`）
 * - `__PACK__`   → API 路径段（`skill-pack`）
 *
 * 用法：
 *   node scripts/build-client.mjs            构建所有含 client/panel.js 的包
 *   node scripts/build-client.mjs dsh-mcp-pack  只构建一个
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHARED_BASE = join(ROOT, 'scripts', 'client-shared', 'panel-base.js')
const SHARED_PROTOCOL = join(ROOT, 'scripts', 'client-shared', 'panel-protocol.js')

/** 约定被破坏时立刻失败：宁可不出产物，也不出一个加载即崩的 client.js。 */
function assert(condition, message) {
  if (!condition) throw new Error('build-client: ' + message)
}

/**
 * 生成一个包的产物。
 *
 * `write: false` 只算出文本不落盘——`check-panels` 用它验证「磁盘上的产物与源码一致」，
 * 避免改了 panel.js 却忘了构建。
 */
export async function buildOne(pkgDir, options = {}) {
  const pkgRoot = join(ROOT, 'packages', pkgDir)
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const base = await readFile(SHARED_BASE, 'utf8')
  const prelude = await readFile(join(pkgRoot, 'client', 'prelude.js'), 'utf8')
  // 包可以带自己的协议层；没有就用共享的那份（skill 与 plugin 同形）。
  let protocol
  try {
    protocol = await readFile(join(pkgRoot, 'client', 'protocol.js'), 'utf8')
  } catch {
    protocol = await readFile(SHARED_PROTOCOL, 'utf8')
  }
  const panel = await readFile(join(pkgRoot, 'client', 'panel.js'), 'utf8')

  assert(!/^\s*import\s/mu.test(base), 'panel-base.js 不能含 import')
  assert(!/^\s*export\s/mu.test(base), 'panel-base.js 不能含 export')
  assert(!/^\s*import\s/mu.test(protocol), '协议层不能含 import')
  assert(!/^\s*export\s/mu.test(protocol), '协议层不能含 export')
  assert(!/^\s*export\s/mu.test(panel), pkgDir + '/panel.js 不能含 export')

  // 源文件行尾不统一（历史遗留的 CRLF 与新增的 LF 并存），产物一律出 LF。
  const normalize = (text) => text.replaceAll('\r\n', '\n')
  const short = pkgDir.replace(/^dsh-/u, '')
  const fill = (text) => normalize(text).replaceAll('__PREFIX__', pkgDir).replaceAll('__PACK__', short)
  const filled = fill(base)
  const filledProtocol = fill(protocol)

  const out = [
    '/**',
    ' * 由 scripts/build-client.mjs 生成，不要手改。',
    ' * 源码：packages/' + pkgDir + '/client/prelude.js + scripts/client-shared/panel-base.js',
    ' *      + 协议层（包的 client/protocol.js 或共享的 panel-protocol.js）+ packages/' + pkgDir + '/client/panel.js',
    ' */',
    'window.__ModuleLoader__.load({',
    "  id: '" + manifest.name + "',",
    '  factory(require) {',
    fill(prelude),
    '',
    filled,
    '',
    filledProtocol,
    '',
    normalize(panel),
    '  },',
    '})',
    '',
  ].join('\n')

  assert(out.includes('const CHIP_LABEL'), 'prelude 没有提供 CHIP_LABEL')
  assert(!out.includes('__PREFIX__'), '占位符 __PREFIX__ 没有被替换')
  assert(!out.includes('__PACK__'), '占位符 __PACK__ 没有被替换')
  assert(out.includes('window.__ModuleLoader__.load('), '产物缺少加载器外壳')

  if (options.write !== false) {
    await mkdir(join(pkgRoot, 'client'), { recursive: true })
    await writeFile(join(pkgRoot, 'client', 'client.js'), out, 'utf8')
  }
  return { pkgDir, out, lines: out.split('\n').length }
}

/** 被 import 时只导出能力，不执行构建。 */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

const args = invokedDirectly ? process.argv.slice(2) : []
const candidates = args.length > 0
  ? args
  : (await readdir(join(ROOT, 'packages'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)

let built = 0
if (!invokedDirectly) {
  // 被 import：到此为止。
} else
for (const dir of candidates) {
  try {
    await readFile(join(ROOT, 'packages', dir, 'client', 'panel.js'), 'utf8')
  } catch {
    continue
  }
  const result = await buildOne(dir)
  console.log('client: ' + result.pkgDir + ' → ' + String(result.lines) + ' 行')
  built += 1
}

if (invokedDirectly && built === 0) {
  console.error('build-client: 没有找到任何 client/panel.js')
  process.exit(1)
}
