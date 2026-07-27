// 生产服务器：同时托管静态产物（dist/）与后端 API（wardrobe + responsive-image）。
// 复用 vite.config 中插件的 configurePreviewServer，因此无需重复挂载路由。
// 运行：node prod-server.mjs  （PORT 默认 4173，HOST 默认 0.0.0.0）
import { preview } from "vite";

const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "0.0.0.0";

const server = await preview({
  preview: {
    host,
    port,
    strictPort: false,
    // 允许任意 Host 头（部署到自有域名 / PaaS 时无需逐一配置）
    allowedHosts: true,
  },
});

const addr = server.httpServer?.address();
const actualPort = addr && typeof addr === "object" ? addr.port : port;
console.log(`✓ 网络衣橱生产服务已启动: http://${host}:${actualPort}`);
console.log("  前端静态产物(dist) 与 /api/* 后端接口均由本进程提供。");
console.log("  依赖 .env 中的 API Key 与 data/ 目录持久化，请在上线环境中确保两者可用。");
