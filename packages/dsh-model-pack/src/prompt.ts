/**
 * 委派系统提示词段（spec §6.3 / §6.3.1）。
 *
 * 段名固定 `model-pack.delegation`，只在 `subagent_tier` 注册成功后由编排层注入；
 * 注入条件与顺序见 spec §6.1（先注册成功，再 deny 官方工具，最后注入本段）。
 *
 * 这段做四件事：判断要不要派、按难度选档、要求检查点与自足交付、压过官方那段
 * 「Start independent delegations with subagent_fork」的残留推荐——独立任务一律走
 * `subagent_tier`，`subagent_fork` 只留给需要本对话上下文的任务。
 *
 * 判据、检查点、交付契约放在这里而不是用户 AGENTS.md：它们随工具是否存在而变化，
 * 且只需父会话看到——子代理自己会读 AGENTS.md，读到「要不要继续嵌套委派」反而有害。
 *
 * 两条硬约束（spec §6.3.1）：
 * 1. 段内容只能来自配置与内置常量，**不拼 pack 名、模型名、cwd 这类随会话变化的值**——
 *    否则前缀每次会话都不一样，KV cache 复用就没了。
 * 2. 段内不出现任何 provider / model 名。用户覆盖同样受此约束，校验在写入侧。
 *
 * 内置文本与用户覆盖的关系：逐键合并，用户有则用用户，无则用内置；空串等于缺省。
 */

import { TIER_DEFAULT_NAMES, TIER_IDS, type PromptOverrides, type TierId } from './pack.js'
import type { ResolvedPack } from './policy.js'

/** 段名。编排层按这个名字写入系统提示词。 */
export const DELEGATION_SECTION_NAME = 'model-pack.delegation'

/** 段文本的 token 上限（spec §6.3：段 ≤450，实测占用见 spec 预算表）。 */
export const DELEGATION_MAX_TOKENS = 450

/** 一段待注入的系统提示词。 */
export interface DelegationSection {
  name: string
  text: string
}

/** 一档的判定线索：显示名 + 一句话判据。 */
export interface PromptTierText {
  readonly label: string
  readonly text: string
}

/** 一类提示词文本：编排段 + 四档线索。解析后的形状，字段齐全。 */
export interface PromptText {
  readonly delegation: string
  readonly tiers: Readonly<Record<TierId, PromptTierText>>
}

/**
 * 编排段的插入点。
 *
 * 内置编排段由「前四行 + 空行 + 后五行」组成，档位表落在空行处，前后各隔一行。
 * 用户覆盖若也留了空行就落在同一处，没留就接在末尾——这样覆盖整段不必知道占位符的存在。
 */
const TIER_SLOT = '\n\n'

/**
 * 内置编排段：派不派 → 派给谁 → 怎么派 → 怎么收。
 *
 * 用英文，与宿主其余内置提示词一致：系统提示词是给模型读的，不随界面语言变。
 * 措辞可压缩，含义不可改；不含任何 provider / model 名（测试会断言）。
 */
const DELEGATION = [
  'Delegate only when both hold: the process produces material this conversation never needs, and the result compresses into one quotable paragraph.',
  'Plan before delegating: order by the dependency graph and scope by write ownership.',
  'Start independent delegations together in one message, keep working while they run, and list the dispatched tracks at the end.',
  'Always delegate through subagent_tier and pick the tier by task difficulty; never guess a model yourself:',
  '',
  'When unsure, take the higher tier; security or data migration goes straight to tier4; a reading-only task with no synthesis stays tier1.',
  'Use subagent_fork only when the task needs this conversation\'s context; independent tasks must not use it.',
  'Give every delegation a checkpoint path; the child appends confirmed facts with file:line, ruled-out hypotheses, and the current blocker when a conclusion lands or past ~15 tool calls. Cap a single delegation at about 40 tool calls; past that, return what you have and let the parent decide whether to continue.',
  'A returned result must stand alone: conclusion, evidence locations, what was not done, what is still uncertain.',
  'Before finishing, check every delegation package item by item; a missed scope or an out-of-bounds change is a defect.',
].join('\n')

/**
 * 内置提示词。用户覆盖缺省时逐键回落到这里。
 *
 * 档名与 `TIER_DEFAULT_NAMES` 同源：面板上的出厂名与提示词里的档名不能是两套。
 * 正文用英文（与宿主其余内置提示词一致），档名保留中文——它是面板上的显示名。
 */
export const BUILTIN_PROMPT: PromptText = {
  delegation: DELEGATION,
  tiers: {
    tier1: { label: TIER_DEFAULT_NAMES.tier1, text: 'Reads and reports with citations; never writes. For answers that live in the files, not in your judgment.' },
    tier2: { label: TIER_DEFAULT_NAMES.tier2, text: 'Change whose shape an existing pattern or the request already fixes; may read, decides nothing.' },
    tier3: { label: TIER_DEFAULT_NAMES.tier3, text: 'Write work needing a decision: choose among approaches, or keep several modules consistent.' },
    tier4: { label: TIER_DEFAULT_NAMES.tier4, text: 'Cause or target unknown: architecture, concurrency bugs, security, data migration.' },
  },
}

/**
 * 保守 token 估算：CJK 与全角标点每字符计 1 token，其余每 4 字符计 1 token。
 *
 * 不引入分词器，只求「不会低估」。段文本里中文占多数，这个估算比真实值偏大，
 * 因此断言它不超限就足够安全。
 */
export function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if (isWide(char)) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/** CJK 部首、假名、统一表意、全角标点与全角形式：一律按 1 token 计。 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  if (code >= 0x2e80 && code <= 0x9fff) return true
  if (code >= 0xf900 && code <= 0xfaff) return true
  if (code >= 0x3000 && code <= 0x303f) return true
  return code >= 0xff00 && code <= 0xffef
}

/** 用户有则用用户，无则用内置。空串与纯空白都算「没有覆盖」。 */
function prefer(override: string | undefined, builtin: string): string {
  return override !== undefined && override.trim() !== '' ? override.trim() : builtin
}

/**
 * 逐键合并用户覆盖与内置，返回生效值。
 *
 * 纯数据、不读 IO：读文件是 policy 的事，这一层只做合并，便于在任何地方复算。
 * 同一份覆盖必须永远得到同一份文本——这是前缀复用的前提。
 */
export function resolvePrompt(overrides?: PromptOverrides | null): PromptText {
  const tiers: Record<TierId, PromptTierText> = {
    tier1: { label: '', text: '' },
    tier2: { label: '', text: '' },
    tier3: { label: '', text: '' },
    tier4: { label: '', text: '' },
  }
  for (const tierId of TIER_IDS) {
    const builtin = BUILTIN_PROMPT.tiers[tierId]
    const override = overrides?.tiers?.[tierId]
    tiers[tierId] = {
      label: prefer(override?.label, builtin.label),
      text: prefer(override?.text, builtin.text),
    }
  }
  return { delegation: prefer(overrides?.delegation, BUILTIN_PROMPT.delegation), tiers }
}

/**
 * 档名与判据：`resolvePrompt` 已把用户覆盖与内置合并好（空串也算没覆盖），
 * 这里直接取生效值。pack 里的档位显示名只进工具描述，不进系统提示词。
 */
function labelOf(tierId: TierId, prompt: PromptText): string {
  return prompt.tiers[tierId].label
}

function textOf(tierId: TierId, prompt: PromptText): string {
  return prompt.tiers[tierId].text
}

/** 把档位表放进编排段：有插入点就落在插入点，没有就接在末尾。 */
function compose(delegation: string, rows: readonly string[]): string {
  const base = delegation.trim()
  const at = base.indexOf(TIER_SLOT)
  if (at < 0) return [base, ...rows].join('\n')
  const head = base.slice(0, at)
  const tail = base.slice(at + TIER_SLOT.length)
  return `${head}${TIER_SLOT}${rows.join('\n')}${TIER_SLOT}${tail}`
}

/**
 * 该 pack 有至少一个可用档位时返回段文本，否则 `null`。
 *
 * 没有可用档就别注入：那时 `subagent_tier` 不会注册，段里提到的工具名会指向一个
 * 不存在的工具——比不注入更糟。
 *
 * `prompt` 是 `resolvePrompt` 的结果；缺省按内置算，调用点不必先合并一遍。
 * 只列 `resolved.pack.tiers` 里**真的配了**的档，与工具描述的可选档保持一致。
 */
export function delegationSection(
  resolved: ResolvedPack | null | undefined,
  prompt?: PromptText | null,
): DelegationSection | null {
  const packTiers = resolved?.pack?.tiers
  const usable = TIER_IDS.filter((tierId) => packTiers?.[tierId] !== undefined)
  if (usable.length === 0) return null

  const text = prompt ?? resolvePrompt()
  const rows = usable.map(
    (tierId) => `${tierId} ${labelOf(tierId, text)} — ${textOf(tierId, text)}`,
  )
  return { name: DELEGATION_SECTION_NAME, text: compose(text.delegation, rows) }
}
