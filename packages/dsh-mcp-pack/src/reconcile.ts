/**
 * 每个主体的装配记账。
 *
 * 三个不变式住在这里：同一个 key 的上一轮落地没完就不开始下一轮；新一轮先释放
 * 上一轮的资源；落地失败退回「没有资源」，而不是留下半份。调用方只提供「这一轮怎么
 * 算、怎么落地」，并自己决定计划没变时就别调进来。
 */
export type Dispose = () => void

export interface Reconciler {
  /**
   * 重算并落地。返回 true 表示这一轮的资源已生效（或本来就不需要资源）。
   * 失败时返回 false：上一轮已被释放，此刻这个主体没有资源。
   */
  apply(key: string, build: () => Dispose | null): Promise<boolean>
  /** 释放并忘记这个 key 的资源（主体销毁时用）。 */
  release(key: string): void
}

export function createReconciler(warn: (message: string) => void): Reconciler {
  const disposers = new Map<string, Dispose>()
  /** 每个 key 的串联队列：上一轮没完成时，新一轮排在它后面。 */
  const queues = new Map<string, Promise<boolean>>()
  /** 每个 key 的世代号：释放或新一轮开始都会加一，用来丢弃过期结果。 */
  const epochs = new Map<string, number>()

  const drop = (key: string): void => {
    const dispose = disposers.get(key)
    if (dispose === undefined) return
    disposers.delete(key)
    try {
      dispose()
    } catch (error) {
      warn('释放上一个装配失败（' + key + '）：' + String(error))
    }
  }

  const release = (key: string): void => {
    epochs.set(key, (epochs.get(key) ?? 0) + 1)
    drop(key)
  }

  const apply = (key: string, build: () => Dispose | null): Promise<boolean> => {
    const previous = queues.get(key) ?? Promise.resolve(true)
    const epoch = (epochs.get(key) ?? 0) + 1
    epochs.set(key, epoch)
    const task = previous.then(async () => {
      // 排队期间被 release 或被更新的一次顶掉：这一轮不该落地，也不该动资源。
      if (epochs.get(key) !== epoch) return false
      drop(key)
      let dispose: Dispose | null
      try {
        dispose = build()
      } catch (error) {
        warn('装配失败（' + key + '）：' + String(error))
        return false
      }
      // 落地期间被 release（主体销毁）或又被要求重算：这一份资源不该留下。
      if (epochs.get(key) !== epoch) {
        if (dispose !== null) {
          try {
            dispose()
          } catch {
            // 已过期，释放失败也无处可去。
          }
        }
        return false
      }
      if (dispose !== null) disposers.set(key, dispose)
      return true
    })
    queues.set(key, task)
    return task
  }

  return { apply, release }
}
