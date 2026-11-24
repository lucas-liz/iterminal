/**
 * 内置命令库（终端命令提示用）：常用运维命令和中文说明。按前缀匹配，不请求 AI。
 * 每项是「命令（含常用参数）」和一句说明；同一个命令的不同用法分开列。
 */
export const COMMAND_LIBRARY: [string, string][] = [
  // 文件与目录
  ['ls -la', '列出所有文件（含隐藏文件）的详细信息'],
  ['ls -lh', '列出文件，大小用 K / M / G 显示'],
  ['ls -lt', '按修改时间排序列出文件'],
  ['ls -lS', '按文件大小排序列出文件'],
  ['cd -', '回到上一次所在的目录'],
  ['cd ~', '回到主目录'],
  ['pwd', '显示当前所在目录'],
  ['mkdir -p', '创建目录（父目录不存在时一起创建）'],
  ['cp -r', '递归复制目录'],
  ['cp -a', '复制并保留权限、时间等属性'],
  ['mv', '移动或重命名文件'],
  ['rm -f', '强制删除文件（不提示）'],
  ['rm -rf', '递归强制删除目录（危险，确认路径）'],
  ['rmdir', '删除空目录'],
  ['touch', '创建空文件或更新修改时间'],
  ['ln -s', '创建软链接'],
  ['find . -name', '按文件名查找'],
  ['find . -type f -size +100M', '查找大于 100MB 的文件'],
  ['find . -mtime -1', '查找最近一天修改过的文件'],
  ['find . -name "*.log" -mtime +7 -delete', '删除 7 天前的 .log 文件'],
  ['tree -L 2', '以树形显示两层目录结构'],
  ['stat', '查看文件的详细属性（大小、权限、时间）'],
  ['file', '识别文件类型'],
  ['realpath', '显示文件的绝对路径'],
  ['du -sh', '统计目录占用的总大小'],
  ['du -sh * | sort -h', '列出当前目录下各项的大小并排序'],
  ['du -h --max-depth=1', '统计一层子目录的大小'],
  ['df -h', '查看磁盘分区使用情况'],
  ['df -i', '查看 inode 使用情况'],
  // 查看文件内容
  ['cat', '显示文件内容'],
  ['less', '分页查看文件（q 退出，/ 搜索）'],
  ['head -n 50', '显示文件前 50 行'],
  ['tail -n 100', '显示文件最后 100 行'],
  ['tail -f', '实时跟踪文件新增内容（看日志）'],
  ['tail -F', '跟踪文件，文件被轮转后继续跟踪'],
  ['wc -l', '统计行数'],
  ['grep -rn', '递归搜索文本并显示行号'],
  ['grep -i', '忽略大小写搜索'],
  ['grep -v', '显示不匹配的行'],
  ['grep -E', '使用扩展正则搜索'],
  ['grep -C 5', '显示匹配行以及前后 5 行'],
  ['zcat', '查看 gzip 压缩的文件内容'],
  ['zgrep', '在 gzip 压缩的文件里搜索'],
  ['diff -u', '比较两个文件的差异'],
  ['sort | uniq -c | sort -rn', '统计重复行出现的次数并排序'],
  ['awk \'{print $1}\'', '打印每行的第一列'],
  ['sed -n \'1,20p\'', '打印第 1 到 20 行'],
  ['sed -i \'s/old/new/g\'', '直接在文件里替换文本'],
  ['cut -d: -f1', '按冒号分隔取第一列'],
  ['xargs', '把标准输入作为参数传给命令'],
  ['tee', '输出到屏幕的同时写入文件'],
  // 权限与用户
  ['chmod +x', '添加执行权限'],
  ['chmod 644', '设置文件权限为 rw-r--r--'],
  ['chmod 755', '设置权限为 rwxr-xr-x'],
  ['chmod -R', '递归修改权限'],
  ['chown -R', '递归修改文件所有者'],
  ['sudo -i', '切换到 root 的登录 shell'],
  ['su -', '切换用户（加载对方的环境变量）'],
  ['whoami', '显示当前用户名'],
  ['id', '显示用户 ID 和所属组'],
  ['passwd', '修改密码'],
  ['useradd -m', '创建用户并创建主目录'],
  ['usermod -aG', '把用户加入附加组'],
  ['userdel -r', '删除用户及其主目录'],
  ['who', '查看当前登录的用户'],
  ['last', '查看最近的登录记录'],
  // 压缩与打包
  ['tar -czf', '创建 gzip 压缩包'],
  ['tar -xzf', '解压 gzip 压缩包'],
  ['tar -xvf', '解压 tar 包（显示过程）'],
  ['tar -tf', '列出 tar 包里的文件'],
  ['tar -cjf', '创建 bzip2 压缩包'],
  ['tar -xJf', '解压 xz 压缩包'],
  ['zip -r', '把目录压缩成 zip'],
  ['unzip', '解压 zip 文件'],
  ['unzip -l', '列出 zip 里的文件'],
  ['gzip', '压缩文件（生成 .gz）'],
  ['gunzip', '解压 .gz 文件'],
  // 进程与系统
  ['ps aux', '查看所有进程'],
  ['ps aux --sort=-%cpu | head', '按 CPU 占用排序的进程'],
  ['ps aux --sort=-%mem | head', '按内存占用排序的进程'],
  ['ps -ef | grep', '查找进程'],
  ['pgrep -f', '按命令行查找进程号'],
  ['pkill -f', '按命令行结束进程'],
  ['kill -9', '强制结束进程'],
  ['kill -15', '正常结束进程（SIGTERM）'],
  ['killall', '按名称结束所有同名进程'],
  ['top', '实时查看进程和资源占用'],
  ['htop', '交互式查看进程（需要安装）'],
  ['free -h', '查看内存使用情况'],
  ['uptime', '查看运行时间和平均负载'],
  ['uname -a', '查看内核和系统信息'],
  ['cat /etc/os-release', '查看系统发行版本'],
  ['hostnamectl', '查看或设置主机名'],
  ['lscpu', '查看 CPU 信息'],
  ['lsblk', '列出块设备（磁盘和分区）'],
  ['lsof -i', '查看网络连接对应的进程'],
  ['lsof -i :8080', '查看谁在占用 8080 端口'],
  ['lsof +D', '查看哪些进程打开了这个目录下的文件'],
  ['vmstat 1', '每秒输出 CPU、内存、IO 统计'],
  ['iostat -x 1', '每秒输出磁盘 IO 详情'],
  ['iotop', '查看各进程的磁盘 IO（需要 root）'],
  ['dmesg -T | tail', '查看内核日志（带时间）'],
  ['nohup', '后台运行命令，退出终端后继续'],
  ['nohup command > out.log 2>&1 &', '后台运行并把输出写到 out.log'],
  ['jobs', '查看当前 shell 的后台任务'],
  ['bg', '把暂停的任务放到后台继续'],
  ['fg', '把后台任务调到前台'],
  ['watch -n 2', '每 2 秒执行一次命令并刷新显示'],
  ['time', '统计命令的执行时间'],
  ['history | grep', '在历史命令里搜索'],
  ['date', '显示当前时间'],
  ['date "+%Y-%m-%d %H:%M:%S"', '按格式显示当前时间'],
  ['timedatectl', '查看或设置时间、时区'],
  ['crontab -l', '查看定时任务'],
  ['crontab -e', '编辑定时任务'],
  ['env', '显示环境变量'],
  ['export', '设置环境变量'],
  ['which', '查找命令所在的路径'],
  ['ulimit -n', '查看可打开的文件数上限'],
  ['reboot', '重启系统（危险）'],
  ['shutdown -h now', '立即关机（危险）'],
  // 服务与日志
  ['systemctl status', '查看服务状态'],
  ['systemctl start', '启动服务'],
  ['systemctl stop', '停止服务'],
  ['systemctl restart', '重启服务'],
  ['systemctl reload', '重新加载服务配置'],
  ['systemctl enable --now', '设置开机启动并立即启动'],
  ['systemctl disable', '取消开机启动'],
  ['systemctl list-units --type=service --state=running', '列出正在运行的服务'],
  ['systemctl daemon-reload', '重新加载 systemd 配置'],
  ['journalctl -u', '查看某个服务的日志'],
  ['journalctl -u nginx -f', '实时跟踪 nginx 服务日志'],
  ['journalctl -xe', '查看最近的系统日志和错误说明'],
  ['journalctl --since "1 hour ago"', '查看最近一小时的日志'],
  ['service', '管理服务（旧系统）'],
  // 网络
  ['ip a', '查看网卡和 IP 地址'],
  ['ip route', '查看路由表'],
  ['ip -s link', '查看网卡收发统计'],
  ['ifconfig', '查看网卡信息（旧命令）'],
  ['ping -c 4', '测试连通性（发送 4 个包）'],
  ['traceroute', '跟踪到目标的路由'],
  ['mtr', '持续跟踪路由和丢包'],
  ['ss -tunlp', '查看监听的端口和对应进程'],
  ['ss -s', '查看连接统计'],
  ['ss -ant | grep ESTAB | wc -l', '统计已建立的 TCP 连接数'],
  ['netstat -tunlp', '查看监听的端口（旧命令）'],
  ['curl -I', '只看 HTTP 响应头'],
  ['curl -v', '显示 HTTP 请求的详细过程'],
  ['curl -o', '下载文件并保存为指定文件名'],
  ['curl -X POST -H "Content-Type: application/json" -d', '发送 JSON 的 POST 请求'],
  ['wget', '下载文件'],
  ['wget -c', '断点续传下载'],
  ['nc -zv', '测试端口是否开放'],
  ['telnet', '测试端口连通性'],
  ['dig', '查询 DNS 解析'],
  ['nslookup', '查询域名解析'],
  ['host', '查询域名对应的 IP'],
  ['cat /etc/resolv.conf', '查看 DNS 服务器配置'],
  ['tcpdump -i any port', '抓取某个端口的数据包'],
  ['iptables -L -n', '查看防火墙规则'],
  ['firewall-cmd --list-all', '查看 firewalld 规则'],
  ['firewall-cmd --add-port=8080/tcp --permanent', '永久放行 8080 端口'],
  ['ufw status', '查看 ufw 防火墙状态'],
  ['ssh', '远程登录'],
  ['ssh -L', '本地端口转发'],
  ['scp -r', '通过 SSH 复制目录'],
  ['rsync -avz', '增量同步文件（压缩传输）'],
  ['rsync -avz --delete', '增量同步并删除目标端多余的文件'],
  ['ssh-keygen -t ed25519', '生成 Ed25519 密钥'],
  ['ssh-copy-id', '把公钥添加到远端主机'],
  // 软件包
  ['apt update', '更新软件源（Debian / Ubuntu）'],
  ['apt install -y', '安装软件包（Debian / Ubuntu）'],
  ['apt remove', '卸载软件包（Debian / Ubuntu）'],
  ['apt list --installed', '列出已安装的软件包'],
  ['yum install -y', '安装软件包（CentOS）'],
  ['yum update', '更新软件包（CentOS）'],
  ['yum list installed', '列出已安装的软件包（CentOS）'],
  ['dnf install -y', '安装软件包（Fedora / RHEL 8+）'],
  ['rpm -qa | grep', '查找已安装的 rpm 包'],
  ['dpkg -l | grep', '查找已安装的 deb 包'],
  ['pip install', '安装 Python 包'],
  ['npm install', '安装 Node.js 依赖'],
  // Docker
  ['docker ps', '查看运行中的容器'],
  ['docker ps -a', '查看所有容器（含已停止）'],
  ['docker images', '查看本地镜像'],
  ['docker logs -f --tail 200', '实时查看容器日志（最后 200 行）'],
  ['docker logs', '查看容器日志'],
  ['docker exec -it', '进入容器执行命令'],
  ['docker exec -it container sh', '进入容器的 shell'],
  ['docker restart', '重启容器'],
  ['docker start', '启动容器'],
  ['docker stop', '停止容器'],
  ['docker rm', '删除容器'],
  ['docker rmi', '删除镜像'],
  ['docker run -d --name', '后台运行一个新容器'],
  ['docker pull', '拉取镜像'],
  ['docker build -t', '构建镜像'],
  ['docker inspect', '查看容器或镜像的详细信息'],
  ['docker stats', '实时查看容器资源占用'],
  ['docker system df', '查看 Docker 磁盘占用'],
  ['docker system prune', '清理不用的容器、网络、镜像（危险）'],
  ['docker network ls', '列出 Docker 网络'],
  ['docker volume ls', '列出数据卷'],
  ['docker cp', '在容器和宿主机之间复制文件'],
  ['docker compose up -d', '后台启动 compose 里的服务'],
  ['docker compose down', '停止并删除 compose 里的服务'],
  ['docker compose ps', '查看 compose 服务状态'],
  ['docker compose logs -f', '实时查看 compose 服务日志'],
  ['docker compose restart', '重启 compose 服务'],
  ['docker-compose up -d', '后台启动 compose 服务（旧版命令）'],
  ['docker-compose logs -f', '实时查看 compose 日志（旧版命令）'],
  // Kubernetes
  ['kubectl get pods', '查看 Pod 列表'],
  ['kubectl get pods -A', '查看所有命名空间的 Pod'],
  ['kubectl get pods -o wide', '查看 Pod 及所在节点、IP'],
  ['kubectl get svc', '查看 Service 列表'],
  ['kubectl get nodes', '查看节点列表'],
  ['kubectl get deploy', '查看 Deployment 列表'],
  ['kubectl describe pod', '查看 Pod 详情和事件'],
  ['kubectl logs -f', '实时查看 Pod 日志'],
  ['kubectl logs --previous', '查看容器上一次运行的日志'],
  ['kubectl exec -it', '进入 Pod 执行命令'],
  ['kubectl apply -f', '应用配置文件'],
  ['kubectl delete pod', '删除 Pod（会被重建）'],
  ['kubectl rollout restart deploy', '滚动重启 Deployment'],
  ['kubectl rollout status deploy', '查看发布进度'],
  ['kubectl scale deploy --replicas=', '调整副本数'],
  ['kubectl top pods', '查看 Pod 资源占用'],
  ['kubectl top nodes', '查看节点资源占用'],
  ['kubectl get events --sort-by=.metadata.creationTimestamp', '按时间查看事件'],
  ['kubectl config get-contexts', '查看可用的集群上下文'],
  ['kubectl config use-context', '切换集群上下文'],
  ['kubectl port-forward', '把 Pod 端口转发到本地'],
  // Git
  ['git status', '查看工作区状态'],
  ['git log --oneline -20', '查看最近 20 条提交'],
  ['git pull', '拉取并合并远端更新'],
  ['git fetch --all', '获取所有远端的更新'],
  ['git diff', '查看未暂存的改动'],
  ['git checkout -b', '创建并切换到新分支'],
  ['git branch -a', '查看所有分支'],
  ['git stash', '暂存当前改动'],
  ['git stash pop', '恢复暂存的改动'],
  ['git reset --hard', '丢弃所有改动并重置（危险）'],
  ['git clone', '克隆仓库'],
  // 数据库与中间件
  ['mysql -uroot -p', '登录 MySQL'],
  ['mysql -uroot -p -e "SHOW DATABASES;"', '列出 MySQL 数据库'],
  ['mysqldump -uroot -p --single-transaction', '导出 MySQL 数据库'],
  ['psql -U postgres', '登录 PostgreSQL'],
  ['pg_dump -U postgres', '导出 PostgreSQL 数据库'],
  ['redis-cli', '连接 Redis'],
  ['redis-cli info memory', '查看 Redis 内存使用'],
  ['redis-cli --bigkeys', '查找 Redis 大键'],
  ['mongosh', '连接 MongoDB'],
  ['nginx -t', '检查 nginx 配置是否正确'],
  ['nginx -s reload', '重新加载 nginx 配置'],
  ['nginx -V', '查看 nginx 版本和编译参数'],
  ['java -version', '查看 Java 版本'],
  ['jps -l', '列出 Java 进程'],
  ['jstack', '导出 Java 线程堆栈'],
  ['jmap -heap', '查看 Java 堆内存'],
  ['jstat -gcutil 1000', '每秒查看 Java GC 情况'],
  // 磁盘与挂载
  ['mount', '查看挂载的文件系统'],
  ['mount -o remount,rw /', '把根分区重新挂载为可写'],
  ['umount', '卸载文件系统'],
  ['fdisk -l', '查看磁盘分区'],
  ['blkid', '查看分区的 UUID 和文件系统类型'],
  ['cat /etc/fstab', '查看开机挂载配置'],
  ['mkfs.ext4', '格式化为 ext4（危险）'],
  ['fsck', '检查并修复文件系统'],
  ['sync; echo 3 > /proc/sys/vm/drop_caches', '释放页面缓存（需要 root）'],
  // 编辑器
  ['vim', '用 vim 编辑文件'],
  ['vi', '用 vi 编辑文件'],
  ['nano', '用 nano 编辑文件'],
];

export interface LibraryMatch {
  command: string;
  description: string;
}

/**
 * 按前缀匹配内置命令库：输入完整的前缀（例如 `docker res`、`tar -`）时给出以它开头的命令；
 * 只输入了命令名的一部分（没有空格）时，给出以它开头的命令。
 */
export function matchLibrary(prefix: string, limit = 8): LibraryMatch[] {
  const p = prefix.replace(/^\s+/, '');
  if (!p) return [];
  const out: LibraryMatch[] = [];
  for (const [command, description] of COMMAND_LIBRARY) {
    if (command.length > p.length && command.startsWith(p)) {
      out.push({ command, description });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface MergedSuggestion {
  command: string;
  description?: string;
  source: 'history' | 'library' | 'snippet';
}

/** 命令提示总共最多几条（一页显示的条数在设置里，超出的滚动查看） */
export const SUGGEST_TOTAL = 20;
/** 历史命令足够多时，系统推荐（命令库 + 快捷命令）最多占几条，给历史命令留位置 */
const SYSTEM_CAP = 12;

const norm = (c: string): string => c.trim().replace(/\s+/g, ' ');

/**
 * 合并命令提示：系统推荐（内置命令库带说明、快捷命令）排在前面，后面是这台主机的历史命令。
 * 历史命令和系统推荐一模一样（忽略多余空格）时只保留系统推荐；历史不够时用系统推荐补满。
 */
export function mergeSuggestions(prefix: string, input: { library: LibraryMatch[]; snippets: string[]; history: string[] }, total = SUGGEST_TOTAL): MergedSuggestion[] {
  const self = norm(prefix);
  const seen = new Set<string>([self]);
  const system: MergedSuggestion[] = [];
  for (const l of input.library) {
    const k = norm(l.command);
    if (seen.has(k)) continue;
    seen.add(k);
    system.push({ command: l.command, description: l.description, source: 'library' });
  }
  for (const s of input.snippets) {
    const k = norm(s);
    if (seen.has(k)) continue;
    seen.add(k);
    system.push({ command: s, source: 'snippet' });
  }
  const sysByKey = new Map(system.map((it, i) => [norm(it.command), i]));
  const history: { command: string; sys?: number }[] = [];
  for (const h of input.history) {
    const k = norm(h);
    const sys = sysByKey.get(k);
    if (sys === undefined && seen.has(k)) continue;
    if (sys === undefined) seen.add(k);
    history.push({ command: h, sys });
  }
  const pure = history.filter((h) => h.sys === undefined).length;
  const keep = Math.min(system.length, Math.max(SYSTEM_CAP, total - pure), total);
  // 和被截掉的系统推荐相同的历史命令：按系统推荐显示（带说明），在历史里的位置不变
  const rest: MergedSuggestion[] = [];
  const used = new Set<number>();
  for (const h of history) {
    if (h.sys === undefined) rest.push({ command: h.command, source: 'history' });
    else if (h.sys >= keep && !used.has(h.sys)) {
      used.add(h.sys);
      rest.push(system[h.sys]);
    }
  }
  return [...system.slice(0, keep), ...rest.slice(0, total - keep)];
}
