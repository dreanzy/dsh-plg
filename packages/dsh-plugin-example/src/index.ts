export const name = 'dsh-plugin-example'

export interface Config {
  greeting?: string
}

export interface MinimalContext {
  logger(scopename: string): { info(message: string): void }
}

export function apply(ctx: MinimalContext, config: Config = {}): void {
  ctx.logger(name).info(config.greeting ?? 'loaded')
}
