import type { StoredMessage, ToolSpec, UserBlock } from './llm/types';

/**
 * Agent 工具（文档一 7.3）。整个会话里工具定义保持不变（历史只追加，prompt 缓存可以命中）。
 * 名称沿用 v0.2：run_command 即文档里的 ssh_exec，read_terminal 即 terminal_read。
 */
const host = { type: 'string', description: '目标编号，例如 t1（终端）或 h2（引用的主机）' };
/** 执行类工具的作用说明（文档一 6.15.1）：只给用户看，不参与风险判定 */
/** 数据库工具的目标：本轮引用的数据库编号（文档一 6.31.3） */
const dbParam = { type: 'string', description: '数据库编号，例如 d1（只能用本轮引用的数据库）' };
const explanation = {
  type: 'string',
  description: '用一两句话说明这条命令做什么、在本次任务里起什么作用（显示在执行卡片和审批卡片上），例如「查看 /var 下最大的目录，定位占满磁盘的位置」',
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'run_command',
    description:
      '在指定主机上执行一条 shell 命令（使用独立的执行通道，不会输入到用户的终端里），返回退出码和输出（超过 16KB 截断）。' +
      '写操作和高危命令会先请用户批准。标准输入是关闭的：不要执行交互式或不会结束的命令（用 -y、--no-pager、top -b -n 1、tail -n 代替 tail -f）；' +
      '连续 idle_timeout_sec（默认 30 秒）没有任何输出会被终止。' +
      '互不依赖的只读检查可以在同一轮里同时调用多次（会并行执行），不要一条一条地等结果。',
    parameters: {
      type: 'object',
      properties: {
        host,
        command: { type: 'string', description: '要执行的完整命令' },
        explanation,
        timeout_sec: { type: 'integer', description: '超时秒数，默认 60，最大 600' },
        idle_timeout_sec: { type: 'integer', description: '连续多少秒没有输出就终止，默认 30；确实会长时间没有输出的命令（大文件打包、长时间编译）调大，不超过 timeout_sec' },
      },
      required: ['host', 'command', 'explanation'],
    },
  },
  {
    name: 'ssh_exec_batch',
    description: '在多台主机上并行执行同一条命令（例如批量巡检），每台主机分别返回退出码和输出。写操作合并成一张审批卡片，用户可以逐台勾选。',
    parameters: {
      type: 'object',
      properties: {
        hosts: { type: 'array', items: { type: 'string' }, description: '目标编号列表' },
        command: { type: 'string' },
        explanation,
        timeout_sec: { type: 'integer', description: '每台主机的超时秒数，默认 60' },
        idle_timeout_sec: { type: 'integer', description: '连续多少秒没有输出就终止，默认 30' },
      },
      required: ['hosts', 'command', 'explanation'],
    },
  },
  {
    name: 'read_terminal',
    description: '读取指定终端最近的屏幕输出（纯文本），用于查看用户刚刚执行的命令和结果。',
    parameters: {
      type: 'object',
      properties: { host, lines: { type: 'integer', description: '读取的行数，默认 100，最大 500' } },
      required: ['host'],
    },
  },
  {
    name: 'get_metrics',
    description: '读取指定主机的实时监控快照：CPU、内存、磁盘分区、网络、负载、占用最高的进程。',
    parameters: { type: 'object', properties: { host }, required: ['host'] },
  },
  {
    name: 'host_list',
    description: '按名称、地址、分组或标签查找主机（不含凭证）。只能在本轮引用的主机上执行命令；要操作其他主机，请让用户把它加入引用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名称或地址里包含的文字' },
        folder: { type: 'string', description: '分组名称（包含子分组）' },
        tag: { type: 'string' },
      },
    },
  },
  {
    name: 'sftp_list',
    description: '列出远端目录（名称、类型、大小、修改时间、权限）。',
    parameters: { type: 'object', properties: { host, path: { type: 'string', description: '绝对路径' } }, required: ['host', 'path'] },
  },
  {
    name: 'sftp_read',
    description: '读取远端文本文件。大文件请用 tail_lines 只读尾部（默认最多 64KB）。',
    parameters: {
      type: 'object',
      properties: {
        host,
        path: { type: 'string', description: '绝对路径' },
        tail_lines: { type: 'integer', description: '只读最后 N 行' },
      },
      required: ['host', 'path'],
    },
  },
  {
    name: 'sftp_write',
    description: '写入远端文本文件（覆盖或追加）。写之前会把原文件备份到 ~/.iterminal/backup/，审批卡片会展示改动对比。',
    parameters: {
      type: 'object',
      properties: {
        host,
        path: { type: 'string', description: '绝对路径' },
        content: { type: 'string', description: '新的完整内容（append 为 true 时是追加的内容）' },
        append: { type: 'boolean' },
        explanation: { ...explanation, description: '用一两句话说明为什么要改这个文件、改了什么' },
      },
      required: ['host', 'path', 'content', 'explanation'],
    },
  },
  {
    name: 'file_upload',
    description:
      '把本机文件上传到服务器（大文件也可以，有进度）。服务器没有 SFTP 时自动用 SSH 命令通道或 FTP。需要用户批准；目标已存在时会覆盖。只用于用户明确要求上传的文件。',
    parameters: {
      type: 'object',
      properties: {
        host,
        local_path: { type: 'string', description: '本机文件的绝对路径（用户给出的路径，或者对话里附加的文件路径）' },
        remote_path: { type: 'string', description: '服务器上的目标路径（绝对路径；以 / 结尾或是已有目录时，保存为该目录下的同名文件）' },
        explanation: { ...explanation, description: '用一两句话说明为什么要上传这个文件' },
      },
      required: ['host', 'local_path', 'remote_path', 'explanation'],
    },
  },
  {
    name: 'file_download',
    description: '把服务器上的文件下载到本机的「下载」目录（不会覆盖已有文件，同名时自动改名），返回本机保存路径。服务器没有 SFTP 时自动用 SSH 命令通道或 FTP。目录请先在服务器上打包再下载。',
    parameters: {
      type: 'object',
      properties: {
        host,
        remote_path: { type: 'string', description: '服务器上文件的绝对路径' },
        explanation: { ...explanation, description: '用一两句话说明为什么要下载这个文件' },
      },
      required: ['host', 'remote_path'],
    },
  },
  {
    name: 'schedule_task',
    description:
      '创建本机定时任务（用户要求「每天 / 每隔一段时间 / 某个时间」自动执行时使用）。三种任务：command（按计划执行命令，可以开启 ai_assist：失败时由 Agent 朝着 goal 排查处理，处理后重新执行验证）；' +
      'prompt（AI 任务，例如巡检：务必同时给出 steps——你在对话里验证过的、每次定时执行的命令清单，和 report——汇总报告关注什么、什么算异常；之后每次只执行这些命令，再由 AI 按 report 写报告）；' +
      'sql（SQL 报表：按计划在引用的数据库 db 上执行一条只读 SQL，把结果作为报表发通知，例如日报、告警；不需要 hosts）。需要用户批准；创建前先用 schedule_list 看看有没有重复的任务。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称（简短，例如「每天清理日志」）' },
        hosts: { type: 'array', items: { type: 'string' }, description: '目标主机：本轮的编号（t1、h1）或 host_list 返回的主机名（命令任务和 AI 任务必填，SQL 报表不填）' },
        schedule: {
          type: 'object',
          description: '执行计划',
          properties: {
            kind: { type: 'string', enum: ['interval', 'daily', 'weekly', 'monthly', 'once', 'cron'] },
            every_min: { type: 'integer', description: 'interval：每隔多少分钟' },
            time: { type: 'string', description: 'daily / weekly / monthly：HH:mm（本机时区）' },
            weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly：0–6，周日是 0' },
            month_day: { type: 'integer', description: 'monthly：每月几号' },
            at: { type: 'string', description: 'once：执行时间，格式 YYYY-MM-DD HH:mm（本机时区）' },
            cron: { type: 'string', description: 'cron：5 段表达式（分 时 日 月 周）' },
          },
          required: ['kind'],
        },
        command: { type: 'string', description: '命令任务：每次执行的命令（可以是多行脚本，必须是非交互的）' },
        prompt: { type: 'string', description: 'AI 任务：任务描述（报告里会用到）' },
        steps: {
          type: 'array',
          description: 'AI 任务的执行方案：每次定时执行的命令（非交互、可重复执行、输出简洁；正常的「没找到」不要返回非 0），最多 10 条',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string', description: '"*" 表示所有目标主机，或者某一台目标主机的编号 / 名称' },
              command: { type: 'string' },
              purpose: { type: 'string', description: '这条命令检查什么（几个字）' },
            },
            required: ['command'],
          },
        },
        report: { type: 'string', description: 'AI 任务：每次汇总报告关注什么、什么情况算「需要注意」、什么情况算「异常」' },
        ai_assist: { type: 'boolean', description: '命令任务失败时让 Agent 介入处理（默认 false）' },
        goal: { type: 'string', description: '最终目的：Agent 介入或执行 AI 任务时朝着这个目标处理' },
        ai_policy: {
          type: 'string',
          enum: ['READONLY', 'AI_REVIEW', 'APPROVE'],
          description: '写操作怎么处理：READONLY 只读（跳过写操作）；AI_REVIEW 由 AI 审批（默认，不会半夜等人批准）；APPROVE 方案里的写操作按用户确认的执行、Agent 新提出的写操作等用户批准',
        },
        db: { type: 'string', description: 'SQL 报表：本轮引用的数据库编号（d1）' },
        sql: { type: 'string', description: 'SQL 报表：每次执行的一条只读 SQL（统计让数据库算好，结果行数不要太多）' },
        database: { type: 'string', description: 'SQL 报表：库名（不填用默认库）' },
        report_when: { type: 'string', enum: ['always', 'rows'], description: 'SQL 报表：always 每次都发（日报，默认）；rows 查询有结果时才发（告警，例如「超时未支付的订单」）' },
        ai_summary: { type: 'boolean', description: 'SQL 报表：发送前让 AI 用几句话总结结果（默认 false）' },
        explanation: { ...explanation, description: '用一两句话说明为什么要创建这个定时任务' },
      },
      required: ['name', 'schedule', 'explanation'],
    },
  },
  {
    name: 'schedule_list',
    description: '列出本机已有的定时任务（名称、计划、目标主机、上次结果、下次执行时间）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'serial_send',
    description: '向串口或 Telnet 会话发送一行命令并等待输出（例如交换机、路由器、嵌入式设备的命令行）。默认按写操作审批，只读的查看命令（show / display）除外。',
    parameters: {
      type: 'object',
      properties: {
        host,
        data: { type: 'string', description: '要发送的命令（自动追加换行）' },
        explanation,
        wait_for: { type: 'string', description: '等待出现的提示符（正则），默认等待 2 秒没有新输出' },
        timeout_sec: { type: 'integer' },
      },
      required: ['host', 'data', 'explanation'],
    },
  },
  {
    name: 'kb_search',
    description: '检索团队知识库（排障手册、架构文档、历史复盘），返回相关片段和出处。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer', description: '默认 5' } }, required: ['query'] },
  },
  {
    name: 'skill_load',
    description: '读取一个 Skill 的完整步骤（上下文里列出了可用 Skill 的名称和说明）。任务和某个 Skill 匹配时先调用它。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill 名称或 ID' } }, required: ['name'] },
  },
  {
    name: 'skill_save',
    description:
      '新建或修改本机的 Skill（SKILL.md）。用户要求「创建一个 Skill」「把这个流程做成 Skill」「优化 / 修改某个 Skill」时使用。' +
      '修改已有 Skill 前先用 skill_load 读取原文，在原文基础上改，content 传完整的新版本。需要用户批准，审批卡片会展示改动对比。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修改的 Skill 的名称或 ID；新建时不填' },
        content: {
          type: 'string',
          description:
            '完整的 SKILL.md：开头是 --- 包起来的 YAML front matter（必填 name：字母数字 - _；description：一句话说明做什么，Agent 据此判断是否使用；' +
            '可选 title、risk: readonly | write-needs-approval | dangerous、allowed-tools、triggers、mode: single | parallel、params），后面是 Markdown 写的步骤和输出要求',
        },
        explanation: { ...explanation, description: '用一两句话说明新建 / 修改了什么、为什么' },
      },
      required: ['content', 'explanation'],
    },
  },
  {
    name: 'note_list',
    description: '列出 / 搜索本机笔记（标题、分组、更新时间、开头摘要）。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '标题或正文里包含的文字，不填列出最近的笔记' } } },
  },
  {
    name: 'note_read',
    description: '读取一篇本机笔记的完整正文（Markdown）。',
    parameters: { type: 'object', properties: { note: { type: 'string', description: '笔记 ID 或标题' } }, required: ['note'] },
  },
  {
    name: 'note_save',
    description:
      '新建或修改本机笔记（Markdown）。用户要求「记成笔记」「整理成文档」「更新某篇笔记」时使用。修改前先用 note_read 读取原文，content 传完整的新正文（不是增量）。' +
      '修改会保留上一个版本，用户可以在笔记页撤回。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '要修改的笔记 ID 或标题；新建时不填' },
        title: { type: 'string', description: '标题（新建时必填，修改时不填表示不改）' },
        content: { type: 'string', description: '完整的 Markdown 正文' },
        group: { type: 'string', description: '笔记分组名称（可选，不存在时放在「未分组」）' },
        explanation: { ...explanation, description: '用一两句话说明新建 / 修改了什么' },
      },
      required: ['content', 'explanation'],
    },
  },
  {
    name: 'db_schema',
    description:
      '列出引用的数据库里有哪些库 / 表（表名、类型、估算行数、注释）。MySQL 没有指定 database 且数据库没有默认库时列出所有库；PostgreSQL 还会列出所有库和 schema（默认 public）。写 SQL 之前先用它和 db_describe 了解表结构，不要猜表名和列名。',
    parameters: {
      type: 'object',
      properties: {
        db: dbParam,
        database: { type: 'string', description: '库名（不填用数据库设置里的默认库）' },
        schema: { type: 'string', description: 'PostgreSQL 的 schema，默认 public' },
      },
      required: ['db'],
    },
  },
  {
    name: 'db_describe',
    description: '查看一张表的结构：列（类型、可空、默认值、键、注释）、索引、外键 / 约束，MySQL 和 SQLite 附建表语句。',
    parameters: {
      type: 'object',
      properties: { db: dbParam, table: { type: 'string', description: '表名' }, database: { type: 'string' }, schema: { type: 'string', description: 'PostgreSQL 的 schema，默认 public' } },
      required: ['db', 'table'],
    },
  },
  {
    name: 'db_query',
    description:
      '在引用的数据库上执行一条只读 SQL（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN 等），在只读事务里执行，返回列和行（默认最多 200 行）。' +
      '一次只能一条语句；切换库用 database / schema 参数，不要用 USE / SET。统计、汇总尽量让数据库算（COUNT / SUM / GROUP BY），不要把大量明细读回来；大表要带条件或 LIMIT。写操作会被拒绝，请用 db_execute。',
    parameters: {
      type: 'object',
      properties: {
        db: dbParam,
        sql: { type: 'string', description: '一条只读 SQL' },
        database: { type: 'string', description: '库名（不填用默认库）' },
        schema: { type: 'string', description: 'PostgreSQL 的 schema' },
        max_rows: { type: 'integer', description: '最多返回的行数，默认 200，最大 1000' },
        explanation: { ...explanation, description: '用一两句话说明这条 SQL 查什么、在本次任务里起什么作用' },
      },
      required: ['db', 'sql', 'explanation'],
    },
  },
  {
    name: 'db_explain',
    description: '查看一条 SQL 的执行计划（EXPLAIN，不执行语句），用于分析慢查询、判断有没有用上索引。sql 填要分析的语句本身。',
    parameters: {
      type: 'object',
      properties: { db: dbParam, sql: { type: 'string', description: '要分析的 SQL（不用加 EXPLAIN）' }, database: { type: 'string' }, schema: { type: 'string' } },
      required: ['db', 'sql'],
    },
  },
  {
    name: 'db_execute',
    description:
      '在引用的数据库上执行一条写 SQL（INSERT / UPDATE / DELETE / CREATE / ALTER 等），需要用户批准，在事务里执行（失败自动回滚），返回影响的行数。' +
      'UPDATE / DELETE 必须带 WHERE 条件；执行前先用 db_query 确认会影响哪些行。用户只是要 SQL 时把 SQL 写在回答里，不要执行。',
    parameters: {
      type: 'object',
      properties: {
        db: dbParam,
        sql: { type: 'string', description: '一条写 SQL' },
        database: { type: 'string', description: '库名（不填用默认库）' },
        schema: { type: 'string', description: 'PostgreSQL 的 schema' },
        explanation: { ...explanation, description: '用一两句话说明这条 SQL 改什么、为什么要改（显示在审批卡片上）' },
      },
      required: ['db', 'sql', 'explanation'],
    },
  },
  {
    name: 'mcp_call',
    description: '调用已连接的 MCP Server 提供的工具。上下文里会列出可用的 MCP 工具。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object', description: '工具参数（JSON 对象）' },
      },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'ask_user',
    description:
      '向用户提问并等待回答。需要用户做决定时（几种方案选一个、要不要继续、参数取什么值、命令被拒绝后下一步怎么办）用它，' +
      '不要在回答结尾只写一句「需要我继续吗？」。尽量给出 2～5 个具体的选项（每个选项一句说明），把推荐的放在第一个；用户也可以不选、自己输入。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '简短的问题（一句话）' },
        options: {
          type: 'array',
          description: '候选答案（2～5 个）',
          items: { type: 'object', properties: { label: { type: 'string', description: '选项（简短）' }, description: { type: 'string', description: '这个选项会做什么、影响是什么（一句话）' } }, required: ['label'] },
        },
        recommended: { type: 'integer', description: '推荐选项的下标（从 0 开始），没有推荐时不填' },
        multi_select: { type: 'boolean', description: '可以同时选多个（例如勾选要处理的主机）' },
      },
      required: ['question'],
    },
  },
  {
    name: 'memory_propose',
    description:
      '为主机记录一条长期记忆（用途、依赖、注意事项、排障结论），之后引用这台主机时会看到。只在这次对话得出了新的、以后还用得上的结论时调用，' +
      '不要每次对话结束都记；不要重复主机卡片里已有的记忆；每次只写一条简短的事实。' +
      'certainty=confirmed：这次用命令输出验证过，或者纠正了之前错误的记忆（用 replace 指出被纠正的那一条）——直接保存，不打扰用户；' +
      'certainty=uncertain：推测、没有完全验证——会请用户确认，10 秒内没有回应就不保存。',
    parameters: {
      type: 'object',
      properties: {
        host,
        memory: { type: 'string', description: '要记录的一条记忆（一两句话）' },
        certainty: { type: 'string', enum: ['confirmed', 'uncertain'], description: 'confirmed 已验证（直接保存）；uncertain 不确定（问用户，10 秒没回应跳过）' },
        replace: { type: 'integer', description: '纠正已有记忆时，被替换的那一条的序号（主机卡片「Agent 记忆」里的编号，从 1 开始）' },
      },
      required: ['host', 'memory', 'certainty'],
    },
  },
];

/**
 * 联网工具（文档一 6.38）：只在输入框打开「联网」时才加进工具列表（关闭时工具列表和以前完全一样）。
 * 查询词和网址先脱敏再发出去；返回的网页内容同样放进 <untrusted>。
 */
export const WEB_TOOLS: ToolSpec[] = [
  {
    name: 'web_search',
    description:
      '联网搜索公开网页，返回标题、链接、站点、发布时间和摘要。适合查官方文档、软件版本和变更、报错信息、CVE 公告等公开资料；本地就能查清的问题不要搜索。' +
      '查询词最多 128 个字，用关键词而不是整句话；支持 site:域名、-site:域名、"精确短语"、after:2026-01-01 等语法。' +
      '不要把内网地址、主机名、账号、密码、密钥、客户数据写进查询词。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，例如「nginx 502 upstream prematurely closed site:nginx.org」' },
        count: { type: 'integer', description: '返回条数，默认按用户设置（最多 20）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '读取一个公开网页的正文（Markdown）。一般先用 web_search 找到链接再读取；只能读 http / https 的公网地址，不能读内网地址。',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '完整网址，以 http:// 或 https:// 开头' } }, required: ['url'] },
  },
];
export const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map((t) => t.name));

/**
 * Ask 模式允许的工具（只读的上下文读取，文档一 7.1 / 7.3）。Ask 轮次只把这些工具发给模型（看不到执行命令、写文件的工具），
 * 工具网关也按这个名单拦截——模式靠程序保证，不靠提示词（第三十三轮）
 */
export const ASK_TOOLS = new Set(['read_terminal', 'get_metrics', 'host_list', 'kb_search', 'skill_load', 'ask_user', 'schedule_list', 'note_list', 'note_read', 'db_schema', 'db_describe', 'web_search', 'web_fetch']);

/** 计入「单个任务最多执行 N 条命令」的工具 */
export const COMMAND_TOOLS = new Set(['run_command', 'ssh_exec_batch', 'sftp_write', 'file_upload', 'file_download', 'serial_send', 'mcp_call', 'db_query', 'db_explain', 'db_execute']);

/** 旧版本存进历史的 Ask 模式说明（那时还没有 transient 标记） */
const LEGACY_MODE_NOTE = /^（(SQL 工作台的 )?Ask 模式[：:]/;

/** 只对当前轮有效的块 */
export function isTransientBlock(b: UserBlock): boolean {
  return !!b.transient || (b.kind === 'note' && LEGACY_MODE_NOTE.test(b.text));
}

/** 发给模型的历史：除了最后一条用户消息（当前这一轮），去掉只对当轮有效的块（模式说明等） */
export function stripTransient(messages: StoredMessage[]): StoredMessage[] {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'user') {
      last = i;
      break;
    }
  return messages.map((m, i) => (m.role !== 'user' || i === last || !m.blocks.some(isTransientBlock) ? m : { ...m, blocks: m.blocks.filter((b) => !isTransientBlock(b)) }));
}
