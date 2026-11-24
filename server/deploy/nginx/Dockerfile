# 管理后台镜像：第一阶段构建 RuoYi-Vue3 静态文件，第二阶段用 Nginx 托管并转发 /prod-api 到后端
FROM node:20-alpine AS build
ARG NPM_REGISTRY=
WORKDIR /ui
COPY ruoyi-ui/package.json ruoyi-ui/package-lock.json* ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm install --no-audit --no-fund
COPY ruoyi-ui ./
RUN npm run build:prod

FROM nginx:1.27-alpine
ENV TZ=Asia/Shanghai
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /ui/dist /usr/share/nginx/html
EXPOSE 80
