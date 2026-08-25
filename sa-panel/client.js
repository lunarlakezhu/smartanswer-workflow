/* sa-panel client half：SmartAnswer 调研进度面板。
   模块格式与 web 插件一致（window.__ModuleLoader__.load），React/slots/layout/connection
   通过 require 从 shell 加载。三个 slot 注入：
   - details（priority -1 遮蔽 ui-conversation 的 priority 0，lowest renders）
   - conversation.session.header.actions（「📊 调研进度」按钮，仅 smartanswer 会话）
   - conversation.input.dock（隐藏桥：拿 sessionId + inputActions.setDraft，闸门/产物按钮填话术）
   数据：磁盘扫描（/api/sa-panel 轮询，权威）+ ConversationSnapshot（实时活动）。 */

window.__ModuleLoader__.load({
  id: 'sa-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement
    var useEffect = react.useEffect
    var useState = react.useState
    var useRef = react.useRef
    var useMemo = react.useMemo

    // ---- stage→步骤映射（集中一处；stage 值是「下一步」语义：SKILL 在闸门确认后写下一阶段值）----
    var STAGE_RANK = { boot: 0, decompose: 0, search: 1, match: 2, download: 3, dualread: 4, audit: 5, snowball: 6, final: 7 }
    var STAGE_LABEL = {
      boot: '拆解中', decompose: '拆解中', search: '检索中', match: '匹配中', download: '下载中',
      dualread: '双读中', audit: '审计中', snowball: '雪球R2', final: '终答',
    }
    // 步骤 idx 1..8 的 rank；idx 0 启动特殊（stage 非 null 即完成）。
    // gates 覆盖 SKILL 全部五个人工闸门：decompose/edge_r1/edge_r2 的过闸值是
    // confirmed/approved；pdf_r1/pdf_r2（下载完成确认硬闸门）走 awaiting → confirmed。
    var STEPS = [
      { label: '启动', rank: -1 },
      { label: '拆解', rank: 0, gates: [
        { key: 'decompose', label: '确认拆解', confirm: 'confirmed' },
      ] },
      { label: '检索验身', rank: 1 },
      { label: '匹配', rank: 2 },
      { label: '下载转换', rank: 3, gates: [
        { key: 'edge_r1', label: '放行 Edge', confirm: 'approved' },
        { key: 'pdf_r1', label: 'R1 下载完成确认', confirm: 'confirmed' },
      ] },
      { label: '双读', rank: 4 },
      { label: '审计', rank: 5 },
      { label: 'R2 雪球', rank: 6, gates: [
        { key: 'edge_r2', label: '放行 Edge', confirm: 'approved' },
        { key: 'pdf_r2', label: 'R2 下载完成确认', confirm: 'confirmed' },
      ] },
      { label: '终答', rank: 7 },
    ]

    var GATE_PROMPTS = {
      decompose: '确认拆解：同意当前的问题拆解、场景判别与归纳轴，请展开关键词并进入检索阶段。',
      edge_r1: '同意放行 Edge：请批量打开 R1 需下载文献的 DOI 页面，我把 PDF 下载到 r1 目录后告诉你。',
      pdf_r1: 'R1 下载完成确认：r1 目录 PDF 已到账（部分就绪请说明数量与缺失 DOI），请磁盘计数复核后继续。',
      edge_r2: '同意放行 Edge：请批量打开 R2 雪球候选文献的 DOI 页面，我把 PDF 下载到 r2 目录后告诉你。',
      pdf_r2: 'R2 下载完成确认：r2 目录 PDF 已到账（部分就绪请说明数量与缺失 DOI），请磁盘计数复核后继续。',
    }

    function fmtTime(ms) {
      if (!ms) return ''
      try {
        var d = new Date(ms)
        var p = function (n) { return (n < 10 ? '0' : '') + n }
        return d.getMonth() + 1 + '-' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return '' }
    }

    // ---- 子区块组件 ----

    function SaSteps(props) {
      var stage = props.stage
      var finalDone = props.finalDone
      var rank = stage && STAGE_RANK[stage] !== undefined ? STAGE_RANK[stage] : null
      return h('div', { className: 'sap-steps' },
        STEPS.map(function (step, i) {
          var state
          if (rank === null) state = 'unknown'
          else if (i === 0) state = 'done'
          else if (i === STEPS.length - 1) state = finalDone ? 'done' : (rank >= step.rank ? 'active' : 'todo')
          else if (rank > step.rank) state = 'done'
          else if (rank === step.rank) state = 'active'
          else state = 'todo'
          var title = step.gates
            ? step.label + '（★闸门：' + step.gates.map(function (g) { return g.label }).join(' / ') + '）'
            : step.label
          return h('div', { key: i, className: 'sap-step ' + state, title: title },
            h('span', { className: 'sap-step-dot' }, i),
            h('span', { className: 'sap-step-label' }, step.gates ? step.label + '★' : step.label),
          )
        }),
      )
    }

    function SaGates(props) {
      var progress = props.progress
      var onGate = props.onGate
      var rank = progress && progress.stage && STAGE_RANK[progress.stage] !== undefined ? STAGE_RANK[progress.stage] : null
      if (!progress) {
        return h('div', { className: 'sap-hint' }, '无 _progress.yaml（旧版主题或尚未启动调研）')
      }
      var gates = progress.gates || {}
      var cards = []
      for (var i = 0; i < STEPS.length; i++) {
        var step = STEPS[i]
        if (!step.gates) continue
        for (var gi = 0; gi < step.gates.length; gi++) {
          var gd = step.gates[gi]
          var val = gates[gd.key] || ''
          if (val === gd.confirm) continue // 已过闸
          // awaiting = agent 正停在等用户：无论 stage 走到哪都必须可见（SKILL「等用户期间保持 awaiting 可见」条款）；
          // 其余未过闸值只在流程到达该步骤 rank 后提示
          var awaiting = val === 'awaiting'
          if (!awaiting && (rank === null || rank < step.rank)) continue
          cards.push(h('div', { key: gd.key, className: awaiting ? 'sap-gate awaiting' : 'sap-gate' },
            h('div', { className: 'sap-gate-title' }, '★ ' + gd.label + (awaiting ? '（等待你的确认）' : '（需要确认）')),
            h('button', {
              className: 'sap-btn primary',
              onClick: (function (k) { return function () { onGate(k) } })(gd.key),
            }, val ? '再次发送确认话术' : gd.label),
          ))
        }
      }
      if (cards.length === 0) return null
      return h('div', { className: 'sap-gates' }, cards)
    }

    function countLine(label, disk, cfgCount) {
      return h('span', { className: 'sap-count-item' },
        h('b', null, String(disk)),
        ' ' + label,
        cfgCount !== undefined && cfgCount !== null && cfgCount !== disk
          ? h('span', { className: 'sap-count-diff', title: '_progress.yaml 记载 ' + cfgCount + '（面板以磁盘为准）' }, '/' + cfgCount)
          : null,
      )
    }

    function SaCounts(props) {
      var state = props.state
      var disk = state.disk || {}
      var r1 = disk.r1 || {}
      var r2 = disk.r2 || {}
      var prog = state.progress
      var audits = []
      if (state.auditR1 && state.auditR1.stats) audits.push(renderAudit('R1', state.auditR1.stats))
      if (state.auditR2 && state.auditR2.stats) audits.push(renderAudit('R2', state.auditR2.stats))
      return h('div', { className: 'sap-card' },
        h('div', { className: 'sap-card-title' }, '磁盘计数（权威）'),
        h('div', { className: 'sap-count-row' },
          h('span', { className: 'sap-round-tag' }, 'R1'),
          countLine('归档', r1.archived, prog && prog.r1 ? prog.r1.archived : undefined),
          countLine('PDF', r1.pdfs, prog && prog.r1 ? prog.r1.downloaded : undefined),
          countLine('转换md', r1.texts),
        ),
        h('div', { className: 'sap-count-row' },
          h('span', { className: 'sap-round-tag' }, 'R2'),
          countLine('归档', r2.archived, prog && prog.r2 ? prog.r2.archived : undefined),
          countLine('PDF', r2.pdfs),
          countLine('转换md', r2.texts),
        ),
        audits.length > 0 ? h('div', { className: 'sap-audit-line' }, audits) : null,
      )
    }

    function renderAudit(round, stats) {
      return h('span', { key: round, className: 'sap-audit', title: round + ' 审计统计' },
        round + ' 审计：✅' + stats.ok + ' ⚠️' + (stats.warn || 0) + ' 🔄' + (stats.review || 0) + ' 🚫' + (stats.none || 0),
      )
    }

    var OUTCOME_ICON = { completed: '✅', failed: '❌', cancelled: '⏹', interrupted: '⛔', running: '▶' }

    function SaActivity(props) {
      var snap = props.snap
      var runs = []
      var calls = []
      if (snap) {
        try {
          var nodes = snap.chat && snap.chat.nodes
          if (nodes) {
            var it = nodes.values()
            for (var n = it.next(); !n.done; n = it.next()) {
              var node = n.value
              if (node && node.kind === 'workflow-run' && node.data) runs.push(node.data)
            }
          }
        } catch (e) { /* 快照结构异常时实时区退化为 runningCalls */ }
        calls = snap.runningCalls || []
      }
      var recent = runs.slice(-2).reverse()
      return h('div', { className: 'sap-card' },
        h('div', { className: 'sap-card-title' }, '当前活动（实时）'),
        recent.length === 0 && calls.length === 0
          ? h('div', { className: 'sap-hint' }, snap && snap.running ? '会话运行中（无 workflow 活动）' : '空闲')
          : null,
        recent.map(function (run, ri) {
          return h('div', { key: ri, className: 'sap-run' },
            h('div', { className: 'sap-run-head' },
              h('span', { className: 'sap-run-name' }, run.name || 'workflow'),
              h('span', { className: 'sap-run-status ' + (run.status || '') }, run.status === 'running' ? '运行中' : (run.status || '')),
            ),
            (run.phases || []).map(function (ph, pi) {
              return h('div', { key: pi, className: 'sap-phase' },
                h('div', { className: 'sap-phase-name' }, ph.phase === null ? '（未命名阶段）' : ph.phase),
                h('div', { className: 'sap-members' },
                  (ph.members || []).map(function (m, mi) {
                    return h('span', {
                      key: mi,
                      className: 'sap-member ' + (m.status === 'running' ? 'running' : m.status),
                      title: m.label + ' · ' + m.status,
                    }, (OUTCOME_ICON[m.status] || '·') + ' ' + m.label)
                  }),
                ),
              )
            }),
          )
        }),
        calls.length > 0
          ? h('div', { className: 'sap-calls' },
            calls.map(function (c, ci) {
              return h('div', { key: ci, className: 'sap-call', title: c.argsRaw || '' },
                '🔧 ' + c.name,
              )
            }),
          )
          : null,
      )
    }

    function SaPapers(props) {
      var papers = props.papers || []
      if (papers.length === 0) return null
      return h('details', { className: 'sap-papers' },
        h('summary', null, '论文清单（' + papers.length + ' 条）'),
        h('table', { className: 'sap-table' },
          h('thead', null, h('tr', null,
            h('th', null, '编号'), h('th', null, '标题'), h('th', null, '期刊'),
            h('th', null, '年份'), h('th', null, '标记'),
          )),
          h('tbody', null, papers.map(function (p, i) {
            return h('tr', { key: i },
              h('td', null, String(p.no || '')),
              h('td', { title: p.note || '' }, p.title || ''),
              h('td', null, p.journal || ''),
              h('td', null, String(p.year || '')),
              h('td', null, (p.isReview ? '📖' : '') + (p.tier ? ' ' + p.tier : '')),
            )
          })),
        ),
      )
    }

    var ROLE_DEFS = [
      { key: 'dualread.main', label: '双读·主读' },
      { key: 'dualread.verify', label: '双读·验证读' },
      { key: 'dualread.arbitrate', label: '双读·仲裁' },
    ]

    function SaModels(props) {
      var sessionId = props.sessionId
      var api = props.api
      var rpc = props.rpc
      var catalogSt = useState(null) // {current, groups}
      var catalog = catalogSt[0], setCatalog = catalogSt[1]
      var catErrSt = useState('')
      var catErr = catErrSt[0], setCatErr = catErrSt[1]
      var subSt = useState(null) // sa-models.json 当前内容
      var sub = subSt[0], setSub = subSt[1]
      var formSt = useState({ provider: '', model: '', roles: { 'dualread.main': '', 'dualread.verify': '', 'dualread.arbitrate': '' } })
      var form = formSt[0], setForm = formSt[1]
      var saveMsgSt = useState('')
      var saveMsg = saveMsgSt[0], setSaveMsg = saveMsgSt[1]
      var expandedSt = useState(false)
      var expanded = expandedSt[0], setExpanded = expandedSt[1]

      useEffect(function () {
        var stop = false
        if (!api || !api.sessions) return
        api.sessions.models({ sessionId: sessionId }).then(function (resp) {
          if (stop) return
          if (resp && resp.result && resp.result.ok) setCatalog(resp.result.value)
          else setCatErr('session.models 失败：' + (resp && resp.result && resp.result.error ? resp.result.error.code : 'unknown'))
        }).catch(function (err) { if (!stop) setCatErr(String(err && err.message ? err.message : err)) })
        rpc('get-models').then(function (r) {
          if (stop || !r || !r.ok) return
          setSub(r.selection || {})
          var roles = r.selection && r.selection.roles ? r.selection.roles : {}
          setForm({
            provider: (r.selection && r.selection.provider) || '',
            model: (r.selection && r.selection.model) || '',
            roles: {
              'dualread.main': roleToText(roles['dualread.main']),
              'dualread.verify': roleToText(roles['dualread.verify']),
              'dualread.arbitrate': roleToText(roles['dualread.arbitrate']),
            },
          })
        })
        return function () { stop = true }
      }, [sessionId])

      function roleToText(role) {
        if (!role) return ''
        return (role.model || '') + (role.provider ? ' @' + role.provider : '')
      }

      function pickMain(e) {
        var v = e.target.value
        if (!v || !api || !api.sessions) return
        var sep = v.indexOf('||')
        var provider = v.slice(0, sep)
        var model = v.slice(sep + 2)
        api.sessions.selectModel({ sessionId: sessionId, provider: provider, model: model })
          .then(function (resp) {
            if (resp && resp.result && resp.result.ok) {
              setCatalog(function (c) { return c ? { current: resp.result.value.selected, groups: c.groups } : c })
              setCatErr('')
            } else {
              setCatErr('切换失败：' + (resp && resp.result && resp.result.error ? resp.result.error.code + ' ' + resp.result.error.message : 'unknown'))
            }
          }).catch(function (err) { setCatErr(String(err && err.message ? err.message : err)) })
      }

      async function saveSub() {
        var selection = {}
        if (form.provider) selection.provider = form.provider
        if (form.model) selection.model = form.model
        var roles = {}
        for (var i = 0; i < ROLE_DEFS.length; i++) {
          var rd = ROLE_DEFS[i]
          var text = (form.roles[rd.key] || '').trim()
          if (!text) continue
          var role = {}
          var at = text.indexOf('@')
          if (at >= 0) {
            var m = text.slice(0, at).trim()
            var p = text.slice(at + 1).trim()
            if (m) role.model = m
            if (p) role.provider = p
          } else {
            role.model = text
          }
          if (role.model || role.provider) roles[rd.key] = role
        }
        if (Object.keys(roles).length > 0) selection.roles = roles
        var r = await rpc('set-models', { selection: selection })
        if (r && r.ok) {
          setSub(r.selection || {})
          setSaveMsg('已保存（下次 workflow 调用生效）')
        } else {
          setSaveMsg('保存失败：' + (r && r.error ? r.error : 'unknown'))
        }
      }

      var current = catalog && catalog.current
      var currentText = current ? (current.model + ' @' + current.provider) : '…'
      var subActive = !!(sub && (sub.model || sub.provider || sub.roles))
      return h('div', { className: 'sap-card' },
        h('div', { className: 'sap-card-title' },
          '模型设置',
          h('button', { className: 'sap-link', onClick: function () { setExpanded(!expanded) } }, expanded ? '收起' : '展开'),
        ),
        h('div', { className: 'sap-model-row' },
          h('span', { className: 'sap-model-label' }, '主 agent：'),
          catalog && catalog.groups && catalog.groups.length > 0
            ? h('select', {
              className: 'sap-select',
              value: current ? current.provider + '||' + current.model : '',
              onChange: pickMain,
              title: 'session.selectModel 直切（立即生效）',
            },
              !current ? h('option', { value: '' }, '…') : null,
              catalog.groups.map(function (g, gi) {
                return h('optgroup', { key: gi, label: g.name || g.id },
                  (g.models || []).map(function (m, mi) {
                    return h('option', { key: mi, value: g.id + '||' + m.id }, m.name || m.id)
                  }),
                )
              }),
            )
            : h('span', { className: 'sap-model-current' }, currentText),
          catErr ? h('span', { className: 'sap-err' }, catErr) : null,
        ),
        expanded ? h('div', { className: 'sap-submodels' },
          h('div', { className: 'sap-hint' },
            '子代理模型覆盖写入 sa-models.json（面板写、agent 只读；下次 workflow 调用前由主 agent 注入 args）。',
            subActive ? ' 当前：已有覆盖。' : ' 当前：未覆盖（用预设默认）。',
          ),
          h('div', { className: 'sap-model-row' },
            h('span', { className: 'sap-model-label' }, '默认：'),
            h('input', {
              className: 'sap-input', placeholder: 'model（如 deepseek-v4-pro）', value: form.model,
              onChange: function (e) { setForm(function (f) { return { provider: f.provider, model: e.target.value, roles: f.roles } }) },
            }),
            h('input', {
              className: 'sap-input', placeholder: 'provider（可选）', value: form.provider,
              onChange: function (e) { setForm(function (f) { return { provider: e.target.value, model: f.model, roles: f.roles } }) },
            }),
          ),
          ROLE_DEFS.map(function (rd) {
            return h('div', { key: rd.key, className: 'sap-model-row' },
              h('span', { className: 'sap-model-label' }, rd.label + '：'),
              h('input', {
                className: 'sap-input', placeholder: 'model @provider（留空继承默认）',
                value: form.roles[rd.key] || '',
                onChange: (function (k) {
                  return function (e) {
                    setForm(function (f) {
                      var roles = {}
                      for (var kk in f.roles) roles[kk] = f.roles[kk]
                      roles[k] = e.target.value
                      return { provider: f.provider, model: f.model, roles: roles }
                    })
                  }
                })(rd.key),
              }),
            )
          }),
          h('div', { className: 'sap-model-row' },
            h('button', { className: 'sap-btn', onClick: saveSub }, '保存子代理覆盖'),
            saveMsg ? h('span', { className: 'sap-save-msg' }, saveMsg) : null,
          ),
        ) : null,
      )
    }

    var ARTIFACT_DEFS = [
      { key: 'finalHtml', label: '最终回答.html' },
      { key: 'finalMd', label: '最终回答.md' },
      { key: 'preliminary', label: '初步回答.md' },
      { key: 'auditR1', label: 'R1 审计报告' },
      { key: 'auditR2', label: 'R2 审计报告' },
    ]

    function SaArtifacts(props) {
      var artifacts = props.artifacts || {}
      var onFill = props.onFill
      var rows = ARTIFACT_DEFS.filter(function (d) { return artifacts[d.key] })
      if (rows.length === 0) return null
      return h('div', { className: 'sap-card' },
        h('div', { className: 'sap-card-title' }, '产物'),
        rows.map(function (d) {
          var info = artifacts[d.key]
          return h('div', { key: d.key, className: 'sap-artifact' },
            h('span', { className: 'sap-artifact-label' }, d.label),
            h('span', { className: 'sap-artifact-time' }, fmtTime(info.mtimeMs)),
            h('button', {
              className: 'sap-link',
              title: info.path,
              onClick: function () { onFill(info.path) },
            }, '路径填入输入框'),
          )
        }),
      )
    }

    // ---- 主面板 ----

    // Windows 路径比较：统一分隔符 + 小写 + 尾分隔符（尾分隔符让前缀包含自带目录边界，
    // E:\foo 不会匹配 E:\foobar）
    function normFolder(p) {
      var s = String(p || '').replace(/\//g, '\\').toLowerCase()
      if (!s.endsWith('\\')) s += '\\'
      return s
    }
    function sameFolder(a, b) { return normFolder(a) === normFolder(b) }
    function folderRelated(a, b) {
      var x = normFolder(a)
      var y = normFolder(b)
      return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0
    }
    function baseName(p) {
      var s = String(p || '').replace(/[\\/]+$/, '')
      var at = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
      return at >= 0 ? s.slice(at + 1) : s
    }

    function SaPanel(props) {
      var sessionId = props.sessionId
      var useSessions = props.useSessions
      var useSession = props.useSession
      var summary = useSessions(function (s) { return (s.byId || {})[sessionId] })
      var preset = summary && summary.agentPreset
      var snap = useSession(function (s) { return s })

      var topicsSt = useState(null) // null=未加载 []=空
      var topics = topicsSt[0], setTopics = topicsSt[1]
      var topicSt = useState(null) // 当前 topicFolder
      var topicFolder = topicSt[0], setTopicFolder = topicSt[1]
      var stateSt = useState(null)
      var state = stateSt[0], setState = stateSt[1]
      var errSt = useState('')
      var err = errSt[0], setErr = errSt[1]
      var summaryRef = useRef(summary)
      summaryRef.current = summary

      var rpc = props.rpc
      var layout = props.layout

      // 会话→主题绑定解析：持久绑定 → 全库最新进行中主题 → 会话工作区内主题 → 全库最新。
      // 解析成功即写回 bind 持久化（旧版只写手动选择，自动解析每次重开都重新猜错）。
      // 进行中全局优先：主题存放位置是阶段 0 可选项（工作区/任一库根），而工作区内可能残留
      // 上一场实验的未终答主题（cwd 启发式会押错）；_progress.yaml 的 mtime 只随 workflow
      // 推进而变化，最新进行中 ≈ 当前会话正在跑的主题。
      useEffect(function () {
        if (preset !== 'smartanswer') return
        var stop = false
        ;(async function () {
          try {
            var cwd = summaryRef.current && summaryRef.current.cwd
            var lt = await rpc('list-topics', { roots: cwd ? [cwd] : [] })
            if (stop) return
            if (!lt || !lt.ok) { setErr((lt && lt.error) || 'list-topics 失败'); return }
            var all = lt.topics || []
            var bd = await rpc('bind', { sessionId: sessionId })
            if (stop) return
            var bound = bd && bd.ok ? bd.topicFolder : null
            // 持久绑定优先（用户显式选择过）；即便当前扫描根未覆盖也保留（自定义库根可能换过），
            // 目录真没了由 state 轮询显式报错，不静默改绑
            var folder = bound || null
            if (!folder) {
              var live = []
              for (var j = 0; j < all.length; j++) {
                if (all[j].stage && all[j].stage !== 'final') live.push(all[j])
              }
              // list-topics 已按 mtime 降序返回，过滤保序，取 [0] 即候选池中最新的进行中主题
              var pool = live
              if (pool.length === 0) {
                var rel = cwd ? all.filter(function (t) { return folderRelated(t.folder, cwd) }) : []
                pool = rel.length > 0 ? rel : all
              }
              folder = pool[0] ? pool[0].folder : null
            }
            if (folder && !all.some(function (t) { return sameFolder(t.folder, folder) })) {
              all = all.concat([{ folder: folder, topic: baseName(folder), stage: null, mtimeMs: 0 }])
            }
            if (stop) return
            setTopics(all)
            setTopicFolder(folder)
            setErr('')
            if (folder) rpc('bind', { sessionId: sessionId, topicFolder: folder }).catch(function () { /* 持久化失败不打断展示 */ })
          } catch (e) {
            if (!stop) setErr(String(e && e.message ? e.message : e))
          }
        })()
        return function () { stop = true }
      }, [sessionId, preset])

      // state 轮询：会话运行 4s、空闲 30s；组件卸载清除
      var running = !!(snap && snap.running)
      useEffect(function () {
        if (preset !== 'smartanswer' || !topicFolder) return
        var stop = false
        var timer = null
        var tick = async function () {
          try {
            var r = await rpc('state', { topicFolder: topicFolder })
            if (stop) return
            if (r && r.ok) { setState(r); setErr('') } else setErr((r && r.error) || 'state 失败')
          } catch (e) {
            if (!stop) setErr(String(e && e.message ? e.message : e))
          }
          if (!stop) timer = setTimeout(tick, running ? 4000 : 30000)
        }
        tick()
        return function () { stop = true; if (timer) clearTimeout(timer) }
      }, [sessionId, preset, topicFolder, running])

      if (preset !== 'smartanswer') return null

      var progress = state && state.progress
      var stage = progress ? progress.stage : null
      var finalDone = !!(state && state.artifacts && state.artifacts.finalHtml)
      var stageBadge = state === null ? '…' : (stage ? (STAGE_LABEL[stage] || stage) : '旧主题')

      function pickTopic(e) {
        var v = e.target.value
        var folder = v || null
        setTopicFolder(folder)
        setState(null)
        if (folder) rpc('bind', { sessionId: sessionId, topicFolder: folder })
        else rpc('bind', { sessionId: sessionId, topicFolder: null })
      }

      function onGate(key) {
        var text = GATE_PROMPTS[key]
        var bridge = props.getBridge && props.getBridge()
        if (bridge && bridge.setDraft) bridge.setDraft(text)
        else setErr('输入框未就绪（需要打开会话）')
      }

      function fillPath(path) {
        var bridge = props.getBridge && props.getBridge()
        if (bridge && bridge.setDraft) {
          var cur = bridge.draft || ''
          bridge.setDraft(cur ? cur + '\n' + path : path)
        } else setErr('输入框未就绪（需要打开会话）')
      }

      return h('div', { className: 'sap-root' },
        h('div', { className: 'sap-header' },
          h('span', { className: 'sap-topic', title: topicFolder || '' }, state ? state.topic : (topicFolder || '未绑定主题')),
          h('span', { className: 'sap-badge' }, stageBadge),
          topics && topics.length > 0
            ? h('select', {
              className: 'sap-select sap-topic-select',
              value: topicFolder || '',
              onChange: pickTopic,
              title: '纠正会话↔主题绑定（选择即持久化）。自动解析顺序：持久绑定 → 全库最新进行中主题 → 会话工作区内主题 → 全库最新',
            },
              h('option', { value: '' }, '（未绑定）'),
              topics.map(function (t, i) {
                return h('option', { key: i, value: t.folder }, t.topic + (t.stage ? ' · ' + t.stage : ''))
              }),
            )
            : null,
          h('button', { className: 'sap-btn', onClick: function () { layout && layout.closeDetails() } }, '关闭'),
        ),
        err ? h('div', { className: 'sap-error' }, err) : null,
        // 子组件一律经 h() 变成元素：内联函数调用会把子组件的 hooks 计入本组件渲染，
        // 预设翻转（standard→smartanswer）时 hooks 数 9↔15 变化触发 React 违规 → details 槽退位 → 原生空面板
        h(SaSteps, { stage: stage, finalDone: finalDone }),
        h(SaGates, { progress: progress, onGate: onGate }),
        state ? h(SaCounts, { state: state }) : h('div', { className: 'sap-hint' }, topicFolder ? '读取中…' : '未找到调研主题（扫描：会话工作区 + 配置的文献库根）'),
        h(SaActivity, { snap: snap }),
        h(SaPapers, { papers: state && state.papers }),
        h(SaModels, { sessionId: sessionId, api: props.api, rpc: rpc }),
        state ? h(SaArtifacts, { artifacts: state.artifacts, onFill: fillPath }) : null,
      )
    }

    function SaHeaderButton(props) {
      var summary = props.useSessions(function (s) { return (s.byId || {})[props.sessionId] })
      if (!summary || summary.agentPreset !== 'smartanswer') return null
      return h('button', {
        className: 'sap-header-btn',
        onClick: function () { props.layout && props.layout.openDetails() },
        title: '打开 SmartAnswer 调研进度面板',
      }, '📊 调研进度')
    }

    function HiddenBridge(props) {
      useEffect(function () {
        var shared = props.shared
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
          shared.bridge = {
            draft: props.input && typeof props.input.draft === 'string' ? props.input.draft : '',
            setDraft: props.inputActions.setDraft,
          }
        }
        if (props.sessionId) shared.sessionId = props.sessionId
      })
      return h('div', { style: { display: 'none' } })
    }

    // ---- CSS ----

    var CSS =
      '.sap-root{display:flex;flex-direction:column;height:100%;overflow-y:auto;gap:10px;padding:12px;' +
      'color:var(--dsw-alias-label-primary,#e8e9ec);font-size:13px;background:var(--dsw-alias-bg-base,#16181d);}' +
      '.sap-root *{box-sizing:border-box;}' +
      '.sap-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
      '.sap-topic{font-weight:600;font-size:14px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.sap-badge{flex-shrink:0;padding:2px 8px;border-radius:999px;font-size:11px;' +
      'border:1px solid var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff);}' +
      '.sap-topic-select{max-width:180px;}' +
      '.sap-select,select.sap-select{background:var(--dsw-alias-bg-layer-1,#1c1e23);' +
      'color:var(--dsw-alias-label-primary,#e8e9ec);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));' +
      'border-radius:6px;padding:3px 6px;font-size:12px;max-width:100%;}' +
      '.sap-steps{display:flex;flex-wrap:wrap;gap:6px;}' +
      '.sap-step{display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;font-size:11px;' +
      'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-step-dot{width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;' +
      'font-size:9px;background:rgba(128,128,128,.25);}' +
      '.sap-step.done{border-color:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950);}' +
      '.sap-step.done .sap-step-dot{background:var(--dsw-alias-state-success-primary,#3fb950);color:#0b0e13;}' +
      '.sap-step.active{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff);}' +
      '.sap-step.active .sap-step-dot{background:var(--dsw-alias-brand-primary,#4f8cff);color:#0b0e13;}' +
      '.sap-step.unknown{opacity:.55;}' +
      '.sap-gates{display:flex;flex-direction:column;gap:8px;}' +
      '.sap-gate{padding:10px;border-radius:10px;border:1.5px solid var(--dsw-alias-state-warn-primary,#d29922);' +
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d29922) 8%,transparent);display:flex;' +
      'align-items:center;gap:10px;flex-wrap:wrap;}' +
      '.sap-gate-title{flex:1;font-size:12px;color:var(--dsw-alias-state-warn-primary,#d29922);}' +
      '.sap-gate.awaiting{border-width:2px;box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d29922) 35%,transparent);}' +
      '.sap-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:10px;padding:10px;' +
      'display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1e23) 55%,transparent);}' +
      '.sap-card-title{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px;}' +
      '.sap-count-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}' +
      '.sap-round-tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;' +
      'background:rgba(128,128,128,.2);flex-shrink:0;}' +
      '.sap-count-item{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-count-item b{color:var(--dsw-alias-label-primary,#e8e9ec);font-size:13px;}' +
      '.sap-count-diff{color:var(--dsw-alias-state-warn-primary,#d29922);font-size:10px;margin-left:2px;}' +
      '.sap-audit-line{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-run{display:flex;flex-direction:column;gap:6px;}' +
      '.sap-run-head{display:flex;align-items:center;gap:8px;}' +
      '.sap-run-name{font-weight:600;font-size:12px;}' +
      '.sap-run-status{font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid rgba(128,128,128,.3);}' +
      '.sap-run-status.running{color:var(--dsw-alias-brand-primary,#4f8cff);border-color:var(--dsw-alias-brand-primary,#4f8cff);}' +
      '.sap-run-status.completed{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:var(--dsw-alias-state-success-primary,#3fb950);}' +
      '.sap-run-status.failed{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:var(--dsw-alias-state-error-primary,#e5534b);}' +
      '.sap-phase{display:flex;flex-direction:column;gap:4px;}' +
      '.sap-phase-name{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-members{display:flex;flex-wrap:wrap;gap:4px;}' +
      '.sap-member{font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid rgba(128,128,128,.25);' +
      'max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-member.running{color:var(--dsw-alias-brand-primary,#4f8cff);border-color:var(--dsw-alias-brand-primary,#4f8cff);}' +
      '.sap-member.completed{color:var(--dsw-alias-state-success-primary,#3fb950);}' +
      '.sap-member.failed{color:var(--dsw-alias-state-error-primary,#e5534b);}' +
      '.sap-calls{display:flex;flex-direction:column;gap:3px;}' +
      '.sap-call{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9ca3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.sap-papers{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:10px;padding:8px 10px;}' +
      '.sap-papers summary{cursor:pointer;font-weight:600;font-size:12px;}' +
      '.sap-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;}' +
      '.sap-table th{text-align:left;color:var(--dsw-alias-label-secondary,#9a9ca3);font-weight:600;padding:3px 6px;' +
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));}' +
      '.sap-table td{padding:3px 6px;vertical-align:top;border-bottom:1px solid rgba(128,128,128,.08);}' +
      '.sap-table td:nth-child(2){max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.sap-model-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
      '.sap-model-label{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9ca3);flex-shrink:0;}' +
      '.sap-model-current{font-size:12px;}' +
      '.sap-input{background:var(--dsw-alias-bg-layer-1,#1c1e23);color:var(--dsw-alias-label-primary,#e8e9ec);' +
      'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:6px;padding:3px 8px;font-size:12px;}' +
      '.sap-submodels{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));padding-top:8px;}' +
      '.sap-err{color:var(--dsw-alias-state-error-primary,#e5534b);font-size:11px;}' +
      '.sap-save-msg{font-size:11px;color:var(--dsw-alias-state-success-primary,#3fb950);}' +
      '.sap-artifact{display:flex;align-items:center;gap:8px;}' +
      '.sap-artifact-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}' +
      '.sap-artifact-time{font-size:10px;color:var(--dsw-alias-label-secondary,#9a9ca3);flex-shrink:0;}' +
      '.sap-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;' +
      'color:var(--dsw-alias-label-secondary,#9a9ca3);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;flex-shrink:0;}' +
      '.sap-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-label-primary,#e8e9ec);}' +
      '.sap-btn.primary{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff);}' +
      '.sap-link{border:none;background:transparent;color:var(--dsw-alias-brand-primary,#4f8cff);font-size:11px;' +
      'cursor:pointer;padding:0 4px;flex-shrink:0;}' +
      '.sap-link:hover{text-decoration:underline;}' +
      '.sap-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9ca3);}' +
      '.sap-error{color:var(--dsw-alias-state-error-primary,#e5534b);font-size:11px;}' +
      '.sap-header-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;' +
      'color:var(--dsw-alias-label-secondary,#9a9ca3);border-radius:6px;padding:2px 10px;font-size:12px;cursor:pointer;}' +
      '.sap-header-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-label-primary,#e8e9ec);}'

    function insertCss(css) {
      if (typeof document === 'undefined') return function () {}
      var tag = document.createElement('style')
      tag.dataset.plugin = 'sa-panel'
      tag.textContent = css
      document.head.appendChild(tag)
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    function apply(ctx) {
      var disposeCss = insertCss(CSS)
      ctx.effect(function () { return disposeCss }, 'sa-panel: styles')

      var shared = { bridge: null, sessionId: '' }
      var slots = ctx.get('slots')
      var layout = ctx.get('layout')
      if (slots === undefined) return

      var conn = ctx.get('connection')
      var api = conn && conn.api

      var rpc = function (op, payload) {
        return fetch('/api/sa-panel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: op, payload: payload || {} }),
        }).then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status)
          return resp.json()
        })
      }

      // 隐藏桥接：读取当前会话 ID 与输入框写入接口（drop-window 同款）
      slots.inject('conversation.input.dock', function () {
        return slots.register(
          { name: 'conversation.input.dock', id: 'sa-panel-bridge', order: 40 },
          function (props) {
            return h(HiddenBridge, { input: props.input, inputActions: props.inputActions, sessionId: props.sessionId, shared: shared })
          },
        )
      })

      // 会话头操作区按钮
      slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'sa-panel', order: 30 },
          function (props) {
            return h(SaHeaderButton, { sessionId: props.sessionId, useSessions: props.useSessions, layout: layout })
          },
        )
      })

      // 右侧 details 列（priority -1 遮蔽 ui-conversation 的 priority 0；lowest renders）
      slots.inject('details', function () {
        return slots.register(
          { name: 'details', priority: -1 },
          function (props) {
            return h(SaPanel, {
              sessionId: props.sessionId,
              useSessions: props.useSessions,
              useSession: props.useSession,
              rpc: rpc,
              layout: layout,
              api: api,
              getBridge: function () { return shared.bridge },
            })
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions', 'layout', 'connection']
    return module.exports
  },
})
