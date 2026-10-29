# 宸阳书院报销系统 · 微信云托管后端容器
FROM node:18-bullseye-slim

WORKDIR /app

# 先装依赖（利用层缓存）
COPY server/package.json ./package.json
RUN npm install --production

# 再拷贝源码
COPY server/ ./

EXPOSE 3000
CMD ["node", "index.js"]
