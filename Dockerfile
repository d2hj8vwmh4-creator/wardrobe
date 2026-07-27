FROM node:20-slim

WORKDIR /app

# 仅复制依赖清单先安装，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install

# 复制源码并构建静态产物（dist/）
COPY . .

# 注意：.dockerignore 已排除 .env，运行时请通过平台环境变量注入 API Key
RUN npm run build

ENV PORT=4173
ENV HOST=0.0.0.0

EXPOSE 4173

# 生产入口：同一进程托管前端(dist) + 后端(/api/*)
CMD ["npm", "start"]
