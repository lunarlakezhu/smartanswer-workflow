// SmartAnswer 阶段4 · 验明正身 + 排名数据（离线判读版，子代理零网络）
// 前提：主 agent 已用 reference/crossref-fetch.js 预取权威数据（Crossref 主 + OpenAlex 增补）
//   - 有 DOI 条目：按 DOI 查（crossref-fetch.js 路径一）
//   - doiSource='pending' 的无 DOI 条目：crossref-fetch.js 按标题 query.title 查（路径二，实测 0.4-1.4s/篇）
// args: { papers: [{title, doi?, doiSource?, year?, journal?, abstract?}], crossrefData: [预取行],
//         model?: string, provider?: string, smoke }
//   model/provider: 可选子代理模型覆盖（由主 agent 读 sa-models.json 后注入；缺省用引擎默认）
//   预取行: { doi, status:'found'|'not-found'|'error', title, journal, year, titleSrc,
//             abstract, abstractSrc, citedBy, citedBySrc, crossrefCitedBy, isIeee, note, queryTitle? }
//     （queryTitle 仅标题预取行带：= 待验条目的查询标题，用于无 DOI 条目的匹配）
// 输出: { results: [{doi, status:'verified'|'mismatch'|'not-found'|'error', title, year,
//                    journal, abstract, abstractSrc, citedBy, citedBySrc, note?}] }
//   无 DOI 条目 verified 时 doi 回填权威 DOI（否则保持原值，可能为空串）
// 职责边界：只做「验身判读」，不做检索、不联网、不排序；白名单复核与排序由主 agent 做（脚本无 fs/网络）
// 批规则：每 10 篇切一片、每片一个 agent

if (args.smoke) return { smoke: 'ok' };

const papers = (args.papers || []).filter(p => p && (p.doi || p.title));
if (!papers.length) return { results: [] };

const normDoi = d => String(d || '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '');
const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ');
const dataByDoi = {};
const dataByTitle = {};
for (const row of (args.crossrefData || [])) {
  const k = normDoi(row.doi);
  if (k) dataByDoi[k] = row;
  if (row.queryTitle) dataByTitle[normTitle(row.queryTitle)] = row;
}

const CHUNK = 10;
const chunks = [];
for (let i = 0; i < papers.length; i += CHUNK) chunks.push(papers.slice(i, i + CHUNK));

const resultSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          doi: { type: 'string' },
          status: { type: 'string', enum: ['verified', 'mismatch', 'not-found', 'error'] },
          title: { type: 'string' },
          year: { type: 'string' },
          journal: { type: 'string' },
          abstract: { type: 'string' },
          abstractSrc: { type: 'string' },
          citedBy: { type: 'number' },
          citedBySrc: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['doi', 'status']
      }
    }
  },
  required: ['results']
};

phase('验身判读');

const results = await pipeline(chunks, async chunk => {
  const papersText = JSON.stringify(chunk);
  const dataText = JSON.stringify(chunk.map(p => {
    if (p.doi) {
      const k = normDoi(p.doi);
      return dataByDoi[k] || { doi: p.doi, status: 'error', note: '主 agent 未预取此行' };
    }
    const k = normTitle(p.title);
    return dataByTitle[k] || { doi: '', status: 'error', note: '主 agent 未按标题预取此行' };
  }));
  const r = await agent(
    `你是验身判读员。主 agent 已预先取好权威元数据，你只做离线比对，**禁止联网、禁止调用任何工具取数**。\n\n待验文献（检索结果，JSON 数组，注意 doi 可能为空串、doiSource 有 'seen'/'pending'）：${papersText}\n\n预取权威数据（与待验文献一一对应，JSON 数组，含 titleSrc/abstractSrc/citedBySrc 等源标注）：${dataText}\n\n匹配规则：\n- 待验条目 doi 非空 → 按 doi 找对应预取行\n- 待验条目 doi 为空串 → 按「标题实质一致」找对应预取行（忽略大小写/标点/连字符/词序差异）\n\n判定规则（对每条找到的预取行）：\n- 预取行 status='found' 且权威 title 与待验标题实质一致 → status='verified'；若待验条目原 doi 为空，doi 填预取行权威 DOI（titleSrc='crossref' 时以 crossref 为准）\n- 预取行 status='found' 但权威 title 明显是另一篇论文 → status='mismatch'，note 写「权威标题：xxx」\n- 预取行 status='not-found'（两源均 404/标题查询无结果）→ status='not-found'，note 写「两源均查无此篇」或预取行 note\n- 预取行 status='error' 或未预取 → status='error'，note 写原因（交主 agent 重取或 Edge 人工核实）\n\n字段规则：\n- title/year/journal 取预取行权威值（mismatch 时 title 取权威标题；not-found/error 时保持待验条目原值）\n- doi：verified 时填预取行权威 DOI；其余情况保持待验条目原值（可能为空串）\n- abstract 取预取行 abstract；预取行 abstract 为空但待验文献自带摘要时，用检索摘要并 abstractSrc='检索'；两者皆无 → 空串，**禁止编造摘要**\n- citedBy/citedBySrc 直接复制预取行（citedBySrc 为 'openalex' 或 'crossref'）\n\n把每篇结果翻译进 results 数组（一行一个元素），只输出符合 schema 的 JSON。`,
    { label: 'verify-slice', phase: '验身判读', schema: resultSchema,
      ...(args.model ? { model: args.model } : {}), ...(args.provider ? { provider: args.provider } : {}) }
  );
  return r ? r.results : [];
});

phase('汇总');
return { results: results.filter(Boolean).flat() };
