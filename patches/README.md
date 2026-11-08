# patches/ —— SillyTavern 1.19.x 补丁（AGPL-3.0）

> 这些脚本修改 SillyTavern 源码，属于对 AGPL-3.0 作品的修改，因此以 **AGPL-3.0** 发布
> （全文见 `LICENSE-AGPL-3.0`）。扩展本身仍是 MIT；两者边界清晰。

## 包含的补丁

| id | 默认应用 | 修改文件 | 作用 |
|---|---|---|---|
| `sd-angle` | ✅ | `public/scripts/extensions/stable-diffusion/index.js` | 角度配图接口：`__DSH_SD_ANGLE_HINT/_GENERATE/_READY/_HINTS` |
| `sd-stable-writer` | ✅ | 同上 | 写词稳定器钩子：`__DSH_PROMPT_STABLE.writePrompt` / 空回复兜底 |
| `util-save` | ✅ | `src/util.js` | 聊天保存 EPERM/EBUSY 重试（原子写失败回退直接写） |
| `quick-reply` | ⬜ 可选 | `public/scripts/extensions/quick-reply/index.js` | 系统消息不触发 `executeOnAi`（行为变更，默认不应用） |
| `deepseek-reasoning` | ⬜ 可选 | `src/endpoints/backends/chat-completions.js` | DeepSeek Reasoning Effort 取值映射（厂商专用，默认不应用） |

## 用法

```bash
node apply.mjs --st "<SillyTavern 目录>"            # 应用默认补丁（幂等）
node apply.mjs --st "<SillyTavern 目录>" --check    # 只检查（0=已应用/可应用）
node apply.mjs --st "<SillyTavern 目录>" --dry-run  # 只预览
node apply.mjs --st "<SillyTavern 目录>" --only sd-angle
node apply.mjs --list                               # 列出全部补丁
```

- 适用版本：**SillyTavern 1.19.x**（在 1.19.0 上测试）。
- **幂等**：重复运行只会报告「已应用（跳过）」。
- **安全**：改前把原文件备份到 `<ST>/.dsh-pack-patch-backups/<时间戳>/`（保留相对路径）；
  内存里改完先 `node --check`，全部通过才落盘；锚点断言失败则整体失败、不写任何文件。
- 恢复：把备份目录里的文件按相对路径覆盖回 ST 即可。

## 安装器集成

一键安装包（`installer/install.ps1`）会在装完扩展后自动调用：

```
node <安装包临时目录>\patches\apply.mjs --st "<ST>"
```

- `--no-patches` 可跳过；补丁失败只警告，不影响扩展安装。
- 安装记录 `%APPDATA%\SillyTavern-DSH-Pack\install.json` 里有 `patchesApplied` 字段。

## 自测

```bash
node test/selftest.mjs
```

`selftest.mjs` 会在系统临时目录里复制 stock 1.19.0 的目标文件，验证：首次应用、二次幂等、
`--check`、锚点破坏时安全失败、`node --check`、CRLF 保留等（详见脚本输出）。
