# 贡献指南

本层面向维护 Lush 源码与文档的开发者。

- [文档写作约定](documentation.md)：格式、层级、链接、流程图和自动检查。
- [本地读取性能报告](read-performance.md)：重复采样、环境身份、JSON 输出与既有预算；不等同于真实 RPC / 浏览器验收。
- [模块地图](../engineering/modules.md)：源码与测试的职责边界及导出契约。
- [生命周期不变量](../engineering/invariants.md)：修改 runtime 前必须保持的规则。

提交前运行：

```bash
bun run docs:check
bun run test          # 全部现有 Web/core 套件；只需 Bun / Git
```

`bun run test:all` 与默认测试运行同一完整套件；`bun run test:serial 路径...` 用于聚焦串行诊断。无路径忽略模式或打包专项。真实浏览器脚本使用系统浏览器，质量 CI 执行测试与文档检查。

精简测试与 fixture 的边界见[测试模块地图](../engineering/modules-interfaces.md#测试test)。
