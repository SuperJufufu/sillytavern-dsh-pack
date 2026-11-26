# web-bridge（可选）

`dsh-web` 扩展的本地搜索/抓页服务。不依赖任何 API key。

```bash
node tools/web-bridge/server.mjs
# 默认 http://127.0.0.1:8796
```

接口：

- `GET /health`
- `GET /search?q=...&n=4`：Bing RSS，返回 title/link/snippet
- `GET /read?url=...`：抓取网页正文（去脚本样式，最多 14000 字）

只监听 127.0.0.1；不会上传任何本地数据。
