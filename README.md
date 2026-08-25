# SmartAnswer 文献调研工作流套件

一套运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)之上的**个人文献调研工作流**,用于:检索 → 下载 → PDF→Markdown → 精读 → 审计 → 入库 → 终答。本仓库承载全部**代码、配置与文档**,不承载任何文献数据、模型与密钥。

## 仓库组成

| 目录 | 内容 | 用途 |
|---|---|---|
| `smartanswer-preset/` | smartanswer 预设本体(agent.cordis.yml、sa-tools.js、SKILL.md、workflows/、reference/、templates/) | 拷贝到 `~/.dsh/.agent-presets/smartanswer/` 即可用 |
| `sa-panel/` | 调研进度面板插件(host + client) | 拷贝到 `~/.dsh/profiles/web/plugins/sa-panel/` |
| `smartanswer-commands/` | `/smartanswer` 斜杠命令(启动/体检/进度) | 拷贝到 `~/.dsh/profiles/web/plugins/smartanswer-commands/` |
| `profile-web/` | dsh web profile 接线配置(cordis.patch.yml 等) | 合并进 `~/.dsh/profiles/web/` |
| `papersearch-mcp/` | OpenAlex 检索 MCP 后端(零第三方依赖) | 拷贝到 `~/.dsh/mcp/` |
| `pdf2md/` | MinerU PDF→Markdown 转换脚本(pdf2md.py / pdf2md_gpu.py / bat / requirements-cuda.txt) | 放任意位置,如 `E:\PDF2md` |
| `zhu-downloader/` | 文献 PDF 自动下载器(Playwright,支持 Nature/PNAS/Science/IEEE 等) | 放任意位置,`npm install` 后使用 |
| `启动DSH.bat` | 一键启动 dsh web 并自动打开浏览器(路径需按新机改) | 放 dsh 仓库旁 |
| `docs/` | `handover.md`(新机安装总文档)、`dsh-compat.md`(dsh 版本兼容)、`SCHEMA.md`(文献库规范) | 先读 handover.md |
| `patches/` | `dsh-wp3.patch`(dsh 未合入的 WP3 改动,见 dsh-compat.md) | 需要时应用 |

## 快速开始(在新电脑上)

1. **通读 [`docs/handover.md`](docs/handover.md)** —— 它是主交接文档,包含安装步骤、逐文件改机清单、GPU 注意事项与验收方法。
2. **检查 dsh 版本** —— 智能工作流依赖 dsh 侧一项**尚未合入官方**的改动(scriptPath/retry/tools.deny),见 [`docs/dsh-compat.md`](docs/dsh-compat.md)。
3. **按 handover.md 逐节执行**,最后用 `/smartanswer 体检` 验收环境(该命令检查 8 项依赖路径)。

## 前提条件

- Windows(下载器与转换脚本面向 Windows)
- Node.js ≥ 22 + pnpm(dsh 与下载器)
- Python 3.10~3.13(MinerU 要求;新机一个 Python 即可同时服务 MCP 与转换)
- NVIDIA GPU + CUDA 12.8+(RTX 50 系必须;MinerU GPU 加速)
- DeepSeek API Key(dsh 本身需要;检索后端 OpenAlex 可匿名使用)

## 隐私说明

- 仓库中**没有任何 API Key/token/密码**;`papersearch_mcp_server.py` 里的个人邮箱已替换为占位符(新机填自己的)。
- 机器路径中的旧用户名已替换为 `你的用户名` 占位符;硬盘上 `E:\Library-Manage` 等路径按新机实际位置修改。
- **故意不入库**(避免版权与体积问题):文献数据(7.3 GB)、下载的期刊 PDF、Playwright node_modules、MinerU 模型缓存(1.1 GB,首次运行自动下载)、dsh 用户目录下的密钥文件。数据用 `new-library.zip`(1.4 GB)或 U 盘/网盘迁移。

## 本机改动同步约定

新机若改了脚本或文档,请按本仓库与各源目录的对应关系回写(见 handover.md 第 2 节对照表),保持一处权威。
