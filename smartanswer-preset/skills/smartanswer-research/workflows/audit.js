// SmartAnswer 阶段8/9 · 审计对抗：声明逐条核对（LLM 子代理）
// 覆盖度检查（引用位置分布）不再派 LLM：主 agent 用 pwsh 统计各归档 [N] 引用行号的
// 前/中/后三等分分布并写入报告附注（2026-08-19 复盘决策：机械统计零漂移）
// args: { claims: [{n, text, refs}], archivePaths: string[]（真实文件完整路径列表，
//         由主 agent 先枚举，禁止通配符模板——grep 的 path 不支持通配符）,
//         model?: string, provider?: string, smoke }
//   model/provider: 可选子代理模型覆盖（由主 agent 读 sa-models.json 后注入；缺省用引擎默认）
// 输出: { claimChecks: [...] }（供结论-证据对照表：n/verdict/evidence/archive/lineNo/note）
// 审计官为只读角色（指令级软约束）；连字归一化规则在 prompt 中强制
// 二轮增量审计：主 agent 只传新增 claims，并自行做「防回退」比对（禁改清单）
//
// v2（2026-08-19 复盘加固）：
//   - 本文件是唯一权威版本，注入 workflow 时必须逐字转抄，不得压缩/改写/重排
//     （复盘教训：被裁成 27 行后覆盖度 pipeline 整路消失、archivePaths 带通配符）
//   - prompt 附 grep 正确用法（复盘教训：C5 审计官因 path 通配符三轮试错多花 4 分钟）
//   - evidence/archive/lineNo 提为必填，对照表可直接落盘

if (args.smoke) return { smoke: 'ok' };

const claimSchema = {
  type: 'object',
  properties: {
    n: { type: 'string' },
    verdict: { type: 'string', enum: ['✅', '⚠️', '🔄', '🚫'] },
    evidence: { type: 'string' },
    archive: { type: 'string' },
    lineNo: { type: 'string' },
    note: { type: 'string' }
  },
  required: ['n', 'verdict', 'evidence', 'archive', 'lineNo', 'note']
};

phase('审计');

const claimChecks = await pipeline(args.claims, claim =>
  agent(
    `你是审计官。身份约束：只读审计，禁止写任何文件，禁止修改任何归档。\n\n声明 #${claim.n}：${claim.text}\n声明引用 [N] 对应文献：${JSON.stringify(claim.refs)}\n归档文件列表（真实路径，逐个定位）：${JSON.stringify(args.archivePaths)}\n\n任务：逐条验证该声明。\n1. 对每个引用 [N] 回归档定位原文（grep 关键词 + read 上下文，记录文件与行号）。\n   grep 正确用法：{"pattern":"<关键词>","path":"<目录绝对路径>","include":"*.md"}——path 不支持通配符；单文件可直接作 path；找不到文件时先用 glob {"pattern":"**/*.md","path":"<目录>"} 枚举。\n2. 连字归一化：ef fi ciently → efficiently；MinerU 转换可能 ff→f 静默丢失，按归一化后匹配。\n3. 判定：✅ 原文确认 / ⚠️ 部分匹配（陈述超出原文或改写失真）/ 🔄 综述代引（引的是综述而非原始论文，需溯源原始 DOI）/ 🚫 无原文支撑。\n4. 引用全在前 3 页 → 覆盖度存疑，在 note 中提示。\n5. evidence 必须是归档原文摘句（≤40 字）；定位不到时写「未定位」并说明。\n输出 JSON：n/verdict/evidence(原文摘句)/archive(文件名)/lineNo(行号)/note。\n\n完成后必须调用 structured_output 工具提交最终 JSON；以纯文本结束回复 = 本任务失败（引擎只认结构化输出）。`,
    { label: 'audit-' + claim.n, phase: '审计', schema: claimSchema, retry: 1, tools: { deny: ['skill'] },
      ...(args.model ? { model: args.model } : {}), ...(args.provider ? { provider: args.provider } : {}) }
  )
);

phase('汇总');
return { claimChecks };
