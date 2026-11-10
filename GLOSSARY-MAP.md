# Glossary Map

## Contexts

- [仓库全局](./GLOSSARY.md): DSH 装配语义、三个 manager 共有的作用域词汇，以及仓库组织约定
- [dsh-skill-pack](./packages/dsh-skill-pack/GLOSSARY.md): 按工作区绑定 pack 来控制 skill 可见性的领域词汇
- [dsh-plugin-pack](./packages/dsh-plugin-pack/GLOSSARY.md): 按工作区停用插件（工具 + 提示词段）的领域词汇
- [dsh-mcp-pack](./packages/dsh-mcp-pack/GLOSSARY.md): 按工作区控制 MCP 服务器可见性与加载方式的领域词汇
- [dsh-model-pack](./packages/dsh-model-pack/GLOSSARY.md): 按工作区决定新建会话模型路由的领域词汇；与三个 manager 同属「按工作区求值」家族，被管理对象从可见性换成了模型路由

## Relationships

- 包级术语依赖全局术语定义的外部契约（bundle、entry、patch、profile），不重新定义。
- 三个 manager 共有的作用域词汇——工作区、层、跟随、覆盖、求值链、能力项——只由根术语表定义，包级不重复；包级只声明自己的求值链形状。
- `dsh-skill-pack` 与 `dsh-plugin-pack` 的求值链带组级：先读工作区绑定的 pack（项级、组级），再读 `default` pack（项级、组级）。
- `dsh-mcp-pack` 的求值链逐字段独立：同一行上「允许」「模式」「工具规则」「描述」各自跟随或覆盖；`dynamic` 是覆盖，`null` 才是跟随。
- `dsh-plugin-pack` 的作用单位是插件（包），一个开关同时摘掉该插件注册的工具与注入的提示词段；它取代了早期按单个工具裁剪的思路。
- 四包共用「按工作区裁剪模型可见性」这层语义，但被管理的对象不同（skill、插件的贡献、MCP 的行、模型路由）。共用的服务端骨架见 [ADR 0007](./docs/adr/0007-shared-core-package.md)；只共享词汇的旧结论见 [ADR 0002](./docs/adr/0002-keep-workspace-plugins-separate.md)。
- `dsh-model-pack` 复用同一套作用域词汇（工作区、层、跟随、覆盖、求值链），但被管理对象不是「模型可见的什么」，而是模型路由本身：会话路由经 `agent.model` 写进会话日志，档位路由经 `agentOptions` 交给子智能体派发。它因而不并入三个 manager，取舍与路线见 [ADR 0003](./docs/adr/0003-model-scheme-over-agent-preset.md)。
