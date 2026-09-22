# 贡献指南

本层面向维护 Lush 源码与文档的开发者。

- [文档写作约定](documentation.md)：格式、层级、链接、流程图和自动检查。
- [模块地图](../engineering/modules.md)：源码与测试的职责边界及导出契约。
- [生命周期不变量](../engineering/invariants.md)：修改 runtime 前必须保持的规则。

提交前运行：

```bash
bun run docs:check
bun run test
```
