import { useEffect, useMemo, useState } from 'react';
import { aiAllowed, promptLogin } from '../../util/ai-access';
import { showConversation } from '../../util/navigate';
import { create } from 'zustand';
import { Alert, App, Form, Input, InputNumber, Modal, Select, Space, Switch, Tag, TreeSelect, Typography } from 'antd';
import type { SkillTargets } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { folderOptions, useHosts } from '../../store/hosts';
import { FormSection } from '../FormSection';

interface SkillRunState {
  open: boolean;
  preset: { skillId?: string; targets?: SkillTargets };
  show(preset?: { skillId?: string; targets?: SkillTargets }): void;
  hide(): void;
}

/** 打开「运行 Skill」对话框（分组右键、主机菜单、设置页、AI 面板都从这里进） */
export const useSkillRun = create<SkillRunState>((set) => ({
  open: false,
  preset: {},
  show(preset = {}) {
    // Skill 由模型执行：离线使用（Guest）时提示登录
    if (!aiAllowed()) return promptLogin('登录后才能运行 Skill');
    set({ open: true, preset });
  },
  hide() {
    set({ open: false });
  },
}));

const RISK_TEXT = { readonly: ['只读', 'green'], 'write-needs-approval': ['写操作需批准', 'orange'], dangerous: ['高危', 'red'] } as const;

/**
 * 运行 Skill（文档一 7.6）：选择 Skill、目标（主机 / 分组 / 标签，不选时用 Skill 声明的默认目标）和参数，预览会在哪些主机上运行。
 */
export function SkillRunDialog(): React.JSX.Element {
  const { message } = App.useApp();
  const { open, preset, hide } = useSkillRun();
  const skills = useAgent((s) => s.skills);
  const model = useAgent((s) => s.model);
  const hosts = useHosts((s) => s.hosts);
  const folders = useHosts((s) => s.folders);
  const [skillId, setSkillId] = useState<string | undefined>();
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, string | number | boolean>>({});
  const [preview, setPreview] = useState<{ hosts: { id: string; name: string }[]; skipped: number } | null>(null);
  const [running, setRunning] = useState(false);
  const skill = skills.find((s) => s.id === skillId);

  useEffect(() => {
    if (!open) return;
    void useAgent.getState().loadSkills();
    // 没打开过 AI 面板时还没有选模型：读一次提供商，用默认模型
    void useAgent.getState().loadProviders();
    setSkillId(preset.skillId ?? useAgent.getState().skills[0]?.id);
    setHostIds(preset.targets?.hostIds ?? []);
    setFolderIds(preset.targets?.folderIds ?? []);
    setTags(preset.targets?.tags ?? []);
  }, [open]);

  useEffect(() => {
    setParams(Object.fromEntries((skill?.params ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default!])));
  }, [skill?.id]);

  const targets: SkillTargets = useMemo(() => ({ hostIds, folderIds, tags }), [hostIds, folderIds, tags]);
  const usingDefaults = !hostIds.length && !folderIds.length && !tags.length;

  // 预览目标：没有选目标时按 Skill 的默认目标解析
  useEffect(() => {
    if (!open || !skill) return;
    const t = setTimeout(() => {
      const defaults = usingDefaults ? defaultTargets(skill.hosts, folders, hosts) : targets;
      invoke('skill.resolveTargets', { targets: defaults })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 200);
    return () => clearTimeout(t);
  }, [open, skill?.id, targets, usingDefaults, folders, hosts]);

  const allTags = useMemo(() => [...new Set(hosts.flatMap((h) => h.tags))].sort(), [hosts]);

  const run = async (): Promise<void> => {
    if (!skill || !model) return;
    setRunning(true);
    try {
      const { conversationId } = await invoke('skill.run', { skillId: skill.id, targets, params, model });
      hide();
      await showConversation(conversationId);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      title="运行 Skill"
      width={640}
      okText={preview?.hosts.length ? `在 ${preview.hosts.length} 台主机上运行` : '运行'}
      cancelText="取消"
      confirmLoading={running}
      okButtonProps={{ disabled: !skill || !model || !preview?.hosts.length, 'data-testid': 'skill-run-ok' } as never}
      onOk={() => void run()}
      onCancel={hide}
      destroyOnHidden
    >
      <FormSection title="Skill">
        <Select
          style={{ width: '100%', marginBottom: 8 }}
          value={skillId}
          onChange={setSkillId}
          placeholder="选择 Skill"
          options={skills.map((s) => ({ value: s.id, label: s.title }))}
          data-testid="skill-run-skill"
        />
        {skill && (
          <div style={{ marginBottom: 12 }}>
            <Space size={4} wrap style={{ marginBottom: 4 }}>
              <Tag bordered={false}>{skill.mode === 'parallel' ? `每台主机并行（同时 ${skill.concurrency} 台）` : '一个 Agent 处理全部目标'}</Tag>
              <Tag bordered={false} color={RISK_TEXT[skill.risk][1]}>
                {RISK_TEXT[skill.risk][0]}
              </Tag>
              {skill.onError === 'stop' && <Tag bordered={false}>出错即停止</Tag>}
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
              {skill.description}
            </Typography.Paragraph>
          </div>
        )}
      </FormSection>
      <FormSection title="目标">
        <Form layout="vertical">
          <Form.Item label="主机">
            <Select
              mode="multiple"
              allowClear
              value={hostIds}
              onChange={setHostIds}
              optionFilterProp="label"
              placeholder="选择主机"
              options={hosts.filter((h) => h.protocol === 'SSH').map((h) => ({ value: h.id, label: h.name }))}
              data-testid="skill-run-hosts"
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item label="分组（含子分组）" style={{ flex: 1 }}>
              <TreeSelect multiple allowClear value={folderIds} onChange={setFolderIds} treeData={folderOptions(folders)} treeDefaultExpandAll placeholder="选择分组" />
            </Form.Item>
            <Form.Item label="标签" style={{ flex: 1 }}>
              <Select mode="multiple" allowClear value={tags} onChange={setTags} options={allTags.map((t) => ({ value: t, label: t }))} placeholder="选择标签" />
            </Form.Item>
          </div>
        </Form>
        {usingDefaults && skill && skill.hosts.length > 0 && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{`没有选择时使用 Skill 声明的默认目标：${skill.hosts.join('、')}`}</Typography.Paragraph>
        )}
        {preview && (
          <Alert
            type={preview.hosts.length ? 'info' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            data-testid="skill-run-preview"
            message={
              preview.hosts.length
                ? `将在 ${preview.hosts.length} 台主机上运行：${preview.hosts.slice(0, 8).map((h) => h.name).join('、')}${preview.hosts.length > 8 ? ' …' : ''}`
                : '没有可以执行的主机（只支持 SSH 主机）'
            }
            description={preview.skipped ? `跳过 ${preview.skipped} 台非 SSH 主机` : undefined}
          />
        )}
      </FormSection>
      {skill && skill.params.length > 0 && (
        <FormSection title="参数">
          <Form layout="vertical">
            {skill.params.map((p) => (
              <Form.Item key={p.name} label={p.name} extra={p.description}>
                {p.type === 'number' ? (
                  <InputNumber value={params[p.name] as number | undefined} onChange={(v) => setParams((x) => ({ ...x, [p.name]: v ?? '' }))} style={{ width: 200 }} />
                ) : p.type === 'boolean' ? (
                  <Switch checked={!!params[p.name]} onChange={(v) => setParams((x) => ({ ...x, [p.name]: v }))} />
                ) : (
                  <Input value={String(params[p.name] ?? '')} onChange={(e) => setParams((x) => ({ ...x, [p.name]: e.target.value }))} data-testid={`skill-param-${p.name}`} />
                )}
              </Form.Item>
            ))}
          </Form>
        </FormSection>
      )}
      {!model && <Alert type="warning" showIcon message="请先在 AI 面板选择模型（或在设置里配置默认模型）" />}
    </Modal>
  );
}

/** 把 Skill 的默认目标（folder:名称、tag:标签、主机名）换成具体的 ID，交给主进程解析 */
function defaultTargets(defs: string[], folders: { id: string; name: string }[], hosts: { id: string; name: string }[]): SkillTargets {
  const t: Required<SkillTargets> = { hostIds: [], folderIds: [], tags: [] };
  for (const d of defs) {
    const [kind, ...rest] = d.split(':');
    const v = rest.join(':').trim();
    if (kind === 'folder') t.folderIds.push(...folders.filter((f) => f.name === v).map((f) => f.id));
    else if (kind === 'tag') t.tags.push(v);
    else t.hostIds.push(...hosts.filter((h) => h.name === d).map((h) => h.id));
  }
  return t;
}
