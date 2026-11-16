#!/usr/bin/env node
/**
 * 界面基调的自动检查：面板里不许出现第三方插件的 CSS 变量。
 *
 * 为什么要有这条检查：这类问题语法合法、`node --check` 通过、测试全绿，
 * 只有真渲染时才暴露（曾经整个开关变成一条纯白胶囊）。靠人跑的自查命令等于没有，
 * 所以让它进 `pnpm test`。
 *
 * 判据只看「被引号包住的 --dsh- 前缀」，注释里提到这个前缀不算违规——
 * 文档与注释本来就要解释哪条不能用。
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')
/**
 * 判据：引号（单、双、反引号）之后、到下一个同类引号之前，出现 `--dsh-`。
 *
 * 覆盖 `'var(--dsh-x)'`、`" --dsh-x"`、`\`var(--dsh-x)\`` 三种写法。
 * 旧版写成 `/(['"])s*--dsh-/`——`\s` 漏了反斜杠，实际匹配「引号后跟零个或多个
 * 字母 s」，`var(--dsh-x)` 全部漏检，检查形同虚设。
 */
const FORBIDDEN = /(['"`])[^'"`]*--dsh-/g

// 自测：判据本身失效时立刻红，而不是安静地放行一切。
if (!FORBIDDEN.test("'var(--dsh-x)'")) {
  console.error('ui-baseline: 自测失败——判据匹配不到 var(--dsh-x)')
  process.exit(1)
}
FORBIDDEN.lastIndex = 0

let violations = 0
let scanned = 0

let packages
try {
  packages = await readdir(packagesDir, { withFileTypes: true })
} catch {
  console.log('ui-baseline: 没有 packages 目录，跳过')
  process.exit(0)
}

for (const entry of packages) {
  if (!entry.isDirectory()) continue
  const clientDir = join(packagesDir, entry.name, 'client')
  let files
  try {
    files = await readdir(clientDir)
  } catch {
    continue
  }
  for (const file of files) {
    if (!file.endsWith('.js')) continue
    const path = join(clientDir, file)
    const lines = (await readFile(path, 'utf8')).split('\n')
    scanned += 1
    lines.forEach((line, index) => {
      // 整行注释跳过：文档与注释本来就要解释「哪条不能用」。
      // 只跳整行，不剥行内注释——字符串里的 `//`（URL 一类）会被误剥，
      // 那会变成漏检。
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      if (!FORBIDDEN.test(line)) return
      FORBIDDEN.lastIndex = 0
      violations += 1
      console.error(path.replace(root, '') + ':' + (index + 1) + ': 引用了第三方 CSS 变量 --dsh-*')
    })
    FORBIDDEN.lastIndex = 0
  }
}

if (scanned === 0) {
  console.error('ui-baseline: 没有扫描到任何面板文件——目录改名或权限问题会让这条检查静默失效')
  process.exit(1)
}

if (violations > 0) {
  console.error('')
  console.error('界面基调要求只用宿主的 --dsw-* 变量，理由见 docs/ui-baseline.md')
  process.exit(1)
}

console.log('ui-baseline: ok（扫描 ' + scanned + ' 个面板文件）')
