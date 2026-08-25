# dsh 版本兼容:WP3 是什么、为什么必需、怎么拿到

> 一句话:**smartanswer 工作流依赖的 dsh 侧改动(scriptPath / tools.deny / retry / grep 提示)截至 2026-08-25 尚未合入官方**,新机必须先处理本文再跑工作流。

---

## 1. 现状

| 项 | 状态 |
|---|---|
| 源机器的 dsh | 本地 master `47f943859b`(**0.1.0-rc.5**) |
| 官方上游 master | `b150a551b8d`(PR #2908,**0.1.1-rc.2**,2026-08-21)——本机落后约 390 个 PR |
| WP3 是否在官方 | **否**(已用 GitHub API 验证:提交与 PR 搜索 `scriptPath` 均 0 命中) |
| WP3 在本机 | 工作区未提交改动(14 个文件),清单见第 3 节;与 smartanswer 配套的 Agent Note 也已写好(`.agents/notes/implemented/feature/2026-08-19-workflow-hardening-scriptpath-retry-tools.*`)但同样未提交 |

## 2. 为什么 smartanswer 必需它

WP3 = dsh 产品层四个特性(2026-08-19 诊断后补上,解决"模型转抄篡改脚本、子代理无重试、非法参数形状"三类问题):

| 特性 | 作用 | smartanswer 哪里依赖 |
|---|---|---|
| ① workflow 工具 `scriptPath` | 引擎侧经文件系统读脚本,杜绝模型转抄篡改 | SKILL 要求编排脚本走 scriptPath;无它则退回"模型转抄脚本"——正是要杜绝的篡改通道 |
| ② `agent()` 的 `tools: { deny }` | 子代理工具裁剪(deny skill 即不注入 catalog) | `dualread.js v3` 用 `tools.deny:['skill']` 防止子代理自我加戏 |
| ③ `agent()` 的 `retry` | 引擎级失败重派 | `dualread.js v3` 用 `retry:1` 兜底子代理失败 |
| ④ grep 通配符报错提示 | 使用体验 | search/audit 脚本的 grep 用法 |

**后果**:在未含 WP3 的 dsh 上,`retry:1`/`tools.deny` 是旧引擎不认识的形状(可能报错或被忽略),且没有 `scriptPath` 时注入脚本被模型转抄后可能与 `workflows/*.js` 不一致——轻则流程退化,重则工作流中断。这不是改配置能绕过的。

## 3. WP3 涉及的文件(补丁内容)

`patches/dsh-wp3.patch` 包含 14 个文件、846 行,与源机 `.sa-fix\handover-doc.md` §4 清单一致:

```
docs/tool-catalog.i18n.yaml / tool-catalog.md / tool-catalog.zh.md
packages/fs/tool-fs-search/src/search-core.ts         (grep 提示)
packages/fs/tool-fs-search/tests/tools.spec.ts
packages/workflow/tool-workflow/package.json           (peerDep dsh-fs)
packages/workflow/tool-workflow/src/index.ts           (scriptPath)
packages/workflow/tool-workflow/tests/tool-workflow.spec.ts
packages/workflow/tool-workflow/tsconfig.json
packages/workflow/workflow-worker-thread/src/host.ts   (toolFilter 透传)
packages/workflow/workflow-worker-thread/src/runtime.ts(retry + tools 校验)
packages/workflow/workflow-worker-thread/src/types.ts
packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts
scripts/gen-tool-catalog.ts
```

补丁基于源机 HEAD `47f943859b`(0.1.0-rc.5)生成;**新机/官方版比这个新,apply 可能冲突**,此时手动逐文件对照解决(改动小而集中,冲突大多只是上下文行)。

## 4. 两条获取路径

### 路径 A(推荐):作为 PR 提交到官方 dsh 仓库

开发侧(源机)按仓库规范走:先 `git pull --rebase origin master` 适配官方最新,再提交为一个 PR(打标 `kind/feature` + `area/workflow` + `area/fs`,含 Agent Note 三件套),按 `.agents/skills/dsh-pre-push-checks` 跑聚焦检查(`pnpm vitest run packages/workflow/tool-workflow packages/workflow/workflow-worker-thread packages/fs/tool-fs-search` + `pnpm run typecheck` + `pnpm run doc-sync`),合入后等发布——之后新机直接装新版本 dsh 即可,补丁不再需要。

### 路径 B:本机打补丁(短期)

在克隆的官方 dsh 仓库里:

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git apply --3way ../smartanswer-workflow/patches/dsh-wp3.patch   # 冲突则手工合并
pnpm install        # tool-workflow 新增了 dsh-fs 依赖,lockfile 需重新生成
pnpm build
```

打完即可进入 handover.md 的安装步骤。

## 5. 如何验收 dsh 能力(打完补丁/装新版后必做)

1. **聚焦测试**(补丁新增 14 个用例 + 原有用例应全绿):
   ```powershell
   pnpm vitest run packages/workflow/tool-workflow packages/workflow/workflow-worker-thread packages/fs/tool-fs-search
   ```
2. **类型检查**:`pnpm run typecheck`
3. **功能检查**(真实起会话后):
   - workflow 工具描述里出现 `scriptPath`(与 `script` 互斥);
   - 跑一次最小 workflow 任务:注入脚本与 `workflows\*.js` 逐字一致(或日志显示走 scriptPath 文件读取);
   - 子代理开局无 skill 加载(`tools.deny` 生效);
   - 人工让子代理失败一次,观察自动重派(`retry` 生效)。

**如何判断已装的 dsh 是否含 WP3**:`grep -n scriptPath packages/workflow/tool-workflow/src/index.ts` 有输出即已含;或看官方 release notes 是否出现 workflow/scriptPath 相关条目。未含时不要跑 smartanswer 流程(见第 2 节)。
