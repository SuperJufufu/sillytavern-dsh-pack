# SillyTavern DSH Pack —— 一键安装器

> 双击 `SillyTavern-DSH-Pack-Setup-v0.3.0.cmd` 即可。安装器会：
> 1. 检测本机是否已有 **SillyTavern 1.19.0**（有就不下载本体）；
> 2. 没有就自动下载 ST 1.19.0 源码包（GitHub tag，约 36.7 MB），解压到安装目录；
> 3. 检测/自动准备 Node.js（ST 1.19 要求 Node >= 20；没有就下载便携版到本地，无需管理员）；
> 4. 安装 13 个扩展到 `<ST>/data/default-user/extensions/`（已存在同版本会跳过；旧版本先备份）；
> 5. 执行依赖安装（`npm install --omit=dev`，与 ST 自带 Start.bat 一致）；
> 6. 在桌面创建「SillyTavern DSH」快捷方式。

## 目录

```
installer/
├── bootstrap.cmd     # 单文件安装包的 bootstrap 模板（ASCII，占位 @@PSB64@@ 与 ::PAYLOAD）
├── install.ps1       # 主安装逻辑（UTF-8 with BOM，由 bootstrap 调用）
└── README.md         # 本文件
tools/
└── build-installer.mjs   # 构建单文件安装包（node tools/build-installer.mjs）
```

## 构建

```bash
node tools/build-installer.mjs
# 产物：dist/SillyTavern-DSH-Pack-Setup-v0.3.0.cmd（约 600 KB）
```

构建原理：把 `installer/install.ps1` + `extensions/**` + `patches/**` + `LICENSE` + `NOTICE` 打成 ZIP（store，无依赖），
base64 后追加到 `bootstrap.cmd` 的 `::PAYLOAD` 行后；bootstrap 里内嵌一段用 `-EncodedCommand` 执行的
短 PowerShell，负责解出 payload 并把命令行参数转发给 `install.ps1`。

- `dist/` 已加入 `.gitignore`；**安装包上传到 GitHub Releases，不提交进仓库**。
- 构建会自动给 `install.ps1` 补 UTF-8 BOM（PowerShell 5.1 读中文所需）。

## 安装器参数（调试/自动化用）

```
--st-path <dir>      指定已有 ST 目录（跳过自动检测）
--install-dir <dir>  新装 ST 的目标目录（默认 %LOCALAPPDATA%\SillyTavern-DSH\SillyTavern）
--data-root <dir>    指定 data 根（默认 <ST>/data）
--st-version <ver>   目标 ST 版本（默认 1.19.0）
--from-zip <path>    用本地 ST zip 代替下载
--mirror <prefix>    下载镜像前缀（例如 https://ghproxy.net/）
--node-version <v>   指定 Node 版本（默认自动选最新 LTS）
--check-only         只检测：0=已找到对应版本，2=未找到，3=版本不符
--dry-run            只打印计划，不写文件
--skip-npm           跳过 npm install
--no-patches         跳过 ST 补丁
--no-shortcut        不创建桌面快捷方式
--no-detect          跳过自动检测（强制按 --install-dir 新装）
--no-node-download   缺 Node 时报错而不是自动下载
--no-record          不写安装记录（测试用）
--yes                自动确认（无人值守）
--help               显示帮助
```

## 下载实现说明

- 优先用 **Windows 自带的 `curl.exe`**（`%SystemRoot%\System32\curl.exe`）：
  PowerShell 5.1 的 `Invoke-WebRequest` 在部分网络/系统上访问 GitHub 会 TLS 重置（`基础连接已经关闭`）。
- curl 不可用或失败时回退 `Invoke-WebRequest`。
- 支持 `--mirror`（如 `https://ghproxy.net/`）与 `--from-zip`（完全离线）。

## 安全说明

- 安装器**只写入**：新装 ST 目录、`<ST>/data/default-user/extensions/`、ST 补丁文件（改前备份）、安装记录
  `%APPDATA%\SillyTavern-DSH-Pack\install.json`、桌面快捷方式；不做系统级修改、不需要管理员。
- 扩展旧版本会被移动到 `<data>/default-user/.dsh-pack-backups/<时间戳>/` 再覆盖。
- 下载只用 HTTPS；ST 来自 `github.com/SillyTavern/SillyTavern` 的 tag 源码包，解压后校验 `package.json` 版本。
- 安装器不包含、也不下载任何成人内容；扩展包本身是「去成人内容」版本；补丁脚本为 AGPL-3.0。
- 日志：`%TEMP%\dsh-pack-install-*.log`。
