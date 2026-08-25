// SmartAnswer 阶段7/9 · 双读精读：每篇「主读 + 验证读」并行，再仲裁收敛
// args: { papers: [{id, mdPath, kind: 'paper'|'review', title, year}],
//         templates: { archivePaper, archiveReview, verifyPaper, verifyReview },
//         topic, subQuestions,
//         model?: string, provider?: string,
//         models?: { main?: {model?, provider?}, verify?: {model?, provider?}, arbitrate?: {model?, provider?} },
//         smoke }
//   model/provider: 可选子代理模型覆盖（主 agent 读 sa-models.json 后注入；缺省用引擎默认）
//   models.{main,verify,arbitrate}: 双读分角色覆盖，角色字段缺省回退全局 model/provider
// 输出: [{ id, verdict: '一致'|'验证读补充'|'差异已仲裁', finalSections }]
// 注：全文内容段由主 agent 用 pwsh 追加进归档（省 token 且逐字保真），子代理不输出全文段
// 批规则：主 agent 每批 ≤10 篇，多批同脚本同参数切片调用
//
// v3（2026-08-19 复盘加固，依赖引擎新增的 agent() retry/tools 选项）：
//   - 本文件是唯一权威版本，注入 workflow 时必须逐字转抄（推荐改用 scriptPath 注入），
//     不得压缩/改写/重排（复盘教训：batch3/4 被压成 34 行，仲裁 prompt 丢失全文路径）
//   - retry: 1 —— 引擎级重派一次「带 schema 却纯文本收尾」的子代理
//     （复盘教训：7 个双读子代理读完全文却纯文本输出被判 failed、无重试）
//   - tools.deny: ['skill'] —— 子代理为一次性工，裁掉 skill 工具即不再注入
//     skill catalog（复盘教训：每个子代理开局白加载 197 行 SmartAnswer 手册）
//   - prompt 末尾显式声明 structured_output 契约

if (args.smoke) return { smoke: 'ok' };

const CONTRACT = '\n\n完成后必须调用 structured_output 工具提交最终 JSON；以纯文本结束回复 = 本任务失败（引擎只认结构化输出）。';
// 角色级模型覆盖：models.{main,verify,arbitrate} 字段缺省回退全局 model/provider
const roleOpts = (key) => {
  const role = ((args.models || {})[key]) || {};
  const model = role.model || args.model;
  const provider = role.provider || args.provider;
  return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
};
const OPTS = (label, phase, schema, mo) => ({ label, phase, schema, retry: 1, tools: { deny: ['skill'] }, ...(mo || {}) });

const mainSchema = {
  type: 'object',
  properties: {
    sections: { type: 'string' },
    notes: { type: 'string' }
  },
  required: ['sections']
};

const verifySchema = {
  type: 'object',
  properties: {
    findings: { type: 'string' },
    supplements: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } }
  },
  required: ['findings']
};

const arbitSchema = {
  type: 'object',
  properties: {
    finalSections: { type: 'string' },
    verdict: { type: 'string', enum: ['一致', '验证读补充', '差异已仲裁'] }
  },
  required: ['finalSections', 'verdict']
};

phase('双读');

const results = await pipeline(args.papers,
  async paper => {
    const isReview = paper.kind === 'review';
    const mainPrompt = `你是主读研究员。\n全文文件：${paper.mdPath}（用 read 工具完整阅读；可疑或缺失处记入 notes，交主 agent 回 PDF 复核）\n文献类型：${isReview ? '综述' : '普通论文'}\n调研主题：${args.topic}\n子问题：${JSON.stringify(args.subQuestions)}\n\n任务：按下方模板产出归档段落（只产模板部分，不含「全文内容」段）：\n\n${isReview ? args.templates.archiveReview : args.templates.archivePaper}\n\n要求：观点/条目不得遗漏，每条带出处段落。\n输出 JSON：sections=完整归档段落（含来源/标题/年份/DOI 元数据头）；notes=可疑点清单。${CONTRACT}`;
    const verifyPrompt = `你是验证读研究员，专门挑毛病。\n全文文件：${paper.mdPath}（用 read 工具完整阅读）\n文献类型：${isReview ? '综述' : '普通论文'}\n调研主题：${args.topic}\n\n只回答以下验证问题（按文献类型选版本）：\n\n${isReview ? args.templates.verifyReview : args.templates.verifyPaper}\n\n输出 JSON：findings=逐问回答；supplements=主读容易遗漏的要点列表；risks=容易读错/漏读的易错点列表。${CONTRACT}`;
    const dual = await parallel([
      () => agent(mainPrompt, OPTS('main-read-' + paper.id, '双读', mainSchema, roleOpts('main'))),
      () => agent(verifyPrompt, OPTS('verify-read-' + paper.id, '双读', verifySchema, roleOpts('verify')))
    ]);
    return { paper, dual };
  },
  async ({ paper, dual }) => {
    const main = dual && dual[0] ? dual[0].sections : '（主读失败，需重读）';
    const vf = dual && dual[1] ? dual[1].findings : '（验证读失败）';
    const supplements = dual && dual[1] && dual[1].supplements ? dual[1].supplements.join('\n- ') : '';
    const risks = dual && dual[1] && dual[1].risks ? dual[1].risks.join('\n- ') : '';
    return await agent(
      `你是仲裁（主读方执行）。\n文献：${paper.title}（${paper.year}），编号 ${paper.id}，全文文件：${paper.mdPath}\n\n主读归档段落：\n${main}\n\n验证读回答：\n${vf}\n\n验证读补充候选：\n- ${supplements}\n\n验证读提示的易错点：\n- ${risks}\n\n规则：\n1. 验证读提到主读漏了 → 补入归档并标「验证读补充」；\n2. 矛盾 → 回原文（read ${paper.mdPath}）裁定；\n3. 一致 → 标「✅双读一致」。\n\n输出 JSON：finalSections=最终归档段落（含元数据头、完整观点/六维内容、交叉验证状态行，不含「全文内容」段）；verdict=裁决。${CONTRACT}`,
      OPTS('arbitrate-' + paper.id, '仲裁', arbitSchema, roleOpts('arbitrate'))
    );
  }
);

phase('汇总');
return results;
