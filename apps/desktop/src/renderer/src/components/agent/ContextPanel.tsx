import { Button, Tooltip, Typography } from 'antd';
import { ApiOutlined, BookOutlined, CloseOutlined, CloudServerOutlined, CodeOutlined, DatabaseOutlined, FileTextOutlined, FolderOutlined, PaperClipOutlined, ReadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { AgentRefs, Folder, Host, McpServerConfig, Note, SkillInfo } from '@itm/protocol';
import { useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { useLibrary } from '../../store/library';
import { openHost } from '../../actions';
import { DB_TYPE_LABEL, dbWhere, useDatabases } from '../../store/databases';
import { kbName, useKb } from '../../store/kb';

interface Props {
  refs: AgentRefs;
  hosts: Host[];
  folders: Folder[];
  notes: Note[];
  mcpServers: McpServerConfig[];
  skills: SkillInfo[];
}

/** 一类引用一张卡片（参考 Claude 右侧的「环境」「输出内容」） */
function Section({ title, count, children, action }: { title: string; count: number; children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element | null {
  if (!count) return null;
  return (
    <div className="ctx-card">
      <div className="ctx-card-head">
        <span>{title}</span>
        <span className="ctx-count">{count}</span>
        {action}
      </div>
      <div className="ctx-card-body">{children}</div>
    </div>
  );
}

function Item({ icon, label, sub, title, onOpen, onRemove, extra, testId }: { icon: React.ReactNode; label: string; sub?: string; title?: string; onOpen?(): void; onRemove(): void; extra?: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <div className={`ctx-item ${onOpen ? 'link' : ''}`} title={title} data-testid={testId}>
      <span className="ctx-icon">{icon}</span>
      <span className="ctx-label" onClick={onOpen}>
        <span className="ctx-name">{label}</span>
        {sub && <span className="ctx-sub">{sub}</span>}
      </span>
      {extra}
      <Tooltip title="移除引用">
        <Button size="small" type="text" className="ctx-x" icon={<CloseOutlined />} onClick={onRemove} aria-label="移除引用" />
      </Tooltip>
    </div>
  );
}

/**
 * AI 对话模式右侧的上下文面板（参考 Claude）：只展示本轮引用的终端 / 主机、分组、笔记、Skill、MCP、文件（悬停时可以移除）；
 * 添加引用在输入框左下角的 +，或者输入 @。终端页右侧的 AI 面板仍然把引用放在输入框上方。
 */
export function ContextPanel({ refs, hosts, folders, notes, mcpServers, skills }: Props): React.JSX.Element {
  const st = useAgent();
  const databases = useDatabases((s) => s.list);
  const kbList = useKb((s) => s.list);
  const total = refs.terminals.length + st.folderIds.length + st.noteIds.length + skills.length + st.mcpServerIds.length + st.databaseIds.length + st.kbCollections.length + st.files.length + st.attachments.length;
  return (
    <aside className="agent-context" data-testid="agent-context">
      <div className="ctx-head">
        <Typography.Text strong>上下文</Typography.Text>
        {total > 0 && <span className="ctx-count">{total}</span>}
      </div>
      <div className="ctx-body" data-testid="agent-refs">
        {total === 0 && (
          <div className="ctx-card ctx-empty-card" data-testid="ctx-empty">
            <div className="ctx-card-head">
              <span>还没有引用</span>
            </div>
            <div className="ctx-empty">没有引用终端或主机时，Agent 不能执行命令。点输入框左下角的 + 或输入 @，可以引用主机、数据库、知识库、分组、笔记、Skill、MCP 和文件。</div>
          </div>
        )}
        <Section
          title="终端 / 主机"
          count={refs.terminals.length}
          action={
            refs.terminals.length > 1 ? (
              <Button size="small" type="link" danger className="ctx-clear" onClick={() => st.removeTerminalRefs(refs.terminals)} data-testid="ctx-hosts-clear">
                全部移除
              </Button>
            ) : undefined
          }
        >
          {refs.terminals.map((t) => (
            <Item
              key={t.tabId}
              icon={t.kind === 'local' ? <CodeOutlined /> : <CloudServerOutlined />}
              label={t.title}
              sub={t.sessionId ? '已连接的终端' : '执行命令时建立连接'}
              title={t.sessionId ? '已连接的终端' : '未打开终端的主机（执行命令时会建立连接）'}
              onRemove={() => st.removeTerminalRefs([t])}
              extra={
                !t.sessionId && t.hostId ? (
                  <Tooltip title="在终端中打开">
                    <Button
                      size="small"
                      type="text"
                      className="ctx-x"
                      icon={<CodeOutlined />}
                      onClick={() => {
                        const h = hosts.find((x) => x.id === t.hostId);
                        if (!h) return;
                        openHost(h, 'ssh');
                        useApp.getState().leaveAi('workspace');
                      }}
                      data-testid="ref-open-terminal"
                    />
                  </Tooltip>
                ) : undefined
              }
            />
          ))}
        </Section>
        <Section title="数据库" count={st.databaseIds.length}>
          {st.databaseIds.map((did) => {
            const d = databases.find((x) => x.id === did);
            return (
              <Item
                key={did}
                icon={<DatabaseOutlined />}
                label={d?.name ?? '（已删除）'}
                sub={d ? `${DB_TYPE_LABEL[d.type]} ${dbWhere(d)}` : undefined}
                title="Agent 可以查询这个数据库，改数据需要你批准"
                onRemove={() => st.toggleDatabase(did, false)}
                testId="ctx-db"
              />
            );
          })}
        </Section>
        <Section title="知识库" count={st.kbCollections.length}>
          {st.kbCollections.map((kid) => (
            <Item key={kid} icon={<ReadOutlined />} label={kbName(kbList, kid)} sub="发送时先按问题检索，命中的片段一起发给模型" onRemove={() => st.toggleKb(kid, false)} testId="ctx-kb" />
          ))}
        </Section>
        <Section title="分组" count={st.folderIds.length}>
          {st.folderIds.map((fid) => (
            <Item key={fid} icon={<FolderOutlined />} label={folders.find((f) => f.id === fid)?.name ?? '（已删除）'} sub="包含子分组里的主机" onRemove={() => st.toggleFolder(fid, false)} />
          ))}
        </Section>
        <Section title="笔记" count={st.noteIds.length}>
          {st.noteIds.map((nid) => (
            <Item
              key={nid}
              icon={<BookOutlined />}
              label={notes.find((n) => n.id === nid)?.title ?? '（已删除）'}
              title="点击打开笔记（发给模型前脱敏）"
              onOpen={() => useLibrary.getState().openNote(nid)}
              onRemove={() => st.toggleNote(nid, false)}
            />
          ))}
        </Section>
        <Section title="Skill" count={skills.length}>
          {skills.map((s) => (
            <Item key={s.id} icon={<ThunderboltOutlined />} label={s.title} sub={s.description} onRemove={() => st.toggleSkill(s.id, false)} />
          ))}
        </Section>
        <Section title="MCP" count={st.mcpServerIds.length}>
          {st.mcpServerIds.map((mid) => (
            <Item key={mid} icon={<ApiOutlined />} label={mcpServers.find((s) => s.id === mid)?.name ?? 'MCP'} sub="Agent 可以调用它的工具" onRemove={() => st.toggleMcp(mid, false)} />
          ))}
        </Section>
        <Section title="文件（只在下一次发送时带上）" count={st.files.length + st.attachments.length}>
          {st.files.map((f, i) => (
            <Item key={`${f.hostId}:${f.path}`} icon={<FileTextOutlined />} label={f.path.split('/').pop() ?? f.path} sub={`${f.path}（尾部 ${f.tailLines ?? 200} 行）`} onRemove={() => st.removeFile(i)} />
          ))}
          {st.attachments.map((a) => (
            <Item key={a.path} icon={<PaperClipOutlined />} label={a.name} sub={a.path} onRemove={() => st.removeAttachment(a.path)} />
          ))}
        </Section>
      </div>
    </aside>
  );
}
