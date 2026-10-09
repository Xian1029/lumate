# Lumate 部署说明

本文档描述 Lumate 二开版在已有 OpenTutor ECS 主机上的隔离部署方式。部署包包含三个服务：Next.js 前端、FastAPI 后端和 Redis。SQLite 数据库、上传文件和 Redis 数据都保存在 Lumate 专用 Docker 命名卷中，容器重建不会丢失学习空间数据，也不会触碰现有 `opentutor-*` 容器、网络或数据卷。

本部署文件固定使用以下隔离资源：

- Compose 项目：`lumate-customized`
- 容器：`lumate-customized-web`、`lumate-customized-api`、`lumate-customized-redis`
- 网络：`lumate-customized-network`
- 数据卷：`lumate-customized_data`、`lumate-customized_uploads`、`lumate-customized_redis`
- 前端端口：宿主机 `3003` → 容器 `3001`
- API 端口：宿主机回环地址 `127.0.0.1:8001` → 容器 `8000`

默认 `docker-compose.yml` 与专用的 `docker-compose.deploy.yml` 都已使用 Lumate 隔离命名；即使误执行 `docker compose up -d`，也不会创建或替换 `opentutor-*` 容器。生产 ECS 仍推荐显式使用 `docker-compose.deploy.yml`。

## 部署前需要准备

- 一台安装 Docker Engine 24+ 和 Docker Compose v2 的 Linux/macOS/Windows 主机。
- 一个可用的 LLM 服务及对应密钥。默认示例使用 DeepSeek，也可以改成项目支持的其他 provider。
- 一个至少 32 个字符的 JWT 密钥。
- 一个 Fernet 加密密钥，用于生产环境敏感数据加密。
- 若要启用代码运行题，需要允许 API 容器访问 Docker socket；不需要代码运行时可以切换到项目支持的其他沙箱方案。

## 首次部署

```bash
cp deploy/.env.production.example deploy/.env.production

# 生成 JWT_SECRET_KEY
openssl rand -hex 32

# 生成 ENCRYPTION_KEY（需要 Python cryptography 依赖）
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 将上面两条命令的结果和 LLM API key 写入 deploy/.env.production
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml up -d --build

# 确认没有复用 OpenTutor 的容器
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml ps
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -E 'lumate-customized|opentutor' || true
```

`deploy/.env.production` 只存在于部署主机，不要提交到 Git。首次启动会创建数据库表和系统初始数据；之后可将 `APP_AUTO_CREATE_TABLES` 与 `APP_AUTO_SEED_SYSTEM` 改为 `false`，再执行 `docker compose ... up -d`。

## 验证与日常运维

```bash
# 查看服务状态
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml ps

# 后端存活检查（API 仅绑定到本机回环地址）
curl http://127.0.0.1:${API_PORT:-8001}/api/health/live

# 前端地址：http://localhost:${WEB_PORT:-3003}

# 查看日志
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml logs -f api web

# 更新代码后重新构建
git pull --ff-only origin main
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml up -d --build

# 停止服务（不删除数据卷）
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml down
```

只应将 Web 端口暴露到公网；API 端口默认绑定 `127.0.0.1`，由 Next.js 服务端代理 `/api/*`。如果部署在反向代理（Nginx、Caddy 或云负载均衡）之后，请把 `CORS_ORIGINS` 改为实际的 HTTPS 域名，并按需设置 `TRUST_PROXY_HEADERS=true`。

## 备份与恢复

停止或暂停写入后，备份以下两个卷：`lumate-customized_data`（SQLite 数据库、学习空间和进度）以及 `lumate-customized_uploads`（教材和解析产物）。

```bash
docker run --rm -v lumate-customized_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/lumate_customized_data.tgz -C /data .
docker run --rm -v lumate-customized_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/lumate_customized_uploads.tgz -C /data .
```

恢复前先停止 Compose，再将对应压缩包解压回同名卷。不要删除 `lumate-customized_data` 或 `lumate-customized_uploads`，否则会清空学习空间数据和教材文件。

## 常见问题

- **API 容器反复重启**：查看 `logs api`。生产环境必须设置 `JWT_SECRET_KEY` 和 `ENCRYPTION_KEY`，并且长度/格式正确。
- **AI 提示服务不可用**：确认 `LLM_PROVIDER`、对应 API key、模型名和网络出口；`LLM_REQUIRED=true` 时不会使用模拟回复。
- **上传大 PDF 失败**：确认 `MAX_UPLOAD_SIZE_MB`，同时保证反向代理的请求体限制不小于该值。内置 Next.js 代理已将上限设为 550 MB。
- **代码运行题不可用**：确认 Docker socket 路径和 `CODE_SANDBOX_BACKEND=container`；不要在生产环境随意开启 `ALLOW_INSECURE_PROCESS_SANDBOX=true`。
- **页面能打开但 API 失败**：检查 `CORS_ORIGINS` 是否精确包含当前浏览器地址，并确认 `api` 健康检查为 `healthy`。
