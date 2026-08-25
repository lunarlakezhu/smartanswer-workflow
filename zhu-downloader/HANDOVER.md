# ZhuDownLoader 试验交接文档

> 日期：2026-08-25
> 目标：验证 Qoder 的文献 PDF 自动下载方案能否迁移到 deepseek-harness，作为插件的前期试验
> 结论：**方案可行**。原脚本搬入后 4 条下载路径全部验证通过，但需 3 处针对性修复（见下文）。

---

## 1. 来源与去向

| 项 | 路径 |
|---|---|
| 原 Agent 定义 | `E:\Qoder files\.qoder\agents\zhu-downloader.md` |
| 原脚本（未改动） | `E:\Qoder files\scripts\pw_download.mjs` |
| 试验目录（本目录） | `E:\deepseek-harness\ZhuDownLoader\` |
| 修复后脚本 | `ZhuDownLoader\pw_download.mjs` |

原脚本保持原样，所有修复只落在试验目录的副本上。

## 2. 环境

- Node.js v24.18.0，npm 11.12.1
- `npm install playwright` 已在试验目录完成（`"type": "module"`）
- Chromium 浏览器复用系统缓存 `%USERPROFILE%\AppData\Local\ms-playwright\`（chromium-1234），**无需重新下载浏览器**
- 出版商全文访问依赖校园网订阅；付费文章会正确识别为失败而不是误存 HTML

## 3. 用法

```bash
cd E:\deepseek-harness\ZhuDownLoader
node pw_download.mjs "<DOI>" "<输出目录>"
# 示例
node pw_download.mjs "10.1038/s41467-024-48293-2" "test-downloads"
```

输出：`<输出目录>\{DOI合法字符}.pdf` + 追加写入 `download.log`。

出版商识别与策略（沿用原方案）：

| 出版商 | 策略 |
|---|---|
| Nature/Springer | PowerShell `WebClient` 直下 `.pdf`（最快，~6s） |
| PNAS | Playwright，`a#downloadPdfUrl` DOM 点击触发下载事件 |
| Science | Playwright reader 页 → 点 `download=true` 链接 |
| IEEE | Playwright `route.fetch(timeout:0)` 流式拦截 `getPDF.jsp`（慢，~50s） |
| SAGE | Playwright 点 PDF 按钮（**本次未实测**） |
| Elsevier | 不自动下载，打开 Edge 提示人工过 Cloudflare |

## 4. 验证记录

| 出版商 | 测试 DOI | 结果 |
|---|---|---|
| Nature（开源） | 10.1038/s41467-024-48293-2 | ✅ 2263KB / 6.4s |
| Nature（付费） | 10.1038/nature14539 | ✅ 2895KB / 10.9s（cookie 重试修复后；原"付费墙"系误诊，实为 nature.com 的 cookie 检查弹回，见 §5.4） |
| PNAS | 10.1073/pnas.2314359121 | ✅ 4460KB / 14.9s（修复后） |
| Science | 10.1126/scirobotics.adr4264 | ✅ 5644KB / 25.9s（原样可用） |
| IEEE | 10.1109/LRA.2023.3322071 | ✅ 10745KB / 50.1s（修复后） |

全部有效产物经 `%PDF-` 文件头校验，见 `test-downloads\download.log`。

## 5. 本次修复的 4 个问题（相对原脚本的差异）

1. **Nature 付费文被 cookie 检查弹回**（`pw_download.mjs` `downloadNature`）
   - 原诊断"付费墙"系误诊：nature.com 对受限 PDF 先查 cookie，PowerShell `WebClient` 裸请求被 302 回 HTML 文章页（`error=cookies_not_supported`），根本没走到校园网 IP 鉴权。
   - 修复：直下后检查 `%PDF-` 头，非 PDF 则用带 cookie jar 的 `curl -c -b -L` 重试。开源文仍走原快路径（~5s），付费文 ~11s。
2. **PNAS 选择器命中隐藏按钮**（`pw_download.mjs:102-110`）
   - 原选择器 `a:has-text("Download PDF")` 命中 DOM 中第一个匹配项——隐藏的 supporting-information 按钮，超时失败。
   - 进一步发现：物理点击被 `<div data-extent="article-wrapper">` 遮罩拦截；`ctx.request` 直接请求 PDF 端点返回 403（即使带 Referer）。
   - 最终方案：改用页面规范元素 `a#downloadPdfUrl`，以 `evaluate(el => el.click())` 触发真实下载事件。三条路径（选择器/直链/物理点击）均验证过，只有 DOM click 可行。
3. **IEEE 页面 networkidle 永不满足**（`pw_download.mjs:179-184`）
   - IEEE Xplore 后台请求不断，`waitUntil: 'networkidle'` 30s 超时。改为 `domcontentloaded` + 60s，PDF 按钮等待 15s → 30s（动态渲染偏慢）。
4. **失败后浏览器残留、进程挂死**
   - 原脚本异常路径不执行 `browser.close()`，实测进程挂起需强杀。4 条浏览器路径（PNAS/Science/IEEE/SAGE）统一加 `try/finally`。

## 6. 已知遗留

- `download.log` 失败条目会写入多行错误堆栈，破坏单行日志格式（可在 `logEntry` 里把 `detail` 的换行替换掉）。
- SAGE 路径未实测（无合适测试 DOI）。
- Elsevier 按设计需人工过 Cloudflare，不属于自动能力范围。

## 7. 诊断工具（可留可删）

| 文件 | 用途 |
|---|---|
| `inspect_pnas.mjs` | 列出 PNAS 页面全部 PDF 相关元素及可见性 |
| `probe_pnas.mjs` | 验证浏览器上下文内直接请求 PDF 端点（结论：403） |
| `probe_pnas2.mjs` | 验证带 Referer 请求（403）与 DOM click 下载事件（可行） |
| `probe_ieee.mjs` | 轮询观察 IEEE 页面动态渲染出 stamp 链接的时序 |

## 8. 下一步：做成 deepseek-harness 插件

按仓库 `AGENTS.md` 规范，新能力需落在 `packages/` 下，走 capability seam（Service Definition / Service Provider / Consumer）三角色完整实现；注册一律经 `ctx.effect()`；无硬编码路径/可调参数，部署相关项进 `Config` 由 cordis.yml 注入。当前脚本可作为 Provider 层的执行核心保留，DOI 解析、出版商分发、结果报告拆为 Consumer/工具层。

注意：试验目录位于 deepseek-harness 仓库内但尚未纳入 git 管理，正式插件化时按 `packages/<group>/<pkg>/` 结构重建，不要直接搬目录。
