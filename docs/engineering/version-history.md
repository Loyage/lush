# 版本迭代：main 提交图与固定交付

本文说明 `#versions` 页面的展示与追溯边界。页面用于理解已进入 main 的功能及其开发提交，不提供 Git 写操作、提交级 diff 或 Agent 调用。公共字段、参数、权限与大小限制统一见[分支 RPC](../reference/rpc/branches.md#branchversion_graph)。

## 提交图与固定交付下钻

- 默认显示 `refs/heads/main` 的完整可达 Git 图，按拓扑顺序子先父后。节点是一条提交，旁边显示短 SHA、提交摘要、时间与精确关联的 Worker 编号；无编号回退 `#内部ID`。
- 连线来自真实父提交 SHA，不把 Worker 委派关系或相邻记录当作 Git 边。尚未进入 main 的分支不混入主图；未加载或范围外的父边以虚线边界说明。
- 点击节点在版本页内打开对应的固定交付轮次；有多个 Worker 关联时明确选择。子 Worker 的 Squash 落点可继续下钻其原始交付。独立“查看 Worker”入口仍打开既有详情。
- 返回上层／main 复用已读图，保留模式、指令展开、滚动和焦点。显式刷新重读当前范围，分页固定首次读取的 tip；不自动轮询。
- 无 main 显示空态；读取失败保留旧图并明确提示，不能伪装成空历史。离页、刷新或切换图后，迟到响应不得覆盖新页面。

## 精确追溯

Git 提供提交事实，成功交付 Event 提供 Worker 关联。仅按完整落地 SHA 与明确父目标匹配，不按标题、时间或当前 Worker HEAD 猜测；普通 main 提交没有证据时显示“未关联 Worker”。

交付图使用成功事件中的固定源提交。首轮从创建基线开始，后轮从此前成功交付的固定源提交开始，并排除本轮父侧已有提交，避免同步父分支带入的其它功能冒充本轮开发。旧单源 Squash 核验源与落点树相等、基线祖先关系和父侧证据；v3 多源归并不要求单源树等于组合树，而核验持久批次的精确成员映射、单父落点／树和保留全部固定输入祖先的整合证据。两条路径都用隔离的只读 Git 对象读取器，不受 replace refs 影响；不读取可变的 reservation 或 iteration 基线作为替代。

普通源开发提交可显示当前交付 Worker 归属，但没有独立交付事件，不递归打开自己。子交付关联必须证明它落在该 Worker 的分支上且早于所选交付。历史记录缺少固定证据、基线不可信或 Git 对象已回收时，明确不可追溯，不回退到当前分支。

原 `branch.history` / `GET /api/versions` 第一父链读协议保留兼容，页面使用 `branch.version_graph` / `GET /api/version-graph`；两者游标不可混用。旧 `merged` 记录仍可精确关联，但缺少可靠的固定源与父基线时不提供下钻。

## 简易与详情展示

每次进入默认简易模式：紧凑显示短 SHA、最多两行摘要、时间和 Worker 入口。勾选“详情模式”后显示完整摘要、SHA、作者、Worker 目标、可折叠原始指令与固定 tip／开发基线。模式切换仅改变本地展示，不请求或重建卡片；分页、刷新、失败和图间返回保留当前模式，离页再进入恢复简易。

提交文本与原始指令均以安全文本呈现。节点支持键盘操作，双主题与窄屏不得因 SHA、摘要或详情展开产生横向溢出。

## 实现与验证入口

Git 固定图读取位于 `src/core/workspaces/version-graph.js`，成功事件关联位于 `src/core/project/version-graph.js`；旧第一父链读面分别保留在 `history.js` 与 `version-history.js`。前端入口为 `src/ui/web/assets/render-versions.js`，真实 SHA 泳道计算位于 `version-graph-layout.js`，样式为 `styles-versions.css`。

`bun scripts/check-versions-layout.js` 使用 Firefox／geckodriver、临时 Git 项目与实际 Project 读模型，覆盖真实分叉／汇合、固定 Squash 源与子交付下钻、缓存返回、固定 tip 分页、刷新、双主题和桌面／窄屏布局。脚本清理自有进程与临时项目，保留截图和失败日志，不启动 Agent 或用户服务。
