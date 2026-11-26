/**
 * 会话作用域的状态表。
 *
 * 一个 profile 里多个会话共用一个插件实例，脏表不能共用——共享条目必然用错根去解析
 * （见 ADR-0014）。表与懒建逻辑原先在 `apply` 的闭包里；抽出来之后「同键同一份、
 * 异键各自独立」可以直接断言，不必驱动整个 apply。
 */
import { DirtySet } from './dirty.js'
import type { Flight } from './flight.js'

/** 一个会话的脏表与待结算项。键见 `sessionKeyOf`。 */
export interface SessionState {
  readonly dirty: DirtySet
  readonly pendingShell: Set<string>
  readonly backgroundJobs: Map<string, string>
  readonly inFlight: Map<string, Flight>
}

export interface SessionStore {
  /** 取一个会话的状态，首次访问时建。 */
  of(key: string): SessionState
  /** 正在跟踪的会话数。 */
  readonly size: number
  /** 释放：逐会话清空各自的容器，再丢掉表本身。 */
  clear(): void
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>()
  return {
    of(key: string): SessionState {
      let state = sessions.get(key)
      if (state === undefined) {
        state = { dirty: new DirtySet(), pendingShell: new Set(), backgroundJobs: new Map(), inFlight: new Map() }
        sessions.set(key, state)
      }
      return state
    },
    get size(): number {
      return sessions.size
    },
    clear(): void {
      for (const state of sessions.values()) {
        state.dirty.clear()
        state.pendingShell.clear()
        state.backgroundJobs.clear()
        state.inFlight.clear()
      }
      sessions.clear()
    },
  }
}
