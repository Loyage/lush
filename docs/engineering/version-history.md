# 版本迭代：main 主线与 Worker 追溯

## 用户目标与边界

用户要按落地顺序理解哪些指令 / 功能进入 main，而不是把侧分支开发时间误认成上线时间。独立只读页面 `#versions`，标题「版本迭代」，位于工作导航组。用户已选择第一父链提交列表与 Worker 追溯；首期不增加提交级 diff、不执行 Agent、不提供 Git 写操作。

- 从本项目 `refs/heads/main` 读取第一父链，最新在前，有界分页。直接提交、根提交与历史合并都保留。
- Git 是提交事实来源，SQLite 的精确交付记录是 Worker 关联证据。按完整 SHA 匹配已成功进入 main 的交付记录，不根据提交标题、当前 Worker HEAD 或时间猜测。
- 同一 Worker 的多次交付各自保留；只合入父 Worker、尚未进入 main 的子 Worker 不冒充 main 的独立落点。没有证据时明确显示「未关联 Worker」，不回填或改写历史数据。
- 原始指令来自 Input 的原始内容，和 Worker 当前目标分开。关联 Worker 可跳转既有详情。
- 无 main 时返回明确的空状态；Git 错误不伪装成空历史。刷新重新读取最新 main；分页固定首屏 tip，期间 main 前进不重复或漏页。无关或失效游标明确报错。

## 跨分区契约

新增用户专属只读 RPC `branch.history({cursor?,limit?})`，HTTP `GET /api/versions?cursor=...&limit=...`；Host 仅向已解析项目 daemon 转发，项目路由前缀与鉴权沿用现有边界。无 CLI 新命令。limit 默认 50，范围 1..100。

返回：

```js
{
  branch: 'main',
  tip: '完整 SHA 或 null',
  commits: [{
    commit: '完整 SHA', short_commit: '短 SHA', parents: ['完整 SHA'],
    subject: '提交摘要', author: { name: '作者名' }, committed_at: 'ISO 时间',
    association: 'verified', // 或 unassociated
    tasks: [{
      id: 12, goal: 'Worker 目标', task_kind: 'order',
      input: { id: 7, content: '原始指令' }, // 无 Input 时 null
      evidence: 'task.merge_integrated' // 证据种类
    }]
  }],
  cursor: '不透明后续页游标或 null',
  has_more: false
}
```

`tip` 无 main 时为 null；其余字段类型固定。cursor 与 has_more 表示下一页。Git 读取在 Workspaces 边界内，不接受任意 ref/路径或 Git 参数；游标需严格验证，不信任调用方 SHA 属于 main 第一父链。游标使用 daemon 内签名，重启后旧游标明确失效，页面刷新重新开始。Git 输出上限 4 MiB、响应上限 512 KiB，超限明确报错，不静默截断文字或冒充空结果。

主要证据为 `task.merge_integrated` 的完整落地 SHA 与 main 父 Worker；旧 `merged` 事件只在明确 `parent='main'`，或确认为旧协议且 `legacy=true`、Worker 的目标为 main 时兼容，返回 `evidence='merged'`。所有关联还必须命中实际第一父链提交。旧 no-ff 事件可能只记录侧分支源 SHA，不能把它猜成对应 merge commit；缺失明确 main 目标的事件保持未关联。不得使用当前 HEAD、标题或时间推断。更多旧事件证据必须测试其精确提交和 main 目标校验。

## 文件职责

- 后端：`src/core/workspaces/history.js` 负责 Git 主线读取；`src/core/project/version-history.js` 负责准确交付证据与 Worker/Input 投影；现有入口 mixin、RPC branch handler/registry、Web server 接入。
- 前端：`src/ui/web/assets/render-versions.js` 负责加载、刷新、分页、空态/失败态和关联展示；导航与路由由现有 app/sidebar-ui 装配；样式可独立 `styles-versions.css`。迟到响应不得覆盖新页面或后一次刷新。
- 后端与前端分别维护相关测试及所属模块地图；父Worker负责整体验证。

验收重点：真实 Git 第一父链、跨页一致性、多轮交付、未关联普通提交、伪造标题、非 main 交付、缺失 main、鉴权/项目隔离、导航唯一选中、失败重试与异步竞态。所有测试只使用临时项目或 mock，不操作用户 daemon/Host。

真实浏览器验证入口 `bun scripts/check-versions-layout.js` 使用 Firefox / geckodriver、临时 Git 项目和实际 Project 读模型，验证双主题、桌面/窄屏无横向溢出、指令展开、Worker 跳转接缝、固定 tip 分页和显式刷新。脚本退出清理自有进程与临时项目，截图留在输出目录，失败保留日志；不启动 Agent 或用户服务。
