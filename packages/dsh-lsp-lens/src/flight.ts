/**
 * 飞行表：一次诊断从发起到结算的行程，以及「什么时候该放弃它」。
 *
 * 这条判定原先埋在 `apply` 的 pre-step 里，只能通过假 ctx 跑整个 `apply` 才测得到。
 * 它没有任何副作用，抽出来之后可以直接喂几个对象测（见 ADR-0018）。
 */
import type { FileFeedback } from './render.js'

/** 一次诊断在飞行表里的行程。结果写回这里，下一步 pre-step 结算。 */
export interface Flight {
  readonly path: string
  readonly version: string
  readonly step: number
  readonly startedAt: number
  done: boolean
  result: FileFeedback | null
}

/** 飞行结果的最长生命周期：超过 2 步或 30s 就放弃并落墓碑。 */
export const FLIGHT_MAX_STEPS = 2
export const FLIGHT_MAX_MS = 30_000

/**
 * 一次结算的结论。
 *
 * `pending` 是「还没有结果，也没到放弃的时候」，调用方保留它；其余三档都要把它从
 * 飞行表里删掉——包括 `stale`：它同样要落墓碑，否则下一次 pre-step 会重新判一次，
 * 同一份诊断被反复等待。
 */
export type FlightSettlement =
  | { readonly kind: 'pending' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'take'; readonly result: FileFeedback }
  | { readonly kind: 'empty' }

/**
 * 判定这次飞行该怎么处置。
 *
 * 纯函数：只读 `flight` 的三个时间字段与 `done`，不看表、不删项、不记日志。
 * 「过 2 步」用的是严格大于——恰好第 2 步时诊断可能刚好回来。
 */
export function settleFlight(flight: Flight, step: number, now: number): FlightSettlement {
  if (!flight.done) {
    const stale = step - flight.step > FLIGHT_MAX_STEPS || now - flight.startedAt > FLIGHT_MAX_MS
    return stale ? { kind: 'stale' } : { kind: 'pending' }
  }
  return flight.result === null ? { kind: 'empty' } : { kind: 'take', result: flight.result }
}
