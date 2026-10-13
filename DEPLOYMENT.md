# Lumate 部署说明

本文档描述 Lumate 二开版在已有 OpenTutor ECS 主机上的隔离部署方式。部署包包含三个服务：Next.js 前端、FastAPI 后端和 Redis。SQLite 数据库、上传文件和 Redis 数据都保存在 Lumate 专用 Docker 命名卷中，容器重建不会丢失学习空间数据，也不会触碰现有 `opentutor-*` 容器、网络或数据卷。

本部署文件固定使用以下隔离资源：

- Compose 项目：`lumate-customized`
- 容器：`lumate-customized-web`、`lumate-customized-api`、`lumate-customized-redis`
- 网络：`lumate-customized-network`
- 数据卷：`lumate-customized_data`、`lumate-customized_uploads`、`lumate-customized_redis`
- 前端端口：宿主机 `3003` → 容器 `3001`
- API 端口：宿主机回环地址 `127.0.0.1:8001` → 容器 `8000`

默认 `docker-compose.yml` 与专用的 `docker-compose.deploy.yml` 都已使用 Lumate 隔离命名；即使误执行 `docker compose up -d`，也不会创建或替换 `opentutor-*` 容器。服务器上仍推荐显式使用 `docker-compose.deploy.yml`。

## 部署前需要准备

- 一台安装 Docker Engine 24+ 和 Docker Compose v2 的 Linux/macOS/Windows 主机。
- 一个可用的 LLM 服务及对应密钥。默认示例使用 DeepSeek，也可以改成项目支持的其他 provider。
- 一个至少 32 个字符的 CSRF 签名密钥；部署脚本可自动生成。默认开发模式不加载 CSRF 中间件，也无 JWT 登录；密钥供切换生产配置时使用。
- 一个 Fernet 加密密钥，用于敏感数据加密。
- 若要启用代码运行题，需要允许 API 容器访问 Docker socket；不需要代码运行时可以切换到项目支持的其他沙箱方案。

## 首次部署

Linux 推荐单命令部署（需要 Docker Engine、Compose v2 和 Python 3）：

```sh
sudo sh scripts/deploy.sh
```

脚本默认读取 `deploy/.env.development`，首次从 `deploy/.env.development.example` 创建；可继续用 `--env-file` 指定另一份配置，例如 `sudo sh scripts/deploy.sh --env-file deploy/.env.production`。生产文件首次从其示例创建；其他自定义文件需要先准备。不会借用根目录本地 `.env`。配置原子保存为权限 `600` 的文件，并保留旧文件备份。不同文件会切换同一套 Lumate 容器和数据卷，不会同时创建两套环境。脚本会生成或复用 CSRF 签名密钥；Fernet 加密密钥缺失时生成，已有密钥格式错误或与容器不一致时停止核对。缺少访问地址、模型名或 API Key 时会提示输入，API Key 隐藏输入。

默认配置为 `APP_ENVIRONMENT=development`、`AUTH_ENABLED=false`、`DEPLOYMENT_MODE=single_user`；已有开发配置中的模式字段会自动规范为这三个值，原文件备份且密钥保留。这种模式不验证 JWT，且不启用 CSRF 请求校验；所有访问者共用一个账号，已有多账号数据库会使用最早创建的账号。必须用防火墙、VPN 或反向代理访问控制限制使用者，不能将 Web 端口直接对所有人开放。显式指定生产配置可恢复生产环境的 CSRF 防护；若显式开启 JWT，需提供至少 32 字符的 `JWT_SECRET_KEY`。

它会校验 Compose 的容器与数据卷隔离范围，构建前后端镜像，在切换在线服务前测试一次真实 LLM 请求（会使用少量 API 额度），然后启动服务并等待 API、Web、Redis 全部健康。开发配置会在构建前和启动后分别核对 API 环境变量，确保实际运行的是开发单用户模式。API 容器不存在时会自动创建，已有容器则更新；同名镜像不再被当作容器。删除容器后原数据卷仍在，首次切换开发配置会尝试从旧 `deploy/.env.production` 恢复密钥与 LLM 配置；若找不到原加密密钥，脚本会在构建前停止，不能随意生成新密钥。LLM 不可用或健康检查失败会以非零状态退出。部署脚本不修改 Git 跟踪的源码，也不执行 Git 更新；重复部署仍使用同一批 Lumate 数据卷。

以下是供需要手动控制配置时使用的替代流程：

```bash
cp deploy/.env.development.example deploy/.env.development

# 生成 CSRF_SECRET_KEY（表单请求签名，与 JWT 登录无关）
openssl rand -hex 32

# 生成 ENCRYPTION_KEY（需要 Python cryptography 依赖）
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 将上面两条命令的结果和 LLM API key 写入 deploy/.env.development
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml up -d --build

# 确认没有复用 OpenTutor 的容器
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml ps
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -E 'lumate-customized|opentutor' || true
```

如果 API 日志出现 `sqlite3.OperationalError: unable to open database file`，请拉取包含数据卷权限修复的最新代码后，重新执行上面的 `up -d --build`。镜像会自动修复 Lumate 专用数据卷的权限；不要删除或重命名任何 `opentutor-*` 容器、网络或数据卷。

### 更新或重新配置云端 LLM

更新代码成功后重复运行部署脚本即可；需要更换模型供应商或 API Key 时：

```bash
sudo sh scripts/deploy.sh --configure
```

设置页保存的运行时 LLM 配置写入 `/app/data/runtime.env`，保存在 `lumate-customized_data` 卷中，容器重建后自动加载。旧脚本 `fix_llm_persistence.sh` 已移除。所有 Docker 操作仅属于 `lumate-customized`，不操作 `opentutor-*` 服务。若之前的旧脚本造成 Git 本地修改，先用 `git status` 检查并保留修改再拉取；不要把旧脚本恢复到新版上。

`deploy/.env.development` 只存在于部署主机，不要提交到 Git。首次启动会创建数据库表和系统初始数据；之后可将 `APP_AUTO_CREATE_TABLES` 与 `APP_AUTO_SEED_SYSTEM` 改为 `false`，再执行 `docker compose ... up -d`。

## 验证与日常运维

```bash
# 查看服务状态
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml ps

# 后端存活检查（API 仅绑定到本机回环地址）
curl http://127.0.0.1:${API_PORT:-8001}/api/health/live

# 前端地址：http://localhost:${WEB_PORT:-3003}

# 查看日志
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml logs -f api web

# 更新代码后重新构建
git pull --ff-only origin main
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml up -d --build

# 停止服务（不删除数据卷）
docker compose --project-name lumate-customized --env-file deploy/.env.development -f docker-compose.deploy.yml down
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

- **API 容器反复重启**：查看 `logs api`。所选部署配置必须设置 `CSRF_SECRET_KEY` 和 `ENCRYPTION_KEY`，并且长度/格式正确；仅开启 JWT 登录时才需 `JWT_SECRET_KEY`。
- **AI 提示服务不可用**：确认 `LLM_PROVIDER`、对应 API key、模型名和网络出口；`LLM_REQUIRED=true` 时不会使用模拟回复。
- **上传大 PDF 失败**：确认 `MAX_UPLOAD_SIZE_MB`，同时保证反向代理的请求体限制不小于该值。内置 Next.js 代理已将上限设为 550 MB。
- **代码运行题不可用**：确认 Docker socket 路径和 `CODE_SANDBOX_BACKEND=container`；不要在生产环境随意开启 `ALLOW_INSECURE_PROCESS_SANDBOX=true`。
- **页面能打开但 API 失败**：检查 `CORS_ORIGINS` 是否精确包含当前浏览器地址，并确认 `api` 健康检查为 `healthy`。
- **容器删除后 `KeyError: 'State'`**：旧脚本的通用 `docker inspect` 误读了同名镜像。更新脚本后重新运行 `sudo sh scripts/deploy.sh --env-file deploy/.env.development`；不要删除数据卷。
- **数据卷存在但找不到 `ENCRYPTION_KEY`**：从旧部署配置或备份恢复原密钥，再运行脚本；新密钥不能解密旧数据。
