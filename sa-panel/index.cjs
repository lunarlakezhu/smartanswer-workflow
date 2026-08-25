'use strict'

/**
 * sa-panel host half：SmartAnswer 调研进度面板的数据后端。
 * 注册 /api/sa-panel HTTP 端点（client 同源 fetch）：
 *   list-topics 扫多个根（libraryRoot + extraRoots + 请求携带的会话 cwd）列出调研主题；
 *   state 返回一个主题的进度/磁盘计数/清单；
 *   get-models / set-models 读写 sa-models.json（子代理模型覆盖，面板写、agent 只读）；
 *   bind 读写 sa-panel-state.json（会话→主题持久绑定）。
 * 磁盘计数是唯一权威（SKILL 诚实条款），_progress.yaml 只取 stage/gates/元信息。
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  libraryRoot: 'E:\\Library-Manage\\raw-library\\HanaLibrary',
  presetPluginsDir: 'C:\\Users\\你的用户名\\.dsh\\.agent-presets\\smartanswer\\plugins',
  extraRoots: [],
}

// ---- 迷你 YAML 解析（只服务 _progress.yaml / round1_list.yaml 两个已知形态）----
// 优先用 yaml 包（harness 传递依赖可解析时），失败回退到这里。

function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i)
    }
  }
  return line
}

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return ''
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s)
  return s
}

function splitKeyValue(text) {
  // 返回 [key, rest]；rest 为空表示嵌套块
  const m = /^("[^"]*"|'[^']*'|[^:#]+?)\s*:(.*)$/.exec(text)
  if (!m) return null
  const key = parseScalar(m[1])
  return [key, m[2].trim()]
}

function parseMiniYaml(text) {
  let yamlParse = null
  try { yamlParse = require('yaml') } catch { /* 传递依赖不可达，用下面的手写解析 */ }
  if (yamlParse) {
    try { return yamlParse.parse(text) } catch { /* 格式异常回退手写 */ }
  }
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripComment(raw.replace(/\t/g, '  '))
    if (noComment.trim() === '') continue
    lines.push({ indent: noComment.match(/^ */)[0].length, text: noComment.trim() })
  }
  let pos = 0

  // 解析当前缩进层的一个块（列表或映射）；pos 停在本层结束处
  function parseBlock(indent) {
    const l = lines[pos]
    if (l && l.indent === indent && (l.text === '-' || l.text.startsWith('- '))) return parseList(indent)
    return parseMap(indent)
  }

  function parseList(indent) {
    const items = []
    while (pos < lines.length && lines[pos].indent === indent
      && (lines[pos].text === '-' || lines[pos].text.startsWith('- '))) {
      const rest = lines[pos].text === '-' ? '' : lines[pos].text.slice(2).trim()
      if (rest === '') {
        pos++
        if (pos < lines.length && lines[pos].indent > indent) items.push(parseBlock(lines[pos].indent))
        else items.push('')
      } else if (splitKeyValue(rest)) {
        // 对象列表项：首行键值对改写为与后续字段行对齐的缩进，并入同一映射流
        lines[pos] = { indent: indent + 2, text: rest }
        items.push(parseMap(indent + 2))
      } else {
        items.push(parseScalar(rest))
        pos++
      }
    }
    return items
  }

  function parseMap(indent) {
    const map = {}
    while (pos < lines.length && lines[pos].indent === indent
      && lines[pos].text !== '-' && !lines[pos].text.startsWith('- ')) {
      const kv = splitKeyValue(lines[pos].text)
      if (!kv) { pos++; continue }
      if (kv[1] === '') {
        if (pos + 1 < lines.length && lines[pos + 1].indent > indent) {
          pos++
          map[kv[0]] = parseBlock(lines[pos].indent)
        } else {
          map[kv[0]] = []
          pos++
        }
      } else {
        map[kv[0]] = parseScalar(kv[1])
        pos++
      }
    }
    return map
  }

  if (lines.length === 0) return {}
  return parseBlock(lines[0].indent)
}

// ---- 磁盘扫描 ----

function walkTopics(root) {
  const found = new Map() // dir -> {stage, topic, mtimeMs}
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith('_')) continue
        walk(full, depth + 1)
      } else if (ent.name === '_progress.yaml') {
        let stage = null
        let topic = null
        let mtimeMs = 0
        try {
          mtimeMs = fs.statSync(full).mtimeMs
          const text = fs.readFileSync(full, 'utf8')
          const doc = parseMiniYaml(text) || {}
          stage = typeof doc.stage === 'string' && doc.stage ? doc.stage : null
          topic = typeof doc.topic === 'string' && doc.topic ? doc.topic : null
        } catch { /* 不可读文件按无 progress 记录目录与 mtime */ }
        const dir2 = path.dirname(full)
        if (!found.has(dir2)) found.set(dir2, { stage, topic, mtimeMs })
      }
    }
  }
  walk(root, 0)
  // 老（无 _progress.yaml）主题：库根一级下含 r1 子目录的目录
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue
      const full = path.join(root, ent.name)
      if (found.has(full)) continue
      if (fs.existsSync(path.join(full, 'r1'))) {
        found.set(full, { stage: null, topic: null, mtimeMs: dirMtimeMs(full) })
      }
    }
  } catch { /* 根不可读时 walk 已返回空 */ }
  return found
}

function dirMtimeMs(dir) {
  try { return fs.statSync(dir).mtimeMs } catch { return 0 }
}

// ---- 多根扫描（2026-08-23 修复：主题存放位置是阶段 0 用户可选项，单扫 libraryRoot 会漏掉自定义位置）----

// Windows 大小写不敏感去重键：统一分隔符 + 小写 + 尾分隔符（同时让前缀包含判断带边界）
function rootKey(p) {
  let s = path.resolve(p).replace(/\//g, '\\').toLowerCase()
  if (!s.endsWith('\\')) s += '\\'
  return s
}

// 逐根复用 walkTopics，按主题目录去重合并（同主题被多个根覆盖时取先扫的根）
function scanRoots(roots) {
  const seenRoots = new Set()
  const found = new Map() // rootKey(主题目录) -> { dir, stage, topic, mtimeMs }
  for (const root of roots) {
    if (!root || typeof root !== 'string') continue
    const key = rootKey(root)
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    for (const [dir, info] of walkTopics(root)) {
      const dk = rootKey(dir)
      if (!found.has(dk)) found.set(dk, { dir, stage: info.stage, topic: info.topic, mtimeMs: info.mtimeMs })
    }
  }
  return found
}

function countByGlob(dir, pred) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && pred(e.name)).length
  } catch { return 0 }
}

function listByGlob(dir, pred) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && pred(e.name))
      .map((e) => e.name)
  } catch { return [] }
}

function artifactInfo(p) {
  try {
    const st = fs.statSync(p)
    return { path: p, mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }
}

// 归档计数：主题根与 r1\ 两处 r1-*.md 合并（按文件名去重）
function archivedCount(topicDir, round) {
  const rootHits = listByGlob(topicDir, (n) => n.startsWith(round + '-'))
  const inRound = listByGlob(path.join(topicDir, round), (n) => n.startsWith(round + '-'))
  return new Set(rootHits.concat(inRound)).size
}

function readAuditSummary(p) {
  try {
    const text = fs.readFileSync(p, 'utf8')
    const m = /##\s*审计概要\s*\n([\s\S]*?)(?=\n##\s|\n*$)/.exec(text)
    const section = m ? m[1].trim() : text.slice(0, 400)
    const stats = { ok: null, warn: null, review: null, none: null }
    const grab = (sym) => {
      const re = new RegExp(sym + '[^0-9\\n]*?(\\d+)')
      const r = re.exec(section)
      return r ? parseInt(r[1], 10) : null
    }
    stats.ok = grab('✅')
    stats.warn = grab('⚠️')
    stats.review = grab('🔄')
    stats.none = grab('🚫')
    const meaningful = stats.ok !== null || stats.warn !== null || stats.none !== null
    return { summary: section.slice(0, 400), stats: meaningful ? stats : null }
  } catch { return null }
}

function readRound1List(topicDir) {
  const p = path.join(topicDir, 'r1', 'round1_list.yaml')
  if (!fs.existsSync(p)) return { papers: [], listPath: null }
  const papers = []
  try {
    const doc = parseMiniYaml(fs.readFileSync(p, 'utf8')) || {}
    const sections = ['review', 'papers']
    for (const sec of sections) {
      const arr = Array.isArray(doc[sec]) ? doc[sec] : []
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue
        papers.push({
          section: sec,
          no: it.no ?? it.id ?? null,
          title: typeof it.title === 'string' ? it.title : '',
          year: it.year === undefined ? '' : String(it.year),
          journal: typeof it.journal === 'string' ? it.journal : '',
          doi: typeof it.doi === 'string' ? it.doi : '',
          note: typeof it.note === 'string' ? it.note : '',
          tag: typeof it.tag === 'string' ? it.tag : '',
          tier: typeof it.tier === 'string' ? it.tier : '',
          isReview: sec === 'review' || it.is_review === true || String(it.tag || '').includes('📖'),
        })
      }
    }
  } catch { /* 解析失败返回已收集部分 */ }
  return { papers, listPath: p }
}

// ---- 主题状态 ----

function opState(cfg, topicFolder) {
  if (!topicFolder || typeof topicFolder !== 'string') return { ok: false, error: '缺少 topicFolder' }
  const dir = topicFolder
  if (!fs.existsSync(dir)) return { ok: false, error: '主题目录不存在：' + dir }
  let progress = null
  let progressMtimeMs = null
  const pp = path.join(dir, '_progress.yaml')
  if (fs.existsSync(pp)) {
    progressMtimeMs = artifactInfo(pp)?.mtimeMs ?? null
    try {
      const doc = parseMiniYaml(fs.readFileSync(pp, 'utf8')) || {}
      const subQ = Array.isArray(doc.subQuestions) ? doc.subQuestions.filter((x) => typeof x === 'string') : []
      const kws = Array.isArray(doc.keywords) ? doc.keywords.filter((x) => typeof x === 'string') : []
      const r1 = doc.r1 && typeof doc.r1 === 'object' ? doc.r1 : {}
      const r2 = doc.r2 && typeof doc.r2 === 'object' ? doc.r2 : {}
      const gates = doc.gates && typeof doc.gates === 'object' ? doc.gates : {}
      progress = {
        topic: typeof doc.topic === 'string' ? doc.topic : path.basename(dir),
        stage: typeof doc.stage === 'string' && doc.stage ? doc.stage : null,
        scenario: typeof doc.scenario === 'string' ? doc.scenario : '',
        axis: typeof doc.axis === 'string' ? doc.axis : '',
        subQuestions: subQ,
        keywords: kws,
        r1: {
          papers: typeof r1.papers === 'number' ? r1.papers : 0,
          downloaded: typeof r1.downloaded === 'number' ? r1.downloaded : 0,
          archived: typeof r1.archived === 'number' ? r1.archived : 0,
          locked: r1.locked === true,
          forbidden: Array.isArray(r1.forbidden) ? r1.forbidden.length : 0,
        },
        r2: {
          papers: typeof r2.papers === 'number' ? r2.papers : 0,
          archived: typeof r2.archived === 'number' ? r2.archived : 0,
        },
        gates: {
          decompose: typeof gates.decompose === 'string' ? gates.decompose : '',
          edge_r1: typeof gates.edge_r1 === 'string' ? gates.edge_r1 : '',
          pdf_r1: typeof gates.pdf_r1 === 'string' ? gates.pdf_r1 : '',
          edge_r2: typeof gates.edge_r2 === 'string' ? gates.edge_r2 : '',
          pdf_r2: typeof gates.pdf_r2 === 'string' ? gates.pdf_r2 : '',
        },
      }
    } catch { /* 解析失败：progress 保持 null，磁盘计数照常 */ }
  }
  const r1Dir = path.join(dir, 'r1')
  const r2Dir = path.join(dir, 'r2')
  const { papers, listPath } = readRound1List(dir)
  const auditR1 = readAuditSummary(path.join(r1Dir, 'audit_report_r1.md'))
  const auditR2 = readAuditSummary(path.join(r2Dir, 'audit_report_r2.md'))
  return {
    ok: true,
    topicFolder: dir,
    topic: progress ? progress.topic : path.basename(dir),
    progress,
    progressMtimeMs,
    disk: {
      r1: {
        pdfs: countByGlob(r1Dir, (n) => n.toLowerCase().endsWith('.pdf')),
        texts: countByGlob(path.join(r1Dir, '_text'), (n) => n.toLowerCase().endsWith('.md')),
        archived: archivedCount(dir, 'r1'),
      },
      r2: {
        pdfs: countByGlob(r2Dir, (n) => n.toLowerCase().endsWith('.pdf')),
        texts: countByGlob(path.join(r2Dir, '_text'), (n) => n.toLowerCase().endsWith('.md')),
        archived: archivedCount(dir, 'r2'),
      },
    },
    artifacts: {
      round1List: artifactInfo(listPath || path.join(r1Dir, 'round1_list.yaml')),
      auditR1: artifactInfo(path.join(r1Dir, 'audit_report_r1.md')),
      auditR2: artifactInfo(path.join(r2Dir, 'audit_report_r2.md')),
      preliminary: artifactInfo(path.join(dir, '初步回答.md')),
      finalMd: artifactInfo(path.join(dir, '最终回答.md')),
      finalHtml: artifactInfo(path.join(dir, '最终回答.html')),
    },
    auditR1: auditR1 || null,
    auditR2: auditR2 || null,
    papers,
  }
}

// ---- 模型覆盖文件（sa-models.json：面板写，agent 只读）----

const ROLE_KEYS = new Set(['dualread.main', 'dualread.verify', 'dualread.arbitrate'])

function validateSelection(sel) {
  if (sel === null || sel === undefined) return {} // 清空覆盖
  if (typeof sel !== 'object' || Array.isArray(sel)) return { error: 'selection 必须是对象' }
  const out = {}
  for (const key of Object.keys(sel)) {
    if (key !== 'provider' && key !== 'model' && key !== 'roles') {
      return { error: '未知键 ' + key + '（只允许 provider/model/roles）' }
    }
  }
  for (const key of ['provider', 'model']) {
    const v = sel[key]
    if (v === undefined || v === '') continue
    if (typeof v !== 'string') return { error: key + ' 必须是非空字符串' }
    out[key] = v
  }
  if (sel.roles !== undefined) {
    if (typeof sel.roles !== 'object' || sel.roles === null || Array.isArray(sel.roles)) {
      return { error: 'roles 必须是对象' }
    }
    const roles = {}
    for (const rk of Object.keys(sel.roles)) {
      if (!ROLE_KEYS.has(rk)) return { error: 'roles 键 ' + rk + ' 不在允许列表（dualread.main|dualread.verify|dualread.arbitrate）' }
      const rv = sel.roles[rk]
      if (typeof rv !== 'object' || rv === null || Array.isArray(rv)) return { error: 'roles.' + rk + ' 必须是对象' }
      const role = {}
      for (const k2 of Object.keys(rv)) {
        if (k2 !== 'provider' && k2 !== 'model') return { error: 'roles.' + rk + ' 只允许 provider/model' }
      }
      for (const k2 of ['provider', 'model']) {
        const v2 = rv[k2]
        if (v2 === undefined || v2 === '') continue
        if (typeof v2 !== 'string') return { error: 'roles.' + rk + '.' + k2 + ' 必须是非空字符串' }
        role[k2] = v2
      }
      if (Object.keys(role).length > 0) roles[rk] = role
    }
    if (Object.keys(roles).length > 0) out.roles = roles
  }
  return { value: out }
}

function modelsPath(cfg) { return path.join(cfg.presetPluginsDir, 'sa-models.json') }
function bindingsPath(cfg) { return path.join(cfg.presetPluginsDir, 'sa-panel-state.json') }

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function opGetModels(cfg) {
  const p = modelsPath(cfg)
  const sel = readJson(p, null)
  return { ok: true, path: p, exists: fs.existsSync(p), selection: sel && typeof sel === 'object' ? sel : {} }
}

function opSetModels(cfg, selection) {
  const { value, error } = validateSelection(selection)
  if (error) return { ok: false, error }
  const p = modelsPath(cfg)
  writeJson(p, value)
  return { ok: true, path: p, selection: value }
}

// bind：{sessionId, topicFolder} 写映射并返回全量；{sessionId} 读单条；{} 返回全量
function opBind(cfg, payload) {
  const p = bindingsPath(cfg)
  const bindings = readJson(p, {})
  const map = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
  if (payload && typeof payload.sessionId === 'string' && payload.sessionId
    && payload.topicFolder !== undefined) {
    if (payload.topicFolder === null || payload.topicFolder === '') {
      delete map[payload.sessionId]
    } else if (typeof payload.topicFolder === 'string') {
      map[payload.sessionId] = payload.topicFolder
    } else {
      return { ok: false, error: 'topicFolder 必须是字符串或 null' }
    }
    writeJson(p, map)
  }
  if (payload && typeof payload.sessionId === 'string' && payload.sessionId) {
    return { ok: true, topicFolder: map[payload.sessionId] || null, bindings: map }
  }
  return { ok: true, bindings: map }
}

// ---- 插件主体 ----

module.exports = {
  name: 'sa-panel',
  inject: ['webServer'],
  apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) }

    const handlers = {
      'list-topics': (payload) => {
        // 扫描根 = 配置根（libraryRoot + extraRoots）+ 请求根（client 传会话 cwd）。
        // 阶段 0 允许用户任选存放位置，会话工作区是自定义位置的最常见落点。
        const roots = []
        const addRoot = (r) => {
          if (typeof r !== 'string' || !r.trim()) return
          const key = rootKey(r)
          if (!roots.some((x) => rootKey(x) === key)) roots.push(r)
        }
        addRoot(cfg.libraryRoot)
        for (const r of cfg.extraRoots || []) addRoot(r)
        for (const r of (payload && payload.roots) || []) addRoot(r)
        const found = scanRoots(roots)
        const topics = [...found.values()].map((t) => ({
          folder: t.dir,
          topic: t.topic || path.basename(t.dir),
          stage: t.stage,
          mtimeMs: t.mtimeMs,
        }))
        topics.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return { ok: true, roots, topics }
      },
      'state': (payload) => opState(cfg, payload && payload.topicFolder),
      'get-models': () => opGetModels(cfg),
      'set-models': (payload) => opSetModels(cfg, payload && payload.selection),
      'bind': (payload) => opBind(cfg, payload || {}),
    }

    const webServer = ctx.webServer
    ctx.effect(function () {
      return webServer.register({
        kind: 'exact',
        path: '/api/sa-panel',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }))
              return
            }
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const handler = handlers[data && data.op]
            const result = handler
              ? handler(data.payload || {})
              : { ok: false, error: 'unknown op: ' + String(data && data.op) }
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(result))
          } catch (err) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
          }
        },
      })
    }, 'sa-panel: route')
    console.log('[sa-panel] HTTP route /api/sa-panel registered (libraryRoot=' + cfg.libraryRoot + ')')
  },
}
