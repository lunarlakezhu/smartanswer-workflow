# sa-panel · SmartAnswer 调研进度面板

DSH web profile 用户插件（host 半 + client 半）。零 repo 改动。

## 功能

- 会话头「📊 调研进度」按钮（仅 `agentPreset === 'smartanswer'` 的会话显示）打开右侧 details 列面板。
- 面板：主题绑定下拉、十阶段步骤条（含 ★ 闸门位）、五闸门确认卡片（decompose / edge_r1 / pdf_r1 / edge_r2 / pdf_r2；`awaiting` 状态任何阶段可见并高亮，话术一键填入输入框）、磁盘计数（权威，`_progress.yaml` 只取 stage/gates/元信息）、实时 workflow 活动（ConversationSnapshot）、论文清单（折叠）、模型设置（主 agent `session.selectModel` 直切 + 子代理覆盖写 `sa-models.json`）、产物路径一键填入。
- host 半 HTTP 端点 `POST /api/sa-panel`：`list-topics | state | get-models | set-models | bind`。

## 主题发现与绑定（2026-08-23 修复）

主题存放位置是 SKILL 阶段 0 的用户可选项，不总在默认库根下。`list-topics` 的扫描根 =
`libraryRoot` + `extraRoots` + 请求携带的会话 cwd（client 每次打开面板自动传）。
绑定解析顺序：持久绑定 → 全库最新进行中主题（`stage` 非 `final`，按 `_progress.yaml` mtime 降序）→
会话工作区内的主题 → 全库最新；解析结果写回 `bind` 持久化，手动下拉选择仍可随时纠正。
进行中全局优先是刻意的：工作区内常残留上一场实验的未终答主题，cwd 启发式会押错
（`_progress.yaml` 的 mtime 只随 workflow 推进而变，最新进行中 ≈ 当前会话正在跑的主题）。

## 渲染纪律：子组件必须经 `h()` 元素渲染

`SaPanel` 在预设非 smartanswer 时提前 `return null`。若子组件以普通函数内联调用
（如 `SaModels({...})`），子组件的 hooks 会计入 `SaPanel` 本次渲染；同一已挂载组件在预设翻转
（standard→smartanswer）时 hooks 数变化 → React 抛错 → `SlotErrorBoundary` 将 details 槽条目
永久退位 → 原生空面板「点击消息流中的工具行查看详情」占用到页面关闭为止
（2026-08-23 水下3D打印事故根因）。`test-client.cjs` 的「hooks 恒定」断言盯住这一点。

## 配置（cordis.patch.yml insert config 覆盖）

| 键 | 默认值 | 说明 |
|---|---|---|
| `libraryRoot` | `E:\Library-Manage\raw-library\HanaLibrary` | 文献库根（扫 `_progress.yaml`，深度 ≤3） |
| `extraRoots` | `[]` | 额外扫描根数组（常用固定自定义位置时配置） |
| `presetPluginsDir` | `C:\Users\你的用户名\.dsh\.agent-presets\smartanswer\plugins` | `sa-models.json` / `sa-panel-state.json` 落位目录 |

## 已知边界

- **遮蔽 details slot**：本插件以 priority -1 遮蔽 ui-conversation 的 DetailsPanel（priority 0，lowest renders）。该入口在 repo 内从未接线（ui-conversation README 自述），零回归；若未来 repo 接线 details 列，需协调 priority。
- **stage 语义**：SKILL 写入的 `stage` 是「下一步」语义（阶段 1-3 结束写 `search`），步骤条映射按此实测定死在 client.js 的 `STAGE_RANK` 常量。
- **谎报纪律**：面板计数一律磁盘自数，`_progress.yaml` 计数字段仅作对照展示（差异高亮）。
- **event window 有界**：老 workflow 节点可能翻页出窗，实时区只承诺「当前/近期」，历史进度以磁盘为准。
- **sa-models.json 权属**：文件由面板写，agent 只读不写（SKILL.md 硬规则）。
- **cwd 扫描深度**：会话 cwd 作扫描根时沿用深度 ≤3 + `_` 前缀目录跳过，超大工作区只是扫描稍慢，无其他影响。
- **自动绑定持久化**：打开面板即把解析结果写入 `sa-panel-state.json`；解析错时用主题下拉纠正一次即覆盖。

## 卸载

删掉 `cordis.patch.yml` 中本插件 insert 段与 `package.json` 依赖，重启 DSH。
