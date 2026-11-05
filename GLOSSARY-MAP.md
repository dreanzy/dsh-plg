# Glossary Map

## Contexts

- [仓库全局](./GLOSSARY.md): DSH 装配语义与仓库组织约定，所有包共用
- [dsh-skill-manager](./packages/dsh-skill-manager/GLOSSARY.md): 按工作区控制 skill 可见性的领域词汇
- [dsh-plugin-manager](./packages/dsh-plugin-manager/GLOSSARY.md): 按工作区停用插件（工具 + 提示词段）的领域词汇
- [dsh-mcp-manager](./packages/dsh-mcp-manager/GLOSSARY.md): 按工作区控制 MCP 服务器可见性与加载方式的领域词汇

## Relationships

- 包级术语依赖全局术语定义的外部契约（bundle、entry、patch、profile），不重新定义。
- 包级术语之间无共享：每个插件包自带词汇，跨包复用时才抽公共定义。
- `dsh-mcp-manager` 的「工作区」与 `dsh-skill-manager` 同一含义（目录路径），但它在 MCP 场景多了一层「模式」：同一个可见性开关之外，还有工具何时进入上下文。
- `dsh-plugin-manager` 的作用单位是插件（包），一个开关同时摘掉该插件注册的工具与注入的提示词段；它取代了早期按单个工具裁剪的思路。