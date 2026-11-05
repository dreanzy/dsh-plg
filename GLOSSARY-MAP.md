# Glossary Map

## Contexts

- [仓库全局](./GLOSSARY.md): DSH 装配语义、三个 manager 共有的作用域词汇，以及仓库组织约定
- [dsh-skill-manager](./packages/dsh-skill-manager/GLOSSARY.md): 按工作区控制 skill 可见性的领域词汇
- [dsh-plugin-manager](./packages/dsh-plugin-manager/GLOSSARY.md): 按工作区停用插件（工具 + 提示词段）的领域词汇
- [dsh-mcp-manager](./packages/dsh-mcp-manager/GLOSSARY.md): 按工作区控制 MCP 服务器可见性与加载方式的领域词汇

## Relationships

- 包级术语依赖全局术语定义的外部契约（bundle、entry、patch、profile），不重新定义。
- 三个 manager 共有的作用域词汇——工作区、层、跟随、覆盖、求值链、能力项——只由根术语表定义，包级不重复；包级只声明自己的求值链形状。
- `dsh-skill-manager` 与 `dsh-plugin-manager` 的求值链带组级：项级与组级各读一层，工作区层的任何决定压过全局层的任何决定。
- `dsh-mcp-manager` 的求值链逐字段独立：同一行上「允许」「模式」「工具规则」「描述」各自跟随或覆盖；`dynamic` 是覆盖，`null` 才是跟随。
- `dsh-plugin-manager` 的作用单位是插件（包），一个开关同时摘掉该插件注册的工具与注入的提示词段；它取代了早期按单个工具裁剪的思路。
- 三包共用「按工作区裁剪模型可见性」这层语义，但被管理的对象不同（skill、插件的贡献、MCP 的行）。合并与否见 [ADR 0002](./docs/adr/0002-keep-workspace-plugins-separate.md)。
