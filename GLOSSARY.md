# dsh-plg

DeepSeek Harness 插件仓库。术语分两层：DSH 装配语义（本仓库必须遵守的外部契约）与仓库自己的组织约定。各插件包自己的领域词汇跟着包走，见 [GLOSSARY-MAP.md](./GLOSSARY-MAP.md)。

## DSH 装配语义

**插件包（Plugin package）**:
一个 npm 包，恰好贡献一个插件，通过 `package.json` 的 `dsh.bundle.patch` 成为 profile 的一层。
_Avoid_: 插件、bundle 包、组件

**Bundle**:
`dsh.bundle.patch` 声明的组合身份，安装与卸载的单位。
_Avoid_: 安装包、模块

**Entry（插件行）**:
patch 数组里的一行，`name` 指向模块，`id` 在一个 profile 内全局唯一。插件行才是启停的单位。
_Avoid_: 插件条目、节点、实例

**Patch**:
一份 YAML 数组，只能 `insert` 追加或按 `id` 整行覆盖；`config` 整体替换，绝不深合并。
_Avoid_: 配置、补丁文件、override

**Profile**:
一组 bundle 按序组成的运行配置，位于 `$DSH_HOME/profiles/<name>`。层序：`bundles` → profile 的 patch → `$DSH_HOME/cordis.patch.yml` → `--patch`。
_Avoid_: 环境、实例、配置集

## 仓库约定

**一包一 entry**:
每个插件包只贡献一条 entry，让分发、版本、启停三者对齐。
_Avoid_: 多入口包、伞包

**零共享**:
插件包之间不共享代码；需要复用时才抽独立包并各自发版，不用 `workspace:` 协议。
_Avoid_: 共享内核、公共库

**源码安装**:
用户以 `github:<owner>/<repo>#<sha>&path:/packages/<pkg>` 安装，触发该包的 `prepare` 构建。
_Avoid_: git 安装、裸装

**界面基调（UI baseline）**:
多个插件面板共用的一套视觉约定：变量来源、开关语义、高亮方式。规格以代码为准，理由与红线见 [docs/ui-baseline.md](./docs/ui-baseline.md)。
_Avoid_: 设计系统、主题、样式规范
