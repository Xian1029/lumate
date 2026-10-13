# Lumate

Lumate 是一个基于学习资料的 AI 学习助手，支持教材上传、学习空间、AI 对话、练习、笔记、复习与学习进度。前端使用 Next.js，后端使用 FastAPI，数据存储使用 SQLite，后台任务使用 Redis。

仓库：[Xian1029/lumate](https://github.com/Xian1029/lumate)。本文说明 Linux 服务器上的生产部署。生产部署调用云端 LLM API，无须在服务器部署大模型。

## 部署准备

服务器需要安装 Docker Engine、Docker Compose v2、Python 3 和 Git。首次部署和更新均需要能下载 Docker 镜像、npm 与 Python 依赖，并能访问所选 LLM 的 API。

少量用户使用可从 4 vCPU、8 GB 内存、50 GB SSD 起步。PDF 解析和 OCR 会占用 CPU 与内存，教材文件、Docker 镜像及备份会持续占用磁盘；这些规格是容量起点，不代表已经压测的并发保证。

准备一个云端 LLM 供应商的有效 API Key、模型名，以及浏览器访问的公网地址，例如 `https://learn.example.com`。公网使用时应配置域名和 HTTPS 反向代理。

确认工具可用：

```sh
docker info
docker compose version
python3 --version
git --version
```

使用有 Docker 权限的账户运行；下面以服务器管理员为例。

## 首次部署：一个 sh 命令

先获取代码：

```sh
git clone https://github.com/Xian1029/lumate.git
cd lumate
```

执行新的部署入口：

```sh
sudo sh scripts/deploy.sh
```

`deploy.sh` 调用项目内的 Python 标准库部署程序，无须为部署程序安装 Python 包。旧入口 `scripts/fix_llm_persistence.sh` 已移除。

可传入另一份环境配置：`sudo sh scripts/deploy.sh --env-file deploy/.env.staging`。路径相对于仓库根目录；默认仍使用 `deploy/.env.production`。每份文件可分别设置 `APP_ENVIRONMENT`、`AUTH_ENABLED` 和 `DEPLOYMENT_MODE`。不同配置文件会切换同一套 Lumate 容器和数据卷，不会同时创建两套环境。

默认生产配置关闭 JWT 登录（`AUTH_ENABLED=false`、`DEPLOYMENT_MODE=single_user`），所有访问者共用同一个账号；已有多账号数据库会使用最早创建的账号。任何能打开 Web 地址的人都能查看或修改该账号的学习数据，公网使用时请在反向代理或网络层限制访问。若配置文件显式开启 JWT，仍须设置至少 32 字符的 `JWT_SECRET_KEY`。

脚本自动完成以下步骤：

1. 检查 Docker Engine 和 Compose 是否可用，并核对现有 Lumate 容器归属。
2. 优先读取 `deploy/.env.production`；没有时读取旧根目录 `.env`；两者均不存在时使用生产配置示例。
3. 为 CSRF 请求防护生成或复用独立签名密钥。Fernet 加密密钥缺失时生成；已有加密密钥格式无效或与容器不一致时停止核对。
4. 按需要提示输入公网地址、云端模型与 API Key。API Key 使用隐藏输入。
5. 原子保存权限为 `600` 的生产配置，并为已有生产文件创建独立备份。
6. 校验 Compose 的容器和数据卷命名，构建 API 与 Web 镜像。
7. 使用新 API 镜像发起一次真实 LLM 请求。成功后将 LLM 配置写入 Lumate 持久化数据卷。
8. 启动三个服务，最多等待 180 秒，全部健康后才报告部署成功。

LLM 测试会消耗少量 API 额度。构建失败或 LLM 测试失败时脚本会退出，尚未执行切换在线服务的 `up` 操作。切换之后若服务未健康，脚本会报错，需要查看日志；它不自动回滚镜像。

脚本不会执行 Git 命令或修改被 Git 跟踪的源码，因此重复部署不会由脚本自身产生源码修改冲突。

## 访问与隔离

| 资源 | 默认值 |
| --- | --- |
| Compose 项目 | `lumate-customized` |
| API 容器 | `lumate-customized-api` |
| Web 容器 | `lumate-customized-web` |
| Redis 容器 | `lumate-customized-redis` |
| 网络 | `lumate-customized-network` |
| 数据卷 | `lumate-customized_data` |
| 上传卷 | `lumate-customized_uploads` |
| Redis 卷 | `lumate-customized_redis` |
| Web 端口 | `3003` |
| API 地址 | `127.0.0.1:8001` |

前端默认可通过 `http://服务器地址:3003` 访问。生产域名通过反向代理转发到 Web 端口；`CORS_ORIGINS` 应与浏览器访问的地址匹配，包括协议与非默认端口。

这些资源独立于原有 `opentutor-*` 服务。若端口已被其他服务占用，在生产配置中修改 `WEB_PORT` 或 `API_PORT` 后重新部署。

只需暴露 Web 端口。API 的 `/api/*` 请求由 Next.js 代理；Redis 不发布到公网。部署程序不会安装或修改 Nginx、域名解析、防火墙或证书，需要运维人员准备这些设置。

## 云端 LLM 与持久化

部署程序支持 `deepseek`、`openai`、`anthropic`、`openrouter`、`gemini`、`groq`。DeepSeek 的示例模型为 `deepseek-chat`；其他供应商请输入账户实际可用的模型名。

运行时 LLM 配置保存为 API 容器内的 `/app/data/runtime.env`，属于 `lumate-customized_data` 卷。设置页保存的模型与密钥会在容器重启、重建后加载。运行时文件只覆盖 LLM 字段，不覆盖数据库、CSRF 或加密密钥。

需要更换供应商、模型或 API Key 时：

```sh
sudo sh scripts/deploy.sh --configure
```

也可以在设置页修改。API Key、CSRF 密钥、加密密钥和配置备份均属于敏感信息，不要提交到 Git 或贴到日志截图中。

## 更新已有服务器

例如项目位于 `/opt/ai-edu/lumate`：

```sh
cd /opt/ai-edu/lumate
git status --short
git pull --ff-only origin main
sudo sh scripts/deploy.sh
```

必须确认 `git pull` 成功后再运行新脚本。若看到 `Your local changes ... would be overwritten` 或 `Aborting`，新代码尚未安装。

若冲突仅来自旧脚本，可保存该文件的修改再更新：

```sh
git stash push -m "server-old-deploy-script" -- scripts/fix_llm_persistence.sh
git pull --ff-only origin main
sudo sh scripts/deploy.sh
```

暂时不要恢复旧脚本的 stash。若冲突涉及 `apps/api/config.py` 或 Compose 文件，先检查差异并保留需要的改动，不能直接清空整个工作区。配置文件和持久化卷应在代码更新时保留。

## 服务状态与日志

以下命令在仓库根目录运行，使用与部署程序相同的项目和生产文件：

```sh
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml ps

docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml logs --tail=100 api web redis

curl -fsS http://127.0.0.1:8001/api/health/live
```

如果修改过 `API_PORT`，健康检查使用对应端口。不要公开整个 `.env.production`、Docker `inspect` 输出或 Compose 展开配置，它们可能包含密钥。

## 备份与停止

至少备份生产配置、SQLite 数据库、运行时 LLM 文件和上传教材。`deploy/.env.production` 内的加密密钥也必须保留；随意替换会使此前加密保存的数据无法解密。

数据库与上传文件需要一致的备份时，先停止 Lumate 写入：

```sh
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml stop api web
```

然后备份 `lumate-customized_data` 与 `lumate-customized_uploads` 命名卷，具体示例见 [DEPLOYMENT.md](DEPLOYMENT.md)。完成后重新启动：

```sh
docker compose --project-name lumate-customized --env-file deploy/.env.production -f docker-compose.deploy.yml start api web
```

不要执行带 `-v` 的 `docker compose down`，它会删除命名卷。旧脚本源码已由 Git 历史保留，运行中的学习数据由命名卷保留。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 提示缺少生产配置 | 使用新 `scripts/deploy.sh`，它会自动准备文件；确认拉取更新成功。 |
| `ENCRYPTION_KEY` 缺失 | 新部署程序会生成或复用正在运行容器的密钥；格式无效或不一致时需要核对已有配置。 |
| `CSRF_SECRET_KEY must be at least 32 characters` | 使用新部署脚本生成并持久化 CSRF 密钥；手动部署时需自行设置。仅显式开启 JWT 时才需要 `JWT_SECRET_KEY`。 |
| `PermissionError: /app/.env` | 使用新版本重新构建部署；Compose 应传入 `LOCAL_ENV_FILE=/app/data/runtime.env`。 |
| LLM 测试失败 | 检查 Key、余额、供应商对应模型名以及服务器的 DNS、TLS 与网络出口；用 `--configure` 重新设置。 |
| 构建失败 | 检查构建输出、磁盘、内存，以及 Docker/npm/Python 包源的网络访问。 |
| 三项服务未全部健康 | 查看 API、Web、Redis 日志；Web 的检查已改为 Alpine 镜像自带的 `wget`。 |
| 上传大 PDF 失败 | 同时检查应用 `MAX_UPLOAD_SIZE_MB`、反向代理上传大小及超时、服务器内存和解析日志。 |
| Git 更新被本地修改挡住 | 更新未成功；保留并处理本地差异后再拉取，不能继续执行旧入口。 |

健康检查通过表示服务已启动，不等于所有业务场景已验证。上线后应使用实际域名创建学习空间，上传一份实际教材并发起 AI 对话，确认代理、解析和 LLM 均可用。

## 更多文档

- [详细部署说明](DEPLOYMENT.md)
- [功能说明](FEATURES.md)
- [安全说明](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [许可证](LICENSE)
