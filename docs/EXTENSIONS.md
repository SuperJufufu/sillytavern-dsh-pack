# 扩展明细（v0.3 · 13 个）

> 版本对应 v0.3 导出状态（2026-11-08）。所有扩展均为纯前端/ST 扩展，删除文件夹即可卸载。
> 依赖补丁的扩展会在「补丁」一列标注（见 `patches/README.md`）。

## 加载顺序

`loading_order` 小的先加载。本包已排好：
`dsh-gpu-queue`(1) → `dsh-model-config`(5) → `ui-simplify`(200) → `qwen-bg`(210) →
`dsh-gen-guard`(250) → `chat-namer`(250) → `dsh-auto-avatar`(260) → `dsh-chat-thumbs`(270) →
`dsh-prompt-stable`(996) → `dsh-swipe-shots`(997) / `dsh-text-semantics`(997) / `dsh-image-fold`(998) /
`dsh-fast-stream`(999)。

---

## 1. dsh-fast-stream（DSH 流式加速）v1.0.0

- **作用**：强制关闭 ST 的 Smooth Streaming（按 token 加延迟，等于限速），刷新率拉到 100。
- **配置**：无面板；删文件夹恢复原设置。**依赖**：无。

## 2. dsh-text-semantics（DSH 文本语义配色）v1.1.0

- **作用**：按语义给正文分色：斜体=环境叙述（暖金）、对白（亮橙）、加粗=内心（亮紫）、
  下划线=动作（亮青）、等宽=系统标记（亮蓝）；行高 1.8、正文 15px。
- **注意**：纯显示层；依赖 ST 的 3 条 `DSH 语义-*` 正则（可在 ST 正则面板补）。**依赖**：无。

## 3. ui-simplify（界面精简）v2.4.0

- **作用**：聊天/首页内容区 95vw、右侧面板 76vw；左侧图标按钮、右侧折叠、首页隐藏对话类按钮、防自动跳底。
- **注意**：纯 UI 改造，可能和自定义主题/CSS 互相覆盖。**依赖**：无。

## 4. dsh-gen-guard（DSH 生成看门狗）v1.1.1

- **作用**：检测「生成中」卡死并自动解锁，诊断写进聊天元数据；给 `dsh-image-fold` 提供 `sdBusy()` 信号。
- **依赖**：无。

## 5. dsh-image-fold（DSH 图片折叠）v1.1.4

- **作用**：把聊天里的生成图折叠成一条小消息（缩略条 + 重绘/删除）；点开看大图，Esc 关闭。
- **注意**：删除会连磁盘文件一起删（不可撤销），建议先备份 `data/default-user/user/images`。
- **依赖**：ST 的 SD 出图链路（ComfyUI/桥接）。

## 6. dsh-model-config（DSH 本地模型配置）v1.0.1

- **作用**：把记忆表格/角色卡更新用的 LLM 指向本地 Ollama，并给 Ollama 请求补 `reasoning_effort: none`。
- **默认**：`http://127.0.0.1:11434`、`gemma4-e4b-ctx8k:latest`。**依赖**：本地 Ollama（可选）。

## 7. dsh-gpu-queue（DSH 重任务排队）v1.0.0

- **作用**：生图（SDXL）、背景图（Qwen）、本地 LLM 三类重任务串行，避免同时抢 GPU；小模型检测不受影响。
- **识别**：按端口 `8188 / 8189 / 11434`；改端口请同步正则。**依赖**：无。

## 8. dsh-swipe-shots（DSH 角度配图）v1.1.0

- **作用**：每条 AI 回复后按内容生成 2 张不同角度图（`scene` 广角 + `closeup` 近景），
  并隐藏系统图片消息里的提示词文字；手动滑到旧回复时按该回复重出角度图。
- **依赖**：`patches/sd-angle`（必需，提供 `__DSH_SD_ANGLE_*`）+ ComfyUI。
- **未打补丁**：扩展正常加载，提示词隐藏可用，角度图不生成。

## 9. chat-namer（对话自动命名（DeepSeek））v2.1.0

- **作用**：用 ST 当前模型给对话起中文标题；打开旧对话补命名，之后每 5 轮更新；手改过的不再自动改；本地小模型兜底。
- **默认**：`engine: main`、`updateEveryN: 5`、`maxChars: 18`；本地兜底 `http://127.0.0.1:8030` + `qwen3-1.7b`。
- **注意**：标题过滤（拒绝含性词汇的标题）是防御性逻辑，不是成人内容。

## 10. dsh-chat-thumbs（聊天列表（封面 + 预览））v1.3.1

- **作用**：欢迎页 Recent Chats 用聊天里的场景插画作封面；预览清洗生图提示词/占位符、标题去重、相对时间、折叠条数。
- **注意**：`map.json` 是运行时生成的数据，**不随包分发**；首次使用会现场读取聊天里的【场景插画】消息自愈。
- **依赖**：无。

## 11. dsh-prompt-stable（DSH 写词稳定器）v1.2.0

- **作用**：条件宏写词模板 + 聊天内状态变量（场景/人物/镜头）+ 全局外观核心标签自动维护（切聊天/角色卡/人格/
  世界书/每 N 条/写词前刷新，纯本地不算 LLM）+ 写词缓存 + 规则兜底 + 思考折叠。
- **v1.2.0 公开版配置**：面板可填「外观世界书名单」（逗号分隔；留空=只用角色卡/人格绑定的书）、
  「角色别名 JSON」（如 `{"旁白":"Narrator"}`）；默认模板不含任何成人内容。
- **依赖**：`patches/sd-stable-writer`（写词钩子）；未打补丁时仍可作为普通写词模板/兜底扩展使用。

## 12. dsh-auto-avatar（自动画头像（SDXL））v1.0.1

- **作用**：新会话第一轮自动给正文最先出现的角色画头像并替换角色卡头像（旧图备份到 `user/files`）。
- **v1.0.1 公开版配置**：`drawPersona` 默认关；`lorebooks`（世界书名单，默认空=只用角色卡描述）；
  `chatScopeTag`（可选对话隔离标记，默认空=不隔离）；`skipNames`（追加的「非角色」名字，逗号分隔）；
  ComfyUI 桥接地址常量 `DEFAULT_COMFY_URL`。
- **依赖**：`patches/sd-angle`（或 SD 出图链路）+ ComfyUI。

## 13. qwen-bg（背景图（先判断场景，变了才换））v3.4.2

- **作用**：每条回复后判断场景是否变化（ST 主模型，本地小模型可兜底），变了才生成新背景；
  每段聊天单独记住场景/背景；角色图出图时背景排队；换新背景后删除被替换的旧背景（别处在用则保留）；可设主页固定背景。
- **v3.4.2 公开版配置**：`DEFAULT_COMFY_URL` / `DEFAULT_DETECTOR_URL` 常量（面板可覆盖）；
- **v3.4.2 判断质量**：prompt 增加两条 RULE（changed=true 必须写新地点、changed=false 沿用旧词）+ 示例改成互不相同的两个场景，防止小模型照抄示例；实测把「场景关键词正确更新率」从 1/5 提到 4/5（qwen3-1.7b）
  `homeBg` 默认空、`homeBgEnabled` 默认关（需自己选图）；不再带任何成人词表清洗。
- **依赖**：ComfyUI（8188/8189）+ 可选本地判断模型（8030）。

---

## 补丁映射（见 `patches/`）

| 扩展 | 必需补丁 | 说明 |
|---|---|---|
| `dsh-swipe-shots` | `sd-angle` | 提供 `__DSH_SD_ANGLE_HINT/_GENERATE/_READY/_HINTS` |
| `dsh-prompt-stable` | `sd-stable-writer` | SD 写词链路接入稳定器钩子 |
| （所有扩展） | `util-save` | 聊天保存偶发 EPERM 修复，提升稳定性 |

其余补丁（quick-reply / deepseek-reasoning）如存在，默认是否应用以 `patches/apply.mjs --list` 为准。
