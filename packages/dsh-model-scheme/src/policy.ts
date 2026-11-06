/**
 * 配置读写与求值链（纯函数）：工作区绑定、全局方案，外加提示词覆盖文件。
 *
 * 提示词覆盖与方案正交（spec §6.3.1）：所有方案共用一份，路径同样是注入的 `home`。
 * 合并逻辑不在这里——这里只负责把文件读上来、把命令落到盘上。
 *
 * 求值链严格三段（spec §4）：
 *   工作区 `schemeId` 指向的方案存在 → 否则全局 `defaultSchemeId` 指向的方案存在
 *   → 否则出厂方案 `BUILTIN`。
 *
 * 不 import 任何宿主服务、不读宿主事件：这里的输入只有路径与命令，
 * 目的是让这些规则能在 `os.tmpdir()` 下被完整验证，而不依赖 DSH 进程。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  BUILTIN_SCHEME,
  BUILTIN_SCHEME_ID,
  EMPTY_BINDING,
  EMPTY_PROMPTS,
  EMPTY_STORE,
  TIER_IDS,
  isTierId,
  parsePromptOverrides,
  parseScheme,
  parseSchemeStore,
  parseWorkspaceBinding,
  serializePromptOverrides,
  serializeSchemeStore,
  serializeWorkspaceBinding,
  type PromptOverrides,
  type PromptTierOverride,
  type Scheme,
  type SchemeStore,
  type WorkspaceBinding,
} from './scheme.js'

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/**
 * 注入用的根覆盖。
 *
 * `home` 只在测试与显式配置时用；缺省走 `dshHomePath`（`$DSH_HOME` 或 `~/.dsh`）。
 * 工作区层不需要这个覆盖：它由 cwd 决定，cwd 本身就是注入点。
 */
export interface SchemePathOptions {
  /** 全局层根目录；缺省为 DSH home。 */
  readonly home?: string
}

/** `$DSH_HOME/model-scheme/schemes.json`：全局层。 */
export function globalSchemePath(options: SchemePathOptions = {}): string {
  const home = options.home
  if (home === undefined || home.trim() === '') return dshHomePath('model-scheme', 'schemes.json')
  return join(home, 'model-scheme', 'schemes.json')
}

/** `$DSH_HOME/model-scheme/prompts.json`：提示词覆盖（与方案正交，全局一份）。 */
export function globalPromptsPath(options: SchemePathOptions = {}): string {
  const home = options.home
  if (home === undefined || home.trim() === '') return dshHomePath('model-scheme', 'prompts.json')
  return join(home, 'model-scheme', 'prompts.json')
}

/** `<cwd>/.dsh/model-scheme.json`：某个工作区的那一层。 */
export function workspaceSchemePath(cwd: string): string {
  return join(cwd, '.dsh', 'model-scheme.json')
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/** 两层配置加提示词覆盖的当前状态。 */
export interface SchemeState {
  readonly global: SchemeStore
  readonly workspace: WorkspaceBinding
  /** 提示词覆盖；缺省字段跟随内置（spec §6.3.1）。 */
  readonly prompts: PromptOverrides
  readonly warnings: readonly string[]
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

/**
 * 读一份文本，不存在返回 `undefined`。
 *
 * 其余读取错误（权限、路径穿过文件）也按「没有这一层」处理并留一条 warning：
 * 读失败不该让会话建不出来。风险是可能覆盖一个读不了的文件，所以写入前会再读一次，
 * 那一次失败就跳过写入（见 transact）。
 */
async function readText(path: string, warnings: string[]): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    warnings.push(`读取 ${path} 失败，已按缺省处理：${String(error)}`)
    return undefined
  }
}

/**
 * 读两层配置。
 *
 * `cwd` 为 `null` 时只有全局层：工作区粒度需要目录，没有目录就没有那一层。
 * 解析失败由 scheme.ts 降级成缺省值并附说明，这里只负责把文件读上来。
 */
export async function loadState(cwd: string | null, options: SchemePathOptions = {}): Promise<SchemeState> {
  const warnings: string[] = []
  // 路径同时传给解析器：坏 JSON 的 warning 里带上它，面板才能直接定位到文件。
  const storePath = globalSchemePath(options)
  const storeParsed = parseSchemeStore(await readText(storePath, warnings), storePath)
  warnings.push(...storeParsed.warnings)

  const promptsPath = globalPromptsPath(options)
  const promptsParsed = parsePromptOverrides(await readText(promptsPath, warnings), promptsPath)
  warnings.push(...promptsParsed.warnings)

  let workspace: WorkspaceBinding = EMPTY_BINDING
  if (cwd !== null && cwd.trim() !== '') {
    const bindingPath = workspaceSchemePath(cwd)
    const bindingParsed = parseWorkspaceBinding(await readText(bindingPath, warnings), bindingPath)
    warnings.push(...bindingParsed.warnings)
    workspace = bindingParsed.value
  }

  return { global: storeParsed.value, workspace, prompts: promptsParsed.value, warnings }
}

/* ------------------------------------------------------------------ *
 * 求值链
 * ------------------------------------------------------------------ */

/** 取值来自哪一层。面板据此显示「跟随」还是「绑定失效」。 */
export type SchemeSource = 'workspace' | 'global' | 'builtin'

export interface ResolvedScheme {
  readonly id: string
  readonly scheme: Scheme
  /** 最终用了哪一层。 */
  readonly source: SchemeSource
  /** 工作区绑定指向已删方案：面板标「绑定失效」。 */
  readonly brokenBinding: boolean
  readonly warnings: readonly string[]
}

function builtin(brokenBinding: boolean, warnings: readonly string[]): ResolvedScheme {
  return { id: BUILTIN_SCHEME_ID, scheme: BUILTIN_SCHEME, source: 'builtin', brokenBinding, warnings }
}

/**
 * 求值链。
 *
 * `cwd` 只用来把 warning 写成可读的一句话（例如点明是哪个工作区的绑定失效），
 * 求值本身不需要它——工作区层已经随 `loadState(cwd)` 读进 `state` 了。
 *
 * 绑定失效时**不修文件**：工作区层原样留着那个已删的 id，面板据此标红，
 * 重新建出同名方案即自动恢复。
 */
export function resolve(state: SchemeState, cwd?: string | null): ResolvedScheme {
  const warnings: string[] = []
  const bound = state.workspace.schemeId
  const where = cwd === undefined || cwd === null || cwd === '' ? '' : `「${cwd}」处的工作区`

  let brokenBinding = false
  if (bound !== undefined && bound !== '') {
    if (bound === BUILTIN_SCHEME_ID) return builtin(false, warnings)
    const scheme = state.global.schemes[bound]
    if (scheme !== undefined) {
      return { id: bound, scheme, source: 'workspace', brokenBinding: false, warnings }
    }
    brokenBinding = true
    warnings.push(`${where}绑定的方案「${bound}」已不存在，已回落全局默认`)
  }

  const fallbackId = state.global.defaultSchemeId
  if (fallbackId !== undefined && fallbackId !== '') {
    if (fallbackId === BUILTIN_SCHEME_ID) return builtin(brokenBinding, warnings)
    const scheme = state.global.schemes[fallbackId]
    if (scheme !== undefined) {
      return { id: fallbackId, scheme, source: 'global', brokenBinding, warnings }
    }
    warnings.push(`全局默认方案「${fallbackId}」已不存在，已回落出厂方案`)
  }

  return builtin(brokenBinding, warnings)
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/**
 * 写入意图。都是**绝对状态**（「让这个键等于这个值」），因此幂等且彼此可交换；
 * 同一键的多条命令后写者赢，这与用户连点两次下拉框的预期一致。
 *
 * `null` 表示删键（= 跟随上一层），不是写 null。
 */
export type SchemeCommand =
  | { readonly op: 'setDefaultScheme'; readonly schemeId: string | null }
  | { readonly op: 'putScheme'; readonly schemeId: string; readonly scheme: unknown }
  | { readonly op: 'deleteScheme'; readonly schemeId: string }
  | { readonly op: 'bindWorkspace'; readonly schemeId: string | null }
  | {
      readonly op: 'putPrompts'
      readonly delegation?: string | null
      readonly tiers?: Readonly<Record<string, PromptTierPatch | null>>
    }
  | { readonly op: 'resetPrompts'; readonly keys?: readonly string[] | null }

/** 一档提示词的三态补丁：字符串写入，`null` 删该字段，键不存在则不动。 */
export interface PromptTierPatch {
  readonly label?: string | null
  readonly text?: string | null
}

function isGlobalCommand(command: SchemeCommand): boolean {
  return command.op !== 'bindWorkspace'
}

/** 落到方案文件的那几条。只改提示词时不该顺手重写 schemes.json。 */
function touchesSchemeStore(command: SchemeCommand): boolean {
  return command.op === 'setDefaultScheme' || command.op === 'putScheme' || command.op === 'deleteScheme'
}

/** 落到提示词文件的那几条。 */
function touchesPrompts(command: SchemeCommand): boolean {
  return command.op === 'putPrompts' || command.op === 'resetPrompts'
}

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：withFileLock 用 `wx` 直接建 `.lock` 兄弟文件，它不建父目录。
 * 读失败（非 ENOENT）时跳过写入而不是覆盖——读不到就写等于拿缺省值抹掉别人的配置。
 */
async function transact(
  path: string,
  mutate: (current: string | undefined) => string,
  warnings: string[],
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await withFileLock(path, async () => {
      let current: string | undefined
      try {
        current = await readFile(path, 'utf8')
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          warnings.push(`写入前读取 ${path} 失败，已跳过本次写入：${String(error)}`)
          return
        }
        current = undefined
      }
      await writeFileAtomic(path, mutate(current), { mode: 0o600, dirMode: 0o700 })
    })
  } catch (error) {
    warnings.push(`写入 ${path} 失败：${String(error)}`)
  }
}

function applyToStore(current: string | undefined, commands: readonly SchemeCommand[], warnings: string[]): string {
  const parsed = parseSchemeStore(current)
  warnings.push(...parsed.warnings)

  const schemes: Record<string, Scheme> = { ...parsed.value.schemes }
  let defaultSchemeId = parsed.value.defaultSchemeId

  for (const command of commands) {
    if (command.op === 'setDefaultScheme') {
      // 不校验存在性：校验会让同一批命令的先后顺序影响结果。
      // 指向未知方案由 resolve 降级成出厂方案并留 warning（见 resolve）。
      const id = command.schemeId
      defaultSchemeId = id === null || id.trim() === '' ? undefined : id
      continue
    }

    if (command.op === 'putScheme') {
      const id = command.schemeId.trim()
      if (id === '') {
        warnings.push('方案 id 不能为空，已忽略')
        continue
      }
      if (id === BUILTIN_SCHEME_ID) {
        warnings.push(`出厂方案「${BUILTIN_SCHEME_ID}」不可覆盖，已忽略`)
        continue
      }
      const scheme = parseScheme(command.scheme, id)
      warnings.push(...scheme.warnings)
      if (scheme.value === null) continue
      schemes[id] = scheme.value
      continue
    }

    if (command.op === 'deleteScheme') {
      const id = command.schemeId.trim()
      if (id === BUILTIN_SCHEME_ID) {
        warnings.push(`出厂方案「${BUILTIN_SCHEME_ID}」不可删除，已忽略`)
        continue
      }
      if (!Object.hasOwn(schemes, id)) {
        warnings.push(`方案「${id}」不存在，删除已忽略`)
        continue
      }
      // 只删方案本身，不动 defaultSchemeId：顺手清键会让「先设默认再删」
      // 与「先删再设默认」写出不同的文件，破坏命令的可交换性。
      delete schemes[id]
    }
  }

  return serializeSchemeStore({ schemes, ...(defaultSchemeId === undefined ? {} : { defaultSchemeId }) })
}

/**
 * 一个提示词字段的三态补丁。
 *
 * 空串是坏输入：降级成「不动」并留 warning——严格拒绝在路由层，那里能给出 bad-request。
 * 这里宽容是因为它同时服务手写文件与内部调用，抛错会把一次保存整批废掉。
 */
function patchField(
  current: string | undefined,
  patch: string | null | undefined,
  label: string,
  warnings: string[],
): string | undefined {
  if (patch === undefined) return current
  if (patch === null) return undefined
  const value = patch.trim()
  if (value === '') {
    warnings.push(`${label} 不能为空串，已忽略`)
    return current
  }
  return value
}

/**
 * 应用提示词类命令。
 *
 * `putPrompts` 是绝对状态：给了哪个键就设哪个键，`null` 删键（= 恢复内置）。
 * `resetPrompts` 不传 keys 即全部恢复内置；落盘表现同样是删键，不写空串。
 */
function applyToPrompts(
  current: string | undefined,
  commands: readonly SchemeCommand[],
  warnings: string[],
): string {
  const parsed = parsePromptOverrides(current)
  warnings.push(...parsed.warnings)

  let delegation = parsed.value.delegation
  const tiers: Partial<Record<(typeof TIER_IDS)[number], PromptTierOverride>> = { ...parsed.value.tiers }

  for (const command of commands) {
    if (command.op === 'putPrompts') {
      delegation = patchField(delegation, command.delegation, 'putPrompts 的 delegation', warnings)
      const patches = command.tiers
      if (patches === undefined || patches === null) continue
      for (const [key, patch] of Object.entries(patches)) {
        if (!isTierId(key)) {
          warnings.push(`putPrompts 有不存在的档 id「${key}」，已忽略`)
          continue
        }
        if (patch === null) {
          delete tiers[key]
          continue
        }
        const previous = tiers[key]
        const label = patchField(previous?.label, patch.label, `putPrompts 的 tiers.${key}.label`, warnings)
        const text = patchField(previous?.text, patch.text, `putPrompts 的 tiers.${key}.text`, warnings)
        if (label === undefined && text === undefined) {
          delete tiers[key]
          continue
        }
        tiers[key] = {
          ...(label === undefined ? {} : { label }),
          ...(text === undefined ? {} : { text }),
        }
      }
      continue
    }

    if (command.op === 'resetPrompts') {
      const keys = command.keys
      if (keys === undefined || keys === null) {
        delegation = undefined
        for (const tierId of TIER_IDS) delete tiers[tierId]
        continue
      }
      for (const raw of keys) {
        const key = raw.trim()
        if (key === 'delegation') {
          delegation = undefined
          continue
        }
        if (isTierId(key)) {
          delete tiers[key]
          continue
        }
        warnings.push(`resetPrompts 有不存在的键「${raw}」，已忽略`)
      }
    }
  }

  return serializePromptOverrides({
    ...(delegation === undefined ? {} : { delegation }),
    tiers,
  })
}

function applyToBinding(
  current: string | undefined,
  commands: readonly SchemeCommand[],
  warnings: string[],
): string {
  const parsed = parseWorkspaceBinding(current)
  warnings.push(...parsed.warnings)

  let schemeId = parsed.value.schemeId
  for (const command of commands) {
    if (command.op !== 'bindWorkspace') continue
    // 与 setDefaultScheme 同理：不校验存在性，悬空绑定由 resolve 降级并报「绑定失效」。
    //
    // 出厂方案归一化成「未绑定」：工作区只有两种状态——单独指定某个方案，或不指定、
    // 落到全局。出厂方案是全局层的取值，不是目录能直接指向的目标。求值上两者等价，
    // 但数据里留一个 builtin 会让「哪些目录单独指定了方案」的判断多一种特例。
    const raw = command.schemeId === BUILTIN_SCHEME_ID ? null : command.schemeId
    const id = raw
    schemeId = id === null || id.trim() === '' ? undefined : id
  }
  return serializeWorkspaceBinding({ ...(schemeId === undefined ? {} : { schemeId }) })
}

/**
 * 应用一批意图，返回落盘后的完整状态。
 *
 * 顺序固定（全局层 → 工作区层），两个文件各自一把锁，不会交叉等待。
 * 唯一会抛的是调用方错误：带了工作区命令却没给 cwd——那不是坏输入降级的问题，
 * 是调用点拿不到目录，静默忽略会让 UI 显示「已绑定」而磁盘上什么都没有。
 */
export async function applyCommands(
  cwd: string | null,
  commands: readonly SchemeCommand[],
  options: SchemePathOptions = {},
): Promise<SchemeState> {
  const wantsWorkspace = commands.some((command) => !isGlobalCommand(command))
  if (wantsWorkspace && (cwd === null || cwd.trim() === '')) {
    throw new Error('工作区命令缺少工作目录（cwd）')
  }
  const root = cwd === null || cwd.trim() === '' ? null : cwd

  const warnings: string[] = []
  if (commands.some(touchesSchemeStore)) {
    await transact(globalSchemePath(options), (current) => applyToStore(current, commands, warnings), warnings)
  }
  // 提示词覆盖是全局层的一份独立文件，与方案文件各自一把锁。
  if (commands.some(touchesPrompts)) {
    await transact(globalPromptsPath(options), (current) => applyToPrompts(current, commands, warnings), warnings)
  }
  if (wantsWorkspace && root !== null) {
    await transact(workspaceSchemePath(root), (current) => applyToBinding(current, commands, warnings), warnings)
  }

  const state = await loadState(root, options)
  return { ...state, warnings: [...state.warnings, ...warnings] }
}

/** 一份空状态，供不读盘的调用点（如测试替身）构造。 */
export const EMPTY_STATE: SchemeState = {
  global: EMPTY_STORE,
  workspace: EMPTY_BINDING,
  prompts: EMPTY_PROMPTS,
  warnings: [],
}
