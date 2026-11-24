# iTerminal 服务端（基于 RuoYi-Vue springboot3）

iTerminal 桌面客户端的服务端和管理后台。基座是 [RuoYi-Vue](https://gitee.com/y_project/RuoYi-Vue) 的 springboot3 分支（3.9.2，MIT 协议），
提供用户、角色、菜单权限、部门、字典、参数、日志等能力；iTerminal 的业务都在新增的 `ruoyi-iterminal` 模块里。

| 组成 | 位置 | 说明 |
|---|---|---|
| 后端 | `ruoyi-admin`（启动模块）+ `ruoyi-iterminal`（iTerminal 业务） | Spring Boot 3.5、Spring Security + JWT、MyBatis、Redis |
| 管理后台 | `ruoyi-ui` | RuoYi-Vue3（Vue 3 + Element Plus + Vite），菜单「iTerminal」下 8 个页面 |
| 数据库脚本 | `sql/ry_20260417.sql`、`sql/quartz.sql`、`sql/iterminal.sql` | 依次执行 |
| 冒烟测试 | `test/client-smoke.mjs` | 用 Node 22+ 模拟客户端，验证 20 项接口 |

## 0. 用 Docker Compose 一键部署（推荐）

`deploy/` 目录里有完整的部署文件：MySQL 8.4、Redis 7、后端、Nginx（管理后台静态文件 + `/prod-api` 反向代理 + 长连接）。
需要 Docker 24+ 和 Docker Compose v2；镜像构建时会自动编译后端和管理后台，不需要在本机装 JDK / Maven / Node。

```bash
cd deploy
cp .env.example .env
```

编辑 `.env`，把 5 个密码 / 密钥换成随机值（`openssl rand -hex 32` 可以生成），然后：

```bash
docker compose up -d --build
```

- 第一次启动时 MySQL 自动按顺序执行 `sql/` 下的 3 个初始化脚本（只在数据卷为空时执行）；
- 访问 `http://服务器地址/` 打开管理后台（默认端口 80，`.env` 里的 `HTTP_PORT` 可以改）；
- 桌面客户端连接 `http://服务器地址/prod-api`（登录框不能填写地址：打包时用 `.env` 的 `ITM_DEFAULT_SERVER_URL` 写入默认地址，或者用企业预置配置的 `ServerUrl` / 客户端的管理员设置，见第 6 节）；
- 数据在 3 个数据卷里：`iterminal_mysql-data`（数据库）、`iterminal_redis-data`、`iterminal_backend-data`（录像、安装包、日志）；
- 国内网络构建慢时，在 `.env` 里打开 `MAVEN_MIRROR` / `NPM_REGISTRY`；
- HTTPS：在 `deploy/nginx/default.conf` 里加一个 `listen 443 ssl` 的 server，并把证书目录挂载进 nginx 容器。

常用命令：

```bash
docker compose logs -f backend
```

```bash
docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" iterminal' > iterminal-backup.sql
```

不用 Docker 时按下面的第 1–5 节手动部署。

## 1. 环境要求

- JDK 17 或更高（Spring Boot 3 的最低要求）
- Maven 3.8+
- MySQL 8.0+（字符集 utf8mb4）
- Redis 6+
- Node.js 18+（只有构建管理后台时需要）

## 2. 初始化数据库

**第 1 步：建库和账号**（用 MySQL 的 root 账号执行一次，密码换成你自己的）：

```sql
CREATE DATABASE iterminal DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'itm'@'localhost' IDENTIFIED BY '换成你的数据库密码';
GRANT ALL PRIVILEGES ON iterminal.* TO 'itm'@'localhost';
FLUSH PRIVILEGES;
```

后端和数据库不在同一台机器时，把 `'itm'@'localhost'` 换成 `'itm'@'%'` 或者后端所在的 IP。

**第 2 步：按顺序导入 3 个脚本**（在本目录执行，提示输入的是上面 itm 账号的密码）：

```bash
mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/ry_20260417.sql
mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/quartz.sql
mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal.sql
```

| 脚本 | 内容 |
|---|---|
| `ry_20260417.sql` | 若依基础表：用户、角色、菜单、部门、岗位、字典、参数、操作日志、登录日志、通知 |
| `quartz.sql` | 若依「定时任务」模块用的 Quartz 表 |
| `iterminal.sql` | iTerminal 业务表（`itm_` 前缀）、「iTerminal」菜单和按钮权限、字典、AI 策略参数、「运维审批员」角色、示例命令规则；最后清理若依的演示数据（外链菜单、演示通知），停用演示账号 `ry`，并让管理员第一次登录时提示修改初始密码 |

重新执行这 3 个脚本会**清空并重建**所有表，只在初始化时使用。

**已经初始化过的库升级**：不要重新执行上面 3 个脚本，按版本执行升级脚本（可以重复执行，不会丢数据）：

```bash
mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261017.sql
mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261019.sql
```

| 升级脚本 | 内容 |
|---|---|
| `iterminal-upgrade-20261017.sql` | 第十三轮：团队模型 / 知识库的可用范围增加用户和组织（`user_ids` / `dept_ids` 列）；单项分享表 `itm_share_link`；问题反馈表 `itm_feedback`、`itm_feedback_file`；参数 `itm.feedback.*`；字典「反馈类型 / 反馈状态」、通知事件「新的问题反馈」；菜单「问题反馈」和按钮权限 |
| `iterminal-upgrade-20261019.sql` | 知识库本地向量模型：参数 `itm.kb.embedUrl`（本地向量服务地址）。不执行也能用，第一次保存向量模型配置时后端会自动补上 |

**初始账号**：`admin` / `admin123`。第一次登录管理后台时会提示修改初始密码，上线前务必修改。

## 3. 配置

所有配置都可以用环境变量覆盖，不用改配置文件：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SERVER_PORT` | `8080` | 后端端口 |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `localhost` / `3306` / `iterminal` | MySQL |
| `DB_USER` / `DB_PASSWORD` | `itm` / 空 | MySQL 账号（**必须设置密码**） |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` / `REDIS_PASSWORD` | `localhost` / `6379` / `0` / 空 | Redis |
| `TOKEN_SECRET` | 无 | JWT 签名密钥，**必须设置**（至少 32 个字符，例如 `openssl rand -hex 32`），没有设置时后端拒绝启动 |
| `ITM_DATA_KEY` | 空（用 `TOKEN_SECRET` 派生） | 加密团队模型 API Key、团队主机密码 / 私钥的密钥；**设置后不要再改**，换了之后已保存的密文解不开，需要重新填写 |
| `ITM_UPLOAD_PATH` | `~/iterminal/uploadPath` | 文件目录：会话录像（`itm/recordings`）、客户端安装包（`itm/releases`）、云备份和分享包（`itm/backups`、`itm/shares`）、知识库文档（`itm/kb`）、若依的上传文件 |
| `ITM_LOG_PATH` | `~/iterminal/logs` | 日志目录 |
| `ITM_MAX_UPLOAD` | `1GB` | 单个上传文件的上限（客户端安装包通常 100MB 以上） |
| `DRUID_USER` / `DRUID_PASSWORD` | `itm` / 空 | Druid 监控页的登录账号（请设置密码） |
| `ITM_SMTP_HOST` / `ITM_SMTP_PORT` | 空 / `465` | 邮件通知的 SMTP 服务器（不配置时邮件渠道发送会提示没有配置） |
| `ITM_SMTP_USER` / `ITM_SMTP_PASSWORD` / `ITM_SMTP_FROM` | 空 | SMTP 账号、密码（或授权码）、发件人（为空时用账号） |
| `ITM_SMTP_SSL` / `ITM_SMTP_STARTTLS` | `true` / `false` | 465 端口用 SSL；587 端口改成 `false` / `true` |

AI 策略和保留期限在管理后台「系统管理 → 参数设置」里修改（键名以 `itm.` 开头）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `itm.ai.unattendedCap` | `READONLY` | 无人值守（定时任务）的权限上限：`READONLY` / `APPROVE` / `AUTO` |
| `itm.ai.allowLlmReview` | `true` | 是否允许客户端用大模型复核命令风险 |
| `itm.approval.expireMin` | `30` | 远程审批的有效期（分钟） |
| `itm.audit.retentionDays` | `180` | 命令审计、执行记录、已处理的审批保留天数 |
| `itm.recording.retentionDays` | `30` | 会话录像（数据库记录和 .cast 文件）保留天数 |
| `itm.notify.retentionDays` | `30` | 通知发送记录保留天数 |
| `itm.admin.url` | 空 | 管理后台的访问地址（例如 `https://ops.example.com`），通知消息里的「在管理后台查看」链接用它 |
| `itm.llm.rpm` | `30` | 团队模型：每人每分钟最多请求次数（0 不限制） |
| `itm.llm.dailyTokenLimit` | `0` | 团队模型：每人每天最多 token（输入 + 输出，0 不限制） |
| `itm.ai.allowPersonalProvider` | `true` | 登录后是否还能用自己配置的模型（`false` 时客户端只能用团队模型） |
| `itm.backup.keepCount` | `20` | 每人保留最近多少份云备份（置顶的另算，最多 5 份） |
| `itm.backup.maxMb` | `50` | 单个云备份 / 分享包的大小上限（MB） |
| `itm.sync.allowCredentialSync` | `true` | 是否允许个人凭证进入云备份和分享包 |
| `itm.share.enabled` / `itm.share.allowCredentials` | `true` / `true` | 是否允许分享码；分享包能否包含凭证 |
| `itm.kb.embedProviderId` / `itm.kb.embedUrl` / `itm.kb.embedModel` | 空 | 知识库的向量模型（在「知识库」页面设置，不要在参数设置里直接改）：提供商 ID（云端，团队模型）或本地向量服务地址（例如 `http://127.0.0.1:11434/v1`）二选一，加上模型 ID；都为空时只用关键词检索 |

超过保留期限的数据每天 03:30 自动删除（后端启动 2 分钟后也会执行一次）；管理员可以调用 `POST /iterminal/retention/cleanup` 立即清理一次。

## 4. 构建和启动后端

```bash
mvn -DskipTests package
DB_PASSWORD=你的数据库密码 TOKEN_SECRET=你的随机密钥 java -jar ruoyi-admin/target/ruoyi-admin.jar
```

启动后访问 `http://127.0.0.1:8080/captchaImage` 能返回 JSON 就说明正常。

### 4.1 知识库本地向量服务（可选）

知识库默认只用关键词检索。要按语义检索（问法和原文不一样也能找到），给它配一个向量模型，推荐和后端部署在同一台服务器上的本地向量服务：
**Ollama + bge-m3**（只用 CPU，常驻内存约 2GB，文档内容不出服务器）。离线安装包 `iterminal-embedding-linux-amd64.tar.gz`（程序 + 模型 + `install.sh` + systemd 服务）的用法见包里的 `README.md`：

```bash
tar -xzf iterminal-embedding-linux-amd64.tar.gz && cd iterminal-embedding && sudo sh install.sh
```

装好后在管理后台「知识库 → 向量模型 → 设置」选「本地向量服务」，地址 `http://127.0.0.1:11434/v1`（后端在 Docker 里时用 `http://host.docker.internal:11434/v1`，见包里的说明），模型 `bge-m3`，测试后保存。
也可以选「云端（团队模型）」，用团队模型里 OpenAI 兼容的提供商（千问 `text-embedding-v4`、豆包 `doubao-embedding` 等；DeepSeek 没有向量接口），文档内容会发给这个提供商。

## 5. 管理后台

开发时（`/dev-api` 转发到后端，默认 `http://localhost:8080`）：

```bash
cd ruoyi-ui
npm install
VITE_PROXY_TARGET=http://127.0.0.1:8080 VITE_PORT=8088 npm run dev
```

上线时构建静态文件，用 Nginx 托管（`/prod-api` 转发到后端，长连接需要 Upgrade 头）：

```bash
cd ruoyi-ui && npm run build:prod   # 输出到 ruoyi-ui/dist
```

```nginx
server {
    listen 443 ssl;
    server_name ops.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    client_max_body_size 1g;          # 上传客户端安装包

    location / {
        root /opt/iterminal/admin;     # ruoyi-ui/dist 的内容
        try_files $uri $uri/ /index.html;
    }
    location /prod-api/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;                    # 客户端长连接 /prod-api/ws/client
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

菜单「iTerminal」下的页面：

| 页面 | 能做什么 |
|---|---|
| 设备管理 | 登录过的客户端设备、在线状态、版本；吊销设备（令牌立即失效，客户端需要重新输入密码） |
| 命令审计 | 客户端上报的命令和安全事件，按来源（手动 / Agent / Skill / 定时任务 / 外部 MCP）、风险筛选，导出 Excel |
| 会话录像 | 客户端上传的终端录像（asciicast），在线回放（倍速、跳过空闲、拖动进度） |
| 定时任务 | 新建命令 / Skill / AI 任务，指定执行设备、目标主机（主机名称或 ID）、cron、权限上限；立即执行 |
| 执行记录 | 每次执行的状态、进度和每台主机的输出 |
| 远程审批 | 无人值守任务遇到需要审批的命令时在这里批准 / 拒绝（客户端里的审批人也会收到） |
| 版本发布 | 上传客户端安装包，设置灰度比例、最低支持版本；客户端自动更新从这里拉取 |
| 命令规则 | 团队命令规则和脱敏规则，随 AI 策略下发给客户端（最先匹配，用户规则不能放宽） |
| 团队模型 | 配置大模型提供商（Anthropic / OpenAI / OpenAI 兼容，内置常见厂商地址）和 API Key（加密保存，不下发）、模型列表、可用角色；测试连接、从接口拉取模型；按用户和模型统计用量、查看每次调用 |
| 团队主机 | 分组树 + 主机（SSH / Telnet、密码 / 私钥加密保存）、按角色可见（子分组继承）、是否允许客户端查看密码；客户端登录后自动同步到「团队主机」分组（只读） |
| 通知渠道 | 钉钉 / 企业微信 / 飞书机器人（支持加签、@ 手机号）、邮件、通用 Webhook（JSON + HMAC 签名）；订阅任务失败、设备离线、任务成功、等待审批、审批过期、高危命令；可以发送测试消息、查看发送记录 |
| 云备份与分享 | 只看元数据：每个用户的云备份（份数、大小、设备、时间）和分享码状态（拉取次数、范围）；可以强制关闭某人的分享码。备份和分享包是客户端端到端加密的，服务端看不到内容，也看不到分享码 |
| 知识库 | 新建知识库（可限定角色）、上传 Markdown / 文本 / HTML / PDF / Word .docx 或直接粘贴文字，自动解析、按章节切块并建全文索引；设置向量模型（**本地向量服务**：和后端部署在一起的 Ollama + bge-m3，文档不出服务器；或**云端**：团队模型里 OpenAI 兼容的提供商，例如千问 `text-embedding-v4`）后同时按语义检索，换了模型自动重新生成向量；检索测试。客户端 AI 助手排障时用 `kb_search` 工具检索并注明出处 |

权限：`admin` 拥有全部权限；「运维审批员」角色（`itm_approver`）可以查看审计、录像、执行记录并处理远程审批。
其他角色在「系统管理 → 角色管理」里按菜单和按钮（`itm:*`）分配。

## 6. 客户端接入

桌面客户端侧栏底部点「登录」，只填写用户名和密码；连接的服务端地址界面上不显示也不能填写：

- 自己打包客户端时，在仓库根目录的 `.env` 里写 `ITM_DEFAULT_SERVER_URL=https://你的服务器/prod-api`，打出来的安装包默认连接这个地址（开源发布的安装包里没有默认地址，是纯本地模式）；
- 部署在别的地址时，在客户端「设置 → 关于」里连续快速点击软件图标 5 次，输入管理员密码后修改服务端地址（可以先测试连接；留空保存恢复打包时的默认值）；
- 或者批量分发时用企业预置配置指定 `ServerUrl`（例如 `https://ops.example.com/prod-api`，直连后端时是 `http://服务器IP:8080`）：
  Windows 注册表 `HKLM\Software\iTerminal\ServerUrl`，macOS 托管偏好 `com.corp.iterminal` 的 `ServerUrl`，Linux `/etc/iterminal/config.json` 的 `serverUrl`。

登录后客户端会：注册设备、建立长连接（定时任务派发、远程审批）、上报命令审计和会话录像、拉取团队命令规则和脱敏规则、
团队模型（经服务端代理调用，客户端不接触 API Key）和团队主机（只读，按角色同步）；
在「设置 → 数据同步」里可以设置同步密码，使用云备份和分享码（端到端加密）；AI 助手可以检索团队知识库。
自动更新地址是 `{服务端地址}/api/v1/releases/{渠道}/{系统}/{架构}`，登录后自动使用，也可以用预置配置 `serverUrl` 统一指定。

## 7. 验证

```bash
node test/client-smoke.mjs http://127.0.0.1:8080
```

模拟客户端验证登录、令牌刷新与吊销、长连接、审计、录像分片、定时任务派发、远程审批、版本发布等 20 项。
它会用 `admin / admin123` 登录管理后台接口，所以需要先在「参数设置」里把「账号自助-验证码开关」改成 `false`（测试完再改回来）；
运行后会留下名为 smoke-mac 的测试设备和几条测试审计记录。

团队模型和团队主机的冒烟测试（团队模型会在本机 18092 端口模拟 OpenAI / Anthropic 上游，等待限流窗口，约 2 分钟）：

```bash
node test/llm-smoke.mjs http://127.0.0.1:8080
```

```bash
node test/asset-smoke.mjs http://127.0.0.1:8080
```

通知的冒烟测试会在本机模拟钉钉 / 企业微信 / 飞书机器人、Webhook 和 SMTP 服务器（端口 18091、2525），验证加签、@、重试和发送记录：

```bash
ITM_SMTP_HOST=127.0.0.1 ITM_SMTP_PORT=2525 ITM_SMTP_AUTH=false ITM_SMTP_SSL=false ITM_SMTP_FROM=itm@example.com java -jar ruoyi-admin/target/ruoyi-admin.jar
```

```bash
node test/notify-smoke.mjs http://127.0.0.1:8080
```

云备份和分享码、知识库的冒烟测试（知识库会在本机 18093 端口模拟向量接口，生成 Markdown / GBK 文本 / HTML / PDF / Word 测试文件）：

```bash
node test/cloud-smoke.mjs http://127.0.0.1:8080
```

```bash
node test/kb-smoke.mjs http://127.0.0.1:8080
```

本地向量模型的冒烟测试（需要本机或服务器上的 Ollama + bge-m3，用真实向量验证换个说法、英文提问也能检索到）：

```bash
node test/kb-local-smoke.mjs http://127.0.0.1:8080 http://127.0.0.1:11434 bge-m3
```

客户端和真实服务端的联调测试在客户端仓库：

```bash
cd ../iterminal/apps/desktop
ITM_REAL_SERVER=http://127.0.0.1:8080 npx playwright test e2e/real-server.spec.ts e2e/real-cloud.spec.ts
```

## 8. 接口一览（客户端用，前缀 `/api/v1`）

统一响应 `{code: 0, message, data}`，HTTP 状态码表示成败（401 需要刷新令牌或重新登录）。

| 接口 | 说明 |
|---|---|
| `POST /auth/login` | 用户名密码登录，注册设备，返回访问令牌和刷新令牌（30 天，每次使用后轮换） |
| `POST /auth/refresh` | 刷新令牌换新的访问令牌 |
| `POST /auth/logout` | 退出登录 |
| `GET /me`、`GET /devices` | 当前用户和设备 |
| `GET /ws/ticket` → `WS /ws/client?ticket=` | 一次性票据（30 秒）换长连接；消息需要确认（ack），10 秒没确认重发，最多 3 次 |
| `GET /ai/policy` | 团队命令规则、脱敏规则、无人值守权限上限、是否允许 LLM 复核、是否允许个人模型 |
| `GET /ai/models` | 当前用户可以用的团队模型（不含 Key） |
| `POST /llm/proxy/{提供商ID}/chat/completions`、`/v1/messages` 等 | 大模型代理：客户端把 `{服务端}/api/v1/llm/proxy/{ID}` 当作 OpenAI / Anthropic 兼容地址，用登录令牌鉴权（`Authorization: Bearer` 或 `x-api-key`），服务端换上真实 Key 后转发，流式原样透传；按用户限流、统计用量 |
| `GET /team/assets` | 当前用户能看到的团队主机和分组（含凭证） |
| `GET/PUT /sync/e2e-key` | 端到端加密的密钥托管（同步密码和恢复码各包一份数据密钥；`If-Match` 乐观锁） |
| `POST/GET /backups`、`GET /backups/{id}/content`、`PATCH/DELETE /backups/{id}` | 云备份：上传加密包（multipart）、列表、下载、置顶 / 备注、删除 |
| `GET/PUT/PATCH/DELETE /shares/me`、`PUT /shares/me/content` | 自己的分享码：开启、暂停 / 恢复、改范围、重置、上传分享包 |
| `POST /shares:lookup`、`POST /shares:download` | 用分享码预览和拉取别人的分享包（服务端只存分享码的哈希） |
| `GET /kb/collections`、`POST /kb/search` | 知识库：当前用户能看到的知识库；检索 `{query, collectionIds?, topK?}`，返回片段、章节、出处和得分 |
| `POST /audit/commands:batch` | 批量上报命令审计（按客户端事件 ID 去重） |
| `POST /audit/sessions/{id}/chunks` | 分片上传会话录像（缺片返回 409，重发的分片忽略） |
| `POST /sched/runs/{runId}/approvals` | 执行器创建远程审批 |
| `GET /approvals`、`POST /approvals/{id}:decide` | 审批人查询和处理审批 |
| `GET /releases/{渠道}/{系统}/{架构}/{文件}` | 自动更新：`latest(-mac/-linux).yml` 和安装包（支持断点续传，不需要登录） |

长连接消息：`hello`、`ping/pong`、`ack`、`task.dispatch` / `task.progress` / `task.result`、`approval.request` / `approval.decide` / `approval.result`、`device.revoked`。
