# Glossary Map

## Contexts

- [仓库全局](./GLOSSARY.md): DSH 装配语义与仓库组织约定，所有包共用
- [dsh-skill-manager](./packages/dsh-skill-manager/GLOSSARY.md): 按工作区控制 skill 可见性的领域词汇

## Relationships

- 包级术语依赖全局术语定义的外部契约（bundle、entry、patch、profile），不重新定义。
- 包级术语之间无共享：每个插件包自带词汇，跨包复用时才抽公共定义。
