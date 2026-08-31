---
name: smartanswer-research
description: >-
  SmartAnswer 文献调研全流程框架：问题拆解→多源检索→库内匹配分流→下载与 GPU 转换→双读精读→审计对抗→入库 new-library→雪球二轮→终答（md+HTML）。
  收到文献调研、综述写作、研究现状/技术路线类请求时加载本 skill；换机器后先核对「环境依赖」一节再执行。
---

# SmartAnswer 文献调研流程（DSH 版运行手册）

> 本 skill 是 SmartAnswer 工作流的权威执行手册。**每次调研开始前先完整读一遍本文件，不凭记忆执行。**
> 原始迁移源文档存于 `reference/原始工作流说明书.md`；框架规定见工作区 `SmartAnswer-设计文档.md`。
> 本目录内 `workflows/` 与 `templates/` 均为相对路径，运行时按本 skill 加载时公布的 base directory（即本目录）解析；不依赖任何外部绝对根。

---

## 1. 角色分工

- **主 agent（研究员/主编）**：所有决策、闸门、写盘、修订、终答。只有它能写文件、开 Edge、跑转换。
- **子代理（一次性并行工）**：由 workflow 脚本派出——检索员、匹配员、主读、验证读、仲裁、审计官。子代理无文件写入承诺，只交结构化结果。
- **审计官**：audit.js 派出的核对工，prompt 强制「只读、禁止写任何文件」。DSH 无按子代理的权限沙箱，此为指令级软约束。

## 2. 环境依赖（换机器必核，逐项 Test-Path）

| 项 | 路径 | 用途 |
|---|---|---|
| GPU 转换三件套 | `E:\PDF2md\GPU转换.bat`、`pdf2md_gpu.py`、`pdf2md.py`（同目录） | PDF→md 主通道 |
| Python | `C:\Users\你的用户名\AppData\Local\Programs\Python\Python311\python.exe` | 跑转换（bat 内写死此路径） |
| 期刊白名单 | `E:\Library-Manage\raw-library\HanaLibrary\zhu-journals.md` | 过滤禁用刊 |
| 白名单迁移源 | `E:\Qoder files\zhu-journals.md` | 阶段 0 兜底复制 |
| 文献索引 | `E:\Library-Manage\new-library\文献索引.md` | 库内匹配分流 |
| 入库目标库 | `E:\Library-Manage\new-library\`（`md\`、`pdf\`、`归档\`、`最终回答汇总\`、`SCHEMA.md`、`CHANGELOG.md`） | r1/r2 审计锁定后入库 + 终答入库（第 11、13 节）；规范见 SCHEMA.md |
| 文献库根（默认） | `E:\Library-Manage\raw-library\HanaLibrary\` | 存放 `{主题}\r1\ r2\`；**阶段 0 向用户确认，可更换** |
| 文献自动下载 | `E:\deepseek-harness\packages\literature\*\lib\`（构建产物，经预设 `literature` 组挂载） | `literature_download` 工具（阶段 6）；换机器需在 dsh 仓库 `pnpm run build` 重建并核对预设绝对路径（docs/handover.md），浏览器策略另需一次 `npx playwright install chromium` |
| Edge | `C:\Users\你的用户名\.dsh\.agent-presets\smartanswer\plugins\sa-config.json` 的 `edgePath` | 失败篇兜底批量开 DOI（`sa_open_edge` 工具读取；宿主直启，不经沙箱） |
| Node.js ≥18 | `node --version` 在 PATH 可用即可（实测 v24） | 阶段 4 取数脚本 `reference/crossref-fetch.js` 运行时（自带 TLS，不受沙箱 SChannel 限制） |

换环境：把上表路径全部对应到实际位置再开工，流程不变。本 skill 内出现的路径以本节为准。

## 3. 状态机与产物

每主题一份 `{主题}\_progress.yaml`（骨架：`templates/progress.yaml`）。规则：

- **每阶段开始前读、结束时写**；
- **落写即面板（2026-08-20 复盘：全程零更新导致「调研进度」面板空白）**：`_progress.yaml` 是调研进度面板（sa-panel）的阶段/闸门数据源。阶段开始/结束、每个闸门状态变化（含等待用户时的 `awaiting`）与 `papers/downloaded/archived` 计数变化都必须落写，等用户期间也要保持 `awaiting` 状态可见；
- 会话中断后恢复：先读 `_progress.yaml` 定位阶段 → 核对该阶段产物是否齐全 → 缺则补做，多则跳过；
- 各阶段产物固定文件名：`r1\round1_list.yaml`、`r1-{NN}_中文标题_年份.md`、`r1\audit_report_r1.md`、`初步回答.md`、`r2\round2_list.yaml`、`r2\audit_report_r2.md`、`最终回答.md`、`最终回答.html`；入库进度用 `r1.libArchived`/`r2.libArchived` 计数表达（磁盘计数口径，见第 11 节）。

收到"继续 XX 调研"时：读对应 `_progress.yaml`，从 `stage` 续跑。

## 4. 阶段 0 · 启动（含存放位置与命名确认）

**显式启动方式**：用户在输入框输入 `/smartanswer <主题>`，或说「启动/开始 文献调研：<主题>」。自然语言描述调研需求同样触发；无论哪种方式，进入流程后先执行本阶段。说明：`/smartanswer` 在本会话若运行了「smartanswer 斜杠命令」动态插件（`smart-1`），会被系统命令接管、由插件把主题转交给模型；插件未运行时该行不注册，作为普通消息到达模型——两条路径殊途同归，均按本 skill 进入流程。

1. **询问确认**（用 ask_user_question 一次问全，均提供默认值）：
   - 主题：一句话主题（必答）
   - 存放位置：默认 `E:\Library-Manage\raw-library\HanaLibrary\`（不答即用默认，可换任意文件夹）
   - 文件夹命名：默认用主题名（可自定义，如「水下机械爪-2026」）
2. 按确认结果创建 `{存放位置}\{命名}\r1\`、`r2\`；同名冲突自动 `_2`、`_3` 后缀
3. 检查白名单 `{存放位置}\zhu-journals.md`；不存在则用默认库根的 `E:\Library-Manage\raw-library\HanaLibrary\zhu-journals.md`，仍无则从 `E:\Qoder files\zhu-journals.md` 复制
4. 写 `_progress.yaml`（初值：stage=boot、folder=实际路径、gates 全空）
5. 可选：create_goal 登记本次调研目标（跨轮追踪用）

> 本 skill 后续所有 `{主题}` 路径均指本阶段确认的实际存放位置；未更改则用默认库根。

## 5. 阶段 1-3 · 拆解（★闸门 1）

1. **问题拆解**：2-5 个递进式子问题（避免平面拆分，后问题引用前问题结论）
2. **场景判别**：literature_search / concept_explain / method_compare / paper_interpret / research_status / tech_roadmap
3. **归纳轴判定**：能力 / 任务 / 硬件 / 时间线 / 对比 / 课题组；模糊默认「能力」
4. **★ 闸门 1**：把「拆解 + 场景 + 归纳轴」报告用户，等明确确认（确认 / OK / 可以 / 直接搜吧）。**未确认不得进入搜索。**（用 ask_user_question 或聊天确认）
5. **关键词展开**（确认后）：五维（传统分支 / 跨界交叉 / 新涌现概念 / 核心研究者 / 新兴研究者），每维 2-5 个中英关键词，每维至少 1 个基础单关键词
6. 写 `_progress.yaml`（stage=search、subQuestions、scenario、axis、gates.decompose=confirmed）

## 6. 阶段 4 · 检索（含验身与排序）

1. 组装 args：`{ topic, subQuestions, keywords, sites? }`（keywords 为中英混合字符串数组）
2. 读 `workflows/search.js` → 调用 workflow 工具（meta.name=`smartanswer-search`，args 同上）。**10 路子代理一次并行（不拆批）**：9 出版社（Nature / Springer / Science / ScienceDirect / IEEE / PNAS / SAGE / IOP / Wiley）+ **PubMed 来源补充路**（OpenAlex `has_pmid` 过滤——**不是期刊**，定位是补充医学/生命科学交叉文献）。arXiv 路已删（2026-08-20 裁决：预印本质量弱、排序时基本被剔除且输出体积大）。**CrossRef 不作搜索源**（试运行证实：关键词查询单路耗时约 25 分钟且噪声大，混入无关文献）
   - **紧凑回传（2026-08-20 复盘：11 路带摘要一次回传约 187KB，超过约 50KB 落盘阈值被截断、后 8 路结果全丢，被迫补跑又引发超时雪崩）**：每路子代理 structured_output 只回 `{title, doi, doiSource, year, journal}`（每路上限 15 条），不带 abstract/url/authors——摘要由第 5 步 crossref-fetch 按 DOI 统一预取，不损失信息；脚本侧另有投影兜底，全路汇总约 40KB 以内
   - **预算（OpenAlex 额度制，2026-08-20 实测响应头：每日 1000 credits、search 一次 10 credits，全天约 100 次搜索）**：每路总查询 ≤8、每关键词 ≤2 种写法、候选 ≥12 或连续 3 查询无新增即止；10 路 × 8 = 800 credits，留 200 给补跑
   - **失败路单路补跑**：某路 `searchUnavailable:true` 时，只对该路用 `sites:["<域名>"]` 再调一次 search.js；**禁止多路成批补跑**（2026-08-20 实测：3 路同时补跑打挂串行 MCP server，连环 60s 超时报废 3 路）。错误含 `daily credit quota exhausted` = 当日额度耗尽，**当日不再补跑**，向用户报告后用已获取结果继续
   - **DOI 止损**：搜索中直接可见才填 doi（doiSource='seen'）；看不到填 `""` + doiSource='pending'，交验身阶段按标题补验（禁止猜 DOI、禁止 sci-hub/x-mol/scite 等聚合站查证）
3. 主 agent 汇总去重：DOI 标准化（去 `https://doi.org/` 前缀、统一小写）后合并多站同篇 → 候选清单
4. 白名单预过滤（第一道，用搜索结果的期刊名先剔除黑名单刊，减少取数查询量）
5. **验明正身 + 排名数据**（主 agent 预取 + verify.js 离线判读）：
   - 把候选写成 `{主题}\r1\_dois.json`（`["10.1109/...", ...]`、`[{"doi":"..."}]` 或 **`[{"doi":"","title":"...","doiSource":"pending"}]`**——无 DOI 条目按标题补验）
   - 主 agent 用 pwsh 跑：`node "<此 skill 目录（加载时公布的 base directory）>\reference\crossref-fetch.js" "{主题}\r1\_dois.json" "{主题}\r1\_crossref_data.json"`（Node 自带 TLS，不受沙箱 SChannel 凭证问题影响；**子代理一律禁网**；P3 起可改用 sa_crossref_fetch 工具）
   - 有 DOI 条目按 DOI 查；**doiSource='pending' 条目按标题 `query.title` 查（crossref-fetch.js 路径二，实测 0.4-1.4s/篇、score≥60 视为命中）**，命中后回填权威 DOI
   - 读 `workflows/verify.js` 全文 → 调用 workflow 工具：meta.name=`smartanswer-verify`，args `{ papers: 候选清单, crossrefData: 预取结果数组 }`
   - **本步为固定阶段，不得省略**：验身判读必须经 verify.js workflow 真实运行（会话留痕），禁止主 agent 自行消化 crossref 数据替代（2026-08-19 复盘：该 workflow 被整段跳过）
   - 取数通道（方法②）：身份（标题/期刊/年份）以 **Crossref 权威**为准、404/失败 OpenAlex 兜底（titleSrc 标注）；摘要 Crossref 优先、无则 **OpenAlex 补**（IEEE 路尤其受益：IEEE 很少向 Crossref 存摘要）；被引数统一 **OpenAlex cited_by_count** 口径供排序，Crossref 值存 crossrefCitedBy 备查
   - 预取行 status=not-found（两源均 404/标题查询低分）/error（网络失败）→ 补跑一次仍失败 → Edge 人工核实
   - 预取行摘要为空则留空（2026-08-20 起检索回传不带摘要，无「来源：检索」回退源）；**禁止编造摘要**
   - 期刊名以权威记录为准复核白名单：落黑名单则剔除
6. **核实链残余**：status=verified → 直接入库；error/未预取 → 主 agent 补跑取数脚本一次，仍失败再走人工；mismatch / not-found → 报告用户并 `sa_open_edge` 开 Edge 单页 `https://doi.org/{doi}` 让用户人工核实后定取舍
7. **过滤排序**（主 agent 执行，顺序不可乱）：年份降序 → NS 子刊优先 → 被引降序（用第 5 步 citedBy，统一 OpenAlex 口径；个别退 Crossref 的按 citedBySrc='crossref' 视为下界排后）→ ≤5 篇/刊 → 综述识别标 📖 → 经典补刀可选
8. 输出文献清单（标题 / DOI 直达链接 / 一句话简介 / ✅📖 标注），写 `r1\round1_list.yaml`（模板：`templates/round1-list.yaml`）
9. 清单交用户过目确认（原文流程要求），同时更新 `_progress.yaml`（stage=match）

## 7. 阶段 5 · 库内匹配分流（脚本化，零子代理）

> 2026-08-19 复盘：本阶段原为 match.js 的 5 个 LLM 子代理（耗时 148.6s 做纯 grep 工作），已废弃改脚本；`workflows/match.js` 已删除，禁止再派匹配子代理。

1. 主 agent 用 pwsh 脚本对清单逐篇判定（索引定位 DOI → 取「编号」列 → 定位 md → 头部判形态），零子代理、秒级完成：
   ```powershell
   # $dois = 清单候选 DOI 数组；输出 doi|tier|mdPath
   $lib = 'E:\Library-Manage\new-library'
   $idx = "$lib\文献索引.md"
   foreach ($doi in $dois) {
     $hit = Select-String -LiteralPath $idx -Pattern $doi -SimpleMatch | Select-Object -First 1
     if (-not $hit) { "$doi|miss|"; continue }
     $no = ($hit.Line -split '\|')[1].Trim()            # 索引「编号」列
     $md = Get-ChildItem "$lib\md" -Filter "$no-*.md" -File | Select-Object -First 1
     if (-not $md) { "$doi|miss|"; continue }
     $head = (Get-Content -LiteralPath $md.FullName -TotalCount 30 -Encoding UTF8) -join "`n"
     $tier = if ($head -match '(?m)类型:\s*"?full-text"?|Abstract|^## ') { 'full' } else { 'notes' }
     "$doi|$tier|$($md.FullName)"
   }
   ```
2. 汇总分档，在清单里显式标记：
   - `[库内原文]`：full → 直接双读，输入=库内 md 全文
   - `[需下载]`：其余一律（**含 notes、miss**）→ 阶段 6 先自动下载，失败篇再经 Edge 人工兜底
3. **红线：精读笔记不算原文**（六维答案随调研问题漂移），不得作为双读输入，一律 `[需下载]`
4. 更新 `round1_list.yaml` 加 tier 字段、`_progress.yaml`（stage=download）

## 8. 阶段 6 · 下载与转换（自动下载优先；闸门 2 仅兜底时触发 = Edge 放行 + 下载完成确认）

1. **6a 自动下载（不设确认闸门）**：提取全部 `[需下载]` DOI，立即调用 `literature_download` 工具批量下载（搜到即下，无 Edge、无人工）：
   ```
   literature_download { dois: ["10.1038/...", "10.1007/...", ...], outDir: "{主题}\r1" }
   ```
   - **每批 ≤8 个 DOI**（工具上限 10，留超时余量）；清单更长就分多次调用，逐批落账
   - 自动可下：Nature / Springer / PNAS / Science / IEEE / Wiley / SAGE；**Elsevier（ScienceDirect）按设计返回 manual-required**（Cloudflare 人工质询）；IOP 等未支持出版商直接 failed
   - 结果逐篇给出 `ok | failed | manual-required` + 路径/原因；**失败是终态行，不盲目重试同一出版商**（重试前先看原因：无权限/无 OA 不会因重试改变）
   - **单次调用超时**（工具整体 600s）：先 pwsh 数 `{主题}\r1\*.pdf`，对「清单 − 已有 PDF」的缺失 DOI 重新调用，已到账的不重复下
2. **6b 落账（磁盘口径）**：
   - pwsh 复核 `{主题}\r1\*.pdf` 计数，`round1_list.yaml` 逐篇在 note 标注 `自动下载`（含相对 PDF 文件名）或 `待人工`（含原因）
   - `_progress.yaml`：`r1.downloaded` = 磁盘 PDF 计数；failed + manual-required 的 DOI 逐行写入 `{主题}\r1\download_failed.txt`（每行一个 DOI，可直接作为下次重下清单）
   - **全部成功 → `gates.edge_r1` 与 `gates.pdf_r1` 直接落 `confirmed`（自动下载视同已放行、已确认），跳过 6c**，向用户一行汇报成功清单后进第 4 步 GPU 转换
3. **6c 人工兜底（仅当 download_failed.txt 非空）**——沿用原 Edge 流程，只处理失败篇：
   - 报告失败清单（DOI + 原因），**ask_user_question 获确认（`gates.edge_r1`）**后调用 `sa_open_edge` 批量开失败篇（宿主进程直启、不经 pwsh 沙箱；urls = `https://doi.org/<doi>`）：
     ```
     sa_open_edge { urls: ["https://doi.org/10.1016/xxx", ...] }
     ```
   - **用户把这几篇的 PDF 存到 `{主题}\r1\`**（主 agent 先告知绝对路径）；拖进对话（.dsh-drops）仅作兜底通道
   - **★ 下载完成确认（硬闸门；2026-08-20 复盘：0/21 到账仍推进双读被用户打断）**：打开 Edge 后停在等待，写 `_progress.yaml`（`gates.pdf_r1: awaiting`）。goal_round 自动续跑到达时只做一次 pwsh 计数核对，未确认前不得推进
   - ask_user_question 问「PDF 下载情况」（全部就绪 / 部分就绪（报告数量与缺失 DOI）/ 放弃缺失篇用现有的继续）；答复后 pwsh 复核计数一致才进第 4 步；**用户放弃的篇目从清单标注中落注（放弃原因），后续引用相应减少**
   - **计数为 0 或未经用户确认前，禁止启动 GPU 转换、禁止读双读模板组装双读**
4. **GPU 转换**（主 agent 直接跑，不用用户拖 bat）：
   ```powershell
   python -u "E:\PDF2md\pdf2md_gpu.py" "E:\Library-Manage\raw-library\HanaLibrary\{主题}\r1\*.pdf" -o "E:\Library-Manage\raw-library\HanaLibrary\{主题}\r1\_text"
   ```
   Python 路径用第 2 节表格里的完整路径；`-u` 关输出缓冲；`run_in_background: true` 挂后台 job
5. **进度监控**（三层，不忙轮询，隔一段交互时机读一次并转告用户）：
   - `job_output` 读后台 job：看 `[N/M] [完成] xxx.pdf` 行
   - 文件计数（最可靠）：`r1\_text\*.md` 数 ÷ `r1\*.pdf` 数
   - `nvidia-smi` 心跳：CUDA 进程是否在忙（首次初始化显卡/模型需几十秒，无增长不算卡死）
6. 终检：成功数=PDF 数；**若有失败，不做任何自动兜底**——向用户报告失败清单与原因（转换日志尾部有），由用户手动处理（重新下载 PDF 或自行拖 bat 转换），处理完补检
7. **产物去向汇报（固定步骤，不得省略）**：向用户报告一行——自动下载 N 篇 / 人工兜底 M 篇 / 放弃 K 篇，源 PDF 保留在 `r1\`、Markdown 在 `r1\_text\`（计数 N+M/K 总比）、失败清单（如有）；之后写 `_progress.yaml`（stage=dualread、gates.pdf_r1=confirmed、r1.downloaded=PDF 计数）

## 9. 阶段 7 · 双读精读

1. **组装前逐篇核对 mdPath ↔ DOI（强制）**：对每篇用 `Select-String -LiteralPath <mdPath> -Pattern <清单DOI> -SimpleMatch -List`（或读文件头 20 行）验证文件确属该篇；任一不一致立即停止、重查 `round1_list.yaml` 映射（2026-08-19 复盘：batch3/4 映射错位致 14 篇读错文件）
2. 核对通过后组装 args：
   - `papers`: 每篇 `{ id: '{NN}', mdPath: 'r1\_text\{stem}.md', kind: 'paper'|'review', title, year }`（kind 按阶段 4 的 📖 标注）
   - `templates`: 读 `templates/archive-paper.md`、`archive-review.md`、`verify-questions.md` 的内容注入
   - `subQuestions`、`topic`
3. workflow 跑 `workflows/dualread.js`（**逐字转抄**），**每批 ≤10 篇**（25 篇分 3 次调用，同脚本同参数切片）
   - 主读：综述→观点提炼模板；普通→六维+思考三问模板
   - 验证读：按 kind 选四问版本（见 `templates/verify-questions.md`）
   - 仲裁：验证读提到主读漏了→补入标「验证读补充」；矛盾→回原文裁定；一致→标「✅双读一致」
4. **每批结束立即归档组装**（省 token 且逐字保真；禁止攒批，复盘教训：攒到最后只落 2/34 份归档）：脚本只返回模板段落；主 agent 用 pwsh 追加全文：
   ```powershell
   $full = Get-Content -LiteralPath '<mdPath>' -Raw -Encoding UTF8
   Add-Content -LiteralPath '...\r1-{NN}_{中文标题}_{年份}.md' -Value $full -Encoding UTF8
   ```
   归档文件名 `r1-{NN}_中文简短标题_年份.md`；R1 全部文献必须全部归档
5. **阶段出口条件（磁盘事实，非自报）**：`Get-ChildItem r1-*.md` 计数 = 论文数，达成后才写 `初步回答.md`：子问题优先（≥2 子问题为一级章节）、归纳轴兜底、递进子问题先列前序结论、每技术点 [N] 引用、交叉验证标 ✅多源一致/⚠️存在分歧/📌单源、缺失维度写明「未找到充分信息」
5. 更新 `_progress.yaml`（stage=audit）

## 10. 阶段 8 · 审计对抗

1. 主 agent 从 `初步回答.md` 提取**全量**声明列表：`claims=[{n, text, refs}]`（refs 为 [N] 对应文献）；**每个 [N] 引用支撑的实质性断言各成一条，禁止抽样或合并**（2026-08-19 复盘：57 个引用只提了 10 条）
2. `archivePaths` 必须是主 agent 先枚举出的**真实文件完整路径列表**（pwsh `Get-ChildItem` 或 glob；禁止通配符模板——grep 的 path 不支持通配符）
3. workflow 跑 `workflows/audit.js`（**逐字转抄**）：
   - 逐条 [N] 回归档定位（**连字归一化**：`ef fi ciently`→`efficiently`；ff→f 静默丢失按归一后匹配；数据点回 PDF 复核）
   - 分类：✅ 原文确认 / ⚠️ 部分匹配 / 🔄 综述代引 / 🚫 无原文支撑
4. **覆盖度检查改为主 agent pwsh 统计**：对每个归档统计 [N] 引用行号的前/中/后三等分分布，全部集中前 1/3 → 回溯重读；结果写入审计报告附注（不派 LLM 子代理）
5. 主 agent 写 `r1\audit_report_r1.md` = **结论-证据对照表**（每条：结论摘要 | [N] | 归档文件 | 行号 | 原文摘句 ≤40 字；模板：`templates/audit-report.md`）
6. **修订循环 ≤2 轮**：删 🚫 / 改 ⚠️ / 替换 🔄（溯源原始 DOI）→ 只重跑受影响声明 → **🚫=0 且 ⚠️ 全修正**；超 2 轮未达标 = 上游（双读/归档）有问题，停下修上游
7. **锁定**：对照表 = 禁改清单（写入 `_progress.yaml` 的 `r1.forbidden`）；修订后 `初步回答.md` = 锁定基底（`r1.locked: true`）
8. **r1 入库（第 11 节，round=r1）**：锁定后立即执行——库里只进被审计验证过的版本；复核通过写 `_progress.yaml`（`r1.libArchived`=磁盘计数）后才进入阶段 9

## 11. 入库归档（r1 在阶段 8 锁定后、r2 在阶段 9 增量审计后；终答另有第 13 节终答入库）

> 依据 `E:\Library-Manage\new-library\SCHEMA.md`（编号主键、命名、frontmatter、DOI 去重、CHANGELOG 留痕）。每轮阅读完成（审计锁定）后，把 PDF 原文、转换 md、精读笔记编号入库并更新 `文献索引.md`——库里只进被审计验证过的版本。工作目录产物**复制不移动**（终答闸门计数、r2 防回退审计仍引用原路径）。

1. **数据源**：r1 用 `r1\round1_list.yaml`；r2 用 `r2\round2_list.yaml`（r2 新增固定产物：雪球候选经用户确认后按 round1 同格式落盘，含 no/title/doi/year/journal/is_review，tier 按对索引的 DOI 匹配回填）
2. **主题标签（manifest 的 tags，1–3 个）**：SCHEMA §6 受控词表（DEA/SMA/水下/抓取/综述…）优先；词表覆盖不了的（本流程可跑任意主题）用本次调研关键词补足——词表外标签由脚本自动标注进 CHANGELOG，不算违约
3. **执行**（主 agent pwsh 调 node，脚本无网络无 LLM，仿 crossref-fetch 通道）：
   ```powershell
   node "<skill 目录>\reference\library-archive.js" "{主题}\r1_archive_manifest.json"
   ```
   manifest：`{ mode:"round", round:"r1"|"r2", topic, topicDir, libraryRoot:"E:\Library-Manage\new-library", papers:[{ no, title, doi, year, journal, is_review, tier, pdfPath, mdPath, notePath, tags }] }`（tier=full 论文 pdfPath/mdPath 可缺省——库内已有原文不重复复制；papers 顺序即编号分配顺序）
4. **脚本分支规则（主 agent 必须能向用户解释输出）**：
   - DOI 不在索引 → 新编号（索引最大号+1，3 位零填充）：PDF→`pdf\{编号}_{slug}.pdf`；全文 md 注入 frontmatter（`类型: full-text`）→`md\`；精读笔记注入 frontmatter（普通文献 `六维精读`+`信息等级: A`；综述 `综述精读`+等级留空）→`归档\`；索引表末追加行、无 PDF 标 `—` 并入附注清单
   - DOI 已在索引（阶段 5 tier=full/notes、r2 撞库）→ 复用原编号不新增行：笔记以 `{编号}_{slug}_{主题}_精读.md` 分层入 `归档\`；原编号缺 PDF 时补 PDF 并翻转索引列；全文 md 不重复入库（同编号双 md 属人工决策，不做）
   - 校验失败（清单内 DOI 重复/字段缺失/tier=full 却查无 DOI/新论文 md 缺失/编号将超 3 位）→ exit 1 整体不入库，修 manifest 后重跑；**重跑幂等**：已入部分自动跳过，全量入过则零改动零追加
   - stdout 末行 `JSON_RESULT: {...}` 是唯一核对数据源（新增编号、分层清单、补 PDF、无 PDF、词表外标签、warnings）
5. **复核与落盘**：pwsh 复核 JSON_RESULT 与磁盘一致（索引新增行数=新论文数、`md\ pdf\ 归档\` 文件计数）；warnings 非空必须逐条处理——尤其「转换 md 未检出 DOI」= 清单映射错位，回阶段 7 第 1 步重核后才算入库完成；通过后写 `_progress.yaml`（`r1.libArchived`/`r2.libArchived`=磁盘计数）并向用户汇报入库摘要（编号区间、分层清单、无 PDF 清单、CHANGELOG 位置）

## 12. 阶段 9 · 二轮雪球（闸门 3）

1. 从 📖 综述归档挖候选：≥2 篇共同引用优先 / 独立成段讨论 ≥3 句次之 / **禁仅凭标题**
2. 逐篇核实 + 摘要判断，与第一轮去重（DOI 标准化：去 `https://doi.org/` 前缀、统一大小写）
3. 下载同阶段 6 的三段式：先 `literature_download` 批量自动下载到 `r2\`（每批 ≤8、落账、写 `r2\download_failed.txt`）；全部成功则 `gates.edge_r2`/`gates.pdf_r2` 直接落 `confirmed` 跳过 Edge，有失败篇才走 `sa_open_edge` 兜底（同闸门 2 完整两问：Edge 放行 `gates.edge_r2` + **下载完成确认 `gates.pdf_r2`**）→ GPU 转换（同上）→ 双读（复用阶段 7，id 换 `r2-{NN}`）→ `r2-{NN}_*.md` 全量归档
4. **增量审计**：audit.js 只查新增声明 + **防回退**（已删内容重现按 🚫）+ 覆盖度 pwsh 复检 → 🚫=0 → 写 `r2\audit_report_r2.md`（结论-证据对照表同格式）
5. 写 `r2\round2_list.yaml`（round1 同格式；雪球候选经用户确认后即回填元数据，tier 按对索引的 DOI 匹配——它是 r2 入库的数据源）
6. **r2 入库（第 11 节，round=r2）**：跑 library-archive.js → pwsh 复核 → 写 `_progress.yaml`（stage=final、r2.libArchived=磁盘计数）

## 13. 阶段 10 · 终答

0. **终答前置硬闸门（任一不满足禁止写最终回答）**：
   a. `Get-ChildItem r1-*.md`（R2 已跑则含 r2 归档）计数 = 清单论文数；
   b. `audit_report_r2.md` 存在，或用户在对话中明确表示「跳过 R2」；
   c. 阶段 4 的 smartanswer-verify workflow 已真实运行；
   d. r1 已入库且（R2 已跑则 r2 也已入库）：`libArchived` 计数与索引新增行数/磁盘文件计数一致（用户明确豁免 R2 时 r2 项免）；
   e. 缺项只能补做或请用户明确豁免，不得降级交付（2026-08-19 复盘：缺归档仍 Copy-Item 出终答）
1. 携带禁改清单：**只叠加第二轮内容**，第一轮保持锁定版本不变
2. 8 项自查：DOI 可验证 / 结论来自精读 / 陈述有原文 / 全量已读 / 覆盖全文 / 无代引 / 雪球已验 / 缺文已声明
3. 写 `最终回答.md`：搜索范围概述、两轮文献总览、综述分析、核心发现（子问题优先）、交叉验证汇总、GB/T 7714 参考文献（标注轮次与等级 (A)/(D)）、缺文清单
4. **同一步内生成 `最终回答.html`**——🚨 不可跳过、不得延后为「如需请告诉我」（复盘教训）；100% 基于已审计内容，语义化 HTML5、引用上标、移动端适配。不再派终审 subagent：其复核的是自报数据，本条 0 的磁盘闸门取代之
5. **终答入库（第 11 节终答模式，固定步骤不得省略）**：组装 map（轮内 [N] → 全库编号，取自 round1/round2 清单与两轮入库的 JSON_RESULT）→ `node "<skill 目录>\reference\library-archive.js" "{主题}\final_archive_manifest.json"`（mode:final，mdPath/htmlPath 均必填）→ `最终回答.md/.html` 复制为 `最终回答汇总\{NN}-{主题}.md/.html`，md 副本文末自动附「轮内编号 → 全库编号映射」（SCHEMA §9）
6. 汇报：文献清单、归档数（磁盘计数）、审计可信度、入库编号区间与文件位置、产物位置；update_goal complete

## 14. 编排脚本调用约定

1. 先 `read` 对应 `workflows\*.js` 全文（本目录相对路径）
2. 调用 workflow 工具：meta={name, description}、rgs=本节所述 JSON；脚本注入**优先用 scriptPath 参数**（填 workflows 目录下对应脚本的绝对路径，引擎侧读文件、逐字注入，转抄面消失），script=脚本全文仅作兜底通道。若用 script，则必须逐字转抄文件内容，任何压缩/改写/重排均属流程违约（2026-08-19 复盘：audit.js 被裁成 27 行、dualread 被压成 34 行，覆盖度检查与仲裁全文路径因此消失；2026-08-20 起新引擎已支持 scriptPath）
3. 脚本无 fs/网络，**只协调**；写盘永远由主 agent 做
4. 每个脚本首行有 `args.smoke` 守卫：冒烟零 agent，可用于验证
5. pipeline 单项失败返回 null：主 agent 汇总时 `filter(Boolean)`，失败项单独重派或手工处理
6. **子代理模型覆盖（读 sa-models.json）**：每次调用 workflow 前读 `C:\Users\你的用户名\.dsh\.agent-presets\smartanswer\plugins\sa-models.json`（由调研进度面板写入）。文件不存在或为空对象 `{}` = 不覆盖，照常组装 args。非空时把顶层 `model`/`provider` 注入 args——四个脚本都接受可选 `args.model`/`args.provider`，透传给每个子代理的 agent() 选项；dualread 额外接受 `args.models.{main,verify,arbitrate}` 分角色覆盖（角色字段缺省回退顶层值），面板写入的角色键为 `dualread.main|dualread.verify|dualread.arbitrate`，注入时映射为 `main|verify|arbitrate`。**硬规则：该文件由面板写，agent 只读不写——不要创建、修改或删除它**。

## 15. 已知坑（必须内化）

1. **CrossRef 只按 DOI 精确查询（验身+排名），禁止当搜索引擎**：关键词查询（query.bibliographic）慢（试运行约 25 分钟/路）且噪声大（混入无关文献）；多 ISSN 重复键 `issn:a,issn:b` 的坑已随禁用关键词检索一并失效
2. nature 直抓 303 / IEEE 订阅墙 → 检索元数据缺失由验身补齐（身份 Crossref 权威、摘要无则 OpenAlex 补、被引数 OpenAlex 口径）；两源均查不到 → Edge 人工核实
3. **DSH 沙箱内 PowerShell/.NET 的 SChannel TLS 全废**（主 agent 与子代理同样复现「安全包中没有可用的凭证」/「基础连接已经关闭」），本地代理 17897 时开时关 → 取数一律由**主 agent 用 Node 脚本** `reference/crossref-fetch.js`（自带 OpenSSL+CA，实测三源全通）预取落盘；**子代理禁止联网、禁止自行调试网络**；旧 ps1 通道（裸 socket 走代理）仅代理在场时应急
4. MinerU 连字静默丢失（ff→f）→ 审计归一化兜底；PDF 直读连字拆分同理
5. Python 输出缓冲 → 转换一律 `-u`
6. workflow 上限：并发默认 ≤16（排队自动）、单批双读 ≤10 篇、验身判读 ≤10 篇/agent（verify.js 内部自动切片）；引擎超限报错自带分批提示（阶段 5 已脚本化，不再有匹配 agent）
7. 白名单过滤在排序前（检索后预过滤一次 + 验身后按权威期刊名复核一次：Crossref 优先、OpenAlex 兜底）
8. 笔记型 md 永不作为双读输入
9. 检索子代理拿不到摘要时**必须留空，严禁编造**（试运行中 nature 路出现过编造摘要）
10. **DOI 确认强迫循环**（2026-08-16 实测）：ScienceDirect/IEEE 结果页 URL 是 `pii/`、`document/` 格式不含 DOI，旧 prompt 要求「DOI 必须完整」→ 子代理陷入"搜→确认不了→再搜"死循环（SD 599 次 / IEEE 500 次 web_search，45 分钟未完成被取消；Springer 101 次因元数据完美主义偏慢）。**对策即 v2 约束（§6 第 2 条）**：DOI 止损（看不到就 pending 交验身阶段按标题补验）+ 硬性预算 + 防纠结。标题补验 `query.title` 实测 0.4-1.4s/篇、score≥60 命中（勿用 `query.bibliographic`，仍慢且噪声大）
11. **workflow 子代理必须用 structured_output 提交结果**：带 schema 的 agent() 以纯文本收尾 = 引擎判 failed → 该项 null（2026-08-19 复盘：7 个双读子代理读完全文却纯文本输出全部作废）。dualread.js/audit.js 的 prompt 已写明并自动重派一次；主 agent 自派 subagent 时同样要求
12. **OpenAlex 额度制（2026-08-20 实测响应头 X-RateLimit-*）**：每日 1000 credits、search 一次 10 credits（全天约 100 次搜索），耗尽后 429 且 Retry-After 为小时级。server v3.1 对此立即报 `daily credit quota exhausted` 不再重试——检索子代理见此错误立即停（不等 2 次）、当日不补跑，向用户报告后用已获取结果继续或次日再跑。检索预算（每路 ≤8 次）即为此设
13. **工作流回传体积红线**：多路汇总类 workflow 的子代理 structured_output 只回下游真正消费的紧凑字段——落盘阈值约 50KB（内联+spill 双截断，2026-08-20 实测 187KB 回传丢 8 路）；大字段（摘要等）一律由后续阶段的落盘预取补齐
14. **禁止用 pwsh 开 Edge**（2026-08 试验复盘：沙箱 pwsh 跑 `& msedge.exe <23 个 URL>` 返回 exit 0 但浏览器没开——沙箱 kill-on-close Job 在 pwsh 退出瞬间杀掉整棵进程树，受限 token 还阻断向既有 Edge 实例的 IPC 交接，且命令假成功、无任何 denial 信号）；开浏览器一律走 `sa_open_edge` 工具（宿主进程 detached+unref 直启，不经沙箱，Edge 路径取 sa-config.json 的 edgePath）
15. **sa-panel 的 stage 枚举是固定的**（boot|decompose|search|match|download|dualread|audit|snowball|final，面板按 STAGE_RANK 映射步骤条）：入库不引入新 stage 值，进度用 `r1.libArchived`/`r2.libArchived` 计数表达——写入未知 stage 值会让面板步骤条降级为原文本
16. **literature_download 是阶段 6 的第一通道，Edge 只兜底**（2026-08-31 起自动下载）：每批 ≤8 个 DOI（工具上限 10，留整体 600s 超时余量）；结果行是终态——Elsevier/ScienceDirect 恒为 manual-required（Cloudflare 人工质询，按设计不走自动），无权限/非 OA 的 failed 不会因重试改变，禁止对同一出版商盲目重试；调用超时就数磁盘已有 PDF、只对缺失 DOI 补调；工具报「不可用」（如换机未部署）→ 整体回退原 Edge 手动流程并告知用户

## 16. 产物闸门（执行保证）

1. 开始前先读本 skill（不凭记忆）
2. 归档数 = 论文数（r1、r2 各自全量）
3. 审计报告 🚫=0；二轮无回退
4. `最终回答.html` 存在才汇报
5. 人工闸门一个不少：拆解确认 ×1；Edge 放行与 **PDF 下载完成确认 ×2（r1/r2 各一次）仅在自动下载有失败篇、需要 Edge 兜底时触发**（ask_user_question + pwsh 计数复核）；自动下载全部成功时两 gate 直接落 `confirmed`（2026-08-20 前"PDF 下载 ×2"只写在纸面从未作为交互执行，agent 曾在 0/21 到账时推进双读被用户打断——自动下载时代该闸门防的是「失败篇未兜底确认就推进」）
6. `_progress.yaml` 的 papers/downloaded/archived 等计数字段只能来自磁盘计数命令的输出，禁止凭记忆或预估填写（复盘教训：曾谎报 archived:34，磁盘实为 2）
7. **入库完成才算轮结束**（第 11 节）：索引新增行数、CHANGELOG 留痕、`md\ pdf\ 归档\` 文件计数三方一致（全部磁盘计数）；入库 warnings 清零或已逐条处理并告知用户；终答入库（第 13 节第 5 步）在汇报前完成
