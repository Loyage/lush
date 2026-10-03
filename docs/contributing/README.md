# 贡献指南

本层面向维护 Lush 源码与文档的开发者。

- [文档写作约定](documentation.md)：格式、层级、链接、流程图和自动检查。
- [模块地图](../engineering/modules.md)：源码与测试的职责边界及导出契约。
- [生命周期不变量](../engineering/invariants.md)：修改 runtime 前必须保持的规则。

提交前运行：

```bash
bun run docs:check
bun run test          # 通用套件；只需 Bun / Git，不需要 Electron 开发依赖
```

涉及桌面打包时，准备 `package.json` 中固定的开发依赖，再运行 `bun run test:packaging`；`bun run test:all` 合并运行通用与打包测试。质量 CI 分别执行两套，Windows CI 另验证真实安装器构建。`bun run test:serial 路径...` 用于聚焦串行诊断；省略路径时包含打包套件。

精简测试与 fixture 的边界见[测试模块地图](../engineering/modules-interfaces.md#测试test)。
