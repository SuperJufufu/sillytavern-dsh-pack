# examples/

这里放**可选**的后端替换示例，不随安装包分发（安装包只含 `extensions/` + `patches/`）。

- `cloud-image-adapter.example.js`：把 `dsh-swipe-shots` 的出图后端换成云端生图 API 的骨架。
  用法：修改配置后，作为 ST 的「Quick Reply / 扩展脚本」或浏览器控制台脚本加载；
  它只是在页面里定义 `window.__DSH_SD_ANGLE_GENERATE`，**不修改任何 ST 文件**。

⚠️ 示例没有绑定任何具体云厂商；请按你使用的 API 文档替换 `callCloudImage()` 里的请求。
⚠️ 不要把 API key 提交到仓库。
