import { useEffect, useMemo, useState } from 'react';
import { App, Form, Input, Modal, Select, Switch, Typography } from 'antd';
import type { AgentPolicy, Folder, FolderSettingsInput, SkillInfo } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { folderLabel, useHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';
import { AgentPolicySelect } from '../../components/AgentPolicyMenu';
import { FormSection } from '../../components/FormSection';
import { freshOnOpen } from '../../util/fresh';

interface FormValues {
  defaultCredentialId: string;
  defaultJumpHostId: string;
  agentPolicy: AgentPolicy | '';
  aiNote: string;
  defaultSkills: string[];
  production: boolean;
}

/**
 * 分组设置（文档一 6.5）：默认凭证、默认跳板机、Agent 权限、说明、默认 Skill，逐级继承到子分组和其中的主机。
 */
function FolderSettingsModalDialog({ folder, onClose, onSaved }: { folder: Folder | null; onClose(): void; onSaved(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const folders = useHosts((s) => s.folders);
  const hosts = useHosts((s) => s.hosts);
  const credentials = useVault((s) => s.credentials);
  const [form] = Form.useForm<FormValues>();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (folder) void invoke('skill.list').then(setSkills).catch(() => setSkills([]));
  }, [folder]);

  const parentHint = useMemo(() => (folder?.parentId ? `上级分组「${folderLabel(folders, folder.parentId)}」的设置会继承下来；这里设置的值优先。` : ''), [folder, folders]);

  const save = async (): Promise<void> => {
    if (!folder) return;
    const v = await form.validateFields();
    const settings: FolderSettingsInput = {
      defaultCredentialId: v.defaultCredentialId || null,
      defaultJumpHostId: v.defaultJumpHostId || null,
      agentPolicy: v.agentPolicy || null,
      aiNote: v.aiNote || null,
      defaultSkills: v.defaultSkills ?? [],
      production: !!v.production,
    };
    setSaving(true);
    try {
      await invoke('folder.update', { id: folder.id, settings });
      message.success('分组设置已保存');
      onSaved();
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!folder}
      title={`分组设置 · ${folder ? folderLabel(folders, folder.id) : ''}`}
      width={580}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={onClose}
      destroyOnHidden
    >
      {folder && (
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            defaultCredentialId: folder.defaultCredentialId ?? '',
            defaultJumpHostId: folder.defaultJumpHostId ?? '',
            agentPolicy: folder.agentPolicy ?? '',
            aiNote: folder.aiNote ?? '',
            defaultSkills: folder.defaultSkills,
            production: folder.production,
          }}
          data-testid="folder-settings"
        >
          {parentHint && <Typography.Paragraph type="secondary">{parentHint}</Typography.Paragraph>}
          <FormSection title="连接">
            <Form.Item name="defaultCredentialId" label="默认凭证" extra="认证方式为「使用凭证」且没有指定凭证的主机使用它">
              <Select
                showSearch
                optionFilterProp="label"
                options={[
                  { value: '', label: '继承上级' },
                  ...credentials.filter((c) => !c.ownerHostId && (c.type === 'PASSWORD' || c.type === 'SSH_KEY' || c.type === 'DB')).map((c) => ({ value: c.id, label: `${c.name}${c.username ? `（${c.username}）` : ''}` })),
                ]}
              />
            </Form.Item>
            <Form.Item name="defaultJumpHostId" label="默认跳板机" extra="没有设置跳板机的主机经过它连接（跳板机自己除外）">
              <Select
                showSearch
                optionFilterProp="label"
                options={[{ value: '', label: '继承上级' }, ...hosts.filter((h) => h.protocol === 'SSH').map((h) => ({ value: h.id, label: `${h.name}（${h.address}）` }))]}
              />
            </Form.Item>
          </FormSection>
          <FormSection title="Agent">
            <Form.Item name="agentPolicy" label="Agent 权限" extra="子分组和主机没有设置时使用它（就近生效）；团队主机只能收紧">
              <AgentPolicySelect inherit={{ label: '继承上级', description: '使用上级分组的 Agent 权限，顶层分组使用「设置 → Agent 与审批」里的默认权限' }} testId="folder-agent-policy" />
            </Form.Item>
            <Form.Item name="production" label="生产环境" valuePropName="checked" extra="Agent 在其中的主机上执行任何写操作都需要审批（即使权限是「完全允许」）">
              <Switch />
            </Form.Item>
            <Form.Item name="aiNote" label="分组说明" extra="逐级拼接后作为 Agent 的上下文，例如业务、负责人、注意事项">
              <Input.TextArea rows={3} maxLength={4000} placeholder="例如：订单服务，Java 17 + Tomcat；变更窗口 22:00-24:00" />
            </Form.Item>
            <Form.Item name="defaultSkills" label="默认 Skill" extra="引用这个分组里的主机时，Agent 会优先考虑这些 Skill">
              <Select mode="tags" options={skills.map((s) => ({ value: s.id, label: s.name }))} />
            </Form.Item>
          </FormSection>
        </Form>
      )}
    </Modal>
  );
}

export const FolderSettingsModal = freshOnOpen(FolderSettingsModalDialog, (p) => p.folder);
