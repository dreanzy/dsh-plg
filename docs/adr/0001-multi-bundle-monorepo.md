# 一个仓库，多个独立发布的插件包

## 背景与决定

要在同一仓库维护多个 DSH 插件，且每个插件能单独通过 npm 分发、单独安装、单独升级。因此每个插件是一个独立的 bundle 包（`packages/dsh-plugin-*`），各自声明 `dsh.bundle.patch`、各自版本与发布；仓库只做聚合与共享开发脚本。

单个包挂多个 entry、或全仓统一版本的方案被否掉：前者无法单独升级，后者会让只改一个插件也逼所有人升版本。

## 考虑过的替代方案

- **单包多 entry**：安装体验简单，但整包同装同卸、同版本号，与「单独分发」的目标冲突。
- **每插件一个独立仓库**：彻底隔离，但多份构建配置、多份 CI、跨插件改动的原子提交都做不了。
- **`workspace:` 协议共享代码**：实测在用户从 git 子目录安装时不会替换成真实版本，而是报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。因此约定零共享，需求出现时才抽独立包发版。

## 后果

- 每个包自带 `tsconfig.json` 与 `prepare`，不 extends 仓库根文件——git 安装只打包子目录，根文件不进包。
- 每个包自带 `typescript` 依赖，不依赖根 workspace 的 hoist 结果。
- 产物目录统一叫 `lib/`（而不是 `dist/`），与带 Web UI 的生态实例一致：将来给某个包加浏览器半边时，`exports["./client"] → "./lib/client.js"` 不会改动已发布的路径。
- 分发包内确实会带上仓库根的 `LICENSE`（`pnpm pack` 实测），但发布仍以 `package.json` 的 `license` 字段为准。
