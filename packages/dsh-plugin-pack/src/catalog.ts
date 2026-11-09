import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Catalog, PluginContribution } from './types.js'

/**
 * 插件目录：扫描得到「插件 → 工具 / 段」的归属。
 *
 * 宿主不记录任何归属信息：`ToolDefinition` 没有来源字段，段的注册项也不带 owner，
 * 公共 API 里没有枚举手段。所以这里只能静态扫源码，把字面量形式的注册名抓出来。
 *
 * 抓不到的一律留空：宁可少省 token，也不误删别人的段或误关别人的工具。
 *
 * ## 扫哪些包
 *
 * 1. **profile 直接依赖**：`$DSH_PROFILE_DIR`，或 `$DSH_HOME/profiles/*` 里声明了
 *    `dsh.profile.bundles` 的那些目录。只读 `dependencies`——传递依赖不会挂载 bundle，
 *    扫它只会多出错误来源。
 * 2. **官方包**：asar 里 `dsh/node_modules/@deepseek-ai/<包>/lib` 下的 js。官方包装在
 *    app.asar 里，不在 profile 的 `node_modules` 下，只能单独从归档头里取。
 *
 * ## 归属规则
 *
 * - 工具：`defineTool({ … name: '…' })`，240 字符窗口。窗口要挡的是「同一文件里远处
 *   另一个对象的 name」，240 够长也够短。
 * - 段：`systemPrompt.section(` / `.section(` 里 240 字符内的 `name` 字面量。模板形式
 *   `前缀:…` 只记静态前缀（如 `tool:`），且前缀必须是包名里的一个词——`mcp:` 记给
 *   `dsh-mcp-client`，`tool:` 记给 `dsh-tool-bash`，但不记给 `dsh-subagent`。
 * - **同名工具或段被多个包注册时，两个包都记**（见 types.ts 的 `Catalog`）。运行期按
 *   清单取交集：多记一条只会让两个开关都能命中，不会误删别人的东西；反过来先到先得
 *   会随机丢掉一个合法来源，而丢来源的代价是「关不掉」。
 *
 * ## 缓存
 *
 * 指纹 = 各候选包 `name@version@入口 mtime@lib 最大 mtime@文件数@总字节数` 拼串的
 * sha256 前 16 位。后两项挡「删掉非最新文件」与「同毫秒改写」。
 * 命中就只读 package.json 与 stat，不读任何 js 内容。
 */

/**
 * `$DSH_HOME/packs/plugin/catalog.json`。
 *
 * 与三份策略文件同目录，但它只是归属扫描的缓存：不参与求值，可删，删了重扫。
 */
export function catalogPath(): string {
  return dshHomePath('packs', 'plugin', 'catalog.json')
}

/** 扫描总预算：超时就带着已抓到的结果返回，不让装配路径无限等。 */
const SCAN_BUDGET_MS = 5_000

/** 单文件上限。超过就不读：那是产物或打包文件，正则扫进去只会误抓与拖慢。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * 单包最多读多少个 js，防止某个包把源码与产物堆在一起时吃满预算。
 *
 * 512 而不是 200：带 tui/runtime 子树的实体插件（dsh-blender-plugin 已 219 个）会撞
 * 200，整包被判残缺，工具归属拿不到，停用对它永久无效。
 */
const MAX_FILES_PER_PACKAGE = 512

/** lib 目录递归深度上限。 */
const MAX_LIB_DEPTH = 6

/** 名字字面量的窗口：够长以容纳多行对象字面量，够短以避开同文件的无关 name。 */
const NAME_WINDOW = 240

/** 取 `text:` 字面量时的窗口。覆盖常见段的整段，超出只记上界，不要求精确。 */
const TEXT_WINDOW = 4096

/** 找配对括号的跨度上限。段体可以很长，卡在 4 K 会让长段的体积直接记 0。 */
const MAX_SECTION_SPAN = 64 * 1024

/**
 * 工具名判定。`{0,240}` 是刻意的收紧：不限距离会把注释里的示例、类型声明、
 * 甚至不相干的 `name:` 字段一起抓进来。
 */
const TOOL_PATTERN = /defineTool\(\{[\s\S]{0,240}?name:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g

/**
 * 包内候选名字：任何 `name: '字面量'`，不再要求它包在 `defineTool({` 里。
 *
 * 有的插件用 `ctx.tools.register(vTool({ name }))`，有的把 name 放进工厂函数的返回
 * 对象，结构解析都够不着。这里只收集「这个包写过这些名字」，归属交给运行期清单裁：
 * 名字必须真的注册在宿主里，且没有第二个包也写过它（见 `candidateTools`）。
 */
const NAME_PATTERN = /(?<![\w$])name:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g

/** 单包候选名上限：防止把字典或产物塞进 lib 的包把缓存撑大。 */
const MAX_NAMES_PER_PACKAGE = 512

/** 段的注册点。`.section(` 一网打尽 `systemPrompt.section(` 与解构后的 `section(`。 */
const SECTION_PATTERN = /\.section\s*\(\s*\{/g

/** 从 asar 头解析出的条目表。 */
interface AsarIndex {
  readonly entries: readonly AsarEntry[]
  readonly dataOffset: number
}

interface AsarEntry {
  readonly path: string
  readonly size: number
  readonly offset: number
}

/** 一个待扫的候选文件：内容读取推迟到真正扫描时，命中缓存就一次也不读。 */
interface CandidateFile {
  readonly path: string
  readonly size: number
  readonly mtime: number
  readonly read: () => Promise<string>
}

/** 一个候选包：入口 + lib 下的 js。 */
interface PackageCandidate {
  readonly name: string
  readonly version: string
  readonly entry: CandidateFile | null
  readonly lib: readonly CandidateFile[]
  /** lib 的清单被上限（单包文件数或递归深度）截断了：这份列表不是整包。 */
  readonly truncated: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    // 不存在、权限、被占用都按「没有」处理：目录是展示用的附加信息，
    // 它失败不该把整个面板变成错误页。
    return undefined
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path)
  if (text === undefined) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.round(value)
}

function parsePlugin(value: unknown): PluginContribution | null {
  const record = asRecord(value)
  if (record === null) return null
  const pkg = record['pkg']
  if (typeof pkg !== 'string' || pkg === '') return null
  // 候选名与手工表分开：`names` 缺席说明这是旧版本写的缓存，不是「这个包没有名字」。
  const names = Array.isArray(record['names']) ? toStringArray(record['names']) : undefined
  return {
    pkg,
    tools: toStringArray(record['tools']),
    ...(names === undefined ? {} : { names }),
    sections: toStringArray(record['sections']),
    toolVolume: toCount(record['toolVolume']),
    sectionChars: toCount(record['sectionChars']),
    // 缺字段按「已确证」处理：手写缓存不必逐项写全，缺省的语义是「没发现问题」。
    toolsKnown: record['toolsKnown'] !== false,
    sectionsKnown: record['sectionsKnown'] !== false,
  }
}

/** 缓存是 `Catalog` 加一个手工开关；手写表优先级最高。 */
interface CachedCatalog extends Catalog {
  readonly manual: boolean
  /**
   * 缓存里每一项都带候选名。
   *
   * 旧版本写的缓存没有 `names`，而指纹只看包的字节，不看扫描器版本：不显式判一次，
   * 升级后会一直命中旧缓存，候选名永远是空的。
   */
  readonly shaped: boolean
}

function parseCatalog(value: unknown): CachedCatalog | null {
  const record = asRecord(value)
  if (record === null) return null
  const plugins: PluginContribution[] = []
  let shaped = true
  const rawPlugins = record['plugins']
  if (Array.isArray(rawPlugins)) {
    for (const item of rawPlugins) {
      const plugin = parsePlugin(item)
      if (plugin !== null) {
        plugins.push(plugin)
        if (plugin.names === undefined) shaped = false
      }
    }
  }
  return {
    key: typeof record['key'] === 'string' ? record['key'] : '',
    plugins,
    orphanTools: toStringArray(record['orphanTools']),
    orphanSections: toStringArray(record['orphanSections']),
    // 缺字段按「完整」处理：手写缓存不必逐项写全，缺省的语义是「没发现问题」。
    complete: record['complete'] !== false,
    manual: record['manual'] === true,
    shaped,
  }
}

/**
 * 上一次读到的东西与它的文件戳。
 *
 * 命中时连 `JSON.parse` 都不做：`agent/created` 每条会话都会读一次，而目录文件
 * 有几十 KB、几百条插件。`stat` 比「读全文再解析」便宜两个数量级。
 */
let memo: { readonly path: string; readonly stamp: string; readonly value: CachedCatalog | null } | null = null

function stampOf(path: string): string {
  try {
    const info = statSync(path)
    return `${String(info.size)}:${String(Math.round(info.mtimeMs))}`
  } catch {
    return 'absent'
  }
}

/**
 * 只读缓存，不触发扫描。装配路径上只允许用它。
 *
 * 不对外导出：模块外一律经由 `defaultCatalogFeed.read()`，那样扫描状态与去重
 * 才有唯一的一份归属。
 */
function readCachedCatalog(): Catalog | null {
  const path = catalogPath()
  const stamp = stampOf(path)
  // 取成局部量再判空：`memo` 是可变的，直接访问属性时 TypeScript 收窄不了。
  const hit = memo
  // 路径也参与比较：测试与多 profile 场景下 `$DSH_HOME` 会换，只比大小与时间戳会串味。
  if (hit !== null && hit.path === path && hit.stamp === stamp) {
    return hit.value === null ? null : toCatalog(hit.value)
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    memo = { path, stamp, value: null }
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // 坏 JSON 按空目录处理：目录能重建，抛错只会让面板整页失败。
    memo = { path, stamp, value: null }
    return null
  }
  const parsed = parseCatalog(raw)
  memo = { path, stamp, value: parsed }
  return parsed === null ? null : toCatalog(parsed)
}

async function readCachedEntry(): Promise<CachedCatalog | null> {
  const text = await readText(catalogPath())
  if (text === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  return parseCatalog(raw)
}

function toCatalog(entry: CachedCatalog): Catalog {
  return {
    key: entry.key,
    plugins: entry.plugins,
    orphanTools: entry.orphanTools,
    orphanSections: entry.orphanSections,
    complete: entry.complete,
  }
}

/* ------------------------------------------------------------------ 候选包 */

async function isProfileDir(dir: string): Promise<boolean> {
  const manifest = await readJson(join(dir, 'package.json'))
  if (manifest === null) return false
  const profile = asRecord(asRecord(manifest['dsh'])?.['profile'])
  return profile !== null && Array.isArray(profile['bundles'])
}

/**
 * 找出要扫的 profile 目录。
 *
 * 优先 `$DSH_PROFILE_DIR`（宿主注入）；它不存在或不合格时退回 `$DSH_HOME/profiles/*`，
 * 只认带 `package.json` 且声明了 `dsh.profile.bundles` 的目录，多个就全扫。
 */
async function profileDirs(): Promise<string[]> {
  const explicit = process.env['DSH_PROFILE_DIR']
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = resolve(explicit.trim())
    if (await isProfileDir(dir)) return [dir]
  }

  const root = dshHomePath('profiles')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    if (await isProfileDir(dir)) dirs.push(dir)
  }
  // 排序只为让指纹与遍历顺序无关，结果本身不依赖顺序。
  dirs.sort()
  return dirs
}

/** 把一个普通路径变成候选文件；不是普通文件、或超过大小上限时返回 null。 */
async function candidateFile(path: string): Promise<CandidateFile | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    return {
      path,
      size: info.size,
      mtime: Math.round(info.mtimeMs),
      read: async () => await readFile(path, 'utf8'),
    }
  } catch {
    return null
  }
}

/**
 * 递归列 lib 目录下的 .js，跳过 node_modules 与隐藏目录。
 *
 * 返回值表示**有没有因为上限放弃过子树**。上限命中时列表只是包的一部分，而调用方
 * 只看得到列表，从内容上分不出「就这么多」和「被砍了一半」，所以必须显式带出去。
 */
async function listLibJs(dir: string, depth: number, out: CandidateFile[]): Promise<boolean> {
  if (depth > MAX_LIB_DEPTH) {
    // 越过深度上限就整棵子树放弃，里面有没有 js 不再确认：那正是这条上限要省的遍历。
    // 宁可多报一次残缺（代价是一轮重扫），也不能把「只扫了一半」说成完整。
    return true
  }
  if (out.length >= MAX_FILES_PER_PACKAGE) return true
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  let truncated = false
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_PACKAGE) return true
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (await listLibJs(join(dir, entry.name), depth + 1, out)) truncated = true
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const file = await candidateFile(join(dir, entry.name))
      if (file !== null) out.push(file)
    }
  }
  return truncated
}

/** 解析包声明的入口：文件就用它，目录按 Node 的惯例取 `index.js`。 */
async function entryFile(dir: string, main: string | null): Promise<CandidateFile | null> {
  if (main === null) return null
  const target = join(dir, main)
  const direct = await candidateFile(target)
  if (direct !== null) return direct
  return await candidateFile(join(target, 'index.js'))
}

/** 一个装在普通目录里的包。 */
async function collectDirPackage(dir: string, name: string): Promise<PackageCandidate | null> {
  const manifest = await readJson(join(dir, 'package.json'))
  if (manifest === null) return null
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '0.0.0'
  const main = typeof manifest['main'] === 'string' && manifest['main'] !== '' ? manifest['main'] : null
  const lib: CandidateFile[] = []
  const truncated = await listLibJs(join(dir, 'lib'), 0, lib)
  return { name, version, entry: await entryFile(dir, main), lib, truncated }
}

/**
 * 官方包所在的根。`archive` 表示 app.asar 文件，`dir` 表示解包后的目录（测试与开发用）。
 *
 * 顺序：显式 `$DSH_APP_ASAR` → Electron 的 `process.resourcesPath` → 可执行文件旁边的
 * `resources/app.asar` → 本模块自己被加载时所在的 app.asar。显式给了但不存在时**不回退**：
 * 那是调用方在说「官方包就在这里」。
 */
function officialRoot(): { kind: 'archive' | 'dir'; path: string } | null {
  const explicit = process.env['DSH_APP_ASAR']
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return classifyRoot(resolve(explicit.trim()))
  }

  const candidates: string[] = []
  const resources = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  if (typeof resources === 'string' && resources !== '') candidates.push(join(resources, 'app.asar'))
  candidates.push(join(dirname(process.execPath), 'resources', 'app.asar'))
  // 从任意一个「路径里含 app.asar」的线索反推归档位置：本模块自己被加载的位置、
  // 或进程入口。插件装在 profile 下时前者不含 app.asar，后者常常含。
  for (const hint of [...collectHints(), ...process.argv]) {
    const marker = typeof hint === 'string' ? hint.indexOf('app.asar') : -1
    if (marker > 0) {
      candidates.push(hint.slice(0, marker + 'app.asar'.length))
      break
    }
  }

  for (const candidate of candidates) {
    const root = classifyRoot(candidate)
    if (root !== null) return root
  }
  return null
}

function collectHints(): string[] {
  try {
    return [fileURLToPath(import.meta.url)]
  } catch {
    // import.meta.url 不是文件 URL（某些 bundler 产物）时没有这条线索。
    return []
  }
}

function classifyRoot(path: string): { kind: 'archive' | 'dir'; path: string } | null {
  try {
    const info = statSync(path)
    if (info.isDirectory()) return { kind: 'dir', path }
    if (info.isFile()) return { kind: 'archive', path }
  } catch {
    return null
  }
  return null
}

/**
 * 读 asar 头。解不开就当没有官方包，不抛错。
 *
 * 这里用异步 IO：头最大允许 64 MB，同步读会把主线程（以及 libuv 线程池）占住，
 * 而这发生在插件启动的预热路径上。异步之后诊断与请求都能插进来。
 */
async function readAsarIndex(archive: string): Promise<AsarIndex | null> {
  const handle = await open(archive, 'r').catch(() => null)
  if (handle === null) return null
  try {
    const head = Buffer.alloc(16)
    if ((await handle.read(head, 0, 16, 0)).bytesRead !== 16) return null
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null
    const raw = Buffer.alloc(jsonLength)
    if ((await handle.read(raw, 0, jsonLength, 16)).bytesRead !== jsonLength) return null
    const header = asRecord(JSON.parse(raw.toString('utf8')))
    if (header === null) return null

    const entries: AsarEntry[] = []
    const walk = (node: Record<string, unknown>, prefix: string): void => {
      const files = asRecord(node['files'])
      if (files === null) return
      for (const [name, child] of Object.entries(files)) {
        const record = asRecord(child)
        if (record === null) continue
        const path = prefix === '' ? name : prefix + '/' + name
        if (record['files'] !== undefined) {
          walk(record, path)
          continue
        }
        // 解包文件不在归档体内（offset 缺省）；读不到就跳过。
        if (record['unpacked'] === true) continue
        // offset 在 asar 头里是**字符串**，直接当数字用会全部退化成 0，
        // 于是每个文件都读到数据区的第一段内容——包名对、内容全错。
        const offset = Number(record['offset'])
        if (!Number.isFinite(offset) || offset < 0) continue
        entries.push({ path, size: toCount(record['size']), offset })
      }
    }
    walk(header, '')
    return { entries, dataOffset: 16 + jsonLength }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readAsarEntry(archive: string, dataOffset: number, entry: AsarEntry): Promise<string> {
  const handle = await open(archive, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    await handle.read(buffer, 0, entry.size, dataOffset + entry.offset)
    return buffer.toString('utf8')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 官方包：asar 里的 `dsh/node_modules/@deepseek-ai/<包>`。 */
async function collectArchivePackages(archive: string): Promise<PackageCandidate[]> {
  const index = await readAsarIndex(archive)
  if (index === null) return []
  let archiveMtime = 0
  try {
    archiveMtime = Math.round((await stat(archive)).mtimeMs)
  } catch {
    archiveMtime = 0
  }

  const groups = new Map<string, Map<string, AsarEntry>>()
  for (const entry of index.entries) {
    const match = /^dsh\/node_modules\/(@deepseek-ai\/[^/]+)\/(.+)$/.exec(entry.path)
    if (match === null) continue
    const name = match[1]
    const rel = match[2]
    if (name === undefined || rel === undefined) continue
    if (rel !== 'package.json' && !(rel.endsWith('.js') && entry.size <= MAX_FILE_BYTES)) continue
    let files = groups.get(name)
    if (files === undefined) {
      files = new Map<string, AsarEntry>()
      groups.set(name, files)
    }
    files.set(rel, entry)
  }

  const candidates: PackageCandidate[] = []
  for (const name of [...groups.keys()].sort()) {
    const files = groups.get(name)
    if (files === undefined) continue
    const materialize = (entry: AsarEntry): CandidateFile => ({
      path: archive + '/' + entry.path,
      size: entry.size,
      // 归档里没有逐文件 mtime：用归档自身的 mtime 当整包时间戳。
      // 升级 DSH 会改归档 mtime，指纹照样会变。
      mtime: archiveMtime,
      read: async () => readAsarEntry(archive, index.dataOffset, entry),
    })

    const manifestEntry = files.get('package.json')
    let version = '0.0.0'
    let main = 'lib/index.js'
    if (manifestEntry !== undefined) {
      try {
        const manifest = asRecord(JSON.parse(await readAsarEntry(archive, index.dataOffset, manifestEntry)))
        if (manifest !== null) {
          if (typeof manifest['version'] === 'string') version = manifest['version']
          if (typeof manifest['main'] === 'string' && manifest['main'] !== '') main = manifest['main']
        }
      } catch {
        // version 读不到就退回 0.0.0：指纹仍然可用，只是升级识别粗一点。
      }
    }

    const entryRel = main.replace(/\\/g, '/').replace(/^\.\//, '')
    const entryEntry = files.get(entryRel)
    const lib: CandidateFile[] = []
    for (const rel of [...files.keys()].sort()) {
      if (rel === 'package.json' || rel === entryRel) continue
      if (!rel.startsWith('lib/') || !rel.endsWith('.js')) continue
      const file = files.get(rel)
      if (file !== undefined) lib.push(materialize(file))
    }
    candidates.push({
      name,
      version,
      entry: entryEntry === undefined ? null : materialize(entryEntry),
      lib,
      // 归档这一路不设文件数与深度上限：条目表已经在内存里，遍历不再读盘。
      truncated: false,
    })
  }
  return candidates
}

/** 解包目录里的官方包：`<根>/dsh/node_modules/@deepseek-ai/<包>`。 */
async function collectOfficialDirPackages(root: string, deadline: number): Promise<PackageCandidate[]> {
  const scope = join(root, 'dsh', 'node_modules', '@deepseek-ai')
  let entries
  try {
    entries = await readdir(scope, { withFileTypes: true })
  } catch {
    return []
  }
  const out: PackageCandidate[] = []
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (Date.now() > deadline) break
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = await collectDirPackage(join(scope, entry.name), '@deepseek-ai/' + entry.name)
    if (candidate !== null) out.push(candidate)
  }
  return out
}

async function collectCandidates(deadline: number): Promise<PackageCandidate[]> {
  const out: PackageCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: PackageCandidate | null): void => {
    if (candidate === null || seen.has(candidate.name)) return
    seen.add(candidate.name)
    out.push(candidate)
  }

  for (const profile of await profileDirs()) {
    if (Date.now() > deadline) break
    const manifest = await readJson(join(profile, 'package.json'))
    const deps = asRecord(manifest?.['dependencies'])
    if (deps === null) continue
    for (const name of Object.keys(deps).sort()) {
      if (Date.now() > deadline) break
      // profile 里装的就是这次真正挂载的那一份，同名时压过 asar 里的官方包。
      push(await collectDirPackage(join(profile, 'node_modules', ...name.split('/')), name))
    }
  }

  const root = officialRoot()
  if (root !== null) {
    if (root.kind === 'dir') {
      for (const candidate of await collectOfficialDirPackages(root.path, deadline)) push(candidate)
    } else {
      for (const candidate of await collectArchivePackages(root.path)) push(candidate)
    }
  }
  return out
}

/**
 * 指纹：每个候选包 `name@version@入口 mtime@lib 最大 mtime@文件数@总字节数`，
 * 排序后取 sha256 前 16 位。
 *
 * 后两项不是冗余：只比「最大 mtime」时，删掉一个非最新的 js（最大值不变）、或
 * 同毫秒内改写（时间戳不变）都会得到同一个指纹，于是缓存永远陈旧且没有提示。
 * 文件数挡第一种，字节数挡第二种的大部分。
 */
export function fingerprint(candidates: readonly PackageCandidate[]): string {
  const lines = candidates.map((candidate) => {
    let newest = 0
    let bytes = 0
    for (const file of candidate.lib) {
      if (file.mtime > newest) newest = file.mtime
      bytes += file.size
    }
    return (
      candidate.name +
      '@' +
      candidate.version +
      '@' +
      (candidate.entry?.mtime ?? 0) +
      '@' +
      newest +
      '@' +
      String(candidate.lib.length) +
      '@' +
      String(bytes)
    )
  })
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/* -------------------------------------------------------------------- 扫描 */

/** 包名拆成词，用来判断模板段前缀是不是这个包的一部分。 */
function packageTokens(name: string): Set<string> {
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const tokens = new Set<string>([name, bare])
  for (const token of bare.split(/[-_./]+/)) if (token !== '') tokens.add(token)
  return tokens
}

/** 跳字符串、模板、行注释，返回与 `start` 处 `{` 配对的 `}`。找不到返回 -1。 */
function matchBrace(text: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  let lineComment = false
  const limit = Math.min(text.length, start + MAX_SECTION_SPAN)
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (quote !== null) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 数一段表达式里字符串字面量的字符数，插值本身算 0 字符。
 *
 * 这是**估量**而不是精确值：插值部分按 0 计，实际文本只会更长。面板只用它排序，
 * 少算一点不改变任何决定。
 */
function literalLength(expression: string): number {
  let total = 0
  let index = 0
  while (index < expression.length) {
    const char = expression[index]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < expression.length) {
        const inner = expression[index]
        if (inner === '\\') {
          total += 1
          index += 2
          continue
        }
        if (inner === quote) {
          index += 1
          break
        }
        if (quote === '`' && inner === '$' && expression[index + 1] === '{') {
          let depth = 1
          index += 2
          while (index < expression.length && depth > 0) {
            if (expression[index] === '{') depth += 1
            else if (expression[index] === '}') depth -= 1
            index += 1
          }
          continue
        }
        total += 1
        index += 1
      }
      continue
    }
    index += 1
  }
  return total
}

/** 段本身的字符数：取注册体里第一个 `text:` 后面那段字面量。抓不到记 0。 */
function sectionLength(text: string, braceIndex: number): number {
  const end = matchBrace(text, braceIndex)
  if (end < 0) return 0
  const body = text.slice(braceIndex + 1, end)
  const marker = /\btext\s*:/.exec(body)
  if (marker === null) return 0
  const start = marker.index + marker[0].length
  return literalLength(body.slice(start, start + TEXT_WINDOW))
}

/** 从 `name:` 的窗口里取段名。字面量直接要；模板只取静态前缀，且必须是包名的一个词。 */
function sectionName(window: string, tokens: ReadonlySet<string>): { name: string; dynamic: boolean } | null {
  const literal = /name\s*:\s*'([^'\n]{1,200})'|name\s*:\s*"([^"\n]{1,200})"/.exec(window)
  if (literal !== null) {
    const name = literal[1] ?? literal[2]
    if (name !== undefined && name !== '') return { name, dynamic: false }
  }

  const template = /name\s*:\s*`([^`\n]{0,200})`/.exec(window)
  if (template === null) return null
  const inner = template[1] ?? ''
  const interpolation = inner.indexOf('${')
  const staticPart = interpolation < 0 ? inner : inner.slice(0, interpolation)
  const colon = staticPart.indexOf(':')
  if (colon <= 0) return null
  const token = staticPart.slice(0, colon)
  // 前缀对不上包名就不认：`tool:` 出现在几乎每个工具包里，乱认会把段归错人。
  if (!tokens.has(token)) return null
  return { name: staticPart.slice(0, colon + 1), dynamic: true }
}

interface ScanResult {
  readonly tools: readonly string[]
  readonly names: readonly string[]
  readonly sections: readonly string[]
  readonly sectionChars: number
  readonly toolsKnown: boolean
  readonly sectionsKnown: boolean
}

async function scanPackage(candidate: PackageCandidate, deadline: number): Promise<ScanResult> {
  const tools = new Set<string>()
  const names = new Set<string>()
  const sections = new Map<string, number>()
  const tokens = packageTokens(candidate.name)
  const seen = new Set<string>()
  /**
   * 这包是不是完整扫过。
   *
   * 候选清单自己就被上限砍过时，从第一个文件起就是残缺的：complete 初值 false，
   * 后面读文件失败或撞预算只是保持它。complete 是下游「要不要遮蔽 / 要不要显示未生效」
   * 的依据，说完整却少了一半文件，比说残缺更贵。
   */
  let complete = !candidate.truncated
  let dynamic = 0

  const files = candidate.entry === null ? candidate.lib : [candidate.entry, ...candidate.lib]
  for (const file of files) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    if (Date.now() > deadline) {
      complete = false
      break
    }
    let text: string
    try {
      text = await file.read()
    } catch {
      complete = false
      continue
    }

    for (const match of text.matchAll(TOOL_PATTERN)) {
      const name = match[1]
      if (name !== undefined) tools.add(name)
    }

    // 候选名不分结构，整份文本扫一遍：它是「这个包写过这些名字」，是不是工具由运行期裁。
    for (const match of text.matchAll(NAME_PATTERN)) {
      if (names.size >= MAX_NAMES_PER_PACKAGE) break
      const name = match[1]
      if (name !== undefined) names.add(name)
    }

    for (const match of text.matchAll(SECTION_PATTERN)) {
      const window = text.slice(match.index, match.index + NAME_WINDOW)
      const parsed = sectionName(window, tokens)
      if (parsed === null) continue
      const chars = parsed.dynamic ? 0 : sectionLength(text, match.index + match[0].length - 1)
      const previous = sections.get(parsed.name)
      if (previous === undefined || chars > previous) sections.set(parsed.name, chars)
      if (parsed.dynamic) dynamic += 1
    }
  }

  let sectionChars = 0
  for (const chars of sections.values()) sectionChars += chars

  return {
    tools: [...tools].sort(),
    names: [...names].sort(),
    sections: [...sections.keys()].sort(),
    sectionChars,
    // 工具名是字面量，文件全读到就算完整。
    toolsKnown: complete,
    // 有模板名的包，运行期还会长出没扫到的段名，这份清单天然不完整。
    sectionsKnown: complete && dynamic === 0,
  }
}

/* -------------------------------------------------------------------- 装配 */

async function writeCatalog(catalog: Catalog): Promise<void> {
  const path = catalogPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    // 拿锁后再看一眼 `manual`：用户可能刚把文件改成手写表，覆盖它会拿走唯一的手动入口。
    const latest = await readCachedEntry()
    if (latest !== null && latest.manual) return
    const body =
      JSON.stringify(
        {
          key: catalog.key,
          plugins: catalog.plugins,
          orphanTools: catalog.orphanTools,
          orphanSections: catalog.orphanSections,
          complete: catalog.complete,
        },
        null,
        2,
      ) + '\n'
    await writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 })
    // 写盘后旧的内存副本一定过期。
    memo = null
  })
}

/**
 * 读目录：缓存命中直接返回，否则扫描并写盘。
 *
 * 指纹 = 各包 `name@version` + 入口 mtime 的哈希，对不上就重扫。
 */
async function loadCatalog(options?: CatalogLoadOptions): Promise<Catalog> {
  // 写盘失败只降级成日志：默认空函数，调用方没接就不是错误。
  const warn = options?.warn ?? (() => undefined)
  const cached = await readCachedEntry()
  // 手写表优先级最高：直接采用，不重扫也不覆盖，`force` 也不例外。
  if (cached !== null && cached.manual) return toCatalog(cached)

  const deadline = Date.now() + SCAN_BUDGET_MS
  const candidates = await collectCandidates(deadline)
  const key = fingerprint(candidates)

  // 残缺缓存（complete: false）不短路：它有东西可用，但结果不可信，必须重扫。
  // 否则一次超时或 IO 失败会把「少识别几个包」固化成永久的缓存。
  // `shaped` 单独判：指纹只看包的字节，不看扫描器版本，旧格式缓存必须重扫一次。
  if (
    options?.force !== true &&
    cached !== null &&
    cached.complete !== false &&
    cached.shaped &&
    cached.key === key
  ) {
    return toCatalog(cached)
  }

  const plugins: PluginContribution[] = []
  // "truncated" 与包自己的 known 标志必须分开：
  // - truncated：预算或 IO 把扫描**掐断**了，结果缺一块，写盘会把残缺固化成缓存；
  // - sectionsKnown=false：该包有模板段名（`tool:${name}` 之类），归属天然不完整，
  //   但这是稳定的事实，不是残缺——它绝不能阻止写盘。
  // 混用这两者会让任何带模板段名的包（dsh-tool-fs、dsh-mcp-client…）把缓存永久顶掉，
  // 于是每次请求都重扫、`readCachedCatalog()` 永远返回 null、面板永远停在「识别中」。
  let truncated = false
  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    const scanned = await scanPackage(candidate, deadline)
    if (!scanned.toolsKnown) truncated = true
    plugins.push({
      pkg: candidate.name,
      tools: scanned.tools,
      names: scanned.names,
      sections: scanned.sections,
      // 扫描拿不到 schema 投影，工具体量留给运行期清单补；这里只保留字段。
      toolVolume: 0,
      sectionChars: scanned.sectionChars,
      toolsKnown: scanned.toolsKnown,
      sectionsKnown: scanned.sectionsKnown,
    })
  }
  plugins.sort((left, right) => (left.pkg < right.pkg ? -1 : left.pkg > right.pkg ? 1 : 0))

  // 孤儿要跟运行期清单求差才知道，静态扫描给不出来。留空数组，面板自己算。
  const catalog: Catalog = { key, plugins, orphanTools: [], orphanSections: [], complete: !truncated }

  /**
   * **残缺也落盘**，只是带 `complete: false`。
   *
   * 以前撞预算或读不到文件就干脆不写，于是 `readCachedCatalog()` 永远返回 null：
   * 面板停在「识别中」、hooks 侧的策略全程不生效，而每次请求又会重跑一轮 5 秒预算的
   * 扫描。现在读侧至少有东西可用，`loadCatalog` 也不会拿 `complete: false` 短路扫描。
   */
  try {
    await writeCatalog(catalog)
  } catch (error) {
    // 写不进去（只读 home、权限、占用）只影响下次冷启动要重扫；抛出去会让调用方
    // 丢掉这一轮刚扫到的结果。但也不能像以前那样整个吞掉：没有这条日志，
    // 「面板一直停在识别中」就查不出是缓存根本没落盘。
    warn('dsh-plugin-pack: 插件目录缓存没写成，下次会重扫：' + String(error))
  }
  return catalog
}

/* ------------------------------------------------------------ 候选名归属 */

/**
 * 候选名 → 包名，只保留**唯一**且**未被任何包认领**的那些。
 *
 * 三条同时成立才算：
 * - 名字出现在这个包的源码里（`names`）；
 * - 没有第二个包也写过它：注释、文档、示例都会让一个名字出现在多处，此时放弃；
 * - 没有包在静态扫描里已经认领它：`tools` 是结构化证据，比候选硬。
 *
 * 失手的方向只有「漏」：认不出的名字留在孤儿里，任何开关都管不到——这与 ADR 0001
 * 「宁可少省，也不误删别人的段」是同一条取舍。
 */
export function candidateOwners(catalog: Catalog): Map<string, string> {
  const claimed = new Set<string>()
  for (const plugin of catalog.plugins) for (const name of plugin.tools) claimed.add(name)

  const owners = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const plugin of catalog.plugins) {
    for (const name of plugin.names ?? []) {
      if (claimed.has(name) || ambiguous.has(name)) continue
      const previous = owners.get(name)
      if (previous === undefined) {
        owners.set(name, plugin.pkg)
      } else if (previous !== plugin.pkg) {
        // 两个包都写过这个名字：归属不确定，宁可不要。
        owners.delete(name)
        ambiguous.add(name)
      }
    }
  }
  return owners
}

const candidateCache = new WeakMap<Catalog, Map<string, Set<string>>>()

/**
 * 每个包由候选名补上的工具名。
 *
 * 缓存命中时 `Catalog` 是同一个对象，按身份缓存即可；hooks 的工具掩码与面板的
 * 工具数读的是同一份，两边不会各算一套。
 */
export function candidateTools(catalog: Catalog): Map<string, Set<string>> {
  const hit = candidateCache.get(catalog)
  if (hit !== undefined) return hit
  const out = new Map<string, Set<string>>()
  for (const [name, pkg] of candidateOwners(catalog)) {
    let set = out.get(pkg)
    if (set === undefined) {
      set = new Set<string>()
      out.set(pkg, set)
    }
    set.add(name)
  }
  candidateCache.set(catalog, out)
  return out
}

/* ------------------------------------------------------------------ 读写面 */

/**
 * 插件目录的读写面。
 *
 * 抽成接口不是为了「可替换」，是为了测试能在一份固定的归属表上跑：
 * 真实扫描要读整个 profile 的 node_modules，用例里跑一遍要几百毫秒且随机器变化。
 * 生产路径永远用 defaultCatalogFeed。
 */
export interface CatalogFeed {
  read(): Catalog | null
  load(options?: CatalogLoadOptions): Promise<Catalog>
}

/** 载入选项。`warn` 用来接「缓存没写成，下次会重扫」这类不致命的问题。 */
export interface CatalogLoadOptions {
  readonly force?: boolean
  readonly warn?: (message: string) => void
}

/**
 * 生产用的唯一实例。
 *
 * 必须是模块级单例：routes 的扫描去重按 feed 的**对象身份**索引（一个 feed 一份
 * ScanState，scanning 同时充当并发锁），hooks 与 index 的预热也必须落在同一份状态上。
 * 各处各造一个，两个请求同时进来就会各扫一遍，去重与 60 秒退避一起失效。
 */
export const defaultCatalogFeed: CatalogFeed = {
  read: () => readCachedCatalog(),
  load: (options) => loadCatalog(options),
}
