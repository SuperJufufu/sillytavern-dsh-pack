#!/usr/bin/env node
/**
 * 构建单文件安装包：SillyTavern-DSH-Pack-Setup-<version>.cmd
 *
 * 原理：
 *   1. 把 installer/install.ps1 + extensions/** + LICENSE + NOTICE 打成 ZIP（store 模式，无依赖）；
 *   2. ZIP → base64，追加到 installer/bootstrap.cmd 模板的 `::PAYLOAD` 行后面；
 *   3. 输出 dist/SillyTavern-DSH-Pack-Setup-<version>.cmd（CRLF），
 *      用户双击后由 bootstrap 解出 payload 并调用 install.ps1。
 *
 * 用法：node tools/build-installer.mjs [--version 0.3.0] [--out <file>]
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
function argValue(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const VERSION = argValue('--version', '0.3.0')
const OUT = resolve(argValue('--out', join(ROOT, 'dist', `SillyTavern-DSH-Pack-Setup-v${VERSION}.cmd`)))

// ---------------------------------------------------------------- CRC32 / ZIP (store)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

const UTF8_FLAG = 0x0800

function makeZip(entries) {
  // entries: [{ name: 'installer/install.ps1', data: Buffer }]
  const chunks = []
  const central = []
  let offset = 0
  const { time, day } = dosDateTime()
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const data = entry.data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(0, 8) // method store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(UTF8_FLAG, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(day, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkFiles(full, base, out)
    else out.push({ full, rel: relative(base, full).split(sep).join('/') })
  }
  return out
}

// ---------------------------------------------------------------- 收集 payload
function collectEntries() {
  const entries = []
  const push = (relPath) => {
    const full = join(ROOT, relPath)
    if (!existsSync(full)) throw new Error(`缺少文件: ${relPath}`)
    let data = readFileSync(full)
    if (relPath === 'installer/install.ps1') {
      // PowerShell 5.1 需要 UTF-8 BOM 才能正确读中文
      if (!(data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)) {
        data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data])
        console.warn('[build]  已自动给 installer/install.ps1 补 UTF-8 BOM（打包内）')
      }
    }
    entries.push({ name: relPath, data })
  }
  push('installer/install.ps1')
  for (const f of walkFiles(join(ROOT, 'extensions'))) {
    push('extensions/' + f.rel)
  }
  push('LICENSE')
  push('NOTICE')
  for (const f of walkFiles(join(ROOT, 'patches'))) {
    push('patches/' + f.rel)
  }
  return entries
}

// ---------------------------------------------------------------- bootstrap PS（会被 -EncodedCommand 执行）
const BOOTSTRAP_PS = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "$lines=[IO.File]::ReadAllLines($env:SELF)",
  "$i=[array]::IndexOf($lines,'::PAYLOAD')",
  "if($i -lt 0){ throw 'installer payload not found' }",
  "$b64=($lines[($i+1)..($lines.Length-1)] -join '')",
  "$zip=Join-Path $env:TEMP ('stdsh-'+[guid]::NewGuid().ToString('N')+'.zip')",
  "[IO.File]::WriteAllBytes($zip,[Convert]::FromBase64String($b64))",
  "Expand-Archive -LiteralPath $zip -DestinationPath $env:TMPD -Force",
  "Remove-Item -LiteralPath $zip -Force",
  "$tokens = @()",
  "if ($env:PACK_ARGS) { foreach ($m in [regex]::Matches($env:PACK_ARGS, '(?:\"[^\"]*\"|[^\\s]+)')) { $tok = $m.Value; if ($tok.StartsWith('\"')) { $tok = $tok.Trim('\"') }; $tokens += $tok } }",
  "$valueNames = @('StPath','InstallDir','DataRoot','StVersion','FromZip','Mirror','NodeVersion')",
  "$splat = @{}",
  "for ($k = 0; $k -lt $tokens.Count; $k++) {",
  "  $tok = [string]$tokens[$k]",
  "  if (-not $tok.StartsWith('-')) { continue }",
  "  $name = $tok.TrimStart('-')",
  "  if (-not $name) { continue }",
  "  $parts = $name -split '[-_]'",
  "  $name = ($parts | ForEach-Object { if ($_) { $_.Substring(0,1).ToUpper() + $_.Substring(1) } }) -join ''",
  "  if ($valueNames -contains $name) {",
  "    if ($k + 1 -lt $tokens.Count) { $nxt = [string]$tokens[$k+1]; if (-not $nxt.StartsWith('-')) { $splat[$name] = $nxt; $k++ } }",
  "  } else { $splat[$name] = $true }",
  "}",
  "$splat['Self'] = $env:SELF",
  "$splat['Temp'] = $env:TMPD",
  "$global:InstallerExitCode = 0",
  "& (Join-Path $env:TMPD 'installer\\install.ps1') @splat",
  "$code = 0",
  "if ($null -ne $global:InstallerExitCode) { $code = [int]$global:InstallerExitCode }",
  "exit $code",
].join('\r\n')

function encodePowerShell(command) {
  // -EncodedCommand 需要 UTF-16LE 的 base64
  return Buffer.from(command, 'utf16le').toString('base64')
}

function toCrLf(text) {
  return text.replace(/\r?\n/g, '\r\n')
}

// ---------------------------------------------------------------- 组装
function main() {
  const bootstrapPath = join(ROOT, 'installer', 'bootstrap.cmd')
  if (!existsSync(bootstrapPath)) throw new Error('缺少 installer/bootstrap.cmd')
  const bootstrap = readFileSync(bootstrapPath, 'utf8')
  const marker = '::PAYLOAD'
  const markerIndex = bootstrap.indexOf(marker)
  if (markerIndex < 0) throw new Error('bootstrap.cmd 中找不到 ::PAYLOAD 标记')

  const entries = collectEntries()
  const zip = makeZip(entries)
  const b64 = zip.toString('base64')
  const lines = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))

  const psb64 = encodePowerShell(BOOTSTRAP_PS)
  const header = toCrLf(bootstrap.slice(0, markerIndex + marker.length)).replace('@@PSB64@@', psb64)
  const outText = `${header}\r\n${lines.join('\r\n')}\r\n`
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, outText, 'utf8')

  const { createHash } = createRequire(import.meta.url)('node:crypto')
  const sha256 = createHash('sha256').update(readFileSync(OUT)).digest('hex')
  const size = statSync(OUT).size

  console.log('[build] payload 文件数:', entries.length)
  console.log('[build] payload zip 大小:', zip.length, 'bytes')
  console.log('[build] 安装包输出:', OUT)
  console.log('[build] 安装包大小:', size, 'bytes (' + (size / 1024).toFixed(1) + ' KiB)')
  console.log('[build] sha256:', sha256)
}

main()
