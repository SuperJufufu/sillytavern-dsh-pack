#!/usr/bin/env node
/**
 * 发布前敏感内容扫描器（无第三方依赖）
 *
 * 用途：在把本仓库推到 GitHub 之前，检查是否混入了
 *   - 个人路径 / 主机名 / 本机专用目录
 *   - 密钥特征（sk-…、api_key = "…" 等）
 *   - 角色/人格名等个人内容
 *   - 成人向词（本仓库应完全不含；chat-namer 的标题过滤词表是防御性逻辑，允许例外）
 *   - 用户数据文件（聊天 jsonl、图片、settings.json、secrets.json 等）
 *
 * 用法：
 *   node scripts/scan-sensitive.mjs            # 扫描仓库当前目录
 *   node scripts/scan-sensitive.mjs --verbose  # 额外打印扫描的文件数
 *   node scripts/scan-sensitive.mjs <dir>      # 扫描指定目录
 *
 * 退出码：0 = 通过；1 = 发现需要处理的问题。
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const VERBOSE = args.includes('--verbose')
const ROOT = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())
const SELF = relative(ROOT, new URL(import.meta.url).pathname)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist'])
const SKIP_SELF = 'scripts/scan-sensitive.mjs'

const RULES = [
  {
    id: 'windows-path',
    label: 'Windows 个人路径 / 本机专用目录',
    re: /(?:[A-Za-z]:[\\/](?:Users|用户)[\\/])|\\bAdministrator\\b|(?:^|[\\/])(?:st-tools|ST-Images)(?:[\\/]|$)/,
    // 注意：README/NOTICE 里允许出现泛化的 SillyTavern 链接，不允许出现本机目录名
  },
  {
    id: 'secret',
    label: '密钥特征（请人工确认）',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:api[_-]?key|apikey|token|password|secret)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
  {
    id: 'persona',
    label: '角色 / 人格名',
    re: /观世者|铃喵|米娜|塞拉菲娜|Seraphina/,
  },
  {
    id: 'adult',
    label: '成人向词',
    re: /扶她|futa|阴茎|肉棒|巨根|射精|淫|裸体|露骨|nsfw/i,
    // chat-namer 用这些词做「标题过滤（拒绝含性词汇的标题）」，属于防御性逻辑，跳过该文件
    allow: (rel) => rel === join('extensions', 'chat-namer', 'index.js'),
  },
]

const BAD_FILE_NAMES = [
  { re: /\.jsonl$/i, why: '聊天记录文件' },
  { re: /\.zst$/i, why: '压缩会话文件' },
  { re: /\.(?:png|jpe?g|webp|gif)$/i, why: '图片（本仓库不应包含图片）' },
  { re: /^(?:secrets|settings)\.json$/i, why: '用户设置 / 密钥文件' },
  { re: /^\.env(?:\.|$)/i, why: '环境变量文件' },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function isSkippedSelf(rel) {
  return rel.split(sep).join('/') === SKIP_SELF
}

function main() {
  if (!existsSync(ROOT)) {
    console.error(`[scan] 目录不存在: ${ROOT}`)
    process.exit(2)
  }
  const files = walk(ROOT)
  const failures = []
  const warnings = []
  let scanned = 0

  for (const file of files) {
    const rel = relative(ROOT, file)
    const relUnix = rel.split(sep).join('/')
    if (isSkippedSelf(relUnix)) continue

    // 文件名规则（docs/showcase 下的演示图是发布用的截图，允许）
    const isShowcase = relUnix.startsWith('docs/showcase/')
    if (!isShowcase) {
      for (const rule of BAD_FILE_NAMES) {
        if (rule.re.test(rel.split(sep).pop() || '')) {
          failures.push({ file: relUnix, line: 0, rule: 'bad-file', detail: rule.why })
        }
      }
    }

    // 内容规则（只扫文本）
    let text
    try {
      const buf = readFileSync(file)
      if (buf.includes(0)) continue // 二进制
      text = buf.toString('utf8')
    } catch {
      warnings.push({ file: relUnix, detail: '读取失败，跳过' })
      continue
    }
    scanned++
    const lines = text.split(/\r?\n/)
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!rule.re.test(line)) continue
        if (rule.allow && rule.allow(rel)) continue
        failures.push({
          file: relUnix,
          line: i + 1,
          rule: rule.id,
          detail: rule.label,
          snippet: line.trim().slice(0, 120),
        })
      }
    }
    if (text.length > 40 * 1024 * 1024) warnings.push({ file: relUnix, detail: '大文件（>40MB）' })
  }

  console.log(`[scan] 根目录: ${ROOT}`)
  if (VERBOSE) console.log(`[scan] 扫描文件数: ${scanned} / 总文件数: ${files.length}`)

  if (warnings.length) {
    console.log(`\n[scan] 警告 ${warnings.length} 条（不阻塞）:`)
    for (const w of warnings.slice(0, 20)) console.log(`  - ${w.file}: ${w.detail}`)
  }

  if (!failures.length) {
    console.log('\n[scan] PASS：未发现需要处理的问题。')
    console.log('[scan] 发布前仍建议人工过一遍 README / docs，并确认使用全新 Git 历史。')
    process.exit(0)
  }

  console.log(`\n[scan] FAIL：${failures.length} 处命中（按文件去重显示）:`)
  const byFile = new Map()
  for (const f of failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }
  for (const [file, items] of byFile) {
    console.log(`  - ${file}  (${items.length} 处)`)
    for (const it of items.slice(0, 5)) {
      console.log(`      ${it.rule}${it.line ? `:${it.line}` : ''} ${it.detail}${it.snippet ? `  → ${it.snippet}` : ''}`)
    }
    if (items.length > 5) console.log(`      ... 其余 ${items.length - 5} 处略`)
  }
  console.log('\n[scan] 处理建议：删除个人内容/密钥；若确属误报（如防御性过滤词表），在 RULES 的 allow 里显式豁免并写注释。')
  process.exit(1)
}

main()
