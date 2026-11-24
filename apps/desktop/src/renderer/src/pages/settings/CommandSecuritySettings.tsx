import { useCallback, useEffect, useState } from 'react';
import { App, Button, Collapse, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, ExperimentOutlined, ExportOutlined, ImportOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
import type { ApprovalDecisionKind, BuiltinRuleView, CommandMatchType, CommandRuleList, CommandTestResult, RiskLevel, Settings, UserCommandRule, UserCommandRuleInput } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { freshOnOpen } from '../../util/fresh';

const LEVEL_TAG: Record<RiskLevel, { color: string; text: string }> = {
  L0: { color: 'green', text: 'L0 只读' },
  L1: { color: 'orange', text: 'L1 写操作' },
  L2: { color: 'red', text: 'L2 高危' },
  DENY: { color: 'magenta', text: '禁止' },
};
const DECISION_TEXT: Record<ApprovalDecisionKind, { color: string; text: string }> = {
  AUTO: { color: 'green', text: '自动执行' },
  APPROVE: { color: 'orange', text: '需要批准' },
  CONFIRM: { color: 'red', text: '输入主机名确认' },
  REMOTE: { color: 'purple', text: '远程审批' },
  DENY: { color: 'magenta', text: '拒绝' },
};
const MATCH_LABEL: Record<CommandMatchType, string> = { PREFIX: '前缀', REGEX: '正则', EXACT: '完全一致' };

const LISTS: { key: CommandRuleList; label: string; desc: string; color: string; placeholder: string }[] = [
  { key: 'WHITE', label: '白名单', desc: '视为只读（L0），可以自动执行', color: 'green', placeholder: '例如 kubectl get、docker ps、nginx -t，回车添加' },
  { key: 'DANGER', label: '危险命令', desc: '视为高危（L2），按「高危命令」的方式确认', color: 'red', placeholder: '例如 systemctl restart、kubectl delete，回车添加' },
  { key: 'BLACK', label: '黑名单', desc: '禁止执行（也可以改成输入主机名确认）', color: 'magenta', placeholder: '例如 reboot、iptables -F，回车添加' },
];

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K]) => void {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => {
    update(key, value).catch((e) => message.error(errorMessage(e)));
  };
}

function RuleEditorDialog({ target, onClose }: { target: UserCommandRule | 'new' | null; onClose(saved: boolean): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<UserCommandRuleInput>();
  const editing = target && target !== 'new' ? target : null;
  return (
    <Modal
      open={!!target}
      title={editing ? '编辑规则' : '添加自定义规则'}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
      onCancel={() => onClose(false)}
      okButtonProps={{ 'data-testid': 'cmdrule-save' } as never}
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await invoke('cmdrule.save', { id: editing?.id ?? null, input: v });
          onClose(true);
        } catch (e) {
          message.error(errorMessage(e));
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        requiredMark={false}
        initialValues={editing ? { ...editing } : { level: 'L1', matchType: 'PREFIX', pattern: '', priority: 100, note: '', enabled: true }}
      >
        <Space style={{ width: '100%' }} styles={{ item: { flex: 1 } }}>
          <Form.Item name="matchType" label="匹配方式">
            <Select options={(Object.keys(MATCH_LABEL) as CommandMatchType[]).map((k) => ({ value: k, label: MATCH_LABEL[k] }))} />
          </Form.Item>
          <Form.Item name="level" label="风险等级">
            <Select options={(Object.keys(LEVEL_TAG) as RiskLevel[]).map((k) => ({ value: k, label: LEVEL_TAG[k].text }))} data-testid="cmdrule-level" />
          </Form.Item>
          <Form.Item name="priority" label="顺序" tooltip="自定义规则之间越小越先匹配；三个快捷名单总是排在前面">
            <InputNumber min={0} max={9999} style={{ width: '100%' }} />
          </Form.Item>
        </Space>
        <Form.Item
          name="pattern"
          label="匹配内容"
          extra="匹配的是去掉 sudo、env、timeout 等包装后的命令，例如「systemctl restart nginx」；前缀按词边界匹配"
          rules={[{ required: true, whitespace: true, message: '请填写匹配内容' }]}
        >
          <Input className="mono" placeholder="例如 systemctl restart 或 ^kubectl\s+delete\s" data-testid="cmdrule-pattern" />
        </Form.Item>
        <Form.Item name="note" label="说明">
          <Input placeholder="在审批卡片的判定依据里显示" />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const RuleEditor = freshOnOpen(RuleEditorDialog, (p) => p.target);

/**
 * 设置 → 命令安全（文档一 6.15.7）：在内置审批规则之上，配置白名单 / 危险命令 / 黑名单、自定义规则和处理策略，
 * 可以输入命令测试判定结果。
 */
export function CommandSecuritySettings(): React.JSX.Element {
  const { message } = App.useApp();
  const settings = useApp((s) => s.settings);
  const set = useSet();
  const [user, setUser] = useState<UserCommandRule[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinRuleView[]>([]);
  const [team, setTeam] = useState<BuiltinRuleView[]>([]);
  const [editing, setEditing] = useState<UserCommandRule | 'new' | null>(null);
  const [testCmd, setTestCmd] = useState('');
  const [test, setTest] = useState<(CommandTestResult & { command: string; seq: number }) | null>(null);
  const [testing, setTesting] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const doImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (!importPath) return;
    try {
      const r = await invoke('cmdrule.import', { filePath: importPath, mode });
      message.success(`已导入 ${r.added} 条`);
      await useApp.getState().load();
      await reload();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setImportPath(null);
    }
  };

  const reload = useCallback(async () => {
    try {
      const r = await invoke('cmdrule.list');
      setUser(r.user);
      setBuiltin(r.builtin);
      setTeam(r.team ?? []);
    } catch (e) {
      message.error(errorMessage(e));
    }
  }, [message]);
  useEffect(() => void reload(), [reload]);

  const runTest = async (cmd = testCmd): Promise<void> => {
    if (!cmd.trim()) return;
    setTesting(true);
    try {
      const r = await invoke('cmdrule.test', { command: cmd });
      setTest((t) => ({ ...r, command: cmd, seq: (t?.seq ?? 0) + 1 }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };
  // 规则或策略变化后，自动重新测试
  useEffect(() => {
    if (test && testCmd.trim()) void runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, settings['security.l2Decision'], settings['security.blacklistDecision'], settings['security.strict'], settings['security.maxLength'], settings['ai.autoApproveReadonly']]);

  const setList = async (list: CommandRuleList, patterns: string[]): Promise<void> => {
    try {
      await invoke('cmdrule.setList', { list, patterns });
      await reload();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const custom = user.filter((r) => !r.list);

  return (
    <SettingsSection
      title="命令安全"
      description="Agent、Skill 和外部 MCP 调用执行的每条命令都要经过审批引擎。这里可以在内置规则之上补充白名单、危险命令和黑名单，并调整各等级的处理方式。手动在终端里输入的命令不受影响。"
      extra={
        <Space>
          <Button
            icon={<ImportOutlined />}
            onClick={async () => {
              const filePath = await invoke('dialog.openFile', { title: '导入命令规则', filters: [{ name: 'JSON', extensions: ['json'] }] });
              if (filePath) setImportPath(filePath);
            }}
          >
            导入
          </Button>
          <Button
            icon={<ExportOutlined />}
            onClick={async () => {
              const filePath = await invoke('dialog.saveFile', { title: '导出命令规则', defaultName: 'iterminal-command-rules.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
              if (!filePath) return;
              try {
                const r = await invoke('cmdrule.export', { filePath });
                message.success(`已导出 ${r.count} 条规则和处理策略`);
              } catch (e) {
                message.error(errorMessage(e));
              }
            }}
          >
            导出
          </Button>
          <Popconfirm
            title="恢复默认？"
            description="清空全部自定义规则和名单，处理策略恢复默认"
            okText="恢复"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await invoke('cmdrule.reset');
              await useApp.getState().load();
              await reload();
            }}
          >
            <Button icon={<UndoOutlined />}>恢复默认</Button>
          </Popconfirm>
        </Space>
      }
    >
      <SettingGroup title="命令测试">
        <div className="cmdtest" data-testid="cmdtest">
          <Space.Compact style={{ width: '100%' }}>
            <Input
              className="mono"
              placeholder="输入一条命令看看会怎么处理，例如 sudo systemctl restart nginx && df -h"
              value={testCmd}
              onChange={(e) => setTestCmd(e.target.value)}
              onPressEnter={() => void runTest()}
              data-testid="cmdtest-input"
            />
            <Button type="primary" icon={<ExperimentOutlined />} loading={testing} onClick={() => void runTest()} data-testid="cmdtest-run">
              测试
            </Button>
          </Space.Compact>
          {test && (
            <div className="cmdtest-result" data-testid="cmdtest-result" data-command={test.command} data-seq={test.seq}>
              <Space wrap>
                <span>判定：</span>
                <Tag color={LEVEL_TAG[test.level].color}>{LEVEL_TAG[test.level].text}</Tag>
                <span>处理：</span>
                <Tag color={DECISION_TEXT[test.decision].color} data-testid="cmdtest-decision">
                  {DECISION_TEXT[test.decision].text}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （按默认 Agent 权限、非生产环境）
                </Typography.Text>
              </Space>
              {test.segments.length > 0 && (
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(_, i) => String(i)}
                  dataSource={test.segments}
                  style={{ marginTop: 8 }}
                  columns={[
                    { title: '子命令', dataIndex: 'text', render: (v: string) => <code className="mono">{v}</code> },
                    { title: '等级', dataIndex: 'level', width: 100, render: (v: RiskLevel) => <Tag color={LEVEL_TAG[v].color}>{LEVEL_TAG[v].text}</Tag> },
                    {
                      title: '命中规则',
                      dataIndex: 'rule',
                      width: 220,
                      render: (v: string | null, r) =>
                        v ? (
                          <Space size={4}>
                            <Tag bordered={false} color={r.source === 'user' ? 'blue' : r.source === 'team' ? 'purple' : 'default'}>
                              {r.source === 'user' ? '自定义' : r.source === 'team' ? '团队' : '内置'}
                            </Tag>
                            <span>{v}</span>
                          </Space>
                        ) : r.unknown ? (
                          <Typography.Text type="secondary">未知命令</Typography.Text>
                        ) : (
                          '—'
                        ),
                    },
                  ]}
                />
              )}
              <ul className="cmdtest-reasons">
                {test.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingGroup>

      <SettingGroup title="处理策略">
        <SettingRow label="只读命令（L0）自动执行" description="关闭后，Agent 执行任何命令都需要你批准">
          <Switch checked={settings['ai.autoApproveReadonly']} onChange={(v) => set('ai.autoApproveReadonly', v)} />
        </SettingRow>
        <SettingRow label="写操作（L1）" description="由「Agent 与审批」里的默认 Agent 权限和分组 / 主机的设置决定：需要批准、交给 AI 自动审批，或在「完全允许」时自动执行；生产环境始终需要批准" />
        <SettingRow label="高危命令（L2）" description="删除数据、格式化、批量杀进程等不可逆操作">
          <Segmented
            value={settings['security.l2Decision']}
            onChange={(v) => set('security.l2Decision', v as Settings['security.l2Decision'])}
            options={[
              { value: 'CONFIRM', label: '输入主机名确认' },
              { value: 'APPROVE', label: '单击批准' },
              { value: 'DENY', label: '直接拒绝' },
            ]}
            data-testid="sec-l2"
          />
        </SettingRow>
        <SettingRow label="黑名单命中" description="只影响你自己添加的黑名单">
          <Segmented
            value={settings['security.blacklistDecision']}
            onChange={(v) => set('security.blacklistDecision', v as Settings['security.blacklistDecision'])}
            options={[
              { value: 'DENY', label: '直接拒绝' },
              { value: 'CONFIRM', label: '输入主机名确认' },
            ]}
            data-testid="sec-black"
          />
        </SettingRow>
        <SettingRow label="严格模式" description="不在任何规则里的未知命令直接拒绝（默认按写操作处理、需要批准）">
          <Switch checked={settings['security.strict']} onChange={(v) => set('security.strict', v)} data-testid="sec-strict" />
        </SettingRow>
        <SettingRow label="最大命令长度" description="超过这个长度的命令直接拒绝">
          <InputNumber min={100} max={100000} step={1000} value={settings['security.maxLength']} onChange={(v) => v && set('security.maxLength', v)} addonAfter="字符" style={{ width: 160 }} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="快捷名单（按命令前缀匹配）">
        {LISTS.map((l) => (
          <SettingRow
            key={l.key}
            block
            label={
              <Space size={6}>
                <Tag color={l.color} bordered={false}>
                  {l.label}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                  {l.desc}
                </Typography.Text>
              </Space>
            }
          >
            <Select
              mode="tags"
              style={{ width: '100%' }}
              placeholder={l.placeholder}
              tokenSeparators={['\n']}
              open={false}
              suffixIcon={null}
              value={user.filter((r) => r.list === l.key).map((r) => r.pattern)}
              onChange={(v: string[]) => void setList(l.key, v)}
              tagRender={({ label, closable, onClose }) => (
                <Tag color={l.color} closable={closable} onClose={onClose} className="mono" style={{ marginInlineEnd: 4 }}>
                  {label}
                </Tag>
              )}
              data-testid={`cmdlist-${l.key}`}
            />
          </SettingRow>
        ))}
      </SettingGroup>

      <SettingGroup
        title="自定义规则"
        flush
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing('new')} data-testid="cmdrule-add">
            添加规则
          </Button>
        }
      >
        <Table<UserCommandRule>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={custom}
          locale={{ emptyText: '需要按正则或完全一致匹配、或者指定 L1 等级时，在这里添加规则' }}
          columns={[
            { title: '匹配', dataIndex: 'matchType', width: 90, render: (v: CommandMatchType) => <Tag bordered={false}>{MATCH_LABEL[v]}</Tag> },
            { title: '内容', dataIndex: 'pattern', render: (v: string) => <code className="mono">{v}</code> },
            { title: '等级', dataIndex: 'level', width: 100, render: (v: RiskLevel) => <Tag color={LEVEL_TAG[v].color}>{LEVEL_TAG[v].text}</Tag> },
            { title: '顺序', dataIndex: 'priority', width: 60 },
            { title: '说明', dataIndex: 'note', render: (v: string | null) => v ?? '' },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 60,
              render: (v: boolean, r) => (
                <Switch
                  size="small"
                  checked={v}
                  onChange={async (on) => {
                    await invoke('cmdrule.save', { id: r.id, input: { ...r, enabled: on } });
                    await reload();
                  }}
                />
              ),
            },
            {
              title: '',
              key: 'op',
              width: 80,
              render: (_, r) => (
                <Space size={2}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(r)} />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={async () => {
                      await invoke('cmdrule.delete', { id: r.id });
                      await reload();
                    }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </SettingGroup>

      <Collapse
        className="builtin-rules"
        defaultActiveKey={team.length ? ['team'] : []}
        key={team.length ? 'with-team' : 'no-team'}
        items={[
          ...(team.length
            ? [
                {
                  key: 'team',
                  label: `团队规则（${team.length} 条，由服务端下发，最先匹配，只读）`,
                  children: (
                    <Table<BuiltinRuleView>
                      size="small"
                      rowKey="id"
                      pagination={{ pageSize: 10, size: 'small' }}
                      dataSource={team}
                      data-testid="team-rules"
                      columns={[
                        { title: '等级', dataIndex: 'level', width: 100, render: (v: RiskLevel) => <Tag color={LEVEL_TAG[v].color}>{LEVEL_TAG[v].text}</Tag> },
                        { title: '说明', dataIndex: 'note', width: 180 },
                        { title: '规则', dataIndex: 'pattern', render: (v: string) => <code className="mono builtin-pattern">{v}</code> },
                      ]}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'builtin',
            label: `内置规则（${builtin.length} 条，只读）`,
            children: (
              <Table<BuiltinRuleView>
                size="small"
                rowKey="id"
                pagination={{ pageSize: 10, size: 'small' }}
                dataSource={builtin}
                columns={[
                  { title: '等级', dataIndex: 'level', width: 100, render: (v: RiskLevel) => <Tag color={LEVEL_TAG[v].color}>{LEVEL_TAG[v].text}</Tag> },
                  { title: '说明', dataIndex: 'note', width: 180 },
                  {
                    title: '规则',
                    dataIndex: 'pattern',
                    render: (v: string) => (
                      <Tooltip title={v}>
                        <code className="mono builtin-pattern">{v}</code>
                      </Tooltip>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        内置规则判定为高危（L2）的命令不能被白名单降级；白名单命令带写入参数（例如 sed -i、重定向写文件）时仍按写操作处理。生产环境分组至少按 L1 处理。
      </Typography.Paragraph>

      <Modal
        open={!!importPath}
        title="导入命令规则"
        onCancel={() => setImportPath(null)}
        footer={
          <Space>
            <Button onClick={() => setImportPath(null)}>取消</Button>
            <Button danger onClick={() => void doImport('replace')}>
              替换现有规则
            </Button>
            <Button type="primary" onClick={() => void doImport('merge')}>
              合并
            </Button>
          </Space>
        }
      >
        合并：保留现有规则，追加文件里的规则；替换：先清空现有的自定义规则和名单。两种方式都会使用文件里的处理策略。
      </Modal>
      <RuleEditor
        target={editing}
        onClose={(saved) => {
          setEditing(null);
          if (saved) void reload();
        }}
      />
    </SettingsSection>
  );
}
