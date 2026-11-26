# 联网搜索（dsh-web）

给 SillyTavern 加一个「先搜网页、再回复」的入口。

## 组成

- 扩展：`extensions/dsh-web/`（安装器会装进 ST）
- 本地桥：`tools/web-bridge/server.mjs`（需要单独启动）

## 启动

```bash
node tools/web-bridge/server.mjs
```

默认监听 `http://127.0.0.1:8796`。可在扩展面板里改桥地址。

## 用法

- 输入框左侧地球按钮：输入查询 → 搜索并总结（结果显示在弹窗里，用 deepseek-flash，不触发角色）
- `/web 查询词`：搜索 + 抓前几页 + 注入本轮提示词
- `/read https://...`：只抓这一页并注入

## 说明

- 搜索走 Bing RSS；抓页是直接 HTTP GET，不需要 key
- 弹窗里的总结不会写进聊天记录；可点「插入输入框」再自己发
- `/web` 仍会注入本轮 prompt 并触发一次生成（适合让角色结合资料演）
- 角色卡人格很强时，模型可能仍然按角色口吻回答；需要纯事实回答时可在提示里加「先直接回答，不要演」
