/**
 * 面板路由的协议。
 *
 * 四个插件各有自己的面板，但请求与响应的形状是同一套：HTTP 恒 200，body 是
 * `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。前端只认 code，
 * 非 2xx 会让它丢掉 body。
 *
 * 这几行定义原先在四个 `routes.ts` 里各写一遍，已经漂移过一次：model-pack 的
 * `ErrorCode` 少了 `'unknown-session'`，信封字段叫 `data` 而不是 `value`。
 */

/** 错误码。都短、都稳定，前端按它分支，不解析 message。 */
export type ErrorCode = 'bad-request' | 'unknown-session' | 'internal'

/** 统一信封：成功带 `value`，失败带 `error: { code, message }`。 */
export type Envelope<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }
