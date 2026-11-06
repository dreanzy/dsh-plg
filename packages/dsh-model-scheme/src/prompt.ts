/**
 * 委派系统提示词段（spec §6.3 / §6.3.1）。
 *
 * 段名固定 `model-scheme.delegation`，只在 `subagent_tier` 注册成功后由编排层注入；
 * 注入条件与顺序见 spec §6.1（先注册成功，再 deny 官方工具，最后注入本段）。
 *
 * 这段的唯一职责是压过官方那段「Start independent delegations with subagent_fork」的
 * 残留推荐：独立任务一律走 `subagent_tier`，`subagent_fork` 只留给需要本对话上下文的任务。
 *
 * 两条硬约束（spec §6.3.1）：
 * 1. 段内容只能来自配置与内置常量，**不拼方案名、模型名、cwd 这类随会话变化的值**——
 *    否则前缀每次会话都不一样，KV cache 复用就没了。
 * 2. 段内不出现任何 provider / model 名。用户覆盖同样受此约束，校验在写入侧。
 *
 * 内置文本与用户覆盖的关系：逐键合并，用户有则用用户，无则用内置；空串等于缺省。
 */

import { TIER_DEFAULT_NAMES, TIER_IDS, type PromptOverrides, type TierId } from './scheme.js'
import type { ResolvedScheme } from './policy.js'

/** 段名。编排层按这个名字写入系统提示词。 */
export const DELEGATION_SECTION_NAME = 'model-scheme.delegation'

/** 段文本的 token 上限（spec §6.3：段 ≤350）。 */
export const DELEGATION_MAX_TOKENS = 350

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
 * 内置编排段由「前两行 + 空行 + 后四行」组成，档位表落在空行处；用户覆盖若也留了
 * 空行就落在同一处，没留就接在末尾——这样覆盖整段不必知道占位符的存在。
 */
const TIER_SLOT = '\n\n'

/**
 * 内置编排段：切轨道 + 选档纪律 + 并行与收尾。
 *
 * 措辞可压缩，含义不可改；不含任何 provider / model 名（测试会断言）。
 */
const DELEGATION = [
  '派活之前先切轨道：依赖图定顺序，写权表定范围，互不重叠的才并行。',
  '委派一律走 subagent_tier，按任务难度选档，不要自己猜模型：',
  '',
  '拿不准取高一档；触及数据迁移、安全边界或并发，直接 tier4。',
  '只有需要本对话上下文才用 subagent_fork，独立任务不要用它。',
  '同一消息里并行发起互不依赖的委派；派完继续干活，不要空等或轮询；结束时列出已派轨道。',
  '收尾逐项核对委派包，漏范围与越界都算缺陷。',
].join('\n')

/**
 * 内置提示词。用户覆盖缺省时逐键回落到这里。
 *
 * 档名与 `TIER_DEFAULT_NAMES` 同源：面板上的出厂名与提示词里的档名不能是两套。
 */
export const BUILTIN_PROMPT: PromptText = {
  delegation: DELEGATION,
  tiers: {
    tier1: { label: TIER_DEFAULT_NAMES.tier1, text: '只读定位，产出是带引用的上下文' },
    tier2: { label: TIER_DEFAULT_NAMES.tier2, text: '定义明确，1-3 个文件，验收一句话能说清' },
    tier3: { label: TIER_DEFAULT_NAMES.tier3, text: '需先读后判改法，4 个以上文件或跨模块一致' },
    tier4: { label: TIER_DEFAULT_NAMES.tier4, text: '根因不明，涉及架构取舍、并发、安全、数据迁移' },
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

/** 档名：用户覆盖的 label → 内置 label → 方案里的显示名。 */
function labelOf(tierId: TierId, schemeName: string | undefined, prompt: PromptText): string {
  const fromPrompt = prompt.tiers[tierId]?.label ?? ''
  if (fromPrompt.trim() !== '') return fromPrompt.trim()
  const fromBuiltin = BUILTIN_PROMPT.tiers[tierId].label
  if (fromBuiltin.trim() !== '') return fromBuiltin.trim()
  return schemeName ?? TIER_DEFAULT_NAMES[tierId]
}

/** 判据同理：用户覆盖的 text → 内置 text。 */
function textOf(tierId: TierId, prompt: PromptText): string {
  const fromPrompt = prompt.tiers[tierId]?.text ?? ''
  return fromPrompt.trim() !== '' ? fromPrompt.trim() : BUILTIN_PROMPT.tiers[tierId].text
}

/** 把档位表放进编排段：有插入点就落在插入点，没有就接在末尾。 */
function compose(delegation: string, rows: readonly string[]): string {
  const base = delegation.trim()
  const at = base.indexOf(TIER_SLOT)
  if (at < 0) return [base, ...rows].join('\n')
  return `${base.slice(0, at)}\n${rows.join('\n')}${base.slice(at)}`
}

/**
 * 该方案有至少一个可用档位时返回段文本，否则 `null`。
 *
 * 没有可用档就别注入：那时 `subagent_tier` 不会注册，段里提到的工具名会指向一个
 * 不存在的工具——比不注入更糟。
 *
 * `prompt` 是 `resolvePrompt` 的结果；缺省按内置算，调用点不必先合并一遍。
 * 只列 `resolved.scheme.tiers` 里**真的配了**的档，与工具描述的可选档保持一致。
 */
export function delegationSection(
  resolved: ResolvedScheme | null | undefined,
  prompt?: PromptText | null,
): DelegationSection | null {
  const schemeTiers = resolved?.scheme?.tiers
  const usable = TIER_IDS.filter((tierId) => schemeTiers?.[tierId] !== undefined)
  if (usable.length === 0) return null

  const text = prompt ?? resolvePrompt()
  const rows = usable.map(
    (tierId) => `${tierId} ${labelOf(tierId, schemeTiers?.[tierId]?.name, text)} — ${textOf(tierId, text)}`,
  )
  return { name: DELEGATION_SECTION_NAME, text: compose(text.delegation, rows) }
}
