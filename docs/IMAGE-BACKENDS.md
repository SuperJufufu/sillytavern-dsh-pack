# 生图后端：可选 / 可替换

> 本包**不强制**本地 SDXL。出图相关扩展（`dsh-swipe-shots` / `dsh-auto-avatar` / `qwen-bg` / `dsh-image-fold` 的重绘）
> 在拿不到出图后端时会自动降级（不报错、不影响聊天/其它扩展）。
> `patches/` 全部可选：安装器 `--no-patches` 或手动跳过即可。

## 默认链路（本地 SDXL + ComfyUI）

```
ST 前端扩展 ──► ST 内置 Stable Diffusion 扩展 ──► ComfyUI（SDXL workflow）──► 图片消息
        └─ patches/sd-angle 提供 __DSH_SD_ANGLE_*（角度图用）
```

- ComfyUI 地址：ST 生图扩展设置里的 `ComfyUI URL`（默认 `http://127.0.0.1:8188`，桥接时 `8189`）。
- 本包不包含 ComfyUI / 模型文件；需要自己安装并自备 checkpoint。

## 替换方式一：换本地模型（不改本包代码）

ComfyUI 支持 SD1.5 / SDXL / Illustrious / Pony / Flux / Qwen-Image 等，只要：

1. 在 ComfyUI 里装好对应 checkpoint / 工作流；
2. 在 ST 的 Stable Diffusion 扩展里把 **工作流** 指向你的工作流（或改 ComfyUI 默认工作流）；
3. 确保工作流末尾有 `SaveImage` 节点（ST 通过 ComfyUI HTTP API 轮询 `/history` 取图）；
4. 若换掉 SDXL，`dsh-prompt-stable` 的写词模板/标签风格可能需要按模型微调（面板可改）。

> 换模型不需要改本包任何代码；`patches/sd-angle` 只依赖 SD 扩展的 `generatePicture` / `generatePrompt` 锚点，
> 与具体 checkpoint 无关（锚点不匹配时补丁会安全失败，不会破坏文件）。

## 替换方式二：云端生图 API（自定义后端）

角度图扩展 `dsh-swipe-shots` 的入口是 `window.__DSH_SD_ANGLE_GENERATE(kind)`；
你可以在 ST 里用自己的一段脚本**覆盖它**，改调云端或其它本地服务：

```js
// 伪代码（完整骨架见 examples/cloud-image-adapter.example.js）
window.__DSH_SD_ANGLE_GENERATE = async (kind) => {
  const c = SillyTavern.getContext();
  const prompt = buildPromptFromRecentChat(kind);      // 由你决定怎么从聊天生成提示词
  const image = await fetchCloudImage({ prompt });     // 返回 dataURL / 本地路径
  const msg = { name: c.name2, is_user: false, is_system: false, mes: '',
                send_date: Date.now(), extra: { image, inline_image: false } };
  c.chat.push(msg); c.addOneMessage(msg);
  await fetch('/api/chats/save', { method: 'POST', headers: c.getRequestHeaders(),
    body: JSON.stringify({ file_name: c.chatId, avatar_url: c.characters[c.characterId]?.avatar, chat: c.chat, force: false }) });
};
```

注意事项：
- 云端 API key 不要写进公开仓库；放 ST 的扩展设置 / 环境变量 / 本地文件。
- 图片格式：`extra.image` 可传 `data:image/...;base64,...` 或 `/user/images/...png`（后者需先把文件写进 ST 的 user images 目录）。
- 并发/排队：云端无需 GPU 排队，但 `dsh-gpu-queue` 不会知道；如需排队请在适配器里自行串行。
- 合规：云端服务的内容政策由你自选的服务决定；本包不含任何成人内容。

## 替换方式三：其它本地服务（ComfyUI 兼容）

任何实现 ComfyUI HTTP API（`/prompt`、`/history/<id>`、`/view`）的本地服务都可以：
把 ST 生图扩展的 ComfyUI URL 指向它即可；本包代码无需改动。

## 接口速查

| 接口 | 提供方 | 说明 |
|---|---|---|
| `window.__DSH_SD_ANGLE_GENERATE(kind)` | `patches/sd-angle`（SD 扩展内） | 出 1 张角度图（`scene` / `closeup`）并写入聊天；可被自定义脚本覆盖 |
| `window.__DSH_SD_ANGLE_HINTS` | 同上 | 镜头提示词表 |
| ST 生图扩展 `generatePicture()` | SillyTavern 内置 | 普通 `/imagine` 链路 |
| ComfyUI `/prompt`、`/history/<id>` | ComfyUI | SD 扩展/桥接使用的 HTTP API |

## 安全

- 补丁只改 ST 源码的固定锚点；`apply.mjs --check` 可随时检查状态。
- 未打补丁 / 未装 SD 扩展时：`dsh-swipe-shots` 仍会加载，提示词隐藏可用，角度图跳过。
