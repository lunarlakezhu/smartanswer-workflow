// library_archive.js —— r1/r2 阅读轮完成后的入库脚本（主 agent 专用；无网络、无 LLM、无子代理）
// 依据 E:\Library-Manage\new-library\SCHEMA.md：编号主键（3 位零填充、空缺不复用、新增=最大号+1）、
// 文件命名（新增文件用推荐式 编号_slug）、md\ 与 归档\ frontmatter、论文级 DOI 去重、CHANGELOG 留痕。
// 通道与 crossref-fetch.js 相同：主 agent 经 pwsh 调 node 运行本脚本；脚本只做确定性文件操作，
// 结果全部落在磁盘与 stdout，主 agent pwsh 复核计数后才写 _progress.yaml。
// 设计要点：
//   - 先全量校验后写文件，索引与 CHANGELOG 最后改写：校验失败 exit 1，绝不出现半写索引；
//     文件已部分写入的场景由幂等重跑兜底
//   - 复制不移动：{主题}\ 工作目录产物原样保留（终答硬闸门计数、r2 防回退审计仍引用原路径）
//   - 幂等：同 DOI 已在索引 → 复用编号（分层分支）；目标已存在且内容/大小一致 → 跳过；
//     完整跑完后的重跑 = 全跳过、零索引改动、零 CHANGELOG 追加
//   - 索引为 UTF-8 + BOM + CRLF，读改写全程保真（BOM 随首行原文保留）
// 分层规则（DOI 已在索引的论文：阶段 5 tier=full/notes，或 r2 雪球撞库）：
//   - 精读笔记 → 归档\{编号}_{slug}_{主题}_精读.md（同编号分层共存，不新增索引行）
//   - PDF：该编号在 pdf\ 无任何文件且索引 pdf 列为 — 时补入并翻转索引列、移出「无 PDF」附注；否则跳过
//   - 全文 md 不重复入库（编号已有 md，哪怕它是笔记型卡片——是否升级为全文 md 属人工决策，避免同编号双 md）
// 用法（manifest 均为 JSON 文件路径）：
//   轮次入库：node library_archive.js <manifest.json>
//     { mode:"round", round:"r1"|"r2", topic, topicDir, libraryRoot,
//       papers:[{ no, title, doi, year, journal, is_review, tier,
//                 pdfPath?, mdPath?, notePath, tags:[1-3 个] }] }
//     tier 取 round 清单回填值（full|notes|miss|download）；tier=full 但 DOI 不在索引 = 数据不一致，报错
//   终答入库：node library_archive.js <manifest.json>
//     { mode:"final", topic, topicDir, libraryRoot, mdPath, htmlPath,
//       map:[{ n:轮内[N]序号, libNo:"537", title }] }
//     复制 最终回答.md/.html → 最终回答汇总\{NN}-{主题}.md/.html（NN=目录内最大序号+1，2 位零填充）；
//     md 副本文末追加「轮内 [n] → 全库编号」映射表（SCHEMA §9）；html 为纯副本
// stdout 末行输出 `JSON_RESULT: {...}` 摘要供主 agent 复核；warnings 为不阻断的异常提示
// （如转换 md 未检出 DOI 字符串 = 疑似清单映射错位，回 SKILL 阶段 7 第 1 步核对 mdPath↔DOI）。

const fs = require('fs');
const path = require('path');

// SCHEMA §6 受控词表（2026-08 版）；词表外标签允许入库，但会标注进 CHANGELOG
const CONTROLLED_TAGS = new Set([
  'DEA', 'DEFA', 'SMA', 'PCM相变', '磁驱动', '气动液压', '刚柔耦合', '肌腱', '折纸', '阻塞', '其他',
  '水下', '狭窄空间', '深海', '抓取', '触觉传感', '仿生控制/CPG', '生物体操作',
  '综述', '原创研究', '方法',
]);

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

function normalizeDoi(doi) {
  return String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
}

function pad3(n) { return String(n).padStart(3, '0'); }

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_');
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'for', 'in', 'on', 'with', 'and', 'or', 'to',
  'via', 'based', 'using', 'from', 'by', 'at', 'as', 'is', 'are', 'its', 'into', 'their', 'new',
  'over', 'under', 'toward', 'towards', 'between', 'among', 'within', 'across', 'during', 'through']);

// 英文标题 → 2–4 个实词的小写下划线 slug（≤40 字符；SCHEMA §3：不硬截断标题，用短 slug）
function slugify(title) {
  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  let slug = words.slice(0, 4).join('_');
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/_[^_]*$/, '');
  return slug || 'paper';
}

function yq(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

// SCHEMA §4 frontmatter；year 由调用方保证 /^\d{4}$/（本轮 manifest 校验过），否则原样引用
function buildFrontmatter(no, type, title, journal, year, level, doi, tags) {
  const yearScalar = /^\d{4}$/.test(String(year)) ? String(year) : yq(year);
  return '---\n'
    + '编号: ' + yq(no) + '\n'
    + '类型: ' + yq(type) + '\n'
    + '标题: ' + yq(title) + '\n'
    + '期刊: ' + yq(journal) + '\n'
    + '年份: ' + yearScalar + '\n'
    + '信息等级: ' + yq(level) + '\n'
    + 'DOI: ' + yq(doi) + '\n'
    + '主题: [' + tags.map(yq).join(', ') + ']\n'
    + '---\n\n';
}

function parseIndex(idxPath) {
  const raw = fs.readFileSync(idxPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const rowRe = /^\|\s*(\d{3})\s*\|/;
  let maxNo = 0, lastRowIdx = -1, tableHeaderIdx = -1;
  const doiToNo = new Map();
  const nos = new Set();
  const rowIdxByNo = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (tableHeaderIdx < 0 && /^\|\s*编号\s*\|/.test(line)) tableHeaderIdx = i;
    const m = line.match(rowRe);
    if (!m) continue;
    lastRowIdx = i;
    const no = m[1];
    nos.add(no);
    rowIdxByNo.set(no, i);
    const n = parseInt(no, 10);
    if (n > maxNo) maxNo = n;
    const dm = line.match(/\[([^\]]+)\]\(https?:\/\/doi\.org\//) || line.match(/(10\.\d{4,}[^\s|]*)/);
    if (dm) {
      const doi = normalizeDoi(dm[1]);
      if (doi && !doiToNo.has(doi)) doiToNo.set(doi, no);
    }
  }
  if (lastRowIdx < 0 || tableHeaderIdx < 0) fail('文献索引.md 解析失败：未找到编号表（' + idxPath + '）');
  return { eol, lines, maxNo, doiToNo, nos, rowIdxByNo, lastRowIdx, tableHeaderIdx };
}

function copyOrSkip(src, dst, what) {
  if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); return 'copied'; }
  if (fs.statSync(src).size === fs.statSync(dst).size) return 'skipped';
  fail(what + '目标已存在且大小不同（如需重入先人工处理该文件）：' + dst);
}

function writeOrSkip(dst, content, what) {
  if (!fs.existsSync(dst)) { fs.writeFileSync(dst, content, 'utf8'); return 'copied'; }
  if (fs.readFileSync(dst, 'utf8') === content) return 'skipped';
  fail(what + '目标已存在且内容不同（审计修订后需重入：先删除该文件再重跑）：' + dst);
}

// 索引行按 | 分列后第 7 列为 pdf（[1]编号 [2]标题 [3]期刊 [4]年份 [5]DOI [6]md [7]pdf [8]归档 [9]备注）
function pdfCell(idx, no) {
  const i = idx.rowIdxByNo.get(no);
  if (i === undefined) fail('索引缺编号行：' + no);
  return (idx.lines[i].split('|')[7] || '').trim();
}

function flipPdfCell(idx, no) {
  const i = idx.rowIdxByNo.get(no);
  const cells = idx.lines[i].split('|');
  cells[7] = ' ✅ ';
  if ((cells[9] || '').trim() === '无PDF') cells[9] = '  ';
  idx.lines[i] = cells.join('|');
}

function libHasPdfFile(lib, no) {
  return fs.readdirSync(path.join(lib, 'pdf'))
    .some(f => f.startsWith(no + '-') || f.startsWith(no + '_'));
}

function updateNoPdfNote(idx, added, removed) {
  const i = idx.lines.findIndex(l => /^- 无 PDF 编号（\d+）/.test(l));
  let list = [];
  if (i >= 0) {
    const m = idx.lines[i].match(/^- 无 PDF 编号（\d+）:\s*(.*)$/);
    list = m[1] ? m[1].split('、').map(s => s.trim()).filter(Boolean) : [];
  }
  const rm = new Set(removed.map(n => parseInt(n, 10)));
  list = list.filter(n => !rm.has(parseInt(n, 10)));
  list.push(...added);
  const line = list.length ? '- 无 PDF 编号（' + list.length + '）: ' + list.join('、') : '- 无 PDF 编号（0）: 无';
  if (i >= 0) idx.lines[i] = line;
  else {
    const h = idx.lines.findIndex(l => l.trim() === '## 附注');
    if (h < 0) fail('索引缺 ## 附注 段，无法维护无 PDF 清单');
    idx.lines.splice(h + 1, 0, line);
  }
}

function updateHeaderCounts(idx, lib) {
  const count = (d, ext) => fs.readdirSync(path.join(lib, d)).filter(f => f.endsWith(ext)).length;
  const line = '- 依据: new-library/md（' + count('md', '.md') + '）、pdf（' + count('pdf', '.pdf')
    + '）、归档（' + count('归档', '.md') + '）实体文件（2026-08-11 全量枚举基线，此后入库脚本增量维护）';
  const i = idx.lines.findIndex(l => l.startsWith('- 依据: '));
  if (i >= 0) idx.lines[i] = line;
  else idx.lines.splice(idx.tableHeaderIdx, 0, line, '');
}

function updateRecentLine(idx, line) {
  const i = idx.lines.findIndex(l => l.startsWith('- 最近入库: '));
  if (i >= 0) { idx.lines[i] = line; return; }
  let j = idx.tableHeaderIdx - 1;
  while (j >= 0 && !/^- /.test(idx.lines[j])) j -= 1;
  if (j < 0) fail('索引头部缺少 bullet 区，无法写入最近入库行');
  idx.lines.splice(j + 1, 0, line);
}

function today() { return new Date().toISOString().slice(0, 10); }

function writeChangelog(lib, entryLines) {
  const p = path.join(lib, 'CHANGELOG.md');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '# CHANGELOG · new-library 版本与去重记录\n\n'
      + '> 依据 SCHEMA.md 第 8 节：所有规模/结构变更在此留痕（日期 + 操作 + 影响编号）；\n'
      + '> 索引 md/pdf/归档 存在性标记必须与磁盘一致，漂移修正同样在此登记。\n\n', 'utf8');
  }
  fs.appendFileSync(p, entryLines.join('\n') + '\n', 'utf8');
}

function runRound(m) {
  const lib = m.libraryRoot;
  const idxPath = path.join(lib, '文献索引.md');
  for (const dir of ['md', 'pdf', '归档']) {
    if (!fs.existsSync(path.join(lib, dir))) fail('库目录缺失：' + path.join(lib, dir));
  }
  const idx = parseIndex(idxPath);

  // ---- 校验 + 编号分配（此时尚未写任何文件）----
  const papers = m.papers || [];
  if (!papers.length) fail('manifest.papers 为空');
  const seenDoi = new Map();
  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const at = 'papers[' + i + ']（' + (p.title || '?') + '）';
    for (const k of ['title', 'doi', 'year', 'journal', 'notePath', 'tags']) {
      if (p[k] === undefined || p[k] === null || p[k] === '') fail(at + ' 缺字段 ' + k);
    }
    const doi = normalizeDoi(p.doi);
    if (!/^10\./.test(doi)) fail(at + ' DOI 非法：' + p.doi);
    if (seenDoi.has(doi)) fail(at + ' 与 papers[' + seenDoi.get(doi) + '] DOI 重复：' + doi);
    seenDoi.set(doi, i);
    if (!/^\d{4}$/.test(String(p.year))) fail(at + ' 年份须为 4 位数字：' + p.year);
    if (!Array.isArray(p.tags) || p.tags.length < 1 || p.tags.length > 3) fail(at + ' tags 须 1–3 个');
    if (!fs.existsSync(p.notePath)) fail(at + ' notePath 不存在：' + p.notePath);
    p._doi = doi;
    const libNo = idx.doiToNo.get(doi);
    if (libNo) {
      p._libNo = libNo;
      p._layered = true;
    } else if (p.tier === 'full') {
      fail(at + ' tier=full 但索引查无此 DOI（阶段5匹配与索引不一致，人工核对）：' + doi);
    } else {
      if (idx.maxNo >= 999) fail('编号将超出 3 位（当前最大 ' + idx.maxNo + '）：SCHEMA 编号规则需人工扩位后再入库');
      idx.maxNo += 1;
      p._libNo = pad3(idx.maxNo);
      p._layered = false;
      if (!p.mdPath || !fs.existsSync(p.mdPath)) fail(at + ' 新入库论文 mdPath 缺失或不存在：' + p.mdPath);
    }
  }

  // ---- 写文件（索引最后改写）----
  const warnings = [];
  const actions = { pdf: 0, md: 0, note: 0 };
  const layeredLibNos = [];
  const newRows = [];
  const noPdfNew = [];
  const pdfBackfill = [];
  const offVocab = new Set();
  for (const p of papers) {
    const slug = slugify(p.title);
    const noteType = p.is_review ? '综述精读' : '六维精读';
    const noteLevel = p.is_review ? '' : 'A';
    let noteRaw = fs.readFileSync(p.notePath, 'utf8');
    if (!noteRaw.startsWith('---')) {
      noteRaw = buildFrontmatter(p._libNo, noteType, p.title, p.journal, p.year, noteLevel, p._doi, p.tags) + noteRaw;
    }
    for (const t of p.tags) if (!CONTROLLED_TAGS.has(t)) offVocab.add(t);

    if (p._layered) {
      // 幂等：本 manifest 此前跑过且已按新号入过库时（归档\{libNo}_{slug}.md 已存在），回写同一名
      const plain = path.join(lib, '归档', p._libNo + '_' + slug + '.md');
      const dst = fs.existsSync(plain) ? plain
        : path.join(lib, '归档', p._libNo + '_' + slug + '_' + safeName(m.topic) + '_精读.md');
      if (writeOrSkip(dst, noteRaw, '精读笔记 ') === 'copied') actions.note += 1;
      layeredLibNos.push(p._libNo);
      if (p.pdfPath && fs.existsSync(p.pdfPath) && pdfCell(idx, p._libNo) === '—' && !libHasPdfFile(lib, p._libNo)) {
        if (copyOrSkip(p.pdfPath, path.join(lib, 'pdf', p._libNo + '_' + slug + '.pdf'), 'PDF ') === 'copied') actions.pdf += 1;
        flipPdfCell(idx, p._libNo);
        pdfBackfill.push(p._libNo);
      }
      console.log('✅ ' + p._libNo + '（已有编号·分层）笔记 → ' + path.basename(dst) + '：' + p.title);
      continue;
    }

    const noteDst = path.join(lib, '归档', p._libNo + '_' + slug + '.md');
    if (writeOrSkip(noteDst, noteRaw, '精读笔记 ') === 'copied') actions.note += 1;
    let pdfMark = '✅';
    if (p.pdfPath && fs.existsSync(p.pdfPath)) {
      if (copyOrSkip(p.pdfPath, path.join(lib, 'pdf', p._libNo + '_' + slug + '.pdf'), 'PDF ') === 'copied') actions.pdf += 1;
    } else {
      pdfMark = '—';
      noPdfNew.push(p._libNo);
      warnings.push(p._libNo + ' 无 PDF（pdfPath 缺失或文件不存在），索引按 — 记录：' + p.title);
    }
    const mdRaw = fs.readFileSync(p.mdPath, 'utf8');
    if (!mdRaw.toLowerCase().includes(p._doi)) {
      warnings.push(p._libNo + ' 转换 md 未检出 DOI 字符串，疑似清单映射错位（回阶段7第1步核对 mdPath↔DOI）：' + p.title);
    }
    const mdOut = mdRaw.startsWith('---') ? mdRaw
      : buildFrontmatter(p._libNo, 'full-text', p.title, p.journal, p.year, '', p._doi, p.tags) + mdRaw;
    if (writeOrSkip(path.join(lib, 'md', p._libNo + '_' + slug + '.md'), mdOut, '全文 md ') === 'copied') actions.md += 1;
    const esc = s => String(s).replace(/\|/g, '\\|');
    newRows.push('| ' + p._libNo + ' | ' + esc(p.title) + ' | ' + esc(p.journal) + ' | ' + p.year
      + ' | [' + p._doi + '](https://doi.org/' + p._doi + ') | ✅ | ' + pdfMark + ' | ✅ |  |');
    console.log('✅ ' + p._libNo + '（新编号）md/pdf/归档：' + p.title);
  }

  // ---- 索引 + CHANGELOG ----
  if (newRows.length) idx.lines.splice(idx.lastRowIdx + 1, 0, ...newRows);
  if (noPdfNew.length || pdfBackfill.length) updateNoPdfNote(idx, noPdfNew, pdfBackfill);
  if (newRows.length || pdfBackfill.length) {
    const newNos = papers.filter(p => !p._layered).map(p => p._libNo);
    updateHeaderCounts(idx, lib);
    updateRecentLine(idx, '- 最近入库: ' + today() + ' ' + m.topic + '（' + m.round + '）：新增 '
      + newNos.length + ' 篇（' + newNos[0] + '–' + newNos[newNos.length - 1] + '），分层笔记 '
      + new Set(layeredLibNos).size + ' 份');
    fs.writeFileSync(idxPath, idx.lines.join(idx.eol), 'utf8');
  }
  const wrote = actions.pdf + actions.md + actions.note > 0 || newRows.length > 0;
  if (wrote) {
    const newNos = papers.filter(p => !p._layered).map(p => p._libNo);
    writeChangelog(lib, [
      '## ' + today() + ' · ' + m.topic + ' · ' + m.round + ' 入库',
      '- 新增编号 ' + (newNos.length ? newNos[0] + '–' + newNos[newNos.length - 1] : '无') + '（' + newNos.length
        + ' 篇）：md ' + actions.md + '、pdf ' + actions.pdf + '、精读笔记 ' + actions.note,
      '- 分层精读笔记：' + (layeredLibNos.length ? [...new Set(layeredLibNos)].join('、') + '（编号已在库，笔记入归档\\）' : '无'),
      '- 补 PDF（原编号无 PDF）：' + (pdfBackfill.length ? pdfBackfill.join('、') : '无'),
      '- 无 PDF 新增编号：' + (noPdfNew.length ? noPdfNew.join('、') : '无'),
      '- 词表外主题标签：' + (offVocab.size ? [...offVocab].join('、') + '（SCHEMA §6 受控词表未覆盖，取自调研关键词）' : '无'),
    ]);
  }
  for (const w of warnings) console.log('⚠️ ' + w);
  const newNos = papers.filter(p => !p._layered).map(p => p._libNo);
  const summary = {
    ok: true, mode: 'round', round: m.round, topic: m.topic,
    newPapers: newNos.length, newNos,
    layeredLibNos: [...new Set(layeredLibNos)],
    pdfBackfillNos: pdfBackfill, noPdfNewNos: noPdfNew,
    filesCopied: actions, indexRowsAppended: newRows.length,
    changelog: wrote, offVocabTags: [...offVocab], warnings,
  };
  console.log('JSON_RESULT: ' + JSON.stringify(summary));
}

function runFinal(m) {
  const lib = m.libraryRoot;
  const idx = parseIndex(path.join(lib, '文献索引.md'));
  for (const k of ['topic', 'mdPath', 'htmlPath', 'map']) {
    if (!m[k]) fail('manifest 缺字段 ' + k);
  }
  if (!fs.existsSync(m.mdPath)) fail('最终回答 md 不存在：' + m.mdPath);
  if (!fs.existsSync(m.htmlPath)) fail('最终回答 html 不存在：' + m.htmlPath + '（终答硬闸门要求 md+html 同步入库）');
  const dir = path.join(lib, '最终回答汇总');
  if (!fs.existsSync(dir)) fail('目录缺失：' + dir);
  if (!Array.isArray(m.map) || !m.map.length) fail('map（轮内[n]→全库编号）不能为空');
  const rows = ['| 轮内引用 | 全库编号 | 标题 |', '|---|---|---|'];
  for (const e of m.map) {
    const libNo = String(e.libNo || '');
    if (!/^\d{3}$/.test(libNo) || !idx.nos.has(libNo)) {
      fail('map 引用了索引中不存在的编号：' + JSON.stringify(e));
    }
    rows.push('| [' + e.n + '] | ' + libNo + ' | ' + String(e.title || '').replace(/\|/g, '\\|') + ' |');
  }
  let maxNn = 0;
  for (const f of fs.readdirSync(dir)) {
    const mm = f.match(/^(\d{2})-/);
    if (mm) maxNn = Math.max(maxNn, parseInt(mm[1], 10));
  }
  const nn = String(maxNn + 1).padStart(2, '0');
  const base = safeName(m.topic);
  const mdRaw = fs.readFileSync(m.mdPath, 'utf8');
  const out = mdRaw.replace(/\s*$/, '') + '\n\n---\n\n## 轮内编号 → 全库编号映射（SCHEMA §9）\n\n' + rows.join('\n') + '\n';
  writeOrSkip(path.join(dir, nn + '-' + base + '.md'), out, '最终回答 md ');
  copyOrSkip(m.htmlPath, path.join(dir, nn + '-' + base + '.html'), '最终回答 html ');
  writeChangelog(lib, [
    '## ' + today() + ' · ' + m.topic + ' · 终答入库',
    '- 最终回答汇总\\' + nn + '-' + base + '.md（文末附轮内[n]→全库编号映射）+ .html',
    '- 映射覆盖轮内引用 ' + m.map.length + ' 条',
  ]);
  console.log('✅ 终答入库：' + nn + '-' + base + '.md/.html（映射 ' + m.map.length + ' 条）');
  console.log('JSON_RESULT: ' + JSON.stringify({ ok: true, mode: 'final', topic: m.topic, file: nn + '-' + base, mapEntries: m.map.length }));
}

const manifestPath = process.argv[2];
if (!manifestPath) fail('用法：node library_archive.js <manifest.json>');
let m;
try {
  m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail('manifest 读取/解析失败：' + e.message);
}
if (m.mode === 'final') runFinal(m);
else if (m.mode === 'round' && (m.round === 'r1' || m.round === 'r2')) runRound(m);
else fail('manifest.mode 须为 round（round=r1|r2）或 final');
