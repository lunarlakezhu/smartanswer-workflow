// SmartAnswer 阶段4 · 检索：10 路子代理并行（9 出版社 + PubMed 来源补充路）
// args: { topic, subQuestions, keywords: string[], sites?: string[], searchTool?: string,
//         model?: string, provider?: string, smoke }
//   model/provider: 可选子代理模型覆盖（由主 agent 读 sa-models.json 后注入；缺省用引擎默认）
//   searchTool: 子代理使用的检索工具名，默认 'mcp__papersearch__search'（v4 · A 方案：OpenAlex 免费学术
//   API，注册于 profiles/web/cordis.patch.yml 的 mcp-papersearch 插件；返回真实论文元数据+DOI+真实摘要）；
//   回退旧后端（DSH 原生 web_search，DeepSeek 付费）时由主 agent 传 args.searchTool='web_search'
//   sites: 缺省全部 10 路一次并行；**只用于失败路单路补跑**（sites: ['<域名>'] 一次一路，
//   禁止多路成批补跑——2026-08-20 实测：3 路同时补跑打挂串行 MCP server，连环 60s 超时 -32001）
// 输出: { siteResults: [{site, label, papers, searchUnavailable?}] }（label 为显示名，如 Nature/IEEE）
//   papers 每条**只含紧凑字段** {title, doi, doiSource, year, journal}，每路上限 15 条：
//   2026-08-20 实测 11 路带 abstract/url 回传约 187KB，超过约 50KB 落盘阈值被截断、后 8 路结果全丢；
//   紧凑字段下全路汇总约 40KB 以内，摘要本就由 crossref-fetch 验身阶段按 DOI 统一预取，不损失信息。
//   脚本返回处另有投影兜底：即使子代理违规塞入 abstract/url 也会被剥掉（返回体积由构造保证有上界）
// CrossRef 不在本脚本内：它只做验身+排名，由 verify.js 在去重/白名单预过滤后执行（关键词搜索慢且噪声大——试运行教训）
// 去重/白名单/过滤/排序由主 agent 在脚本外执行（脚本无 fs 能力，只做协调）
//
// v3 防编造+结构化失败（2026-08-17 实测：web_search 余额不足→9 路全部失败，其中 SD 路基于知识
// 编造 13 条假文献仍被判 completed，污染下游 verify；另有 5 路输出纯文本报告被判 failed）：
//   - 工具失败时必须 structured_output 输出 {"papers":[已收录条目],"searchUnavailable":true}（仅零成功才是空数组），
//     不得编造、不得纯文本收尾（2026-08-19 复盘：SD 路 7 次成功结果被整路丢弃）
//   - papers 每条必须来自真实成功的检索工具返回；一次成功搜索都没有 → papers 必须为空数组
//
// v4 切换 OpenAlex 后端（2026-08-18 用户裁决 A 方案）：
//   - 默认 searchTool 改为 'mcp__papersearch__search'（免费免 key，同时消灭"余额耗尽"与"编造"两类故障）
//   - 9 站点不再用 site: 搜索，改用 server 的 journal 参数按出版社过滤（OpenAlex host_organization_lineage，
//     出版社 ID 均为 2026-08-18 实测查询所得）
//   - PubMed 路 = OpenAlex has_pmid:true 过滤，**定位是"文献来源补充"（补医学/生命科学交叉文献），不是期刊**
//   - arXiv 路已删（2026-08-20 用户裁决：预印本质量弱、排序时基本被剔除，且是回传体积的主要贡献者）
//   - 返回自带真实 DOI（doiSource='seen'）与真实摘要（abstract_inverted_index 重建），子代理直抄不猜
//   - nature.com 与 link.springer.com 在 OpenAlex 同属 Springer Nature（无法区分），两路重叠由主 agent 去重
//   - 预算（v4.1 适配 OpenAlex 额度制，2026-08-20 实测响应头：每日 1000 credits、search 一次
//     10 credits，即全天约 100 次搜索）：每路总调用 ≤8、候选 ≥12 或连续 3 次无新增即止；
//     10 路 × 8 = 800 credits，留 200 credits 给失败路补跑。额度耗尽时 server 会立即报
//     "daily credit quota exhausted"（不重试），按工具不可用处理，当日不再补跑
//   - v4.1（2026-08-20）：紧凑回传 + 脚本投影兜底 + sites 单路补跑约定（见上）

if (args.smoke) return { smoke: 'ok' };

// 站点域名 → { label: 显示名, journal: server 的 journal 参数, publisher: 说明 }
const SITE_MAP = {
  'nature.com':              { label: 'Nature',        journal: 'nature',        publisher: 'Springer Nature' },
  'link.springer.com':       { label: 'Springer',      journal: 'springer',      publisher: 'Springer Nature' },
  'science.org':             { label: 'Science',       journal: 'science',       publisher: 'AAAS' },
  'sciencedirect.com':       { label: 'ScienceDirect', journal: 'sciencedirect', publisher: 'Elsevier BV' },
  'ieeexplore.ieee.org':     { label: 'IEEE',          journal: 'ieee',          publisher: 'IEEE' },
  'pnas.org':                { label: 'PNAS',          journal: 'pnas',          publisher: 'National Academy of Sciences' },
  'journals.sagepub.com':    { label: 'SAGE',          journal: 'sage',          publisher: 'SAGE Publishing' },
  'iopscience.iop.org':      { label: 'IOP',           journal: 'iop',           publisher: 'IOP Publishing' },
  'onlinelibrary.wiley.com': { label: 'Wiley',         journal: 'wiley',         publisher: 'Wiley' },
  // 来源补充路（非期刊）：OpenAlex has_pmid 过滤，补医学/生命科学交叉文献
  'pubmed.ncbi.nlm.nih.gov': { label: 'PubMed',       journal: 'pubmed',        publisher: '来源补充 · PubMed-indexed (OpenAlex has_pmid)' },
};

const sites = args.sites && args.sites.length ? args.sites : Object.keys(SITE_MAP);

const info = site => SITE_MAP[site] || { label: site, journal: '', publisher: site };

const keywordText = (args.keywords || []).join('；');

// v4：默认 OpenAlex MCP 工具；回退 web_search 由主 agent 显式传参
const searchTool = args.searchTool || 'mcp__papersearch__search';

// v4.1 紧凑回传：每条只收 5 个字段，abstract/url 一律不带（摘要由验身阶段 crossref-fetch 按 DOI
// 统一预取；2026-08-20 实测带 abstract 的 11 路回传约 187KB，超过落盘阈值被截断丢 8 路）
const papersSchema = {
  type: 'object',
  properties: {
    papers: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          doi: { type: 'string' },
          doiSource: { type: 'string', enum: ['seen', 'pending'] },
          year: { type: 'string' },
          journal: { type: 'string' }
        },
        required: ['title', 'doi', 'doiSource']
      }
    },
    // 检索工具不可用（报错/MCP 未注册/全部调用失败）时置 true，正常检索时省略或 false
    searchUnavailable: { type: 'boolean' }
  },
  required: ['papers']
};

phase('检索');

const siteResults = await parallel(sites.map(site => async () => {
  const { label, journal, publisher } = info(site);
  const journalArgLine = journal
    ? `- 参数固定：{"query": "<英文检索词>", "journal": "${journal}", "limit": 10}（journal 必须填 "${journal}"，不要省略、不要改成别的值）`
    : `- 参数固定：{"query": "<英文检索词>", "limit": 10}（不传 journal）`;
  const r = await agent(
    `你是文献检索员（平台 ${label}，出版社 ${publisher}）。
调研主题：${args.topic}
关键词组（中英混合，检索前必须翻译成英文检索词）：${keywordText}

任务：用 ${searchTool} 工具在 OpenAlex 学术文献库中检索真实文献，输出 JSON 论文列表。

【调用方式】
${journalArgLine}
- 返回 JSON 数组，每条 {"title","authors","year","doi","venue","citations","abstract","url","pmid"}，全部来自 OpenAlex 真实元数据（pmid 仅 PubMed 收录文章非空，其余源为空，可忽略）

【硬性预算 —— 违反任何一条都算任务失败】
1. ${searchTool} 总调用次数 ≤ 8 次，达到 8 必须立即停止并输出最终 JSON（OpenAlex 每日额度有限，省着用）
2. 每个关键词最多 2 种英文写法；优先把 2-3 个相关词组合成一条查询，禁止逐词穷举
3. 以下任一终止条件满足，立即输出最终 JSON（不再搜索）：
   a. 调用次数 ≥ 8
   b. 已收录有效候选 ≥ 12 条
   c. 连续 3 个查询没有新增候选

【工具失败处理 —— 严禁编造，违者本路结果全废】
- 错误信息含 "daily credit quota exhausted"（OpenAlex 当日额度耗尽）→ **立即停止，不等 2 次**：structured_output 输出 {"papers": [全部已收录条目], "searchUnavailable": true}
- ${searchTool} 返回错误（工具报错 / 返回体含 "error" 字段 / 超时 / HTTP 429）时：同一错误重复 2 次即判定工具不可用，停止重试；**已成功获取的候选必须全部保留**，通过 structured_output 输出 {"papers": [全部已收录条目], "searchUnavailable": true}
- papers 里每一条都必须直接来自某次成功 ${searchTool} 返回；一次成功调用都没有 → papers 必须是空数组 []，并带 "searchUnavailable": true
- 严禁"基于知识/记忆生成示例文献"、"模拟输出"、"填充演示数据"——标题、DOI、摘要、URL 一律不得凭记忆编造（2026-08-17 实测：有子代理编造 13 条假文献污染下游验身流程）
- 最终回复必须通过 structured_output 提交 JSON；严禁以纯文本失败报告收尾（引擎只认结构化输出，纯文本=本路 failed）

【DOI 规则 —— 直接抄，禁止推理】
- 返回条目自带非空 doi → 原样填入，doiSource 填 'seen'
- 返回条目 doi 为空字符串 → doi 填 ""，doiSource 填 'pending'，其余字段照常收录
- 严禁：自己拼接/猜测/修正 DOI、根据文章编号推断 DOI、用 sci-hub / x-mol 等第三方聚合站查证

【元数据规则 —— 直接抄，不要纠结】
- year：抄返回的 year；journal：填返回的 venue
- **输出严禁携带 abstract / url / authors / citations / pmid**：摘要由验身阶段按 DOI 统一重新预取；检索回传只交紧凑字段，全路汇总必须落在落盘阈值内（2026-08-20 实测：带摘要回传 187KB 被截断、8 路结果全废）。工具返回里的 abstract 仅用于判断相关性，不进输出
- 禁止为补任何字段做工具之外的额外查询

【质量要求】
- 只收与主题强相关的期刊论文（从 title 与 abstract 判断相关性）
- 宁缺毋滥：每路最多 15 条；候选 ≥ 8 条后停止扩展新关键词
- 最后输出 JSON：{"papers": [{"title","doi","doiSource","year","journal"}], "searchUnavailable": false}（工具不可用时：{"papers": [已收录条目], "searchUnavailable": true}——仅零成功才是空数组）`,
    { label, phase: '检索', schema: papersSchema, retry: 1, tools: { deny: ['skill'] },
      ...(args.model ? { model: args.model } : {}), ...(args.provider ? { provider: args.provider } : {}) }
  );
  // v4.1 投影兜底：无论子代理实际回什么，都剥成紧凑字段并截断，保证全路汇总体积有硬上界
  return {
    site, label,
    papers: (r ? r.papers : []).slice(0, 15).map(p => ({
      title: String(p.title || '').slice(0, 200),
      doi: p.doi || '',
      doiSource: p.doiSource === 'seen' ? 'seen' : 'pending',
      year: p.year || '',
      journal: p.journal || '',
    })),
    ...(r && r.searchUnavailable ? { searchUnavailable: true } : {})
  };
}));

phase('汇总');
return { siteResults };
