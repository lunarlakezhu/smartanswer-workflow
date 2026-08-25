// crossref_fetch.js —— Node 版取数（主 agent 专用；子代理禁网）
// 方法②落地：Crossref 主通道 + OpenAlex 增补通道
// 背景：DSH 沙箱内 PowerShell/.NET 的 SChannel TLS 全废（SEC_E_NO_CREDENTIALS /
//       「基础连接已经关闭」，主 agent 与子代理同样复现），本地代理 17897 时开时关；
//       Node 自带 OpenSSL + 内置 CA，实测 Crossref/OpenAlex/SemanticScholar 三源全通。
//       取数必须由主 agent 经本脚本完成，子代理只拿结果做离线判读。
// 通道策略（每篇最多两源各查一次，不重试）：
//   - 按 DOI：身份（title/journal/year）Crossref 权威；Crossref 404/失败 → OpenAlex 兜底（titleSrc 标注）
//   - 按标题（v2：检索 doiSource='pending' 的无 DOI 条目）：query.title 精确标题取 top1
//     （实测 0.4-1.4s/篇；score≥60 视为命中，<60 视为查无此篇），命中后同样 OpenAlex 补摘要/被引
//   - 摘要：Crossref 优先；Crossref 无摘要 → OpenAlex 补（IEEE 路尤其受益：
//           IEEE 很少向 Crossref 存摘要，OpenAlex 聚合多源通常有）
//   - 被引数：统一取 OpenAlex cited_by_count 口径（排序可比），Crossref 值存 crossrefCitedBy 备查
// 用法：node crossref_fetch.js <输入.json> <输出.json>
//   输入：["10.1109/xxx", ...] | [{doi:"..."}, ...] | [{doi:"", title:"...", doiSource:"pending"}, ...]
//   输出：JSON 数组，每篇：
//     { doi, status, title, journal, year, titleSrc, abstract, abstractSrc,
//       citedBy, citedBySrc, crossrefCitedBy, isIeee, note, queryTitle? }
//     status: found=有记录 | not-found=两源均 404/标题无命中 | error=网络/解析失败（交主 agent 重取或 Edge 人工核实）
// 礼仪：mailto 礼貌池；每篇间隔 300ms。

const fs = require('fs');
const UA = 'SmartAnswer/1.0 (mailto:research-bot@example.org)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(s) {
  return s ? s.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function openalexAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const pos = {};
  for (const [w, arr] of Object.entries(inv)) for (const i of arr) pos[i] = w;
  const n = Object.keys(pos).length;
  let out = '';
  for (let i = 0; i < n; i++) out += (i ? ' ' : '') + pos[i];
  return out;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 404) return { http: 404, notFound: true };
    const data = await res.json();
    return { http: res.status, data };
  } catch (e) { return { http: 0, err: String(e && e.message || e) }; }
}

async function fetchCrossref(doi) {
  const r = await fetchJson('https://api.crossref.org/works/' + encodeURIComponent(doi));
  if (r.notFound) return { found: false, notFound: true };
  if (!r.data || !r.data.message) return { found: false, notFound: false, err: 'crossref http ' + (r.http || r.err) };
  const m = r.data.message;
  if (!Array.isArray(m.title) || !m.title.length) return { found: false, notFound: false, err: 'crossref http ' + (r.http || 'no title') };
  return {
    found: true,
    title: m.title ? m.title[0] : '',
    journal: m['container-title'] ? m['container-title'][0] : '',
    year: m.issued && m.issued['date-parts'] && m.issued['date-parts'][0] ? String(m.issued['date-parts'][0][0]) : '',
    abstract: stripHtml(m.abstract || ''),
    citedBy: Number(m['is-referenced-by-count']) || 0,
  };
}

// v2：按标题 query.title 精确查询（取 top1，score<60 视为查无此篇；score 缺失时放行 top1）
async function fetchCrossrefByTitle(title) {
  const r = await fetchJson('https://api.crossref.org/works?query.title=' + encodeURIComponent(title) + '&rows=1');
  if (r.notFound) return { found: false, notFound: true };
  if (!r.data || !r.data.message) return { found: false, notFound: false, err: 'crossref http ' + (r.http || r.err) };
  const items = r.data.message.items || [];
  if (!items.length) return { found: false, notFound: true };
  const top = items[0];
  const score = typeof top.score === 'number' ? top.score : null;
  if (score !== null && score < 60) return { found: false, notFound: true, note: 'score=' + score.toFixed(1) + ' 低于阈值' };
  return {
    found: true,
    doi: String(top.DOI || ''),
    title: top.title ? top.title[0] : '',
    journal: top['container-title'] ? top['container-title'][0] : '',
    year: top.issued && top.issued['date-parts'] && top.issued['date-parts'][0] ? String(top.issued['date-parts'][0][0]) : '',
    abstract: stripHtml(top.abstract || ''),
    citedBy: Number(top['is-referenced-by-count']) || 0,
    note: score !== null ? 'score=' + score.toFixed(1) : '',
  };
}

async function fetchOpenalex(doi) {
  const r = await fetchJson('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi) + '?mailto=research-bot@example.org');
  if (r.notFound) return { found: false, notFound: true };
  if (!r.data) return { found: false, notFound: false, err: 'openalex http ' + (r.http || r.err) };
  const d = r.data;
  if (!d.id || !d.display_name) return { found: false, notFound: false, err: 'openalex http ' + (r.http || 'no work') };
  const src = d.primary_location && d.primary_location.source;
  return {
    found: true,
    title: d.display_name || '',
    journal: src ? src.display_name : '',
    year: d.publication_year ? String(d.publication_year) : '',
    abstract: openalexAbstract(d.abstract_inverted_index),
    citedBy: Number(d.cited_by_count) || 0,
  };
}

async function one(item) {
  const doiRaw = String(item.doi || '').replace(/\s+/g, '');
  const queryTitle = item.title ? String(item.title).replace(/\s+/g, ' ').trim() : '';
  const isIeee = /^10\.1109\//i.test(doiRaw);
  const out = { doi: doiRaw, status: 'error', title: '', journal: '', year: '', titleSrc: '', abstract: '', abstractSrc: '', citedBy: 0, citedBySrc: '', crossrefCitedBy: 0, isIeee, note: '' };
  const notes = [];
  let cr, oa = null;

  if (doiRaw) {
    // 路径一：按 DOI 精确查询（验身+排名）
    cr = await fetchCrossref(doiRaw);
    oa = await fetchOpenalex(doiRaw);
    if (cr.found) {
      out.status = 'found';
      out.title = cr.title; out.journal = cr.journal; out.year = cr.year;
      out.titleSrc = 'crossref'; out.crossrefCitedBy = cr.citedBy;
      if (cr.abstract) { out.abstract = cr.abstract; out.abstractSrc = 'crossref'; }
      else if (oa.found && oa.abstract) { out.abstract = oa.abstract; out.abstractSrc = 'openalex'; }
    } else if (oa.found) {
      out.status = 'found';
      out.title = oa.title; out.journal = oa.journal; out.year = oa.year;
      out.titleSrc = 'openalex';
      if (oa.abstract) { out.abstract = oa.abstract; out.abstractSrc = 'openalex'; }
      notes.push('crossref: ' + (cr.notFound ? '404' : cr.err));
    } else if (oa.notFound) {
      out.status = 'not-found';
      if (cr.err) notes.push('crossref: ' + cr.err);
    } else {
      out.status = 'error';
      notes.push('crossref: ' + (cr.notFound ? '404' : cr.err));
      notes.push('openalex: ' + (oa.notFound ? '404' : oa.err));
    }
  } else if (queryTitle) {
    // 路径二：按标题补验（v2：检索 doiSource='pending' 的条目）
    if (item.doiSource === 'seen' && !item.doi) {
      out.status = 'error';
      out.note = 'doiSource=seen 但 doi 为空，交主 agent 人工核实';
      return out;
    }
    cr = await fetchCrossrefByTitle(queryTitle);
    if (cr.found && cr.doi) {
      out.doi = cr.doi;
      out.isIeee = /^10\.1109\//i.test(cr.doi);
      out.status = 'found';
      out.title = cr.title; out.journal = cr.journal; out.year = cr.year;
      out.titleSrc = 'crossref'; out.crossrefCitedBy = cr.citedBy;
      if (cr.abstract) { out.abstract = cr.abstract; out.abstractSrc = 'crossref'; }
      oa = await fetchOpenalex(cr.doi);
      if (oa.found) {
        if (!out.abstract && oa.abstract) { out.abstract = oa.abstract; out.abstractSrc = 'openalex'; }
      } else if (oa.err) { notes.push('openalex: ' + oa.err); }
    } else if (cr.notFound) {
      out.status = 'not-found';
      if (cr.note) notes.push(cr.note);
    } else {
      out.status = 'error';
      notes.push('crossref: ' + (cr.err || cr.note));
    }
  } else {
    out.status = 'error';
    out.note = '条目既无 doi 也无 title';
    return out;
  }

  if (oa && oa.found) { out.citedBy = oa.citedBy; out.citedBySrc = 'openalex'; }
  else if (cr && cr.found) { out.citedBy = cr.citedBy; out.citedBySrc = 'crossref'; }
  if (cr && cr.found && oa && !oa.found && oa.err) notes.push('openalex: ' + oa.err);
  if (queryTitle) out.queryTitle = queryTitle;
  out.note = notes.join('; ') || out.note;
  return out;
}

async function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) { console.error('usage: node crossref_fetch.js <in.json> <out.json>'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const items = raw.map(x => typeof x === 'string' ? { doi: x } : x).filter(x => (x && (x.doi || x.title)));
  const results = [];
  for (const it of items) {
    const r = await one(it);
    results.push(r);
    console.log(r.status + '\t' + (r.doi || '(no-doi)') + '\t[' + (r.titleSrc || '-') + ']' + '\tabs:' + (r.abstractSrc || '-') + '\tcite:' + r.citedBy + '\t' + (r.title || '').slice(0, 55));
    await sleep(300);
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('wrote ' + results.length + ' rows -> ' + outPath);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
