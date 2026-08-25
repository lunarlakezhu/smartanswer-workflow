# 文献 PDF 下载能力插件化计划

> 日期：2026-08-25
> 前置：本目录 `HANDOVER.md`（试验验证记录，4 条下载路径全部跑通）
> 结论：在 `packages/literature/` 重建为完整 capability seam，共 4 个新包 + 1 个新组。
> 核心设计目标：**新增期刊 = 一个策略文件 + 一个单测**，不动核心包。

## 0. 已确认的两个决策

| 决策点 | 选择 | 含义 |
|---|---|---|
| 挂载范围 | **独立可选 bundle** | 新建 `packages/bundle/literature` 聚合包；产品内存在但 base bundle 不默认装载；公开 npm 的 dsh 不带 playwright 运行时依赖 |
| 执行模型 | **前台同步** | 一次 tool call 完成整批（超时/并发/上限均可配，默认约 10 分钟上限）；超大批次由模型自动拆分；后台 jobs 列为二期 |

## 1. 总体结构

```
packages/literature/                     # 新组（tsconfig.base.json 加通配、packages/README.md 加行）
├── README.md / .zh.md / .i18n.yaml      # 组 README：包/ctx-key 映射表
├── literature/                          # @deepseek-ai/dsh-literature —— Service Definition（ctx.literature）
├── literature-download-local/           # @deepseek-ai/dsh-literature-download-local —— Provider（策略集+引擎）
└── tool-literature/                     # @deepseek-ai/dsh-tool-literature —— Consumer（literature_download 工具）
packages/bundle/literature/              # @deepseek-ai/dsh-literature-app —— 可选 bundle（聚合装配）
```

结构模板 = `packages/web/` 组（`web` / `web-fetch-http` / `tool-web`）。
`ZhuDownLoader/` 保持 untracked 作 POC 参考（.gitignore 加一行）。

## 2. Service Definition：`literature`

- `LiteratureRuntime extends Service`，ctx key `literature`。
- **公开扩展点** `registerStrategy(strategy): () => void`：`ctx.effect()` 注册、返回 disposer、重复 id 抛 `LiteratureError`（照抄 web 的 `registerProvider` 模式，`packages/web/web/src/index.ts:118-129`）。任何插件都可向此注册表追加期刊策略——持续更新的架构基础。
- `download(requests, { concurrency, signal })`：批量原语。逐篇：
  1. 校验 DOI 格式 → fetch doi.org（`redirect:'manual'` + UA）；
  2. 按注册策略 `matches(url)` 选策略；无匹配报 unsupported 并列出已注册策略；
  3. 委托策略 → `%PDF-` magic-byte 校验；
  4. 结果闭联单 `{status:'ok'|'failed'|'manual-required', ...}` + `assertNever`。
  单篇超时/失败不中断批次，汇总返回；逐条单行追加写 `<outDir>/download.log`（换行清洗，修掉试验中多行堆栈破坏格式的问题）。
- Config：`doiResolverUrl`（默认 `https://doi.org`，测试指回环 fixture）。文件名 sanitize、magic-byte 校验为 seam 共享工具。
- 无新 session 事件：tool/call + tool/result 由 agent-loop 自动落盘，已满足"model-visible ⟺ logged"。

## 3. Provider：`literature-download-local`

- function plugin，`inject: ['literature']`，注册 6 个策略 `src/strategies/{nature,pnas,science,ieee,sage,elsevier}.ts`：
  - **nature**：纯 Node fetch 直下 → 非 `%PDF` 则带 cookie jar 二段重试（移植 curl 修复；去掉 PowerShell/curl 依赖，跨平台）。
  - **pnas**（`a#downloadPdfUrl` + `evaluate` DOM click）、**science**（reader 页 + download=true 链接）、**ieee**（`domcontentloaded` + `route.fetch` 流式拦截）——按试验脚本的 4 处修复移植（见 HANDOVER.md §5）。
  - **sage**：原样移植，真实站点未实测，README Limitations 标注 experimental。
  - **elsevier**：返回 `manual-required` 结果（附 URL 与指引）；`openExternalBrowserForManual` Config（默认 false，true 时跨平台 open：start/open/xdg-open）。
- `src/engine.ts`：Playwright 封装（launch + anti-webdriver initScript + `--disable-blink-features=AutomationControlled` + UA + acceptDownloads + AbortSignal 协作：race 后 `browser.close()` 并 await 静默——defensive patterns "dispose 必须达到静默"）。**引擎工厂构造器可注入**：单测用 fake engine，不依赖真浏览器，CI 无浏览器也过 per-file 100% 覆盖率门槛。
- Config（schemastery，fail-loud 校验）：`headless`（默认 false，沿用已验证反爬配方）、`userAgent`、`browserExecutablePath?`、`navigationTimeoutMs=45000`、`selectorTimeoutMs=30000`、`downloadEventTimeoutMs=60000`、`pdfCaptureTimeoutMs=120000`（IEEE）。
- `playwright` 为本包普通 dependencies（先例：sharp/koffi/node-pty），pin `~1.62` 匹配本机 chromium-1234 缓存；**不**进 pnpm-workspace `allowBuilds`（postinstall 不跑、不自动下载浏览器；运行时用系统缓存，README 写明 `npx playwright install chromium` 兜底）。

## 4. Consumer：`tool-literature`

- `inject: ['tools','literature','systemPrompt']`，工具 `literature_download`。
- args：`{ dois: string[]（1..maxDoisPerCall）, outDir?: string }`；outDir 解析为显式 resolve 步骤（arg ?? Config.downloadRoot，皆无则报错——Config 必填无默认，fail loud）。
- Config：`downloadRoot`（必填）、`maxDoisPerCall=10`、`maxConcurrentDownloads=2`、`perDownloadTimeoutMs=120000`、`toolTimeoutMs=600000`。
- `timeoutMs = min(toolTimeoutMs, 上限)` 并全程转发 `exec.signal`（timeout-policy 协作式强制，`packages/guard/timeout-policy`）；`isConcurrencySafe: () => false`；批内并发池由 seam 的 `download` 承担。
- output：每篇 `{doi, publisher, status, path?, bytes?, durationMs?, reason?}` + 汇总；`render` 文本表格（**失败全量告知**——沿用原 agent 笔记规则）；`presentCall` generic 卡片 kind `fetch`；`presentResult` generic 卡片带 `locations`（成功文件路径）+ `presentationMeta`（可重放卡片）。
- systemPrompt section `tool:literature_download`（order 1xx）：超上限批次自动拆分、失败文献全量上报、勿对同一出版商盲目重试。

## 5. Bundle 与环境启用

- `packages/bundle/literature/`：package.json dependencies 含三插件包 + `cordis.patch.yml` 三行 insert（tool 行带 `downloadRoot` 配置）；`verify-cordis-config` 的 bare-name-in-dependencies 自动满足。
- 用户启用（一次性）：`dsh plugin --profile web add @deepseek-ai/dsh-literature-app`，或 home layer `~/.dsh/cordis.patch.yml` 加一行 insert（对所有 profile 生效，含 `pnpm dsh web` / 启动DSH.bat）。
- 实施时按实际 bundle 装配机制核实（`packages/boot/app-boot/src/profile.ts` 的 `dsh.profile.bundles` 层叠与 `healProfilesModuleFallback` 符号链接），并把结论写进组 README。

## 6. 测试（三档齐备，AGENTS.md:125）

- **单元**（keyless，per-file 100%）：
  - seam：`doiResolverUrl` 指回环 fixture；注册表/重复 id/匹配/unsupported/magic-byte/批量部分失败/日志单行化。
  - nature：回环 fixture（含 cookie-302 场景）。
  - pnas/science/ieee/sage/elsevier：注入 fake engine 覆盖等待/捕获/拦截/中止路径。
  - engine 真浏览器回环测试 `skipIf` 无浏览器。
- **keyless 快照**（AGENTS.md 硬性要求）：新增 ACP 场景 `literature-download`，走 Nature 纯 HTTP 路径——回环 doi-resolver + 出版商 fixture server + `%PDF-` 假体，输出进 tmp，**不需要 chromium**。模板：`examples/acp-agent/tests/snapshots/web-fetch/`（固定端口 fixture server 模式）+ overlay `examples/acp-agent/literature.cordis.yml`。
- **真实 e2e**：`literature.e2e.ts` 无 `DSH_LITERATURE_E2E=1` 自跳；用 4 个已验证 DOI + 1 个 SAGE DOI，校验世界状态（文件存在 + magic bytes + 大小），不是校验 agent 的口头声明。

## 7. 仓库义务（门禁清单）

- `scripts/gen-tool-catalog.ts` 加 `TOOL_PACKAGES` 条目（`assertManifestComplete` 守卫强制）→ `pnpm run gen-tool-catalog` 再生成 `docs/tool-catalog.md` + zh 配对流程。
- config-catalog / cordis-catalog / doc-graphs（`docs/capability-seams.md`）/ module-graph 新鲜度（`pnpm run doc-sync` 全部覆盖）。
- 三包 README en/zh/i18n.yaml（结尾必须有 `## Model Experience` 与 `## Known Limitations and Deferred Work`）+ 组 README + `packages/README.md`。
- `tsconfig.host.json` references；`tsconfig.base.json` 新组通配。
- feature Agent Note（`.agents/notes/implemented/feature/`，同一 PR）。
- `pnpm run hygiene`、`pnpm run doc-sync`、`pnpm run test:coverage` 全绿。

## 8. 新期刊开发工作流（持续更新路径）

1. 复制最接近的 `src/strategies/<publisher>.ts`，实现 `matches` + `download`；
2. 照现有模式写回环 fixture 单测；
3. `DSH_LITERATURE_E2E=1` 真实站点验证；
4. 快速原型可走 `cordis_define` 动态包直接向 `ctx.literature.registerStrategy` 注册验证，定型后落盘；
5. 个人专属期刊也可拆独立小包（如 zhu-extra-journals）只挂 home layer，向同一 seam 注册，不碰核心包。

## 9. 实施顺序

1. seam 包 + nature 策略 + tool 骨架 + 回环 fixture 基建（最早端到端跑通）；
2. engine + pnas/science/ieee 移植（含 4 修复）；
3. sage/elsevier + manual-required 流程；
4. bundle 包 + 环境挂载验证（真实下载冒烟）；
5. 快照场景 + e2e + 全部门禁/文档/Agent Note。

## 10. 已知取舍

- headless 默认 false（已验证反爬配方）；无头服务器需显式改 true 并自担风险。
- SAGE 真实站点未实测（fixture 单测 + opt-in e2e）。
- 超大批次（>10 篇）由模型按上限自动拆分多次调用。
- Elsevier 按设计不自动下载，返回 manual-required + 指引。
- 后台 jobs 执行模型（`ctx.jobs.start` + `job_output` 轮询）列为二期增强。

## 11. 仓库依据（探索结论备查）

- seam 模板：`packages/web/web`（注册表/disposer/错误码模式）；`resolve(request): Spec` 显式默认化约定见 `packages/shell/shell/src/index.ts:65-101`。
- 工具定义框架：`defineTool`/`output{schema,render,presentationMeta}`/`timeoutMs`/`isConcurrencySafe` 见 `packages/core/tools/src/schema.ts:483` 与 `src/index.ts:222-288`；卡片词汇表 `packages/core/tools/src/presentation.ts`。
- 超时强制：`packages/guard/timeout-policy`（协作式，模型不可见）。
- 装配链路：profile 层叠（bundle patches → profile patch → home layer `~/.dsh/cordis.patch.yml` → `--patch`）；`healProfilesModuleFallback` 把 apps/cli 依赖闭包符号链接进 profile node_modules。
- 平台门控行先例：`disabled: !!js process.platform === 'win32'`（bundle patch 行）。
- 外部重依赖先例（普通 dependencies + 按需 allowBuilds）：sharp、koffi、node-pty、e2b。
- 仓库内 playwright 现状：仅 `apps/web` devDependencies（vitest browser mode）；无运行时浏览器自动化先例，本插件是第一个。
