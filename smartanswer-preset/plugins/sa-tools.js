// SmartAnswer 环境绑定工具宿主侧入口（预设自带插件，随目录迁移）
// 这是相对路径行：加载器按预设自身目录解析 ESM。只用 node: 内置模块，不依赖 harness 的 node_modules。
// ctx.tools.register 的 parameters 是直接发给模型 API 的标准 JSON Schema：
// 必须是 { type: 'object', properties, required } 结构，不能写 defineTool 的扁平 DSL。
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'

export const name = 'sa-tools'
export const inject = ['tools']

const presetDir = fileURLToPath(new URL('../', import.meta.url))

// 机器相关路径集中在此 json（换机器只改它）；preset 内部资产一律相对解析
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(new URL('./sa-config.json', import.meta.url), 'utf8'))
} catch (e) {
  /* 缺省空配置 */
}

function presetRel(p) {
  return p && typeof p === 'string' ? p.replace(/\//g, '\\') : p
}

function run(cmd, args, exec) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    const onAbort = () => { try { p.kill() } catch { /* ignore */ } }
    if (exec && exec.signal) exec.signal.addEventListener('abort', onAbort, { once: true })
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.stack || e) }))
    p.on('close', (code) => {
      if (exec && exec.signal) exec.signal.removeEventListener('abort', onAbort)
      resolve({ code, out, err })
    })
  })
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'sa_crossref_fetch',
    description:
      '对一批 DOI（或标题）预取 CrossRef/OpenAlex 身份、摘要与被引数，写入输出 json。只应由主 agent 调用；子代理禁网禁用。路径二：候选项含 {doi:"",title} 时按标题补验并回填权威 DOI。',
    parameters: {
      type: 'object',
      properties: {
        doisFile: { type: 'string', description: '输入 _dois.json 路径' },
        outFile: { type: 'string', description: '输出 json 路径' },
      },
      required: ['doisFile', 'outFile'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const presets = [
        presetDir + 'skills\\smartanswer-research\\reference\\crossref-fetch.js',
        cfg.crossrefFetchPath,
      ].filter(Boolean)
      const script = presets.find((p) => existsSync(p))
      if (!script) return 'ERROR: 未找到 crossref-fetch.js（预设 skills 副本或 sa-config.crossrefFetchPath 均不可用）'
      const r = await run(process.execPath, [script, args.doisFile, args.outFile], exec)
      if (r.code !== 0) return `crossref-fetch 退出 ${r.code}:\n${r.err || ''}\n${r.out || ''}`
      return `OK (exit ${r.code}) -> ${args.outFile}`
    },
  })

  ctx.tools.register({
    name: 'sa_open_edge',
    description:
      '在用户交互会话中用 Edge 批量打开 https URL（文献下载用）。由宿主进程直接派生（detached+unref），不经过 pwsh 沙箱——沙箱的 kill-on-close Job 会在 pwsh 退出瞬间杀掉浏览器进程树，受限 token 也会阻断向既有 Edge 实例的 IPC 交接。只在用户经闸门确认后调用。',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'https URL 列表（如 https://doi.org/<doi>）' },
      },
      required: ['urls'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const edge = cfg.edgePath
      if (!edge || !existsSync(edge)) return 'ERROR: sa-config 缺 edgePath 或路径不存在'
      const urls = (args.urls || []).filter((u) => /^https:\/\//i.test(u))
      if (!urls.length) return 'ERROR: 无合法 https URL'
      return await new Promise((resolve) => {
        const p = spawn(edge, urls, { detached: true, stdio: 'ignore', windowsHide: true })
        p.on('error', (e) => resolve('ERROR: 启动失败: ' + (e && e.message || e)))
        p.unref()
        // launcher 正常路径是毫秒级自退（IPC 交接给既有实例），只有 spawn 级 error 才是失败
        setTimeout(() => resolve(`OK: 已启动 Edge，${urls.length} 个 URL（若未见窗口请检查 Edge 是否被策略禁用）`), 1500)
      })
    },
  })

  ctx.tools.register({
    name: 'sa_convert',
    description:
      '对目录内 *.pdf 跑 MinerU GPU 转换（python -u pdf2md_gpu.py），Markdown 写到输出目录。spawn 不做 glob 展开，工具自行枚举 PDF 逐个传参；长任务协作响应取消信号。',
    parameters: {
      type: 'object',
      properties: {
        inputDir: { type: 'string', description: '含 *.pdf 的目录' },
        outputDir: { type: 'string', description: '转换输出目录' },
      },
      required: ['inputDir', 'outputDir'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const py = cfg.pythonPath
      const gpu = cfg.pdf2mdGpuPath
      if (!py || !gpu || !existsSync(py) || !existsSync(gpu)) {
        return 'ERROR: sa-config 缺 pythonPath / pdf2mdGpuPath 或路径不存在'
      }
      let pdfs
      try { pdfs = readdirSync(args.inputDir).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => args.inputDir + '\\' + f) }
      catch (e) { return 'ERROR: 无法读取 inputDir: ' + (e && e.message || e) }
      if (!pdfs.length) return 'ERROR: inputDir 内无 *.pdf'
      const r = await run(py, ['-u', gpu].concat(pdfs, ['-o', args.outputDir]), exec)
      if (r.code !== 0) return `pdf2md_gpu 退出 ${r.code}:\n${r.err || ''}\n${r.out || ''}`
      return `OK (exit ${r.code}), ${pdfs.length} 个 PDF -> ${args.outputDir}`
    },
  })
}
