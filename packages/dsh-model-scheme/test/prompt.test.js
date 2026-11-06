import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_SCHEME, TIER_DEFAULT_NAMES, TIER_IDS } from '../lib/scheme.js'
import {
  BUILTIN_PROMPT,
  DELEGATION_MAX_TOKENS,
  DELEGATION_SECTION_NAME,
  delegationSection,
  estimateTokens,
  resolvePrompt,
} from '../lib/prompt.js'

/**
 * 委派段的契约（spec §6.3 / §6.3.1）。
 *
 * 全部用内存里的 ResolvedScheme 形状，不读盘：提示词段是纯函数产物，
 * 它该保证的只有「名字对、预算不超、两个工具名都在、档名对、不泄漏模型与 provider、
 * 不随方案变化」，以及「用户覆盖逐键生效、空串等于缺省」。
 */

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function tier(name) {
  return { name, primary: ROUTE, fallbacks: [] }
}

/** 四档全满：段文本的最坏情况，预算断言必须跑这一份。 */
const FULL = {
  id: 'standard',
  scheme: {
    name: '标准',
    tiers: {
      tier1: tier('方案里写的档名'),
      tier2: tier('方案里写的档名'),
      tier3: tier('方案里写的档名'),
      tier4: tier('方案里写的档名'),
    },
  },
  source: 'global',
  brokenBinding: false,
  warnings: [],
}

function withTiers(ids) {
  const tiers = {}
  for (const id of ids) tiers[id] = tier(id)
  return { ...FULL, scheme: { name: '标准', tiers } }
}

/** 一份整段覆盖：四档全给，用来断言「用户有则用用户」。 */
const CUSTOM = {
  delegation: '自定义编排：先分轨，再派活。\n\n收尾自查。',
  tiers: {
    tier1: { label: '探路', text: '只找位置' },
    tier2: { label: '快改', text: '小改动' },
    tier3: { label: '深改', text: '多处联动' },
    tier4: { label: '攻关', text: '原因不明' },
  },
}

test('四档全满时返回固定段名', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  assert.equal(section.name, DELEGATION_SECTION_NAME)
  assert.equal(section.name, 'model-scheme.delegation')
})

test('内置段不超 350 token（四档全配的最坏情况）', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  const tokens = estimateTokens(section.text)
  assert.ok(
    tokens <= DELEGATION_MAX_TOKENS,
    `段文本估计 ${tokens} token，超过上限 ${DELEGATION_MAX_TOKENS}`,
  )
})

test('估算函数本身可复现', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

test('四档默认名是侦察 / 速办 / 攻坚 / 深算', () => {
  assert.deepEqual(
    TIER_IDS.map((id) => TIER_DEFAULT_NAMES[id]),
    ['侦察', '速办', '攻坚', '深算'],
  )
  for (const tierId of TIER_IDS) {
    assert.equal(BUILTIN_PROMPT.tiers[tierId].label, TIER_DEFAULT_NAMES[tierId], tierId)
    assert.notEqual(BUILTIN_PROMPT.tiers[tierId].text.trim(), '', tierId)
  }
})

test('内置编排段含切轨道、并行与收尾验收三件事', () => {
  assert.match(BUILTIN_PROMPT.delegation, /切轨道/)
  assert.match(BUILTIN_PROMPT.delegation, /不要空等或轮询/)
  assert.match(BUILTIN_PROMPT.delegation, /漏范围与越界都算缺陷/)
})

test('段文本同时指出 subagent_tier 与 subagent_fork', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  assert.match(section.text, /subagent_tier/)
  assert.match(section.text, /subagent_fork/)
})

test('独立任务压过 fork：文本明确要求独立任务不用 fork', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  assert.match(section.text, /独立任务不要用它/)
  // 官方残留推荐是「Start independent delegations with subagent_fork」，必须被顶掉。
  assert.doesNotMatch(section.text, /Start independent delegations with/i)
})

test('段文本不含模型 id 与 provider 名', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  assert.doesNotMatch(section.text, /deepseek-/i)
  assert.doesNotMatch(section.text, /deepseek/i)
  assert.doesNotMatch(section.text, /anthropic|openai|google|qwen|glm|moonshot/i)
  // 路由里的 provider/model 一个字都不该出现在段里。
  assert.ok(!section.text.includes(ROUTE.provider))
  assert.ok(!section.text.includes(ROUTE.model))
})

test('档位表述只有任务类型，没有路由细节', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  for (const label of ['侦察', '速办', '攻坚', '深算']) {
    assert.ok(section.text.includes(label), `缺少档位描述：${label}`)
  }
  assert.doesNotMatch(section.text, /reasoning|effort|provider|model/i)
})

test('档位表一档一行，四档正好四行', () => {
  const section = delegationSection(FULL)
  assert.ok(section !== null)
  const tierLines = section.text.split('\n').filter((line) => /^tier\d/.test(line))
  assert.equal(tierLines.length, 4)
})

test('只列方案里可用的档', () => {
  const section = delegationSection(withTiers(['tier1', 'tier2']))
  assert.ok(section !== null)
  assert.match(section.text, /tier1 侦察/)
  assert.match(section.text, /tier2 速办/)

  // 只看档位表：编排段本身会提到 tier4（「直接 tier4」是判据的一部分）。
  const table = section.text.split('\n').filter((line) => /^tier\d/.test(line))
  assert.deepEqual(table.map((line) => line.split(' ')[0]), ['tier1', 'tier2'])
})

test('空方案返回 null', () => {
  assert.equal(delegationSection(withTiers([])), null)
  assert.equal(
    delegationSection({ ...FULL, scheme: { name: '极简', tiers: {} } }),
    null,
  )
})

test('出厂方案（四档全空）返回 null', () => {
  assert.equal(
    delegationSection({
      id: 'builtin',
      scheme: BUILTIN_SCHEME,
      source: 'builtin',
      brokenBinding: false,
      warnings: [],
    }),
    null,
  )
})

test('单档方案也给出段落，且预算仍不超限', () => {
  const section = delegationSection(withTiers(['tier4']))
  assert.ok(section !== null)
  assert.ok(estimateTokens(section.text) <= DELEGATION_MAX_TOKENS)
  assert.match(section.text, /tier4 深算/)
})

/* ------------------------------------------------------------------ *
 * 用户覆盖（spec §6.3.1）
 * ------------------------------------------------------------------ */

test('resolvePrompt：不给覆盖时就是内置', () => {
  const prompt = resolvePrompt()
  assert.equal(prompt.delegation, BUILTIN_PROMPT.delegation)
  for (const tierId of TIER_IDS) {
    assert.deepEqual(prompt.tiers[tierId], BUILTIN_PROMPT.tiers[tierId])
  }
})

test('用户覆盖整段时逐字生效', () => {
  const prompt = resolvePrompt(CUSTOM)
  assert.equal(prompt.delegation, CUSTOM.delegation)

  const section = delegationSection(FULL, prompt)
  assert.ok(section !== null)
  assert.ok(section.text.startsWith(CUSTOM.delegation.split('\n\n')[0]))
  for (const tierId of TIER_IDS) {
    const expected = `${tierId} ${CUSTOM.tiers[tierId].label} — ${CUSTOM.tiers[tierId].text}`
    assert.ok(section.text.includes(expected), `缺少 ${expected}`)
  }
  assert.ok(!section.text.includes('侦察'), '覆盖后不该残留内置档名')
})

test('用户只覆盖一档时其余走内置', () => {
  const prompt = resolvePrompt({ tiers: { tier2: { label: '快办' } } })
  assert.equal(prompt.tiers.tier2.label, '快办')
  // 同档只覆盖 label，text 仍走内置。
  assert.equal(prompt.tiers.tier2.text, BUILTIN_PROMPT.tiers.tier2.text)
  // 其余档与编排段原样。
  assert.equal(prompt.tiers.tier1.label, BUILTIN_PROMPT.tiers.tier1.label)
  assert.equal(prompt.tiers.tier4.text, BUILTIN_PROMPT.tiers.tier4.text)
  assert.equal(prompt.delegation, BUILTIN_PROMPT.delegation)

  const section = delegationSection(FULL, prompt)
  assert.ok(section !== null)
  assert.match(section.text, /tier2 快办 — 定义明确/)
  assert.match(section.text, /tier1 侦察/)
  assert.match(section.text, /tier4 深算/)
})

test('空串与纯空白等于缺省，不落进段文本', () => {
  const prompt = resolvePrompt({
    delegation: '   ',
    tiers: { tier1: { label: '', text: '  ' } },
  })
  assert.equal(prompt.delegation, BUILTIN_PROMPT.delegation)
  assert.equal(prompt.tiers.tier1.label, BUILTIN_PROMPT.tiers.tier1.label)
  assert.equal(prompt.tiers.tier1.text, BUILTIN_PROMPT.tiers.tier1.text)
})

test('段内容不随方案名变化：同一提示词 + 不同方案逐字相同', () => {
  const prompt = resolvePrompt()

  const standard = delegationSection(
    { ...FULL, scheme: { ...FULL.scheme, name: '标准' } },
    prompt,
  )
  const renamed = delegationSection(
    { ...FULL, scheme: { ...FULL.scheme, name: '另一个方案名' } },
    prompt,
  )
  // 档名换成方案里的显示名也不该渗进段：段名只认覆盖与内置。
  const schemeNamed = delegationSection(
    {
      ...FULL,
      scheme: {
        name: 'C:\\work\\somewhere',
        tiers: {
          tier1: tier('方案内显示名甲'),
          tier2: tier('方案内显示名乙'),
          tier3: tier('方案内显示名丙'),
          tier4: tier('方案内显示名丁'),
        },
      },
    },
    prompt,
  )

  assert.ok(standard !== null && renamed !== null && schemeNamed !== null)
  assert.equal(standard.text, renamed.text)
  assert.equal(standard.text, schemeNamed.text)
  assert.ok(!standard.text.includes('C:\\work'), '方案名（可能含 cwd）不得进入段')
  assert.ok(!standard.text.includes('方案内显示名甲'))
})
