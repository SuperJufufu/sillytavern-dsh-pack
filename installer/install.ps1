<#
  SillyTavern DSH Pack —— 一键安装器（主逻辑）
  由 bootstrap.cmd 从单文件安装包中解压后调用。

  设计要点：
    - 只写入：ST 安装目录 / <ST>/data/default-user/extensions / 安装记录 / 桌面快捷方式
    - 检测到目标版本 ST 就不下载；没有才下载 ST 源码包（GitHub tag）
    - ST 1.19 要求 Node >= 20；没有 Node 时自动下载便携版（不需要管理员）
    - 旧版本扩展先备份再覆盖；同版本直接跳过（可重复运行）
    - 不做任何系统级修改
#>

param(
    [string]$Self = '',
    [string]$Temp = '',
    [string]$StPath = '',
    [string]$InstallDir = '',
    [string]$DataRoot = '',
    [string]$StVersion = '1.19.0',
    [string]$FromZip = '',
    [string]$Mirror = '',
    [string]$NodeVersion = '',
    [switch]$CheckOnly,
    [switch]$DryRun,
    [switch]$SkipNpm,
    [switch]$NoShortcut,
    [switch]$NoPatches,
    [switch]$NoNodeDownload,
    [switch]$NoDetect,
    [switch]$NoRecord,
    [switch]$Yes,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
$Script:PackVersion = '0.3.0'
$Script:LogPath = Join-Path $env:TEMP ("dsh-pack-install-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
$Script:NoWrite = [bool]$DryRun
$global:InstallerExitCode = 0

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
    $ProgressPreference = 'SilentlyContinue'
} catch { }
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

# ---------------------------------------------------------------- 输出函数
function Write-LogLine {
    param([string]$Message, [string]$Level = 'INFO')
    try {
        $line = ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message)
        Add-Content -LiteralPath $Script:LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}
function Say { param([string]$Message, [string]$Color = 'Gray') Write-Host $Message -ForegroundColor $Color; Write-LogLine $Message }
function Step { param([string]$Number, [string]$Message) Write-Host ''; Write-Host ("[{0}] " -f $Number) -NoNewline -ForegroundColor Cyan; Write-Host $Message -ForegroundColor White; Write-LogLine ("STEP {0}: {1}" -f $Number, $Message) }
function Ok { param([string]$Message) Write-Host ('  OK  ' + $Message) -ForegroundColor Green; Write-LogLine ('OK: ' + $Message) }
function Warn { param([string]$Message) Write-Host ('  !!  ' + $Message) -ForegroundColor Yellow; Write-LogLine ('WARN: ' + $Message) }
function Fail { param([string]$Message) Write-Host ('  XX  ' + $Message) -ForegroundColor Red; Write-LogLine ('ERROR: ' + $Message) }

function Show-Banner {
    Write-Host ''
    Write-Host '  ==================================================' -ForegroundColor Cyan
    Write-Host ('   SillyTavern DSH Pack  v' + $Script:PackVersion + '  一键安装器') -ForegroundColor Cyan
    Write-Host '   13 个扩展 · 自动检测/下载 SillyTavern · 不含成人内容' -ForegroundColor DarkGray
    Write-Host '  ==================================================' -ForegroundColor Cyan
    Write-LogLine ('installer started; pack=' + $Script:PackVersion + ' ps=' + $PSVersionTable.PSVersion.ToString())
}

function Show-Help {
    Show-Banner
    Write-Host @'
  用法: SillyTavern-DSH-Pack-Setup-v0.3.0.cmd [参数]

  常用:
    --st-path <目录>      指定已有 SillyTavern 目录（跳过自动检测）
    --install-dir <目录>  新装 ST 的目标目录（默认 %LOCALAPPDATA%\SillyTavern-DSH\SillyTavern）
    --data-root <目录>    指定 data 根目录（默认 <ST>\data）
    --st-version <版本>   目标 ST 版本（默认 1.19.0）
    --from-zip <zip>      用本地 ST zip 代替下载
    --mirror <前缀>       下载镜像前缀，例如 https://ghproxy.net/
    --help                显示本帮助

  调试/自动化:
    --check-only          只检测：0=找到对应版本, 2=未找到, 3=版本不符
    --dry-run             只打印计划，不写任何文件
    --skip-npm            跳过 npm install（可稍后跑 Start.bat）
    --no-shortcut         不创建桌面快捷方式
    --no-detect           跳过自动检测（强制按 --install-dir 新装）
    --no-node-download    缺 Node 时报错而不是自动下载
    --no-record           不写安装记录
    --node-version <v>    指定要下载的 Node 版本（默认最新 LTS）
    --yes                 自动确认（无人值守）
'@ -ForegroundColor Gray
}

# ---------------------------------------------------------------- 基础工具
function Get-FullPath {
    param([string]$Path)
    if (-not $Path) { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if ($expanded -match '^[A-Za-z]:[\\/]') { return $expanded.TrimEnd('\', '/') }
    return [IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
}

function Get-StInfo {
    param([string]$Dir)
    if (-not $Dir) { return $null }
    $pkg = Join-Path $Dir 'package.json'
    if (-not (Test-Path -LiteralPath $pkg)) { return $null }
    try {
        $json = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { return $null }
    if (-not $json -or -not $json.name -or $json.name -ne 'sillytavern') { return $null }
    $resolved = $Dir
    try { $resolved = (Resolve-Path -LiteralPath $Dir).Path } catch { }
    return [pscustomobject]@{ Path = $resolved.TrimEnd('\', '/'); Version = [string]$json.version }
}

function Get-InstallRecord {
    $path = Join-Path (Join-Path $env:APPDATA 'SillyTavern-DSH-Pack') 'install.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Find-ExistingSt {
    param([string]$Hint)
    $cands = @()
    if ($Hint) { $cands += $Hint }
    $rec = Get-InstallRecord
    if ($rec -and $rec.stPath) { $cands += [string]$rec.stPath }
    $cands += @(
        (Join-Path $env:USERPROFILE 'SillyTavern'),
        (Join-Path $env:USERPROFILE 'SillyTavern-Launcher\SillyTavern'),
        (Join-Path $env:LOCALAPPDATA 'SillyTavern'),
        (Join-Path $env:LOCALAPPDATA 'SillyTavern-Launcher\SillyTavern'),
        (Join-Path $env:LOCALAPPDATA 'Programs\SillyTavern'),
        (Join-Path $env:LOCALAPPDATA 'SillyTavern-DSH\SillyTavern'),
        (Join-Path ${env:ProgramFiles} 'SillyTavern'),
        'C:\SillyTavern',
        'C:\SillyTavern-Launcher\SillyTavern',
        'D:\SillyTavern',
        'D:\SillyTavern-Launcher\SillyTavern'
    )
    foreach ($base in @((Join-Path $env:USERPROFILE 'SillyTavern-Launcher'), (Join-Path $env:LOCALAPPDATA 'SillyTavern-Launcher'))) {
        if (Test-Path -LiteralPath $base) {
            foreach ($child in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
                $cands += $child.FullName
            }
        }
    }
    $seen = @{}
    $found = @()
    foreach ($c in $cands) {
        if (-not $c) { continue }
        $c = Get-FullPath $c
        if (-not $c) { continue }
        $key = $c.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $info = Get-StInfo $c
        if ($info) { $found += $info }
    }
    return $found
}

function Read-Choice {
    param([string]$Title, [string[]]$Options, [int]$DefaultIndex = 0)
    Write-Host ''
    Write-Host $Title -ForegroundColor Yellow
    for ($i = 0; $i -lt $Options.Count; $i++) {
        Write-Host ('  [{0}] {1}' -f ($i + 1), $Options[$i]) -ForegroundColor Gray
    }
    if ($Yes) {
        Write-Host ('  (--yes) 自动选择 [{0}]' -f ($DefaultIndex + 1)) -ForegroundColor DarkGray
        return $DefaultIndex
    }
    while ($true) {
        $raw = ''
        try { $raw = Read-Host ('选择 [1-{0}]，回车=默认 [{1}]' -f $Options.Count, ($DefaultIndex + 1)) }
        catch { Write-Host '  当前环境无法交互输入，使用默认选项。' -ForegroundColor Yellow; return $DefaultIndex }
        if (-not $raw) { return $DefaultIndex }
        $n = 0
        if ([int]::TryParse([string]$raw, [ref]$n) -and $n -ge 1 -and $n -le $Options.Count) { return ($n - 1) }
        Write-Host '  请输入有效数字。' -ForegroundColor Red
    }
}

function Download-File {
    param([string[]]$Urls, [string]$OutFile, [string]$Label)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    foreach ($url in $Urls) {
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            try {
                if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
                Say ('  下载 {0}: {1}' -f $Label, $url) 'DarkGray'
                $ok = $false
                if (Test-Path -LiteralPath $curl) {
                    # Windows 自带 curl.exe：比 PowerShell 5.1 的 Invoke-WebRequest 在 GitHub 上更可靠
                    $oldEap = $ErrorActionPreference
                    try {
                        $ErrorActionPreference = 'Continue'
                        & $curl --location --fail --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 --output $OutFile $url
                        $ok = ($LASTEXITCODE -eq 0)
                    } finally {
                        $ErrorActionPreference = $oldEap
                    }
                }
                if (-not $ok) {
                    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $OutFile -TimeoutSec 1800
                    $ok = $true
                }
                if ($ok -and (Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -gt 1024)) {
                    Ok ('下载完成: ' + [math]::Round((Get-Item -LiteralPath $OutFile).Length / 1MB, 1) + ' MB')
                    return $true
                }
            } catch {
                Warn ('下载失败（第 {0} 次）: {1}' -f $attempt, $_.Exception.Message)
                Start-Sleep -Seconds 2
            }
        }
    }
    return $false
}

function Get-PackRoot {
    if (-not $PSScriptRoot) { return $null }
    $root = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $root 'extensions')) { return $root }
    return $null
}

# ---------------------------------------------------------------- ST 安装
function Get-StZip {
    param([string]$TargetVersion, [string]$LocalZip)
    if ($LocalZip) {
        if (-not (Test-Path -LiteralPath $LocalZip)) { throw ('找不到 --from-zip 文件: ' + $LocalZip) }
        return (Resolve-Path -LiteralPath $LocalZip).Path
    }
    $name = 'SillyTavern-' + $TargetVersion + '.zip'
    $out = Join-Path $Temp $name
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
    $official = 'https://github.com/SillyTavern/SillyTavern/archive/refs/tags/' + $TargetVersion + '.zip'
    $urls = New-Object System.Collections.Generic.List[string]
    if ($Mirror) { $urls.Add($Mirror.TrimEnd('/') + '/' + $official) }
    $urls.Add($official)
    if (-not (Download-File -Urls @($urls) -OutFile $out -Label ('SillyTavern ' + $TargetVersion + ' 源码包'))) {
        throw 'SillyTavern 下载失败，请检查网络，或用 --from-zip 指定本地 zip，或加 --mirror 用镜像。'
    }
    return $out
}

function Expand-StZip {
    param([string]$ZipPath, [string]$TargetDir, [string]$TargetVersion)
    $work = Join-Path $Temp 'st-unzip'
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Say '  解压 SillyTavern ...' 'DarkGray'
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $work -Force
    $roots = @(Get-ChildItem -LiteralPath $work -Directory -ErrorAction SilentlyContinue)
    if ($roots.Count -lt 1) { throw 'SillyTavern zip 内容异常（没有顶层目录）' }
    $root = $roots[0].FullName
    $info = Get-StInfo $root
    if (-not $info) { throw ('解压后找不到 package.json / 不是 SillyTavern: ' + $root) }
    if ($info.Version -ne $TargetVersion) { throw ('版本不符：期望 ' + $TargetVersion + '，实际 ' + $info.Version) }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'Start.bat'))) { throw 'SillyTavern zip 里缺少 Start.bat，可能包不完整' }
    if (-not $Script:NoWrite) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
        Get-ChildItem -LiteralPath $root -Force | Move-Item -Destination $TargetDir -Force
    }
    return (Get-StInfo $TargetDir)
}

# ---------------------------------------------------------------- Node
function Get-NodeInfo {
    $cands = New-Object System.Collections.Generic.List[string]
    $cands.Add((Join-Path (Join-Path $env:LOCALAPPDATA 'SillyTavern-DSH') 'node\node.exe'))
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $cands.Add($cmd.Source) }
    $cands.Add((Join-Path ${env:ProgramFiles} 'nodejs\node.exe'))
    $cands.Add('C:\Program Files\nodejs\node.exe')
    $cands.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
    $seen = @{}
    foreach ($exe in $cands) {
        if (-not $exe) { continue }
        if (-not (Test-Path -LiteralPath $exe)) { continue }
        $key = $exe.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        try { $raw = (& $exe --version 2>$null) } catch { continue }
        $v = ('{0}' -f $raw).Trim()
        if ($v -match '^v(\d+)\.(\d+)\.(\d+)') {
            $major = [int]$Matches[1]
            if ($major -ge 20) {
                $nodeDir = Split-Path -Parent $exe
                $npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
                if (-not (Test-Path -LiteralPath $npm)) { $npm = '' }
                return [pscustomobject]@{ Exe = $exe; Version = $v; Major = $major; Dir = $nodeDir; NpmCli = $npm }
            }
        }
    }
    return $null
}

function Install-PortableNode {
    param([string]$WantedVersion)
    $index = $null
    foreach ($url in @('https://nodejs.org/dist/index.json', 'https://npmmirror.com/mirrors/node/index.json')) {
        try {
            $raw = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 60
            $index = $raw.Content | ConvertFrom-Json
            if ($index) { break }
        } catch { }
    }
    $ver = ''
    if ($WantedVersion) {
        $ver = [string]$WantedVersion
        if ($ver -notmatch '^v') { $ver = 'v' + $ver }
    } elseif ($index) {
        $lts = @($index | Where-Object { $_.lts -and ($_.version -match '^v(\d+)\.') -and ([int]$Matches[1] -ge 20) }) | Select-Object -First 1
        if ($lts) { $ver = [string]$lts.version }
    }
    if (-not $ver) { $ver = 'v22.14.0'; Warn ('无法获取 Node 版本列表，回退 ' + $ver) }
    $zipName = 'node-' + $ver + '-win-x64.zip'
    $out = Join-Path $Temp $zipName
    $urls = New-Object System.Collections.Generic.List[string]
    $urls.Add('https://nodejs.org/dist/' + $ver + '/' + $zipName)
    $urls.Add('https://npmmirror.com/mirrors/node/' + $ver + '/' + $zipName)
    if (-not (Download-File -Urls @($urls) -OutFile $out -Label ('Node.js ' + $ver))) { throw 'Node.js 下载失败' }
    $work = Join-Path $Temp 'node-unzip'
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Expand-Archive -LiteralPath $out -DestinationPath $work -Force
    $roots = @(Get-ChildItem -LiteralPath $work -Directory)
    if ($roots.Count -lt 1) { throw 'Node.js zip 内容异常' }
    $nodeRoot = Join-Path (Join-Path $env:LOCALAPPDATA 'SillyTavern-DSH') 'node'
    if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $nodeRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $roots[0].FullName -Force | Move-Item -Destination $nodeRoot -Force
    $info = Get-NodeInfo
    if (-not $info) { throw 'Node.js 便携版安装后仍找不到 node.exe' }
    return $info
}

# ---------------------------------------------------------------- 扩展
function Install-Extensions {
    param([string]$PackRoot, [string]$DataRootPath, [bool]$IsDryRun)
    $src = Join-Path $PackRoot 'extensions'
    if (-not (Test-Path -LiteralPath $src)) { throw ('扩展目录不存在: ' + $src) }
    $userRoot = Join-Path $DataRootPath 'default-user'
    $extDst = Join-Path $userRoot 'extensions'
    $backupRoot = Join-Path $userRoot ('.dsh-pack-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $installed = New-Object System.Collections.Generic.List[string]
    $skipped = New-Object System.Collections.Generic.List[string]
    $backed = New-Object System.Collections.Generic.List[string]
    $dirs = @(Get-ChildItem -LiteralPath $src -Directory | Sort-Object Name)
    foreach ($d in $dirs) {
        $ver = '?'
        $manifest = Join-Path $d.FullName 'manifest.json'
        if (Test-Path -LiteralPath $manifest) {
            try { $ver = [string](Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
        }
        $target = Join-Path $extDst $d.Name
        $existingVer = ''
        $existingManifest = Join-Path $target 'manifest.json'
        if (Test-Path -LiteralPath $existingManifest) {
            try { $existingVer = [string](Get-Content -LiteralPath $existingManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
        }
        if ($existingVer -and $existingVer -eq $ver) {
            $skipped.Add(('{0} {1}（已是同版本，跳过）' -f $d.Name, $ver))
            continue
        }
        if (Test-Path -LiteralPath $target) {
            if ($IsDryRun) {
                $backed.Add(('{0} {1} -> 会备份后覆盖' -f $d.Name, $(if ($existingVer) { $existingVer } else { '?' })))
            } else {
                New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
                Move-Item -LiteralPath $target -Destination (Join-Path $backupRoot $d.Name) -Force
                $backed.Add(('{0} {1}' -f $d.Name, $(if ($existingVer) { $existingVer } else { '?' })))
            }
        }
        if ($IsDryRun) {
            $installed.Add(('{0} {1}' -f $d.Name, $ver))
            continue
        }
        New-Item -ItemType Directory -Path $extDst -Force | Out-Null
        Copy-Item -LiteralPath $d.FullName -Destination $extDst -Recurse -Force
        $installed.Add(('{0} {1}' -f $d.Name, $ver))
    }
    return [pscustomobject]@{
        ExtensionDir = $extDst
        Installed    = @($installed)
        Skipped      = @($skipped)
        BackedUp     = @($backed)
        BackupRoot   = $backupRoot
    }
}

# ---------------------------------------------------------------- 补丁
function Apply-PackPatches {
    param([string]$StRoot, $Node)
    if ($NoPatches) {
        Warn '已跳过 ST 补丁（--no-patches）；角度图 / 写词稳定器钩子不会生效。'
        return $false
    }
    $apply = Join-Path (Join-Path $Temp 'patches') 'apply.mjs'
    if (-not (Test-Path -LiteralPath $apply)) {
        Warn ('安装包内没有补丁脚本，跳过: ' + $apply)
        return $false
    }
    if (-not $Node -or -not $Node.Exe) {
        Warn '没有可用的 Node.js，跳过 ST 补丁（可稍后手动运行 patches/apply.mjs）'
        return $false
    }
    Step '5/7' '应用 SillyTavern 补丁（AGPL-3.0；改前自动备份，可重复运行）...'
    $oldEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $out = & $Node.Exe $apply --st $StRoot 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldEap
    }
    foreach ($line in @($out)) {
        Add-Content -LiteralPath $Script:LogPath -Value ('[patch] ' + $line) -Encoding UTF8 -ErrorAction SilentlyContinue
        Write-Host ('  ' + $line) -ForegroundColor DarkGray
    }
    if ($code -ne 0) {
        Warn ('补丁应用失败（退出码 ' + $code + '）；扩展仍可用，但角度图/写词钩子可能不生效。可稍后手动运行 patches/apply.mjs --st "<ST目录>"')
        return $false
    }
    Ok 'ST 补丁已应用'
    return $true
}

# ---------------------------------------------------------------- npm
function Install-NpmDeps {
    param([string]$StRoot, $Node)
    if ($SkipNpm) { Warn '已跳过 npm install（--skip-npm）；首次启动可用 ST 的 Start.bat 自动装依赖。'; return $false }
    $marker = Join-Path $StRoot 'node_modules\express'
    if (Test-Path -LiteralPath $marker) { Ok 'node_modules 已存在，跳过依赖安装'; return $true }
    if (-not $Node) { Warn '没有可用的 Node.js，跳过依赖安装'; return $false }
    if (-not $Node.NpmCli) { Warn '找不到 npm-cli.js，跳过依赖安装（可稍后运行 Start.bat）'; return $false }
    Step '6/7' '安装 Node 依赖（npm install --omit=dev，可能需要几分钟）...'
    $env:NODE_ENV = 'production'
    Push-Location -LiteralPath $StRoot
    try {
        $npmArgs = @($Node.NpmCli, 'install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--no-progress', '--omit=dev', '--ignore-scripts')
        $output = & $Node.Exe @npmArgs 2>&1
        $code = $LASTEXITCODE
        foreach ($line in @($output)) { Add-Content -LiteralPath $Script:LogPath -Value ('[npm] ' + $line) -Encoding UTF8 -ErrorAction SilentlyContinue }
        if ($code -ne 0) {
            Warn ('npm install 退出码 ' + $code + '（可稍后运行 ST 的 Start.bat 重试）')
            return $false
        }
    } finally {
        Pop-Location
    }
    Ok 'Node 依赖安装完成'
    return $true
}

# ---------------------------------------------------------------- 快捷方式 / 记录
function New-DesktopShortcut {
    param([string]$StRoot)
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { Warn '找不到桌面目录，跳过快捷方式'; return }
    $lnk = Join-Path $desktop 'SillyTavern DSH.lnk'
    $target = Join-Path $StRoot 'Start.bat'
    if (-not (Test-Path -LiteralPath $target)) { Warn ('Start.bat 不存在，跳过快捷方式: ' + $target); return }
    try {
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath = $target
        $sc.WorkingDirectory = $StRoot
        $sc.Description = 'SillyTavern (DSH 扩展包)'
        $sc.Save()
        Ok ('桌面快捷方式: ' + $lnk)
    } catch {
        Warn ('创建快捷方式失败: ' + $_.Exception.Message)
    }
}

function Save-InstallRecord {
    param($StRoot, [string]$StVersionValue, [string]$DataRootPath, [string]$ExtDir, [string[]]$Installed, $NodeInfo, [bool]$PatchesApplied)
    if ($NoRecord) { return }
    $dir = Join-Path $env:APPDATA 'SillyTavern-DSH-Pack'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $path = Join-Path $dir 'install.json'
    $record = [ordered]@{
        packVersion    = $Script:PackVersion
        stPath         = $StRoot
        stVersion      = $StVersionValue
        dataRoot       = $DataRootPath
        extensionsDir  = $ExtDir
        extensions     = $Installed
        nodeExe        = $(if ($NodeInfo) { $NodeInfo.Exe } else { '' })
        nodeVersion    = $(if ($NodeInfo) { $NodeInfo.Version } else { '' })
        installedAt    = (Get-Date).ToString('o')
        installerLog   = $Script:LogPath
    }
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
    Ok ('安装记录: ' + $path)
}

# ---------------------------------------------------------------- 主流程
if ($Help) { Show-Help; $global:InstallerExitCode = 0; return }

Show-Banner
Say ('  日志: ' + $Script:LogPath) 'DarkGray'

$packRoot = Get-PackRoot
if (-not $packRoot) { Fail '找不到安装包内容（extensions 目录缺失），安装包可能不完整。'; $global:InstallerExitCode = 1; return }

# 1) 检测
Step '1/7' '检测本机 SillyTavern ...'
$stInfo = $null
$downloadNeeded = $false
$explicitInfo = $null
if ($StPath) {
    $explicitInfo = Get-StInfo $StPath
    if (-not $explicitInfo) { Fail ('--st-path 指定的目录不是 SillyTavern（找不到 package.json / 名称不符）: ' + $StPath); $global:InstallerExitCode = 1; return }
}
$all = @()
if (-not $NoDetect -and -not $StPath) { $all = @(Find-ExistingSt $StPath) }

# check-only：只检测，不提示、不写入
if ($CheckOnly) {
    if ($explicitInfo) {
        if ($explicitInfo.Version -eq $StVersion) { Ok ('找到匹配版本 ' + $StVersion + ': ' + $explicitInfo.Path); $global:InstallerExitCode = 0; return }
        Warn ('--st-path 的版本不符: v' + $explicitInfo.Version + ' (' + $explicitInfo.Path + ')'); $global:InstallerExitCode = 3; return
    }
    $match = @($all | Where-Object { $_.Version -eq $StVersion })
    if ($match.Count -gt 0) { Ok ('找到匹配版本 ' + $StVersion + ': ' + $match[0].Path); $global:InstallerExitCode = 0; return }
    if ($all.Count -gt 0) {
        Warn ('找到 SillyTavern 但版本不符: ' + (($all | ForEach-Object { 'v' + $_.Version }) -join ', '))
        $global:InstallerExitCode = 3; return
    }
    Warn ('未找到 SillyTavern ' + $StVersion); $global:InstallerExitCode = 2; return
}

if ($explicitInfo) {
    $stInfo = $explicitInfo
} elseif ($all.Count -gt 0) {
    $matching = @($all | Where-Object { $_.Version -eq $StVersion })
    $other = @($all | Where-Object { $_.Version -ne $StVersion })
    if ($matching.Count -gt 0) {
        $stInfo = $matching[0]
    } elseif ($other.Count -gt 0) {
        Say ('  发现其他版本的 SillyTavern:') 'Yellow'
        foreach ($o in $other) { Say ('    - v' + $o.Version + '  ' + $o.Path) 'Gray' }
        $choice = Read-Choice -Title ('没有找到目标版本 ' + $StVersion + '，怎么处理？') -Options @(
            ('仍然把扩展装到已有的 v' + $other[0].Version + '（不下载）'),
            ('按规格下载 SillyTavern ' + $StVersion + '（新装一份）'),
            '退出安装'
        ) -DefaultIndex 1
        switch ($choice) {
            0 { $stInfo = $other[0] }
            1 { $downloadNeeded = $true }
            2 { Say '已取消。' 'Yellow'; $global:InstallerExitCode = 3; return }
        }
    } else {
        $downloadNeeded = $true
    }
} else {
    $downloadNeeded = $true
}
if ($stInfo -and -not $downloadNeeded) {
    Ok ('已有 SillyTavern v' + $stInfo.Version + ': ' + $stInfo.Path)
    Say '  已有目标版本，跳过下载本体。' 'DarkGray'
}


# 2) 目标目录
$targetSt = ''
if ($stInfo) {
    $targetSt = $stInfo.Path
} else {
    if ($InstallDir) { $targetSt = Get-FullPath $InstallDir }
    else { $targetSt = Get-FullPath (Join-Path (Join-Path $env:LOCALAPPDATA 'SillyTavern-DSH') 'SillyTavern') }
    Step '2/7' ('未找到 SillyTavern ' + $StVersion + '，将下载并安装到: ' + $targetSt)
    if (Test-Path -LiteralPath $targetSt) {
        $items = @(Get-ChildItem -LiteralPath $targetSt -Force -ErrorAction SilentlyContinue)
        if ($items.Count -gt 0) {
            if ($DryRun) { Warn '目标目录已存在且非空（实际安装会拒绝）' }
            else { Fail ('目标目录已存在且非空: ' + $targetSt + '（请换 --install-dir 或清空它）'); $global:InstallerExitCode = 1; return }
        }
    }
}

$dataRootPath = ''
if ($DataRoot) { $dataRootPath = Get-FullPath $DataRoot }
elseif ($stInfo) { $dataRootPath = Join-Path $targetSt 'data' }
else { $dataRootPath = Join-Path $targetSt 'data' }

# dry-run 计划
if ($DryRun) {
    Step 'DRY-RUN' '只显示计划，不写任何文件：'
    if ($downloadNeeded) {
        Say ('  将下载: https://github.com/SillyTavern/SillyTavern/archive/refs/tags/' + $StVersion + '.zip') 'Gray'
        Say ('  将解压到: ' + $targetSt) 'Gray'
    } else {
        Say ('  使用已有 SillyTavern: ' + $targetSt) 'Gray'
    }
    Say ('  扩展安装目录: ' + (Join-Path (Join-Path $dataRootPath 'default-user') 'extensions')) 'Gray'
    Say ('  将安装扩展: ' + ((Get-ChildItem -LiteralPath (Join-Path $packRoot 'extensions') -Directory | ForEach-Object { $_.Name }) -join ', ')) 'Gray'
    $nodeInfo = Get-NodeInfo
    if ($nodeInfo) { Say ('  Node.js: ' + $nodeInfo.Version + ' (' + $nodeInfo.Exe + ')') 'Gray' }
    else { Say '  Node.js: 未找到，实际运行时会尝试下载便携版' 'Gray' }
    if (-not $SkipNpm) { Say '  将执行 npm install --omit=dev' 'Gray' }
    if (-not $NoPatches) { Say '  将应用 ST 补丁（SD 角度配图 / 写词稳定器钩子；AGPL-3.0，改前备份）' 'Gray' }
    if (-not $NoShortcut) { Say ('  将创建桌面快捷方式: ' + (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SillyTavern DSH.lnk')) 'Gray' }
    Say ('  安装记录: ' + (Join-Path (Join-Path $env:APPDATA 'SillyTavern-DSH-Pack') 'install.json')) 'Gray'
    Ok 'dry-run 结束（未写文件）'
    $global:InstallerExitCode = 0; return
}

# 3) 下载 / 解压 ST
if ($downloadNeeded) {
    $zipPath = Get-StZip -TargetVersion $StVersion -LocalZip $FromZip
    $extracted = Expand-StZip -ZipPath $zipPath -TargetDir $targetSt -TargetVersion $StVersion
    if ($extracted) { $stInfo = $extracted }
    Ok ('SillyTavern ' + $StVersion + ' 已就绪: ' + $targetSt)
} else {
    Ok ('使用已有 SillyTavern: ' + $targetSt)
}

# 4) 扩展
$extResult = $null
Step '3/7' ('安装扩展到: ' + (Join-Path (Join-Path $dataRootPath 'default-user') 'extensions'))
$extResult = Install-Extensions -PackRoot $packRoot -DataRootPath $dataRootPath -IsDryRun $false
foreach ($x in $extResult.Installed) { Ok ('安装 ' + $x) }
foreach ($x in $extResult.Skipped) { Say ('  跳过 ' + $x) 'DarkGray' }
foreach ($x in $extResult.BackedUp) { Warn ('已备份旧版本 ' + $x) }
if ($extResult.BackedUp.Count -gt 0) { Say ('  备份目录: ' + $extResult.BackupRoot) 'DarkGray' }

# 5) Node + 依赖
$nodeInfo = Get-NodeInfo
if (-not $nodeInfo) {
    if ($NoNodeDownload) { Fail '找不到 Node.js（>=20）。请安装 Node.js 后重试，或去掉 --no-node-download 让安装器自动下载。'; $global:InstallerExitCode = 1; return }
    Step '4/7' '未找到 Node.js（>=20），将下载便携版到本地（不需要管理员）...'
    $nodeInfo = Install-PortableNode -WantedVersion $NodeVersion
    Ok ('Node.js 就绪: ' + $nodeInfo.Version + ' -> ' + $nodeInfo.Exe)
} else {
    Ok ('Node.js: ' + $nodeInfo.Version + ' (' + $nodeInfo.Exe + ')')
}
$patchOk = Apply-PackPatches -StRoot $targetSt -Node $nodeInfo
$npmOk = Install-NpmDeps -StRoot $targetSt -Node $nodeInfo

# 6) 快捷方式 + 记录
if (-not $NoShortcut) { Step '7/7' '创建桌面快捷方式 ...'; New-DesktopShortcut -StRoot $targetSt }
Save-InstallRecord -StRoot $targetSt -StVersionValue $StVersion -DataRootPath $dataRootPath -ExtDir $extResult.ExtensionDir -Installed $extResult.Installed -NodeInfo $nodeInfo -PatchesApplied $patchOk

# 汇总
Write-Host ''
Write-Host '  ==================================================' -ForegroundColor Green
Write-Host ('   安装完成  ·  pack v' + $Script:PackVersion) -ForegroundColor Green
Write-Host '  ==================================================' -ForegroundColor Green
Say ('  SillyTavern: ' + $targetSt + '  (v' + $StVersion + ')') 'White'
Say ('  扩展目录:   ' + $extResult.ExtensionDir) 'White'
if (-not $npmOk) { Warn '依赖未完全安装：首次启动时 Start.bat 会自动重试（或手动运行 npm install）。' }
if (-not $patchOk) { Warn 'ST 补丁未应用：dsh-swipe-shots 角度图 / 写词稳定器钩子可能不生效（可手动跑 patches/apply.mjs）。' }
Say ''
Say '  启动方式: 双击桌面「SillyTavern DSH」快捷方式，或运行 ST 目录下的 Start.bat。' 'White'
Say '  首次启动会初始化 data 并自动带上这 13 个扩展；刷新页面即可在 Extensions 面板看到。' 'DarkGray'
Say '  卸载: 删除 extensions 下对应的 13 个文件夹、删除安装记录与快捷方式；若为安装器新装的 ST，可直接删整个 ST 目录。' 'DarkGray'
Say '  注意: 角度配图扩展需要 v1 的 ST 补丁，未打补丁时仅提示词隐藏可用。' 'DarkGray'
Say ''
Say ('  日志: ' + $Script:LogPath) 'DarkGray'
Write-Host ''
$global:InstallerExitCode = 0; return
