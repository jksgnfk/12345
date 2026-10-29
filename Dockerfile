# 宸阳书院报销系统 · 微信云托管后端容器
FROM node:18-bullseye-slim

WORKDIR /app

# 安装编译工具链：wx-server-sdk 依赖链中可能包含需要编译的 native 模块，
# 缺少 gcc/python 会导致 npm install 失败、构建中断。加上以最大化构建成功率。
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用层缓存）
COPY server/package.json ./package.json
RUN npm install --production --no-audit --no-fund

# 再拷贝源码
COPY server/ ./

EXPOSE 3000
CMD ["node", "index.js"]
