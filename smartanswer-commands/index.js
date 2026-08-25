// smartanswer-commands：SmartAnswer 科研工作流斜杠命令（常驻插件）
// /smartanswer <主题>  转交模型进入 skill 流程（阶段 0 会先与用户确认）
// /smartanswer 体检    检查 skill「环境依赖」表所列路径是否齐全
// /smartanswer 进度    扫描文献库，列出各调研主题当前阶段（_progress.yaml）
import fs from 'node:fs'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'smartanswer-commands'

const DEFAULTS = {
  libraryRoot: 'E:\\Library-Manage\\raw-library\\HanaLibrary',
  checks: {
    gpuBat: 'E:\\PDF2md\\GPU转换.bat',
    gpuPy: 'E:\\PDF2md\\pdf2md_gpu.py',
    cpuPy: 'E:\\PDF2md\\pdf2md.py',
    python: 'C:\\Users\\你的用户名\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
    whitelist: 'E:\\Library-Manage\\raw-library\\HanaLibrary\\zhu-journals.md',
    whitelistSource: 'E:\\Qoder files\\zhu-journals.md',
    index: 'E:\\Library-Manage\\new-library\\文献索引.md',
    edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  },
}

const CHECK_LABELS = {
  gpuBat: 'GPU转换.bat',
  gpuPy: 'pdf2md_gpu.py',
  cpuPy: 'pdf2md.py',
  python: 'Python 解释器',
  whitelist: '期刊白名单(库内)',
  whitelistSource: '期刊白名单(迁移源)',
  index: '文献索引',
  edge: 'Edge 浏览器',
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

function runCheck(cfg) {
  const checks = { ...DEFAULTS.checks, ...(cfg.checks ?? {}) }
  const lines = []
  let bad = 0
  for (const key of Object.keys(CHECK_LABELS)) {
    if (!(key in checks)) continue
    const p = checks[key]
    const ok = exists(p)
    if (!ok) bad++
    lines.push(`${ok ? '✅' : '❌'} ${CHECK_LABELS[key]}：${p}`)
  }
  lines.push('')
  lines.push(bad === 0
    ? '全部依赖齐备，可以直接开始调研（/smartanswer <主题>）。'
    : `缺失 ${bad} 项：请按 skill「环境依赖」一节补齐后再开始调研。`)
  return { kind: 'success', text: lines.join('\n') }
}

function scanProgress(root) {
  const found = []
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
        try {
          const text = fs.readFileSync(full, 'utf8')
          const stage = /^stage:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '未知'
          const folder = /^folder:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? full
          found.push({ stage, folder, file: full })
        } catch { /* 跳过不可读文件 */ }
      }
    }
  }
  walk(root, 0)
  return found
}

function runProgress(cfg, filter) {
  const root = cfg.libraryRoot
  if (!exists(root)) {
    return {
      kind: 'success',
      text: `文献库根不存在：${root}\n请先用 /smartanswer <主题> 启动一次调研（阶段 0 会与你确认存放位置），或修改 cordis.patch.yml 里的 libraryRoot。`,
    }
  }
  const found = scanProgress(root)
  const hits = filter === '' ? found : found.filter(x => x.folder.includes(filter))
  const lines = [`文献库：${root}`, '']
  if (hits.length === 0) {
    lines.push('没有找到 _progress.yaml —— 还没有进行中的调研。')
    lines.push('用 /smartanswer <主题> 启动一次新调研。')
  } else {
    hits.forEach((x, i) => {
      lines.push(`${i + 1}. 主题目录：${x.folder}`)
      lines.push(`   当前阶段：${x.stage}`)
    })
    lines.push('')
    lines.push('断点续跑：对 agent 说「继续 <主题> 调研」即可。')
  }
  return { kind: 'success', text: lines.join('\n') }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'smartanswer',
      description: 'SmartAnswer 文献调研：启动流程 / 环境体检 / 查看进度',
      input: { hint: '[主题 | 体检 | 进度]' },
      handler: ({ agent, rawInput }) => {
        const input = rawInput.trim()
        if (input === '') {
          return {
            kind: 'error',
            text: '用法：/smartanswer <主题>（启动调研）｜/smartanswer 体检（检查环境）｜/smartanswer 进度（查看所有调研阶段）',
          }
        }
        if (input.startsWith('体检')) return runCheck(cfg)
        if (input.startsWith('进度')) return runProgress(cfg, input.slice(2).trim())
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `启动文献调研：${input}` }],
          source: { kind: 'user' },
        }))
        return {
          kind: 'success',
          text: `已启动文献调研「${input}」。流程会先与你确认主题、存放位置和文件夹命名（阶段 0），请留意我的提问。`,
        }
      },
    })
  })
}

export default { name, apply }