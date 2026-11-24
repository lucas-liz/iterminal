import { useEffect, useState } from 'react';
import { AgentPolicySelect } from '../../components/AgentPolicyMenu';
import { useShare } from '../../store/share';
import dayjs from 'dayjs';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, TimePicker, Tooltip, Typography } from 'antd';
import { BulbOutlined, CaretRightOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, ShareAltOutlined } from '@ant-design/icons';
import { useSkillRun } from '../../components/agent/SkillRunDialog';
import { type AiRule, type Settings, type SkillInfo } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { useAccount } from '../../store/account';
import { FormSection } from '../../components/FormSection';
import { SkillEditor } from './SkillEditor';
import { SettingGroup, SettingRow, SettingsSection } from './parts';

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K]) => void {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => {
    update(key, value).catch((e) => message.error(errorMessage(e)));
  };
}

/** 设置 → AI 模型（第二十五轮改成双栏布局，见 ModelsSettings.tsx） */
export { ModelSettings } from './ModelsSettings';

/** 设置 → Agent 与审批：命令执行权限、审批、上下文压缩、隐私 */
export function AgentSettings(): React.JSX.Element {
  const settings = useApp((s) => s.settings);
  const set = useSet();
  const night = settings['ai.nightWindow'];
  return (
    <SettingsSection title="Agent 与审批" description="Agent 执行的每条命令都会先经过审批引擎判定风险：只读命令可以自动执行，写操作和高危命令需要你批准。">
      <SettingGroup title="命令执行">
        <SettingRow label="默认 Agent 权限" description="主机和分组没有设置 Agent 权限时使用它；主机、分组可以设置得更宽或更严，就近生效（团队主机只能收紧）。生产环境分组里写操作始终需要批准。">
          <AgentPolicySelect style={{ width: 280 }} value={settings['ai.defaultAgentPolicy']} onChange={(v) => v && set('ai.defaultAgentPolicy', v)} testId="default-agent-policy" />
        </SettingRow>
        <SettingRow label="只读命令自动执行" description="关闭后，Agent 执行任何命令都需要你批准；写操作和高危命令始终需要批准">
          <Switch checked={settings['ai.autoApproveReadonly']} onChange={(v) => set('ai.autoApproveReadonly', v)} />
        </SettingRow>
        <SettingRow label="LLM 复核" description="规则判定为写操作或复杂命令时，再让快速模型复核一次（只会提高风险等级，不会降低）">
          <Switch checked={settings['ai.llmReview']} onChange={(v) => set('ai.llmReview', v)} />
        </SettingRow>
        <SettingRow label="夜间时段" description="这段时间里 Agent 不能执行写操作">
          <Space>
            <TimePicker.RangePicker
              format="HH:mm"
              allowClear={false}
              disabled={!night.enabled}
              value={[dayjs(night.from, 'HH:mm'), dayjs(night.to, 'HH:mm')]}
              onChange={(v) => v?.[0] && v[1] && set('ai.nightWindow', { enabled: true, from: v[0].format('HH:mm'), to: v[1].format('HH:mm') })}
              order={false}
              style={{ width: 180 }}
            />
            <Switch checked={night.enabled} onChange={(v) => set('ai.nightWindow', { ...night, enabled: v })} />
          </Space>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="对话">
        <SettingRow label="最大对话循环次数" description="一次任务里 Agent 最多进行多少轮工具调用（执行命令、读文件等），达到后停下来等你继续；定时任务里的 Agent 也按这个上限">
          <InputNumber min={5} max={500} value={settings['ai.maxRounds']} suffix="次" style={{ width: 120 }} onChange={(v) => v && set('ai.maxRounds', v)} data-testid="ai-max-rounds" />
        </SettingRow>
        <SettingRow label="自动压缩阈值" description="上下文占用达到这个比例时，把之前的对话总结成摘要，之后从摘要继续">
          <InputNumber min={50} max={95} value={settings['ai.autoCompressPct']} suffix="%" style={{ width: 120 }} onChange={(v) => v && set('ai.autoCompressPct', v)} />
        </SettingRow>
        <SettingRow label="终端里显示执行提示" description="Agent 在某台主机上执行命令时，在对应的终端里显示一行「✦ Agent 执行：…」">
          <Switch checked={settings['ai.echoToTerminal']} onChange={(v) => set('ai.echoToTerminal', v)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="数据库">
        <SettingRow label="查询最多返回的行数" description="Agent 每次查询数据库最多读取的行数（Agent 可以在单次查询里调小，最大 1000）；统计请让数据库用 COUNT / GROUP BY 汇总">
          <InputNumber min={1} max={1000} value={settings['db.maxRows']} suffix="行" style={{ width: 120 }} onChange={(v) => v && set('db.maxRows', v)} data-testid="db-max-rows" />
        </SettingRow>
        <SettingRow label="SQL 工作台显示的行数" description="「数据库 → SQL 工作台」每个结果最多显示的行数；需要全部数据时用结果下面的「导出全部」（最多 10 万行）">
          <InputNumber min={10} max={5000} value={settings['db.workbenchRows']} suffix="行" style={{ width: 120 }} onChange={(v) => v && set('db.workbenchRows', v)} data-testid="db-workbench-rows" />
        </SettingRow>
        <SettingRow label="查询超时" description="Agent 和 SQL 工作台的查询超过这个时间，数据库取消查询、客户端断开连接">
          <InputNumber min={1} max={300} value={settings['db.timeoutSec']} suffix="秒" style={{ width: 120 }} onChange={(v) => v && set('db.timeoutSec', v)} data-testid="db-timeout" />
        </SettingRow>
        <SettingRow label="按列名脱敏" description="查询结果发给模型前：密码 / 密钥类的列换成 ****，手机号 / 邮箱 / 身份证 / 银行卡类的列换成 [PII]。界面上的结果表格仍显示原值">
          <Switch checked={settings['db.maskColumns']} onChange={(v) => set('db.maskColumns', v)} data-testid="db-mask-columns" />
        </SettingRow>
      </SettingGroup>

      <AiRulesGroup />

      <SettingGroup title="提醒">
        <SettingRow label="需要审批时通知" description="iTerminal 不在前台时，Agent、Skill 或外部 MCP 调用在等你批准会发系统通知">
          <Switch checked={settings['ai.notifyApproval']} onChange={(v) => set('ai.notifyApproval', v)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="主机记忆">
        <SettingRow label="Agent 记录主机记忆" description="自动：这次用命令验证过的结论（包括纠正之前错误的记忆）直接记录；不确定的会问你，10 秒内没有回应就跳过不记。每条都问：都问你，同样 10 秒不回应就跳过。">
          <Segmented
            value={settings['ai.memoryPolicy'] ?? 'auto'}
            onChange={(v) => set('ai.memoryPolicy', v as Settings['ai.memoryPolicy'])}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'ask', label: '每条都问' },
              { value: 'off', label: '关闭' },
            ]}
            data-testid="memory-policy"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="隐私">
        <SettingRow label="隐藏 IP 地址" description="发给模型前把 IP 替换成 HOST_IP_n，模型在命令里使用时自动换回。密码、私钥、云 AK、令牌等始终会脱敏。">
          <Switch checked={settings['ai.maskIps']} onChange={(v) => set('ai.maskIps', v)} />
        </SettingRow>
      </SettingGroup>
    </SettingsSection>
  );
}

/** AI 规则（自定义指令，文档一 6.15.6）：追加到系统提示词，可以逐条停用 */
function AiRulesGroup(): React.JSX.Element {
  const rules = useApp((s) => s.settings['ai.rules']);
  const set = useSet();
  const [drafts, setDrafts] = useState<AiRule[]>(rules);
  useEffect(() => setDrafts(rules), [rules]);
  const commit = (next: AiRule[]): void => set('ai.rules', next.filter((r) => r.text.trim()).map((r) => ({ ...r, text: r.text.trim() })));
  return (
    <SettingGroup
      title="AI 规则"
      extra={
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={drafts.length >= 50}
          onClick={() => setDrafts((d) => [...d, { id: `r${Date.now().toString(36)}`, text: '', enabled: true }])}
          data-testid="ai-rule-add"
        >
          添加规则
        </Button>
      }
    >
      {drafts.length === 0 ? (
        <SettingRow
          label="还没有规则"
          description="规则会作为「用户规则」追加到 Agent 的系统提示词，例如「执行重启前先确认是否在业务低峰」「回答用中文，命令加注释」。安全相关的规则不能被放宽。"
        />
      ) : (
        drafts.map((r, i) => (
          <div key={r.id} className="setting-row ai-rule-row" data-testid="ai-rule">
            <Switch size="small" checked={r.enabled} onChange={(on) => commit(drafts.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)))} />
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 4 }}
              maxLength={2000}
              placeholder="一条规则，例如：执行任何重启命令前先询问我"
              value={r.text}
              autoFocus={!r.text}
              onChange={(e) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              onBlur={() => commit(drafts)}
              data-testid="ai-rule-text"
            />
            <Button type="text" danger icon={<DeleteOutlined />} onClick={() => commit(drafts.filter((x) => x.id !== r.id))} />
          </div>
        ))
      )}
    </SettingGroup>
  );
}

/** 设置 → Skill */
export function SkillSettings(): React.JSX.Element {
  const { message } = App.useApp();
  const skills = useAgent((s) => s.skills);
  const loadSkills = useAgent((s) => s.loadSkills);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  /** 勾选的 Skill（一起分享，第二十二轮） */
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked((p) => p.filter((id) => skills.some((s) => s.id === id))), [skills]);
  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);
  return (
    <SettingsSection
      title="Skill"
      description="每个 Skill 是 Skill 目录下的一个文件夹，里面放一个 SKILL.md（开头用 front matter 写 name 和 description）。在 Agent 的引用里勾选后，正文会加入对话上下文。"
      extra={
        <Space>
          {picked.length > 0 && (
            <Button icon={<ShareAltOutlined />} onClick={() => useShare.getState().open({ skillIds: picked })} data-testid="skill-share-picked">
              分享选中的 {picked.length} 个
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => void loadSkills()}>
            刷新
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void invoke('skill.openDir')}>
            打开 Skill 目录
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ id: null })} data-testid="skill-new">
            新建 Skill
          </Button>
        </Space>
      }
    >
      <SettingGroup title="已安装" flush>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={skills}
          rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys as string[]), columnWidth: 36 }}
          locale={{ emptyText: 'Skill 目录里还没有 Skill' }}
          columns={[
            { title: '名称', dataIndex: 'title', width: 180 },
            {
              title: '说明',
              dataIndex: 'description',
              render: (v: string, s: SkillInfo) => (
                <Space direction="vertical" size={2}>
                  <span>{v}</span>
                  <Space size={4} wrap>
                    <Tag bordered={false}>{s.mode === 'parallel' ? `并行 ×${s.concurrency}` : '单个 Agent'}</Tag>
                    <Tag bordered={false} color={s.risk === 'readonly' ? 'green' : s.risk === 'dangerous' ? 'red' : 'orange'}>
                      {s.risk === 'readonly' ? '只读' : s.risk === 'dangerous' ? '高危' : '写操作需批准'}
                    </Tag>
                    {s.version && <Tag bordered={false}>{`v${s.version}`}</Tag>}
                  </Space>
                </Space>
              ),
            },
            { title: '大小', dataIndex: 'tokens', width: 110, render: (v: number) => `约 ${v} token` },
            {
              title: '',
              key: 'run',
              width: 200,
              render: (_: unknown, s: SkillInfo) => (
                <Space size={4}>
                  <Button size="small" icon={<CaretRightOutlined />} onClick={() => useSkillRun.getState().show({ skillId: s.id })} data-testid={`skill-run-${s.id}`}>
                    运行
                  </Button>
                  <Tooltip title="编辑">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ id: s.id })} data-testid={`skill-edit-${s.id}`} aria-label="编辑" />
                  </Tooltip>
                  <Tooltip title="分享…（生成分享码，同事输入后导入这个 Skill）">
                    <Button size="small" type="text" icon={<ShareAltOutlined />} onClick={() => useShare.getState().open({ skillIds: [s.id] })} data-testid={`skill-share-${s.id}`} aria-label="分享" />
                  </Tooltip>
                  <Popconfirm
                    title={`删除 Skill「${s.title}」？`}
                    description="会删除整个 Skill 目录"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={async () => {
                      try {
                        await invoke('skill.delete', { id: s.id });
                        await loadSkills();
                      } catch (e) {
                        message.error(errorMessage(e));
                      }
                    }}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除" />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </SettingGroup>
      <SkillEditor target={editing} onClose={() => setEditing(null)} />
    </SettingsSection>
  );
}
