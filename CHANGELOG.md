# Changelog

## v0.3 — 2026-11-08

### 新增扩展（9 → 13）

- `dsh-chat-thumbs` v1.3.1：聊天列表封面 + 预览清洗（泛化：不打包运行时 `map.json`，去私有角色名示例）
- `dsh-prompt-stable` v1.2.0：写词稳定器（泛化：角色别名/外观世界书名可配置；删除成人向默认模板与私有角色逻辑）
- `dsh-auto-avatar` v1.0.1：自动画头像（泛化：`lorebooks`/`chatScopeTag`/`skipNames` 可配置，persona 默认关，去成人词表与私有角色）
- `qwen-bg` v3.4.1：背景图（泛化：桥接/判断地址常量，去私有主页图与成人词表，主页背景默认关）

### 新增 ST 补丁（AGPL-3.0）

- `patches/apply.mjs` 统一入口（`--st` / `--dry-run` / `--check` / `--only` / `--list`）
- `patches/sd-angle.mjs`：SD 角度配图接口
- `patches/sd-stable-writer.mjs`：写词稳定器钩子
- `patches/util-save.mjs`：聊天保存 EPERM 修复
- （可选）`patches/quick-reply.mjs` / `patches/deepseek-reasoning.mjs`
- 补丁改前自动备份到 `<ST>/.dsh-pack-patch-backups/<时间戳>/`，幂等、`node --check` 校验
- `patches/LICENSE-AGPL-3.0` 全文

### 安装器（v0.3.0）

- 安装 13 个扩展 + **自动应用 ST 补丁**（`--no-patches` 可跳过）
- 安装记录新增 `patchesApplied`
- 安装包仍为单文件 `SillyTavern-DSH-Pack-Setup-v0.3.0.cmd`

### CI / Release

- `.github/workflows/ci.yml`：push/PR → 敏感内容扫描 + 语法检查 + 构建安装包（artifact）
- `.github/workflows/release.yml`：`v*` tag / 手动 dispatch → 构建并创建 Release，自动附加安装包

### 清理

- 公开 pack 不包含任何用户数据/角色名/成人内容；扫描器 `node scripts/scan-sensitive.mjs` PASS

### 验证（Windows 11 + PowerShell 5.1）

- `patches/apply.mjs`：在 stock 1.19.0 副本上初始应用成功、二次幂等、`--check` exit 0；
  live 副本检测为「已应用」；锚点破坏时安全失败不写文件；`node --check` 全过（队友 selftest 15/15）。
- 安装器（v0.3.0）在假 ST 副本上：13/13 扩展安装成功；自动应用 `sd-angle` / `sd-stable-writer` / `util-save`，
  备份落在 `<ST>/.dsh-pack-patch-backups/<时间戳>/`；二次运行幂等；`--check` exit 0。
- 安装器失败路径：ST 目录缺 `src/` 时补丁警告但扩展照装（exit 0）；`--no-patches` 正确跳过。
- **安装器真实下载**：`--no-detect --install-dir` → 下载 ST 1.19.0（36.7 MB）→ 解压 → 13/13 扩展 + 3 个补丁（SD 文件 15 处 ANGLE 钩子、util.js 2 处 DSH PATCH、3 个备份）→ rc=0。
- **干净环境加载**（全新 dataRoot + ST 1.19.0）：
  `/api/extensions/discover` 返回 13/13 本地扩展；无头 Chrome 加载页面后 13/13
  `third-party/*/index.js` 已执行，`dsh-prompt-stable` 面板已构建，无本包扩展异常
  （唯一 exception 是 ST 自带 horde.js 的外网请求失败，离线环境正常现象）。
- `node scripts/scan-sensitive.mjs` PASS；全部扩展/补丁/脚本 `node --check` 通过。

## v0.2 — 2026-11-08

新增**单文件一键安装包**（`SillyTavern-DSH-Pack-Setup-v0.2.0.cmd`，约 229 KB）。

### 新增

- `installer/bootstrap.cmd`：单文件安装包模板（ASCII，自解压 payload）。
- `installer/install.ps1`：主安装逻辑（UTF-8 with BOM）：
  - 自动检测本机 SillyTavern 1.19.0（有则**不下载本体**）；
  - 没有则下载 ST 1.19.0 源码包（GitHub tag，约 36.7 MB）并解压；
  - 检测 Node.js（>= 20），缺失时自动下载便携版（无需管理员）；
  - 安装 9 个扩展（同版本跳过；旧版本备份后覆盖）；
  - `npm install --omit=dev`（与 ST 自带 Start.bat 一致）；
  - 创建桌面快捷方式、写安装记录。
- `tools/build-installer.mjs`：把安装器 + 扩展 + LICENSE/NOTICE 打成 ZIP，
  base64 后拼进 bootstrap，产出单文件安装包（无第三方依赖）。

### 改进

- 下载走 Windows 自带 `curl.exe`（PowerShell 5.1 的 `Invoke-WebRequest` 在 GitHub 上会 TLS 重置），
  失败时回退 `Invoke-WebRequest`；支持 `--mirror` 镜像前缀与 `--from-zip` 离线安装。
- 支持参数：`--st-path` / `--install-dir` / `--data-root` / `--st-version` / `--check-only` /
  `--dry-run` / `--skip-npm` / `--no-shortcut` / `--no-detect` / `--no-node-download` /
  `--no-record` / `--yes` / `--help`。
- 安装器退出码：0 成功、1 错误、2 未找到 ST（check-only）、3 版本不符（check-only）。

### 验证（Windows 11 + PowerShell 5.1）

- `--check-only`：找到本机 ST 1.19.0 → 0；版本不符 → 3；未找到 → 2（命令说明一致）。
- `--dry-run`：打印计划，0 写入。
- 真实安装到假 ST 目录：9/9 扩展就位，退出 0。
- `--from-zip` 全新安装：解压 v1.19.0 + 9/9 扩展，退出 0。
- **真实下载安装**：从 GitHub 下载 ST 1.19.0（36.7 MB）、解压、装 9 扩展，退出 0。
- 所有测试均未改本机 live ST 数据、未创建桌面快捷方式/安装记录（测试参数已关闭）。

## v0.1 — 2026-11-08

初始公开版本（从 live SillyTavern 1.19.0 的扩展目录导出，去个人内容后发布）。

### 包含

- 9 个自研前端扩展（见 `README.md` / `docs/EXTENSIONS.md`）
- `scripts/scan-sensitive.mjs`：发布前敏感内容扫描器（无依赖）

### 清理

- `chat-namer/index.js` 注释里的个人角色名示例改为通用「角色名」
- 不含任何用户数据：无聊天、角色卡、世界书、图片、API key、个人路径
- 不含成人向扩展（`adult-defaults`）与角色专属扩展（`narrator-lore`、`sd-appearance`）
- 不含第三方扩展（JS-Slash-Runner / AutoCardUpdaterExtension / st-memory-enhancement）
- 不含对 SillyTavern 源码的补丁（计划 v1 以 AGPL-3.0 单独提供）

### 验证

- `node scripts/scan-sensitive.mjs` → **PASS（0 命中）**
- 所有 `extensions/*/index.js` 通过 `node --check`
- 8 个扩展与 live 源文件逐字节一致；`chat-namer` 仅注释一处差异
