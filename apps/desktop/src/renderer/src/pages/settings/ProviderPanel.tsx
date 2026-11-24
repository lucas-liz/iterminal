import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Dropdown, Empty, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  HolderOutlined,
  LeftOutlined,
  PlusOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  DEFAULT_THINKING_STYLE,
  EFFORT_LABEL,
  endpointPreview,
  guessModel,
  thinkingControlOf,
  vendorPreset,
  type AiModelConfig,
  type AiProvider,
  type AiProviderInput,
  type AiProviderType,
  type AiVendorPreset,
  type ThinkingStyle,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { formatTokens } from '../../util/model-tokens';
import { ModelDialog } from './ModelDialog';

export const TYPE_LABEL: Record<AiProviderType, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
  OPENAI_COMPAT: 'OpenAI 兼容',
  OLLAMA: 'Ollama',
};

const STYLE_OPTIONS: { value: ThinkingStyle; label: string }[] = [
  { value: 'anthropic', label: 'Claude（adaptive thinking + effort）' },
  { value: 'openai-effort', label: 'reasoning_effort（OpenAI、Gemini、Ollama）' },
  { value: 'qwen', label: 'enable_thinking + reasoning_effort / thinking_budget（千问、硅基流动）' },
  { value: 'thinking-type', label: 'thinking.type + reasoning_effort（DeepSeek、GLM、Kimi、豆包）' },
  { value: 'minimax', label: 'thinking.type = adaptive + reasoning_split（MiniMax）' },
  { value: 'openrouter', label: 'reasoning.effort（OpenRouter）' },
  { value: 'tags', label: '不发参数，解析 <think> 标签' },
  { value: 'none', label: '不发参数' },
];

/** 导入模型最多选几个（和 NewMax 一样） */
const MAX_IMPORT = 20;

/** 厂商头像：有颜色的圆角方块 + 首字；团队模型用「团」 */
export function VendorAvatar({ vendor, name, team, size = 28 }: { vendor?: string | null; name: string; team?: boolean; size?: number }): React.JSX.Element {
  const preset = vendorPreset(vendor);
  const bg = team ? '#7c5cff' : (preset?.color ?? '#8c8c8c');
  const text = team ? '团' : (preset?.name ?? name).replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1).toUpperCase() || '?';
  return (
    <span className="vendor-avatar2" style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.48) }}>
      {text}
    </span>
  );
}

/** 模型的能力标记：图（图片）、思（思考），不能调用工具时标「无工具」 */
export function ModelCaps({ m }: { m: AiModelConfig }): React.JSX.Element {
  return (
    <span className="model-caps">
      {m.supportsImages && (
        <Tooltip title={m.imageFormat === 'base64' ? '支持图片（纯 base64）' : '支持图片'}>
          <span className="cap-badge">图</span>
        </Tooltip>
      )}
      {m.reasoning && m.reasoning !== 'none' && (
        <Tooltip
          title={`${m.reasoning === 'always' ? '始终思考' : '可开关思考'}${m.efforts?.length ? `，档位：${m.efforts.map((e) => EFFORT_LABEL[e]).join(' / ')}` : ''}`}
        >
          <span className="cap-badge">思</span>
        </Tooltip>
      )}
      {m.supportsTools === false && (
        <Tooltip title="不能调用工具：只能用 Ask 模式问答">
          <span className="cap-badge warn">无工具</span>
        </Tooltip>
      )}
    </span>
  );
}

interface Draft {
  name: string;
  type: AiProviderType;
  baseUrl: string;
  /** 新填写的 Key；空串 = 不修改（已保存的）或者没有 */
  apiKey: string;
  thinkingStyle: ThinkingStyle;
  echoReasoning: boolean;
  models: AiModelConfig[];
  vendor: string | null;
  enabled: boolean;
}

function draftOf(provider: AiProvider | null, preset: AiVendorPreset | null): Draft {
  if (provider)
    return {
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: '',
      thinkingStyle: provider.thinkingStyle,
      echoReasoning: provider.echoReasoning,
      models: provider.models.map((m) => ({ ...m })),
      vendor: provider.vendor,
      enabled: provider.enabled,
    };
  const p = preset!;
  return {
    name: p.key === 'custom' ? '' : p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: '',
    thinkingStyle: p.thinkingStyle,
    echoReasoning: !!p.echoReasoning,
    // 不预先填充模型：从服务商拉取，或者从官方模型里挑、手动添加
    models: [],
    vendor: p.key === 'custom' ? null : p.key,
    enabled: true,
  };
}

/**
 * 模型服务的详情和编辑（第二十五轮，参考 NewMax）：API 密钥、接口地址、API 格式、模型列表（拖拽排序，第一个是主模型）、
 * 从服务商拉取模型列表、测试连接。团队模型只读。
 */
export function ProviderPanel({
  provider,
  preset,
  onBack,
  onSaved,
  onDeleted,
}: {
  /** 已有的提供商；null 表示按 preset 新建 */
  provider: AiProvider | null;
  preset: AiVendorPreset | null;
  onBack?: () => void;
  onSaved(p: AiProvider): void;
  onDeleted?(): void;
}): React.JSX.Element {
  const { message } = App.useApp();
  const initial = useMemo(() => draftOf(provider, preset), [provider, preset]);
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState<'test' | 'save' | 'activate' | 'fetch' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [fetched, setFetched] = useState<{ id: string; ownedBy?: string; contextWindow?: number }[] | null>(null);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const isNew = !provider;
  const team = provider?.source === 'team';
  const vp = vendorPreset(d.vendor) ?? (isNew ? preset : null);
  const custom = !d.vendor;
  const dirty = isNew || d.apiKey !== '' || JSON.stringify({ ...d, apiKey: '' }) !== JSON.stringify(initial);
  const set = (patch: Partial<Draft>): void => setD((x) => ({ ...x, ...patch }));
  useEffect(() => setTest(null), [d.baseUrl, d.apiKey]);

  const input = (models = d.models): AiProviderInput => ({
    name: d.name.trim() || vp?.name || '模型服务',
    type: d.type,
    baseUrl: d.baseUrl,
    apiKey: d.apiKey ? d.apiKey : isNew ? null : undefined,
    models,
    enabled: d.enabled,
    vendor: d.vendor,
    thinkingStyle: d.thinkingStyle,
    echoReasoning: d.echoReasoning,
  });
  /** 拉取模型列表、检测能力：还没有模型时用一个占位模型通过校验 */
  const probeTarget = (): { id: string | null; input: AiProviderInput } | null => {
    if (team) return null;
    if (!d.apiKey && !provider?.hasKey && !vp?.noKey) return null;
    return { id: provider?.id ?? null, input: input(d.models.length ? d.models : [{ id: '__probe__', contextWindow: 8000, maxOutput: 1000 }]) };
  };

  const checkReady = (): boolean => {
    if (!d.models.length) {
      message.warning('至少添加一个模型：可以从服务商拉取模型列表，或者手动添加');
      return false;
    }
    if (!d.baseUrl.trim() && d.type === 'OPENAI_COMPAT') {
      message.warning('请填写接口地址');
      return false;
    }
    return true;
  };

  const runTest = async (): Promise<boolean> => {
    if (!checkReady()) return false;
    setTest(null);
    try {
      const r = await invoke('ai.providers.test', { id: provider?.id ?? null, input: input(), modelId: d.models[0].id });
      setTest({ ok: true, text: `连接成功 · ${r.latencyMs} ms · ${d.models[0].id} 回复：${r.reply}` });
      return true;
    } catch (e) {
      setTest({ ok: false, text: errorMessage(e) });
      return false;
    }
  };

  const save = async (): Promise<void> => {
    if (!checkReady()) return;
    const saved = await invoke('ai.providers.save', { id: provider?.id ?? null, input: input() });
    message.success(isNew ? '已添加并启用' : '已保存');
    onSaved(saved);
  };

  const run = (kind: 'test' | 'save' | 'activate', fn: () => Promise<unknown>): void => {
    setBusy(kind);
    fn()
      .catch((e) => message.error(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const fetchModels = (): void => {
    const target = probeTarget();
    if (!target) return void message.warning(vp?.noKey ? '请先填写接口地址' : '请先填写 API 密钥');
    setBusy('fetch');
    invoke('ai.providers.fetchModels', target)
      .then((list) => {
        if (list.length) setFetched(list);
        else message.info('服务商没有返回模型，请手动添加');
      })
      .catch((e) => message.error(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  /** 导入：勾选的保留 / 添加，取消勾选的（拉到的列表里有的）删掉；拉到的列表里没有的手动模型保留 */
  const applyImport = (picked: string[]): void => {
    const listed = new Set((fetched ?? []).map((x) => x.id));
    const kept = d.models.filter((m) => !listed.has(m.id) || picked.includes(m.id));
    const have = new Set(kept.map((m) => m.id));
    const known = new Map((vp?.models ?? []).map((m) => [m.id, m]));
    const ctx = new Map((fetched ?? []).map((x) => [x.id, x.contextWindow]));
    const added = picked
      .filter((id) => !have.has(id))
      .map((id): AiModelConfig => {
        const base = known.get(id) ? { ...known.get(id)! } : guessModel(d.type, id);
        const c = ctx.get(id);
        return c ? { ...base, contextWindow: c, maxOutput: Math.min(base.maxOutput, c) } : base;
      });
    set({ models: [...kept, ...added] });
    setFetched(null);
  };

  const moveModel = (from: number, to: number): void => {
    if (from === to) return;
    const next = [...d.models];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    set({ models: next });
  };

  const preview = endpointPreview(d.type, d.baseUrl || vp?.baseUrl || '');
  const title = isNew ? `配置 ${vp?.name ?? '自定义供应商'}` : d.name;

  if (team && provider) {
    return (
      <div className="pp" data-testid="provider-panel">
        <div className="pp-card">
          <div className="pp-head">
            <VendorAvatar name={provider.name} team size={30} />
            <span className="pp-title">{provider.name}</span>
            <Tag color="purple" bordered={false}>
              团队
            </Tag>
          </div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            由管理员在管理后台配置，经服务端调用，不需要自己的 API Key；协议 {TYPE_LABEL[provider.type]}。
          </Typography.Paragraph>
          <div className="pp-label">模型</div>
          <div className="pp-models">
            {provider.models.map((m, i) => (
              <div key={m.id} className="pp-model" data-testid="model-row">
                {i === 0 && <span className="pp-main">主模型</span>}
                <span className="pp-model-name" data-testid="model-id" data-value={m.id}>
                  {m.displayName || m.id}
                </span>
                <span className="pp-model-ctx">{formatTokens(m.contextWindow)}</span>
                <ModelCaps m={m} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pp" data-testid="provider-panel">
      {onBack && (
        <Button className="pp-back" type="text" icon={<LeftOutlined />} onClick={onBack} data-testid="provider-back">
          返回列表
        </Button>
      )}
      <div className="pp-card">
        <div className="pp-head">
          <VendorAvatar vendor={d.vendor} name={d.name || title} size={30} />
          <span className="pp-title">{title}</span>
          {provider?.blocked && (
            <Tag bordered={false} color="orange">
              {provider.blocked}
            </Tag>
          )}
          <span className="pp-head-extra">
            {vp?.keyUrl && (
              <a href={vp.keyUrl} target="_blank" rel="noreferrer" data-testid="vendor-key-link">
                去获取 API 密钥 <ExportOutlined />
              </a>
            )}
            {!isNew && (
              <Tooltip title={d.enabled ? '已启用（关闭后对话里不能选择这个服务的模型）' : '已停用'}>
                <Switch size="small" checked={d.enabled} disabled={!!provider?.blocked} onChange={(v) => set({ enabled: v })} data-testid="provider-enabled" />
              </Tooltip>
            )}
          </span>
        </div>
        {vp?.hint && <div className="pp-hint top">{vp.hint}</div>}

        <div className="pp-field">
          <div className="pp-label">名称</div>
          <Input value={d.name} placeholder={vp?.name ?? '例如 公司网关'} onChange={(e) => set({ name: e.target.value })} data-testid="provider-name" />
        </div>
        <div className="pp-field">
          <div className="pp-label">API 密钥</div>
          <Input.Password
            value={d.apiKey}
            placeholder={provider?.hasKey ? '已保存（留空表示不修改）' : vp?.noKey ? '本机服务一般不需要' : '粘贴 API Key，加密保存在本机'}
            autoComplete="new-password"
            onChange={(e) => set({ apiKey: e.target.value.trim() })}
            data-testid="provider-key"
          />
        </div>
        <div className="pp-field">
          <div className="pp-label">接口地址</div>
          <Input value={d.baseUrl} placeholder={vp?.baseUrl || 'https://…/v1'} onChange={(e) => set({ baseUrl: e.target.value })} data-testid="provider-url" />
          <div className="pp-hint">{preview ? <span data-testid="endpoint-preview">实际请求：{preview}</span> : '例如 vLLM、One API、公司网关的地址（OpenAI 格式通常以 /v1 结尾）'}</div>
        </div>
        <div className="pp-field">
          <div className="pp-label">API 格式</div>
          <Segmented
            block
            value={d.type === 'ANTHROPIC' ? 'ANTHROPIC' : d.type === 'OLLAMA' ? 'OLLAMA' : 'OPENAI_COMPAT'}
            disabled={!custom}
            onChange={(v) => {
              const t = v as AiProviderType;
              set({ type: t, thinkingStyle: DEFAULT_THINKING_STYLE[t] });
            }}
            options={[
              { value: 'ANTHROPIC', label: 'Anthropic 格式' },
              { value: 'OPENAI_COMPAT', label: d.type === 'OPENAI' ? 'OpenAI 格式（官方）' : 'OpenAI 格式' },
              ...(d.type === 'OLLAMA' ? [{ value: 'OLLAMA', label: 'Ollama' }] : []),
            ]}
            data-testid="provider-type"
          />
        </div>

        <div className="pp-field">
          <div className="pp-label">
            模型优先级（至少添加一个）
            <span className="pp-label-extra">
              {vp && vp.models.length > 0 && (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: '*', label: '全部添加', 'data-testid': 'preset-model-all' } as never,
                      { type: 'divider' },
                      ...vp.models.map((m) => ({ key: m.id, label: m.displayName ? `${m.displayName}（${m.id}）` : m.id })),
                    ],
                    onClick: ({ key }) => {
                      const have = new Set(d.models.map((m) => m.id));
                      const add = (key === '*' ? vp.models : vp.models.filter((m) => m.id === key)).filter((m) => !have.has(m.id));
                      if (!add.length) return void message.info('已经添加过了');
                      set({ models: [...d.models, ...add.map((m) => ({ ...m, efforts: m.efforts ? [...m.efforts] : m.efforts }))] });
                    },
                  }}
                >
                  <Button size="small" type="text" data-testid="preset-models">
                    官方模型 <DownOutlined />
                  </Button>
                </Dropdown>
              )}
            </span>
          </div>
          <div className="pp-models">
            {d.models.length === 0 && (
              <Typography.Text type="secondary" className="pp-empty" data-testid="model-empty">
                还没有模型：点下面的「从服务商拉取模型列表」，或者从「官方模型」里挑、手动添加
              </Typography.Text>
            )}
            {d.models.map((m, i) => (
              <div
                key={m.id}
                className={`pp-model ${dragOver === i ? 'drag-over' : ''}`}
                draggable
                onDragStart={(e) => {
                  dragFrom.current = i;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver((x) => (x === i ? null : x))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  if (dragFrom.current !== null) moveModel(dragFrom.current, i);
                  dragFrom.current = null;
                }}
                onDragEnd={() => setDragOver(null)}
                data-testid="model-row"
              >
                <HolderOutlined className="pp-drag" />
                {i === 0 ? <span className="pp-main">主模型</span> : <span className="pp-rank">#{i + 1}</span>}
                <span className="pp-model-name" title={m.displayName ? `${m.displayName}（${m.id}）` : m.id} data-testid="model-id" data-value={m.id}>
                  {m.displayName || m.id}
                </span>
                <span className="pp-model-ctx">{formatTokens(m.contextWindow)}</span>
                <ModelCaps m={m} />
                <Tooltip title={`模型设置：上下文、能力、思考档位${thinkingControlOf(m, d.thinkingStyle) === 'budget' ? '（Token 预算）' : ''}；可以检测模型能力`}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ index: i })} data-testid="model-advanced" aria-label="编辑模型" />
                </Tooltip>
                <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => set({ models: d.models.filter((_, j) => j !== i) })} data-testid="model-remove" aria-label="删除模型" />
              </div>
            ))}
            <button type="button" className="pp-add-model" onClick={() => setEditing({ index: null })} data-testid="model-add">
              <PlusOutlined /> 添加模型
            </button>
          </div>
          <div className="pp-hint">拖拽调整顺序：第一个是这个服务的主模型（设为默认服务时对话用它）</div>
          <Button className="pp-fetch" icon={<CloudDownloadOutlined />} loading={busy === 'fetch'} onClick={fetchModels} data-testid="fetch-models">
            从服务商拉取模型列表
          </Button>
        </div>

        <button type="button" className="md-more" onClick={() => setAdvanced((v) => !v)} data-testid="provider-advanced">
          {advanced ? '收起深度思考参数' : '深度思考参数（发送方式、回传思考内容）'}
        </button>
        {advanced && (
          <div className="pp-advanced">
            <div className="pp-field">
              <div className="pp-label">发送方式</div>
              <Select value={d.thinkingStyle} options={STYLE_OPTIONS} disabled={!custom} onChange={(v) => set({ thinkingStyle: v })} style={{ width: '100%' }} data-testid="provider-thinking-style" />
              <div className="pp-hint">选择预设厂商时已自动设置；自定义接口按它实际支持的参数选择</div>
            </div>
            <div className="pp-field row">
              <span className="pp-label">回传思考内容</span>
              <Tooltip title="历史回答带上 reasoning_content（OpenRouter 为 reasoning_details）。DeepSeek、千问、GLM、Kimi、MiniMax 等调用工具时要求回传">
                <Switch size="small" checked={d.echoReasoning} onChange={(v) => set({ echoReasoning: v })} />
              </Tooltip>
            </div>
          </div>
        )}

        {test && <Alert className="pp-test" type={test.ok ? 'success' : 'error'} showIcon message={test.text} data-testid="provider-test-result" />}

        {isNew ? (
          <div className="pp-footer new">
            <Button
              block
              size="large"
              className="pp-activate"
              icon={<ThunderboltOutlined />}
              loading={busy === 'activate'}
              onClick={() => run('activate', async () => (await runTest()) && (await save()))}
              data-testid="provider-activate"
            >
              测试连接并激活
            </Button>
            <Space size={4}>
              <Button type="link" size="small" loading={busy === 'test'} onClick={() => run('test', runTest)} data-testid="provider-test">
                只测试连接
              </Button>
              <Button type="link" size="small" loading={busy === 'save'} onClick={() => run('save', save)} data-testid="provider-save">
                不测试，直接保存
              </Button>
            </Space>
          </div>
        ) : (
          <div className="pp-footer">
            <Button icon={<ThunderboltOutlined />} loading={busy === 'test'} onClick={() => run('test', runTest)} data-testid="provider-test">
              测试连接
            </Button>
            <Popconfirm title={`删除「${provider?.name}」？`} okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => provider && invoke('ai.providers.delete', { id: provider.id }).then(() => onDeleted?.())}>
              <Button danger type="text" icon={<DeleteOutlined />} data-testid="provider-delete">
                删除
              </Button>
            </Popconfirm>
            <span style={{ flex: 1 }} />
            {dirty && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  有未保存的修改
                </Typography.Text>
                <Button onClick={() => setD(initial)} data-testid="provider-discard">
                  放弃
                </Button>
              </>
            )}
            <Button type="primary" disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', save)} data-testid="provider-save">
              保存
            </Button>
          </div>
        )}
      </div>

      {fetched && <ImportModelsModal list={fetched} existing={d.models.map((m) => m.id)} onOk={applyImport} onClose={() => setFetched(null)} />}
      {editing && (
        <ModelDialog
          model={editing.index === null ? null : d.models[editing.index]}
          existingIds={d.models.map((m) => m.id)}
          providerType={d.type}
          thinkingStyle={d.thinkingStyle}
          probeTarget={probeTarget}
          onClose={() => setEditing(null)}
          onOk={(m) => {
            if (editing.index === null) {
              // 手动添加的模型：已知模型先套上已知的配置（用户在弹窗里改过的为准）
              set({ models: [...d.models, m] });
            } else set({ models: d.models.map((x, j) => (j === editing.index ? m : x)) });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** 「从服务商拉取模型列表」的结果：已添加的默认勾选，取消勾选会从列表里删掉（最多 20 个） */
function ImportModelsModal({
  list,
  existing,
  onOk,
  onClose,
}: {
  list: { id: string; ownedBy?: string; contextWindow?: number }[];
  existing: string[];
  onOk(ids: string[]): void;
  onClose(): void;
}): React.JSX.Element {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>(() => list.filter((m) => existing.includes(m.id)).map((m) => m.id));
  const shown = list.filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()));
  const full = picked.length >= MAX_IMPORT;
  return (
    <Modal
      open
      title="导入模型"
      width={600}
      onCancel={onClose}
      okText={`更新列表（${picked.length}/${MAX_IMPORT}）`}
      cancelText="取消"
      onOk={() => onOk(picked)}
      okButtonProps={{ 'data-testid': 'fetch-models-ok' } as never}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
        从服务商拉到 {list.length} 个模型，已添加的模型会默认勾选；取消勾选会从当前列表删除（最多 {MAX_IMPORT} 个）。
      </Typography.Paragraph>
      <Input prefix={<SearchOutlined />} placeholder="搜索模型 ID" allowClear value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="fetch-model-bar">
        <Typography.Text type="secondary">已选 {picked.length} 个</Typography.Text>
        <Button type="link" size="small" onClick={() => setPicked([])}>
          清空
        </Button>
      </div>
      <div className="fetch-model-list" data-testid="fetch-models-list">
        {shown.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型" />}
        {shown.map((m) => {
          const on = picked.includes(m.id);
          return (
            <label key={m.id} className={`fetch-model-row ${on ? 'on' : ''}`}>
              <Checkbox checked={on} disabled={!on && full} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))} />
              <span className="mono fetch-model-id">{m.id}</span>
              {m.contextWindow ? <Typography.Text type="secondary">{formatTokens(m.contextWindow)}</Typography.Text> : null}
              {m.ownedBy && <Typography.Text type="secondary">{m.ownedBy}</Typography.Text>}
              {existing.includes(m.id) && <Tag bordered={false}>已添加</Tag>}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
