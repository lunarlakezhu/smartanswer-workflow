# SmartAnswer 工作流 · 新机交接文档

> 用途:把本仓库克隆/拷贝到第二台电脑(RTX 5070)后,按本文重建环境。
> 先读本文;dsh 版本相关的特殊事项见 [dsh-compat.md](dsh-compat.md)。
> 文中 `你的用户名` 是占位符,替换为你在新机器上的 Windows 用户名(不含空格)。

---

## 1. 这套系统由什么组成

五个相互配合的部分,全部运行在 dsh 之上:

| 部分 | 位置(仓库) | 一句话角色 |
|---|---|---|
| smartanswer 预设 | `smartanswer-preset/` | 调研工作流本体:SKILL.md(流程权威)+ `workflows/*.js`(编排脚本)+ 人设/闸门 + 环境绑定工具 sa-tools |
| 宿主插件 | `sa-panel/`、`smartanswer-commands/` | 常驻能力:文献进度面板(十阶段步骤条、闸门卡片)+ `/smartanswer` 斜杠命令 |
| 检索后端 | `papersearch-mcp/` | OpenAlex 学术搜索 MCP 服务器(零第三方依赖) |
| 转换器 | `pdf2md/` | MinerU PDF→Markdown(pdf2md.py CPU / pdf2md_gpu.py GPU) |
| 下载器 | `zhu-downloader/` | Nature/PNAS/Science/IEEE/SAGE/Elsevier 文献 PDF 自动下载 |

工作流 = 十阶段状态机(启动确认 → 拆解闸门 → 11 路检索 → verify 验身 → 库内匹配 → 下载+GPU 转换闸门 → 双读精读 → 审计对抗 → R2 雪球闸门 → 终答),每一主题一个 `_progress.yaml`。

**两个硬前提**:① dsh 需含 WP3 改动(见 dsh-compat.md,否则编排脚本里 `retry`/`tools.deny`/`scriptPath` 非法或不生效,工作流会坏);② Windows + NVIDIA GPU + 自己的 DeepSeek API Key。

## 2. 仓库 ←→ 本机来源对照表

| 仓库目录 | 本机源路径 | 说明 |
|---|---|---|
| `smartanswer-preset/` | `C:\Users\<源机器>\.dsh\.agent-presets\smartanswer\` | 预设本体;**本机维护以此为准** |
| `sa-panel/` | `C:\Users\<源机器>\.dsh\profiles\web\plugins\sa-panel\` | host+client 双半插件 |
| `smartanswer-commands/` | `...\profiles\web\plugins\smartanswer-commands\` | 斜杠命令 |
| `profile-web/` | `C:\Users\<源机器>\.dsh\profiles\web\` 的 cordis.patch.yml / cordis.yml / package.json / pnpm-workspace.yaml / pnpm-lock.yaml | 接线配置(不含 node_modules) |
| `papersearch-mcp/` | `C:\Users\<源机器>\.dsh\mcp\papersearch_mcp_server.py` | 仅标准库,任意 Python 3 可跑 |
| `pdf2md/` | `E:\PDF2md\` 的 pdf2md.py / pdf2md_gpu.py / 4 个 bat | 不含 demo/日志/样例 PDF |
| `zhu-downloader/` | `E:\deepseek-harness\ZhuDownLoader\` | 仅代码与 download.log,不含 5 个测试 PDF 与 node_modules |
| `启动DSH.bat` | `E:\deepseek-harness\启动DSH.bat` | 一键起服务(路径需改) |
| `docs/SCHEMA.md` | `E:\Library-Manage\new-library\SCHEMA.md` | 文献库规范(编号/frontmatter/类型) |

**有意不入库的内容及替代迁移方式**:

| 内容 | 大小 | 替代方式 |
|---|---|---|
| `E:\Library-Manage` 全部文献数据(1053 个 PDF、索引、归档) | 7.3 GB | `new-library.zip`(1.4 GB)或 U 盘/网盘;`raw-library` 按需 |
| `zhu-downloader\test-downloads\*.pdf`(5 个期刊正文) | 25.4 MB | 只留了 download.log 作验证证据;PDF 有版权,别放公网/公开库 |
| playwright `node_modules` | 19 MB | 克隆后 `npm install` |
| MinerU 模型缓存(`~\.cache\modelscope\models\`) | 1.3 GB | 首次运行自动下载 ~1.1 GB |
| dsh 用户目录密钥文件(`.credentials.yaml`、`anonymous-user-id`) | 小 | **绝不上传**;新机自建密钥文件 |

## 3. 新机安装步骤(按顺序执行)

### 步骤 0 · 前置工具

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
python --version        # 先看 Python 版本 → 步骤 1 决定
# pnpm:完成 Node 安装后
corepack enable
corepack prepare pnpm@latest --activate
```
Edge 浏览器 Windows 自带(下载流程与 `sa_open_edge` 工具需要)。

### 步骤 1 · Python 版本自查(只关心一个版本)

```powershell
python --version
# 若弹出 Microsoft Store,说明装的是占位符:改输 where python 找到真实路径,再执行 <该路径> --version
```

判断:

- **3.10 / 3.11 / 3.12 / 3.13** → 直接用这一个 Python,同时服务 MinerU 转换和 MCP 检索后端(后端零第三方依赖,任意 3.x 均可)。
- **3.14+ 或 3.9 及更早** → `pip install mineru` 会当场报错(官方要求 `>=3.10,<3.14`)。单独装一个 3.11:
  ```powershell
  winget install Python.Python.3.11
  ```
  以后 MinerU 用 3.11,别的不管。

### 步骤 2 · 安装 dsh(含 WP3)

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm build
```
然后按 [dsh-compat.md](dsh-compat.md) 处理 **WP3**(两条路:打 `patches\` 里的补丁,或等/协助上游合入)。**不处理则 smartanswer 编排脚本跑不起来或退化**,这是唯一无法通过改配置绕过的项。

### 步骤 3 · 落位 smartanswer 预设

把 `smartanswer-preset\` **整个目录**复制为:
```
C:\Users\<你的用户名>\.dsh\.agent-presets\smartanswer\
```
复制后用 `pnpm dsh web`(在 dsh 仓库目录)启动服务;预设改动需重启进程后才对新会话生效。

### 步骤 4 · 落位宿主插件与接线

1. 复制 `sa-panel\` → `C:\Users\<你的用户名>\.dsh\profiles\web\plugins\sa-panel\`
2. 复制 `smartanswer-commands\` → `...\plugins\smartanswer-commands\`
3. 复制 `profile-web\` 下的 5 个文件到 `C:\Users\<你的用户名>\.dsh\profiles\web\`
   - **注意**:dsh 创建 `web` profile 时可能已生成同名文件(cordis.yml / package.json / pnpm-workspace.yaml)。**合并而非覆盖**:把本项目 cordis.patch.yml 里的四个 insert 段(`smartanswer-commands`、`sa-panel`、`drop-window`、`mcp-papersearch`)并入已有 patch 文件末尾即可;package.json 中 `smartanswer-commands`、`sa-panel` 两个 `file:` 依赖加入 dependencies。
4. `cd C:\Users\<你的用户名>\.dsh\profiles\web && pnpm install`
5. **drop-window 是可选插件**(拖文件进窗口,本体在 node_modules 里,不在本仓库):要保留就从老机器把整个 `node_modules\drop-window` 目录拷过来;不要就直接删掉 patch 里那段 insert 和 package.json 里的依赖。

### 步骤 5 · MCP 检索后端

1. 复制 `papersearch-mcp\papersearch_mcp_server.py` → `C:\Users\<你的用户名>\.dsh\mcp\`
2. 改 `cordis.patch.yml` 里 `mcp-papersearch` 段的 `command`:
   ```powershell
   where python    # 复制输出的完整路径,填进 command(如 C:\Users\<你的用户名>\AppData\Local\Programs\Python\Python311\python.exe)
   ```
   该后端零依赖,用哪个 Python 3 都行。改完几秒内热生效。
3. (可选)`papersearch_mcp_server.py` 里 `DEFAULT_MAILTO` 的占位符换成你自己的邮箱(OpenAlex 礼貌池;不填则用匿名池,功能不变)。

### 步骤 6 · PDF→MD 转换器

1. 把 `pdf2md\` 整个目录放到任意位置,例如 `E:\PDF2md\`(四个 bat 用 `%~dp0`,同目录即可)。
2. 按 `requirements-cuda.txt` 装 Python 环境(先装 cu128 torch,再装 MinerU)。
3. GPU 脚本 `pdf2md_gpu.py` 按你新机情况重写/调整(要点见本文第 5 节)。`pdf2md.py`(CPU 版)本身无硬编码路径,可直接用。
4. 四个 bat 里的 Python 路径与默认输出目录按新机修改(见第 4 节清单)。

### 步骤 7 · 文献下载器

```powershell
cd zhu-downloader
npm install
npx playwright install chromium    # 新机没有浏览器缓存,这步必须做
node pw_download.mjs "<DOI>" "<输出目录>"
```
默认输出目录在 `pw_download.mjs` 顶部 `OUT_DIR`,按需修改。注意:本机测试过的 `HANDOVER.md` 里写"无需重新下载浏览器"仅在该机成立。

### 步骤 8 · 文献库数据迁移

不依赖 git。把老机器的数据用移动介质/网盘拷到新机,例如解压 `new-library.zip` 到 `E:\Library-Manage\new-library\`,再按需拷贝 `raw-library`:
- 至少:`new-library\`(已归档库)、`raw-library\HanaLibrary\zhu-journals.md`(期刊白名单正本)
- 常用:`raw-library\HanaLibrary\`、`raw-library\DSH-Library\`(进行中主题)

### 步骤 9 · 填 API Key

dsh 用户目录的密钥文件**本仓库不包含、也绝不加入**。新机第一次启动 dsh 后会提示配置凭据,在 `C:\Users\<你的用户名>\.dsh\.credentials.yaml` 填入你的 `DEEPSEEK_API_KEY` 等。检索后端 OpenAlex 可匿名使用(可选自己的 key 提升配额,注入方式见 papersearch_mcp_server.py 注释)。

## 4. 改机检查清单(逐文件)

> 原则:**核心路径集中在 2 个文件**(sa-config.json 与 cordis.patch.yml);其余为兜底/文档/辅助。所有文件中 `你的用户名` 占位符都要改成真实用户名。

| 文件 | 要改什么 |
|---|---|
| `smartanswer-preset\plugins\sa-config.json` | **8 个键全部核对**:pythonPath(新机 Python)、pdf2mdGpuPath、pdf2mdPath(PDF2md 目录)、whitelistPath、whitelistFallback、libraryRoot、indexFilePath(Library-Manage 路径)、edgePath(Edge 路径) |
| `profile-web\cordis.patch.yml` | ① smartanswer-commands 段:libraryRoot + checks 8 项(与上面同一批路径);② sa-panel 段:libraryRoot、extraRoots、presetPluginsDir;③ mcp-papersearch 段:`command` 改成新机 Python |
| `smartanswer-commands\index.js` | `DEFAULTS` 与 patch 相同(通常**不动**——patch config 会覆盖它;只有去掉 patch 时才需要改) |
| `sa-panel\index.cjs` | `DEFAULTS.libraryRoot`(同上,通常不动);`test-client.cjs` 里两个测试路径仅本机测试用,可不动 |
| `smartanswer-preset\skills\smartanswer-research\SKILL.md` | 「环境依赖」表(8 行)与正文中出现的 `E:\...` 路径:按新机实际位置改;这是模型的执行依据,`/smartanswer 体检` 也按此表检查 |
| `smartanswer-preset\plugins\sa-tools.js` | 无需改(相对引用 `./sa-config.json`、`../skills/...`) |
| `smartanswer-preset\agent.cordis.yml` | 无需改(相对路径解析) |
| `pdf2md\*.bat`(4 个) | 每处 `C:\Users\...\python.exe` 改为新机 Python 路径;`DEFAULT_OUT`(默认输出目录)按需改 |
| `zhu-downloader\pw_download.mjs` | 顶部 `OUT_DIR` 默认值(`E:\Qoder files\download study`)按需改 |
| `启动DSH.bat` | `cd /d E:\deepseek-harness` → 新机 dsh 实际路径 |
| `papersearch-mcp\papersearch_mcp_server.py` | `DEFAULT_MAILTO` 占位符 → 你的邮箱(可选) |
| `docs\SCHEMA.md` | 无需改(规范文档) |

## 5. RTX 5070 GPU 注意事项(转换器)

老机器环境:Python 3.11.9 + **mineru 3.4.4 + torch 2.6.0+cu118**(RTX 3060)。

- **RTX 5070 是 Blackwell 架构(sm_120),cu118 的 torch 不支持**(会报 "no kernel image is available for execution on the device" 之类)。必须装 CUDA 12.8+(cu128)的 torch,例如:
  ```powershell
  pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
  pip install mineru modelscope pymupdf
  ```
  具体依赖清单见 `pdf2md\requirements-cuda.txt`。
- 重写/调整 `pdf2md_gpu.py` 只需保证三点:① `torch.cuda.is_available()` 通过(安装正确即通过);② 设 `MINERU_DEVICE_MODE=cuda`;③ 一个进程批量传多个 PDF(模型只初始化一次,速度快)。参考老脚本的做法:先 import torch 检查,再 import pdf2md(CPU 版逻辑),最后覆盖环境变量。
- 模型不随仓库上传:首次运行自动从 ModelScope 下载 **PDF-Extract-Kit-1.0(约 1.1 GB)**;如果你在新机装完第一次转换很慢,就是在下载模型,属正常。
- onnxruntime 用 CPU 版即可(MinerU 3.x 的 GPU 加速靠 torch,表格/版面部件走 ONNX CPU)。
- **建议验证顺序**:先直接跑 CPU 版 `python pdf2md.py <pdf> -o <out>` 确认 MinerU 环境通,再跑 GPU 版对比速度与结果。转换输出是 `<名>.md` + `<名>_images\`(图片引用已在 md 内改写)。

## 6. 验收

### 6.1 环境体检(最常用)

启动 `dsh web` 后,在 smartanswer 预设会话里输入:
```
/smartanswer 体检
```
该命令检查 8 项存在性(**全部 ✅ 才算环境就绪**):GPU转换.bat、pdf2md_gpu.py、pdf2md.py、Python 解释器、期刊白名单(库内)、白名单(迁移源)、文献索引、Edge 浏览器。

### 6.2 dsh 能力验收(WP3)

见 [dsh-compat.md](dsh-compat.md) 第 5 节:聚焦测试 14 用例全绿 + `pnpm run typecheck`;打补丁路径的机器先做这步。

### 6.3 端到端小轮验收

开一个新主题(小规模)走完整链路:阶段 0 确认 → 检索(面板/检索后端返回真实数据)→ 下载(闸门确认)→ GPU 转换 → 双读 → 审计 → 入库 → 面板计数。核对重点:

| 检查点 | 通过标准 |
|---|---|
| workflow 注入脚本 | 与 `workflows\*.js` 逐字一致(或直接用 scriptPath) |
| 子代理 | 开局无 skill 加载;失败自动重派(retry) |
| 磁盘计数 | `_progress.yaml` 计数与磁盘文件数一致 |
| 入库 | 编号连续、frontmatter 符合 SCHEMA.md、`文献索引.md` 同步 |

量化基线(老机器 2026-08-19 试验):检索丢路 1/11 → 目标 0;双读子代理失败 7/102 → 目标 0;归档 2/34 → 目标 34/34;审计声明覆盖 10 条 → 全量;流程违约 ≥4 → 0。

## 7. 敏感信息提醒

- 本仓库不含任何密钥。**不要**把 `C:\Users\<你的用户名>\.dsh\` 整个上传到 GitHub——里面 `.credentials.yaml` 是真实 API Key,还有会话记录。
- 文献 PDF(测试样本、入库正文)有版权,只随数据迁移(移动介质/网盘),不进 git、不上公网。
- 改配置后建议先 `git diff` 自查一次,再 push。

## 8. 同步约定

- 新机改过脚本/文档,**回写对应源机目录**,或直接在源机改后再同步到两边(一处权威:源机).
- 推荐流程:在源机改 → 提交推送到本仓库 → 新机 `git pull` 后按第 4 节清单核对路径。
