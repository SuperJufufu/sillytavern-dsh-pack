# 演示素材（docs/showcase）

> 对话与角色均为**虚构**，仅用于演示扩展的自动配图能力；图片由本地 SDXL 生成（生图后端可替换）。

## 角色绑定（固定角色设定）

为了让 `scene` / `closeup` / `avatar` 里的角色保持一致，演示图使用同一套角色描述：

| 角色 | 固定设定（中文） | 生成用英文 tag |
|---|---|---|
| **A（主角）** | 银色长发、蓝色眼睛、米色高领毛衣 | `1girl, silver long hair, blue eyes, beige turtleneck sweater` |
| **B（同伴）** | 黑色长直发、琥珀色眼睛、白色针织开衫 + 浅蓝背带裙 | `1girl, long black hair, amber eyes, white knit cardigan, light blue overall dress` |

场景固定：街角咖啡馆靠窗木桌、暖色午后光、咖啡杯。

## 文件

| 文件 | 说明 |
|---|---|
| `demo-chat.png` | ST 风格对话截图（虚构）：AI 回复后自动出 scene + closeup |
| `scene.jpg` | 自动生成：两人广角/场景图（A + B） |
| `closeup.jpg` | 自动生成：主角 A 近景（与 scene 同一角色） |
| `avatar.jpg` | 自动生成：主角 A 头像（同一角色） |
| `first-run-splash.png` | ST 1.19.0 启动 splash 实测：深色 + ST logo，无图片 |
| `first-run.png` | ST 1.19.0 首次欢迎弹窗实测：无背景图 / 无色图 |

## 可复现性

- 出图：本地 ComfyUI（SDXL），prompt 里对 A/B 使用同一套角色 tag；
- 演示只用于 README/截图，不参与扩展运行；换模型/换后端不影响扩展行为。

## README 轮播

- `carousel/01.png` … `05.png`：5 张 1600×1000 功能页（对话生图 / 角色卡 / 背景 / 角色栏 / 生图设置）。
- `carousel/carousel.gif`：同一组画面的来回播放版（5 页正放 + 3 页倒放，1.2s/页）。
- 生成脚本：`tools/make_carousel.py`（改 `frameN()` 即可换版式）。
