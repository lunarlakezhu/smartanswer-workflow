'use strict'
// sa-panel client 半冒烟测试：模拟 __ModuleLoader__/react/slots，验证 apply 与组件渲染不抛错。
// createElement 与真实 React 一致：函数组件只产生元素、不内联执行（其 hooks 属于子 fiber）。
const fs = require('node:fs')
const path = require('node:path')

const registered = []
const fakeSlots = {
  inject(name, fn) {
    const dispose = fn()
    if (typeof dispose !== 'function') throw new Error('slots.inject 回调必须返回 disposer')
  },
  register(opts, component) {
    registered.push({ opts, component })
    return () => {}
  },
}
const fakeLayout = { openDetails() {}, closeDetails() {} }
const calls = []
const fakeCtx = {
  get(name) {
    if (name === 'slots') return fakeSlots
    if (name === 'layout') return fakeLayout
    if (name === 'connection') return { api: { sessions: { models: async () => ({ result: { ok: true, value: { current: { provider: 'p', model: 'm' }, groups: [] } } }), selectModel: async () => ({ result: { ok: true, value: { selected: {} } } }) } } }
    return undefined
  },
  effect(fn) { fn() },
}

// react stub：createElement 只记元素；hooks 记入 states（跨 _reset 复用 state/ref 盒子，模拟跨次渲染保状态）
function makeReactStub() {
  const hooks = { states: [], i: 0 }
  const createElement = function (type, props, ...children) {
    return { type, props: props || {}, children }
  }
  return {
    createElement,
    useEffect(fn) {
      // 与真实 React 一致：effect 按 hook 槽位存储并在每次渲染时更新（否则跨次渲染的
      // effects 无条件累加，hooks 计量把重渲染当新增）
      const idx = hooks.i++
      const box = hooks.states[idx] && hooks.states[idx].kind === 'effect' ? hooks.states[idx] : { kind: 'effect', fn }
      box.fn = fn
      hooks.states[idx] = box
    },
    useState(init) {
      const idx = hooks.i++
      const box = hooks.states[idx] && hooks.states[idx].kind === 'state' ? hooks.states[idx] : { kind: 'state', value: typeof init === 'function' ? init() : init }
      hooks.states[idx] = box
      return [box.value, (v) => { box.value = typeof v === 'function' ? v(box.value) : v }]
    },
    useRef(init) {
      const idx = hooks.i++
      const box = hooks.states[idx] && hooks.states[idx].kind === 'ref' ? hooks.states[idx] : { kind: 'ref', current: init }
      hooks.states[idx] = box
      return box
    },
    useMemo(fn) { return fn() },
    _reset() { hooks.i = 0 },
    get _states() { return hooks.states },
  }
}

// 单层执行：只调用元素自身的组件函数，不递归子元素（hooks 计量必须单层，递归会冲掉计数）
function renderShallow(react, element) {
  return element.type({ ...(element.props || {}), children: element.children })
}
// 深渲染：递归执行函数组件元素（每个组件独立 hook 槽），返回全字符串类型 vdom 供 JSON 断言
function renderDeep(react, node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => renderDeep(react, n))
  if (typeof node.type === 'function') {
    react._reset()
    return renderDeep(react, renderShallow(react, node))
  }
  return { type: node.type, props: node.props, children: (node.children || []).map((n) => renderDeep(react, n)) }
}

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
let loaded = null
global.window = {
  __ModuleLoader__: {
    load(def) { loaded = def },
  },
}
// eslint-disable-next-line no-eval
eval(source)

const react = makeReactStub()
const exports_ = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

console.log('inject = ' + JSON.stringify(exports_.inject))
if (JSON.stringify(exports_.inject) !== JSON.stringify(['slots', 'sessions', 'layout', 'connection'])) {
  throw new Error('inject 声明不符')
}
exports_.apply(fakeCtx)
console.log('registered = ' + registered.map((r) => r.opts.name + (r.opts.id ? '#' + r.opts.id : '') + (r.opts.priority !== undefined ? '@' + r.opts.priority : '')).join(', '))
if (registered.length !== 3) throw new Error('应注册 3 个 slot')

// 组件渲染冒烟：smartanswer 会话
const byIdSA = { 'sess-1': { agentPreset: 'smartanswer', cwd: 'E:\\DSH-workspace' } }
const byIdOther = { 'sess-2': { agentPreset: 'default' } }
const snap = {
  chat: { nodes: { values() { const all = [
    { kind: 'workflow-run', key: 'wf1', data: { name: 'smartanswer-search', status: 'running', phases: [{ key: 'k', phase: '检索', members: [{ seq: 1, label: 'Nature', childId: 'c1', status: 'running' }] }] } },
  ]; return all[Symbol.iterator]() } } },
  runningCalls: [{ callId: '1', name: 'read', argsRaw: '{}', turn: 1, step: 1 }],
  running: true,
}
const propsFor = (sessionId, byId) => ({
  sessionId,
  useSessions: (sel) => sel({ byId }),
  useSession: (sel) => sel(snap),
  rpc: async (op) => {
    if (op === 'list-topics') return { ok: true, topics: [{ folder: 'E:\\lib\\t1', topic: '主题一', stage: 'final', mtimeMs: 1 }] }
    if (op === 'bind') return { ok: true, topicFolder: null }
    if (op === 'state') return {
      ok: true, topic: '主题一', progress: { stage: 'download', gates: { decompose: 'confirmed', edge_r1: '', edge_r2: '' }, r1: { papers: 10, downloaded: 5, archived: 3, locked: false, forbidden: 0 }, r2: { papers: 0, archived: 0 } },
      disk: { r1: { pdfs: 5, texts: 3, archived: 3 }, r2: { pdfs: 0, texts: 0, archived: 0 } },
      artifacts: { finalMd: { path: 'E:\\lib\\t1\\最终回答.md', mtimeMs: 123, size: 1 } },
      papers: [{ no: 1, title: 'T', year: '2024', journal: 'J', isReview: false, tier: '', note: '', doi: '', tag: '' }],
      auditR1: { stats: { ok: 10, warn: 1, review: 0, none: 0 } },
    }
    if (op === 'get-models') return { ok: true, selection: {} }
    if (op === 'set-models') return { ok: true, selection: {} }
    return { ok: false, error: 'op?' }
  },
  layout: fakeLayout,
  api: fakeCtx.get('connection').api,
  getBridge: () => ({ draft: '', setDraft(t) { calls.push(t) } }),
})

// details 组件（第 3 个注册）
const detailsEntry = registered.find((r) => r.opts.name === 'details')
const headerEntry = registered.find((r) => r.opts.name === 'conversation.session.header.actions')
const dockEntry = registered.find((r) => r.opts.name === 'conversation.input.dock')

// 非目标会话：render null
react._reset()
const nullOut = renderShallow(react, headerEntry.component(propsFor('sess-2', byIdOther)))
if (nullOut !== null) throw new Error('非 smartanswer 会话应 render null，得到 ' + JSON.stringify(nullOut))
console.log('header 按钮：非 smartanswer 会话 → null ✓')

react._reset()
const btn = renderShallow(react, headerEntry.component(propsFor('sess-1', byIdSA)))
if (!btn || btn.type !== 'button') throw new Error('smartanswer 会话应有按钮')
console.log('header 按钮：smartanswer 会话 → ' + btn.children.join('') + ' ✓')

react._reset()
const bridge = renderShallow(react, dockEntry.component({ sessionId: 'sess-1', input: { draft: 'x' }, inputActions: { setDraft(t) { calls.push(t) } } }))
if (!bridge) throw new Error('bridge 应渲染')
console.log('input.dock 隐藏桥 ✓')

// hooks 恒定回归（2026-08-23 根因）：同一已挂载组件在预设翻转（standard→smartanswer）时
// hooks 调用数必须一致；旧版内联调用 SaModels（+6 hooks）→ 预设翻转即 React 违规 → details 槽退位
react._reset()
renderShallow(react, detailsEntry.component(propsFor('sess-2', byIdOther)))
const stdHooks = react._states.length
react._reset()
renderShallow(react, detailsEntry.component(propsFor('sess-1', byIdSA)))
const saHooks = react._states.length
if (stdHooks !== saHooks) throw new Error(`SaPanel hooks 数随预设变化（standard=${stdHooks}, smartanswer=${saHooks}）：预设翻转会触发 React hooks 违规 → 槽退位 → 原生空面板`)
console.log(`hooks 恒定 ✓（standard=${stdHooks} = smartanswer=${saHooks}，子组件经 h() 元素渲染）`)

react._reset()
const panel = renderShallow(react, detailsEntry.component(propsFor('sess-1', byIdSA)))
if (!panel || !panel.props || panel.props.className !== 'sap-root') throw new Error('面板应渲染 sap-root')
const deepPanel = JSON.stringify(renderDeep(react, panel))
if (!deepPanel.includes('模型设置')) throw new Error('深渲染应包含 SaModels 的「模型设置」卡片')
console.log('details 面板：smartanswer 会话渲染 ✓（子节点 ' + panel.children.length + ' 个，深渲染含模型设置卡）')

react._reset()
const panelNull = renderShallow(react, detailsEntry.component(propsFor('sess-2', byIdOther)))
if (panelNull !== null) throw new Error('非 smartanswer 会话面板应 null')
console.log('details 面板：非 smartanswer 会话 → null ✓')

// ---- 绑定解析与闸门（fetch stub 驱动真闭包 rpc，覆盖 {op,payload} 序列化路径）----
// 解析顺序（2026-08-23 修订）：持久绑定 → 全库最新进行中主题 → 会话工作区内主题 → 全库最新
const bindWrites = []
const listTopicCalls = []
const stateCalls = []
const liveFolder = 'E:\\DSH-workspace\\SA-migrant\\test-lib\\狭窄环境爪的挑战'
const staleFolder = 'E:\\Library-Manage\\raw-library\\HanaLibrary\\水下狭窄环境下机械爪的研究现状'
const libLiveFolder = 'E:\\Library-Manage\\raw-library\\DSH-Library\\水下3D打印'
// 场景可控的主题列表（host 端契约：已按 mtimeMs 降序）
let topicsReply = [
  { folder: liveFolder, topic: '狭窄环境水下机械爪面临哪些特殊的工况和挑战', stage: 'download', mtimeMs: 9 },
  { folder: staleFolder, topic: '旧主题（库根，无进度）', stage: null, mtimeMs: 1 },
]
let expectTopic = liveFolder
const snapIdle = { chat: { nodes: { values() { return [][Symbol.iterator]() } } }, runningCalls: [], running: false }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url) !== '/api/sa-panel') throw new Error('unexpected fetch url: ' + url)
  const body = JSON.parse(init.body)
  const reply = (value) => ({ ok: true, json: async () => value })
  if (body.op === 'list-topics') {
    listTopicCalls.push(body.payload)
    if (!body.payload || !Array.isArray(body.payload.roots) || !body.payload.roots.includes('E:\\DSH-workspace\\SA-migrant')) {
      throw new Error('list-topics 请求应携带会话 cwd 根，收到 ' + JSON.stringify(body.payload))
    }
    return reply({ ok: true, roots: body.payload.roots, topics: topicsReply })
  }
  if (body.op === 'bind') {
    if (body.payload && body.payload.topicFolder) bindWrites.push(body.payload.topicFolder)
    return reply({ ok: true, topicFolder: null })
  }
  if (body.op === 'state') {
    stateCalls.push(body.payload.topicFolder)
    return reply({
      ok: true,
      topic: '狭窄环境水下机械爪面临哪些特殊的工况和挑战',
      progress: {
        stage: 'download',
        gates: { decompose: 'confirmed', edge_r1: 'approved', pdf_r1: 'awaiting', edge_r2: '', pdf_r2: '' },
        r1: { papers: 36, downloaded: 0, archived: 0, locked: false, forbidden: 0 },
        r2: { papers: 0, archived: 0 },
      },
      disk: { r1: { pdfs: 0, texts: 0, archived: 0 }, r2: { pdfs: 0, texts: 0, archived: 0 } },
      artifacts: {},
      papers: [],
      auditR1: null,
      auditR2: null,
    })
  }
  if (body.op === 'get-models') return reply({ ok: true, selection: {} })
  return reply({ ok: false, error: 'op?' })
}
const propsSA2 = {
  sessionId: 'sess-3',
  useSessions: (sel) => sel({ byId: { 'sess-3': { agentPreset: 'smartanswer', cwd: 'E:\\DSH-workspace\\SA-migrant' } } }),
  useSession: (sel) => sel(snapIdle),
  rpc: async () => { throw new Error('props.rpc 不应被 details 组件使用（闭包 rpc 才是正路）') },
  layout: fakeLayout,
  api: fakeCtx.get('connection').api,
  getBridge: () => null,
}

function runRecordedEffects() {
  const fns = react._states.filter((s) => s.kind === 'effect').map((s) => s.fn)
  for (const fn of fns) fn()
}
async function resolveRound() {
  bindWrites.length = 0
  react._reset()
  renderShallow(react, detailsEntry.component(propsSA2))
  runRecordedEffects()
  await new Promise((r) => setTimeout(r, 30))
}

;(async () => {
  // 场景 1：工作区内进行中主题 vs 库根无进度旧主题 → 绑定进行中主题
  await resolveRound()
  if (listTopicCalls.length === 0) throw new Error('list-topics 未被调用')
  if (!bindWrites.includes(liveFolder)) throw new Error('应自动持久化绑定到进行中主题，实际 bind=' + JSON.stringify(bindWrites))
  if (bindWrites.includes(staleFolder)) throw new Error('不应绑定到无进度旧主题')
  console.log('cwd 根随请求携带 ✓，自动绑定持久化 → ' + liveFolder + ' ✓')

  // 场景 2（2026-08-23 真实事故）：工作区内残留旧实验的进行中主题（mtime 较旧），
  // 库根（DSH-Library）有更新的进行中主题 → 绑定库根最新进行中，不被工作区残留遮蔽
  topicsReply = [
    { folder: libLiveFolder, topic: '水下3D打印', stage: 'download', mtimeMs: 99 },
    { folder: liveFolder, topic: '狭窄环境水下机械爪面临哪些特殊的工况和挑战', stage: 'download', mtimeMs: 9 },
    { folder: staleFolder, topic: '旧主题（库根，无进度）', stage: null, mtimeMs: 1 },
  ]
  await resolveRound()
  if (!bindWrites.includes(libLiveFolder)) throw new Error('应绑定全库最新进行中主题（DSH-Library），实际 bind=' + JSON.stringify(bindWrites))
  console.log('全库最新进行中优先 ✓ → ' + libLiveFolder)

  // 场景 3：工作区内已完结主题（mtime 更新）vs 库根进行中主题 → 进行中优先
  topicsReply = [
    { folder: liveFolder, topic: '工作区内已完结', stage: 'final', mtimeMs: 50 },
    { folder: libLiveFolder, topic: '水下3D打印', stage: 'download', mtimeMs: 2 },
  ]
  await resolveRound()
  if (!bindWrites.includes(libLiveFolder) || bindWrites.includes(liveFolder)) throw new Error('进行中主题应优先于工作区内已完结主题，实际 bind=' + JSON.stringify(bindWrites))
  console.log('进行中优先于工作区已完结 ✓')

  // 场景 4：全库无进行中主题 → 回退：会话工作区内主题优先
  topicsReply = [
    { folder: staleFolder, topic: '库根无进度旧主题', stage: null, mtimeMs: 7 },
    { folder: liveFolder, topic: '工作区内已完结', stage: 'final', mtimeMs: 3 },
  ]
  await resolveRound()
  if (!bindWrites.includes(liveFolder)) throw new Error('无进行中主题时应回退绑定工作区内主题，实际 bind=' + JSON.stringify(bindWrites))
  console.log('无进行中 → 工作区内回退 ✓')

  // 闸门卡片渲染：回到场景 1，解析 → 轮询 → 再渲染，awaiting 的 pdf_r1 闸门卡片应出现
  topicsReply = [
    { folder: liveFolder, topic: '狭窄环境水下机械爪面临哪些特殊的工况和挑战', stage: 'download', mtimeMs: 9 },
    { folder: staleFolder, topic: '旧主题（库根，无进度）', stage: null, mtimeMs: 1 },
  ]
  await resolveRound()
  if (stateCalls[0] !== expectTopic) throw new Error('首轮 state 轮询目标应为解析出的主题，实际 ' + stateCalls[0])
  react._reset()
  renderShallow(react, detailsEntry.component(propsSA2))
  runRecordedEffects()
  await new Promise((r) => setTimeout(r, 30))
  react._reset()
  const panel2 = renderShallow(react, detailsEntry.component(propsSA2))
  const dump = JSON.stringify(renderDeep(react, panel2))
  const awaitingCount = dump.split('（等待你的确认）').length - 1
  const needCount = dump.split('（需要确认）').length - 1
  if (!dump.includes('R1 下载完成确认')) throw new Error('awaiting 闸门卡片（pdf_r1）未渲染')
  if (awaitingCount !== 1) throw new Error('应恰有 1 张 awaiting 卡片，实际 ' + awaitingCount)
  if (needCount !== 0) throw new Error('已过闸/未到阶段的闸门不应出「需要确认」卡片，实际 ' + needCount)
  if (!dump.includes('下载中')) throw new Error('stage 徽标未显示')
  console.log('awaiting 闸门卡片（pdf_r1）渲染 ✓，stage 徽标 ✓')
  globalThis.fetch = realFetch
  console.log('ALL CLIENT SMOKE OK')
  // 轮询 effect 的空闲重挂定时器（30s）会拖住事件循环：冒烟到此为止，显式退出
  process.exit(0)
})().catch((err) => { globalThis.fetch = realFetch; console.error('FAIL', err); process.exit(1) })
