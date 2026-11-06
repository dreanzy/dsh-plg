# 06 面板数据路由

Status: ready-for-agent
Type: task
Blocked by: 02

## 目标

给客户端提供读写方案与工作区绑定的 HTTP 面。

## 范围

`src/routes.ts`：`POST /api/model-scheme/read`（入参 cwd，返回两层状态、求值结果、support、lastError）、`/apply`（命令数组，幂等，语义照现有三包）、`/support`（探测结果）。

注册方式照 `dsh-plugin-manager`：从 connection 服务取 `fetch.register`，缺失时只 warn。返回信封恒为 HTTP 200。

## 验收

`test/routes.test.js`：read 在无文件时返回出厂方案；apply 写入后 read 能读回；未知命令返回错误码而不是抛。

## 边界

不写 UI；不做鉴权（依赖宿主 account 面）。