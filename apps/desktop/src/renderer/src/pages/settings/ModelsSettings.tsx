import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Empty, Input, InputNumber, Segmented, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { CameraOutlined, GlobalOutlined, HolderOutlined, InfoCircleOutlined, PartitionOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import {
  AI_VENDOR_TABS,
  EFFORT_LABEL,
  EFFORTS,
  WEB_SEARCH_COUNT,
  WEB_SEARCH_FORMATS,
  vendorsInTab,
  type AiProvider,
  type AiVendorPreset,
  type Effort,
  type ModelRef,
  type Settings,
  type WebSearchSetting,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { orderProviders, useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { useAccount } from '../../store/account';
import { ProviderPanel, VendorAvatar } from './ProviderPanel';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { useSettingsFocus } from './search-index';

export const EFFORT_OPTIONS: { value: Effort; label: string }[] = EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }));

const modelKey = (m: ModelRef | null): string => (m ? `${m.providerId}\u0000${m.modelId}` : '');
const parseModel = (v?: string): ModelRef | null => {
  if (!v) return null;
  const [providerId, modelId] = v.split('\u0000');
  return { providerId, modelId };
};

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void> {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => update(key, value).catch((e) => void message.error(errorMessage(e)));
}

/** 模型选择框的选项（按提供商分组，按设置里的顺序）；onlyImages：只列能看图的模型 */
function useModelOptions(onlyImages = false): { label: string; options: { label: string; value: string }[] }[] {
  const providers = useAgent((s) => s.providers);
  const order = useApp((s) => s.settings['ai.providerOrder']);
  return orderProviders(providers, order)
    .filter((p) => p.enabled)
    .map((p) => ({
      label: p.source === 'team' ? `${p.name}（团队）` : p.name,
      options: p.models.filter((m) => !onlyImages || m.supportsImages).map((m) => ({ label: m.displayName || m.id, value: modelKey({ providerId: p.id, modelId: m.id }) })),
    }))
    .filter((g) => g.options.length > 0);
}

type View = { kind: 'provider'; id: string } | { kind: 'catalog' } | { kind: 'new'; preset: AiVendorPreset } | { kind: 'web' } | { kind: 'vision' } | { kind: 'roles' };

/**
 * 设置 → AI 模型（第二十五轮，参考 NewMax 的模型设置）：左边是启用的模型服务（拖拽排序，首位为默认）和其他设置的入口，
 * 右边是选中项的详情：模型服务的编辑、添加模型（按 推荐 / 国内 / 聚合 / 海外 / 本地 分类）、图片识别 Fallback、联网搜索、模型分工。
 */
export function ModelSettings(): React.JSX.Element {
  const { message } = App.useApp();
  const settings = useApp((s) => s.settings);
  const providers = useAgent((s) => s.providers);
  const loadProviders = useAgent((s) => s.loadProviders);
  const presetAllows = useApp((s) => s.info?.preset.allowPersonalProvider !== false);
  const team = useAccount((s) => (s.state?.status !== 'none' ? (s.state?.team ?? null) : null));
  const allowPersonal = presetAllows && team?.allowPersonalProvider !== false;
  const set = useSet();
  const [view, setView] = useState<View | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  // 读完服务列表再决定默认显示什么（没读完时 providers 还是空的，会误显示添加列表）
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadProviders().finally(() => setLoaded(true));
  }, [loadProviders]);

  // 首位为默认：默认对话模型所在的服务排在最前面
  const defaultRef = settings['ai.defaultModel'];
  const ordered = useMemo(() => {
    const list = orderProviders(providers, settings['ai.providerOrder']);
    const i = list.findIndex((p) => p.id === defaultRef?.providerId);
    return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
  }, [providers, settings['ai.providerOrder'], defaultRef?.providerId]);

  // 默认选中第一个服务；没有服务时显示添加列表
  useEffect(() => {
    if (!loaded) return;
    if (view) {
      if (view.kind === 'provider' && !providers.some((p) => p.id === view.id)) setView(ordered[0] ? { kind: 'provider', id: ordered[0].id } : { kind: 'catalog' });
      return;
    }
    if (ordered[0]) setView({ kind: 'provider', id: ordered[0].id });
    else if (providers.length === 0 && allowPersonal) setView({ kind: 'catalog' });
  }, [ordered, providers, view, allowPersonal, loaded]);

  // 设置搜索：搜到「联网搜索」「模型分工」等时切到对应的面板
  const focus = useSettingsFocus((s) => s.target);
  useEffect(() => {
    if (focus?.section !== 'models') return;
    if (focus.group === '联网搜索') setView({ kind: 'web' });
    else if (focus.group === '图片识别 Fallback') setView({ kind: 'vision' });
    else if (focus.group === '模型分工' || focus.group === '默认参数') setView({ kind: 'roles' });
  }, [focus?.seq]);

  /** 拖拽排序：放到第一位的服务成为默认（对话模型换成它的主模型） */
  const reorder = (from: number, to: number): void => {
    if (from === to) return;
    const next = [...ordered];
    const [p] = next.splice(from, 1);
    next.splice(to, 0, p);
    void set('ai.providerOrder', next.map((x) => x.id));
    const first = next[0];
    if (first && first.id !== ordered[0]?.id) {
      if (first.enabled && !first.blocked && first.models[0]) {
        void set('ai.defaultModel', { providerId: first.id, modelId: first.models[0].id });
        message.success(`已设为默认：${first.name} · ${first.models[0].displayName || first.models[0].id}`);
      } else message.warning(`「${first.name}」${first.blocked ?? (first.enabled ? '还没有模型' : '已停用')}，不能设为默认`);
    }
  };

  /** 保存后：默认服务的主模型变了就跟着换；还没有默认模型时用这个服务的主模型 */
  const afterSave = async (saved: AiProvider): Promise<void> => {
    await loadProviders();
    const cur = useApp.getState().settings['ai.defaultModel'];
    const main = saved.models[0];
    if (main && saved.enabled && (!cur || (cur.providerId === saved.id && cur.modelId !== main.id) || !useAgent.getState().providers.some((p) => p.id === cur.providerId))) {
      await set('ai.defaultModel', { providerId: saved.id, modelId: main.id });
    }
    setView({ kind: 'provider', id: saved.id });
  };

  const current = view?.kind === 'provider' ? (providers.find((p) => p.id === view.id) ?? null) : null;
  const addTip = allowPersonal ? undefined : team?.allowPersonalProvider === false ? '管理员只允许使用团队模型' : '管理员禁止了添加个人 AI 模型';

  return (
    <SettingsSection title="AI 模型" description="内置 DeepSeek、通义千问、智谱、Kimi、豆包、Claude、OpenAI、Gemini 等厂商的默认地址，也支持任意 OpenAI / Anthropic 兼容接口和本机 Ollama。API Key 加密保存在本机。">
      {team && team.models > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          data-testid="team-models-tip"
          message={team.allowPersonalProvider ? '已登录服务端：带「团队」标签的模型由管理员配置，经服务端调用，不需要自己的 API Key。' : '管理员只允许使用团队模型：个人模型已停用。'}
        />
      )}
      <div className="models-layout">
        <aside className="models-side">
          <div className="models-side-head">
            <div>
              <div className="models-side-title">启用的模型</div>
              <div className="models-side-sub">拖拽排序，首位为默认</div>
            </div>
            <Tooltip title={addTip ?? '添加模型服务'}>
              <Button type="text" icon={<PlusOutlined />} disabled={!allowPersonal} onClick={() => setView({ kind: 'catalog' })} data-testid="add-provider" aria-label="添加模型服务" />
            </Tooltip>
          </div>
          <div className="provider-list" data-testid="provider-list">
            {ordered.map((p, i) => {
              const isDefault = p.id === defaultRef?.providerId;
              const main = isDefault ? (p.models.find((m) => m.id === defaultRef?.modelId) ?? p.models[0]) : p.models[0];
              return (
                <div
                  key={p.id}
                  className={`provider-item ${view?.kind === 'provider' && view.id === p.id ? 'active' : ''} ${!p.enabled || p.blocked ? 'off' : ''} ${dragOver === i ? 'drag-over' : ''}`}
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
                    if (dragFrom.current !== null) reorder(dragFrom.current, i);
                    dragFrom.current = null;
                  }}
                  onDragEnd={() => setDragOver(null)}
                  onClick={() => setView({ kind: 'provider', id: p.id })}
                  data-testid={`provider-item-${p.id}`}
                >
                  <HolderOutlined className="provider-drag" />
                  <VendorAvatar vendor={p.vendor} name={p.name} team={p.source === 'team'} />
                  <div className="provider-item-text">
                    <div className="provider-item-name">
                      <span className="ellipsis">{p.name}</span>
                      {isDefault && <span className="provider-default">默认</span>}
                      {p.source === 'team' && (
                        <Tag color="purple" bordered={false} data-testid={`team-provider-${p.id}`}>
                          团队
                        </Tag>
                      )}
                    </div>
                    <div className="provider-item-sub mono">{!p.enabled || p.blocked ? (p.blocked ?? '已停用') : (main?.id ?? '还没有模型')}</div>
                  </div>
                </div>
              );
            })}
            {ordered.length === 0 && <div className="provider-empty">还没有模型服务</div>}
          </div>
          <button type="button" className={`models-side-add ${view?.kind === 'catalog' || view?.kind === 'new' ? 'active' : ''}`} disabled={!allowPersonal} onClick={() => setView({ kind: 'catalog' })} data-testid="add-provider-row">
            <PlusOutlined /> 添加模型
          </button>
          <div className="models-side-divider" />
          <SideLink icon={<CameraOutlined />} active={view?.kind === 'vision'} onClick={() => setView({ kind: 'vision' })} testId="models-nav-vision">
            图片识别 Fallback
          </SideLink>
          <SideLink icon={<GlobalOutlined />} active={view?.kind === 'web'} onClick={() => setView({ kind: 'web' })} testId="models-nav-web">
            联网搜索
          </SideLink>
          <SideLink icon={<PartitionOutlined />} active={view?.kind === 'roles'} onClick={() => setView({ kind: 'roles' })} testId="models-nav-roles">
            模型分工与默认参数
          </SideLink>
        </aside>
        <main className="models-main">
          {view?.kind === 'provider' && current && <ProviderPanel key={`${current.id}:${current.updatedAt}`} provider={current} preset={null} onSaved={(p) => void afterSave(p)} onDeleted={() => void loadProviders().then(() => setView(null))} />}
          {view?.kind === 'catalog' && <VendorCatalog providers={providers} onPick={(preset) => setView({ kind: 'new', preset })} onOpen={(id) => setView({ kind: 'provider', id })} />}
          {view?.kind === 'new' && <ProviderPanel key={`new:${view.preset.key}`} provider={null} preset={view.preset} onBack={() => setView({ kind: 'catalog' })} onSaved={(p) => void afterSave(p)} />}
          {view?.kind === 'web' && <WebSearchPanel />}
          {view?.kind === 'vision' && <VisionPanel />}
          {view?.kind === 'roles' && <RolesPanel />}
          {!view && <Empty description="还没有模型服务" />}
        </main>
      </div>
    </SettingsSection>
  );
}

function SideLink({ icon, active, onClick, children, testId }: { icon: React.ReactNode; active: boolean; onClick(): void; children: React.ReactNode; testId: string }): React.JSX.Element {
  return (
    <button type="button" className={`models-side-link ${active ? 'active' : ''}`} onClick={onClick} data-testid={testId}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

/** 添加模型：按 推荐 / 国内 / 聚合 / 海外 / 本地 分类的厂商卡片；已经添加过的标「已激活」，点它打开已有的配置 */
function VendorCatalog({ providers, onPick, onOpen }: { providers: AiProvider[]; onPick(p: AiVendorPreset): void; onOpen(id: string): void }): React.JSX.Element {
  const [tab, setTab] = useState<(typeof AI_VENDOR_TABS)[number]['key']>('recommended');
  const list = vendorsInTab(tab);
  return (
    <div className="vendor-catalog" data-testid="vendor-catalog">
      <Segmented block value={tab} onChange={(v) => setTab(v as typeof tab)} options={AI_VENDOR_TABS.map((t) => ({ value: t.key, label: t.label }))} data-testid="vendor-tabs" />
      {tab === 'intl' && (
        <Alert
          className="vendor-proxy-tip"
          type="warning"
          showIcon
          icon={<InfoCircleOutlined />}
          message="访问海外模型需要代理"
          description="TUN 模式、系统代理（Surge / Clash）任选其一；国内网络直连可能连不上。"
        />
      )}
      <div className="vendor-cards">
        {list.map((p) => {
          const existing = p.key !== 'custom' ? providers.find((x) => x.vendor === p.key && x.source !== 'team') : undefined;
          return (
            <button
              key={p.key}
              type="button"
              className={`vendor-card2 ${existing ? 'added' : ''} ${p.group === 'custom' ? 'custom' : ''}`}
              onClick={() => (existing ? onOpen(existing.id) : onPick(p))}
              data-testid={`vendor-${p.key}`}
            >
              <span className="vendor-card2-head">
                <VendorAvatar vendor={p.key} name={p.name} size={22} />
                <span className="vendor-card2-name">{p.name}</span>
                {existing ? (
                  <Tag color="green" bordered={false}>
                    已激活
                  </Tag>
                ) : p.billing ? (
                  <Tag bordered={false}>{p.billing}</Tag>
                ) : null}
              </span>
              <span className="vendor-card2-hint">{p.hint ?? (p.models.length ? p.models.slice(0, 3).map((m) => m.displayName ?? m.id).join('、') : '')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 图片识别 Fallback（第二十五轮）：当前模型看不了图片时，先用识图模型把图片转成文字 */
function VisionPanel(): React.JSX.Element {
  const fb = useApp((s) => s.settings['ai.visionFallback']);
  const options = useModelOptions(true);
  const set = useSet();
  return (
    <div className="models-panel">
      <SettingGroup title="图片识别 Fallback">
        <Typography.Paragraph type="secondary" className="models-panel-desc">
          当前模型看不了图片时（例如 DeepSeek V4 Pro、本机小模型），先用这里选的识图模型把图片转成文字——描述画面，并逐字转写图里的终端输出、报错和配置——再交给当前模型回答。
          能看图的模型照常直接发送图片。命中敏感数据规则的对话不会把图片发给识图模型。
        </Typography.Paragraph>
        <SettingRow label="启用图片识别 Fallback" description="关闭时，看不了图片的模型不能发送图片">
          <Switch checked={fb.enabled} onChange={(v) => void set('ai.visionFallback', { ...fb, enabled: v })} data-testid="setting-vision-enabled" />
        </SettingRow>
        <SettingRow label="识图模型" description={options.length ? '只列出标记了「支持图片」的模型' : '还没有支持图片的模型：在模型设置里勾选「图片」，或者用「检测模型能力」识别'}>
          <Select
            style={{ width: 280 }}
            allowClear
            placeholder="选择识图模型"
            disabled={!fb.enabled}
            value={modelKey(fb.model) || undefined}
            options={options}
            onChange={(v?: string) => void set('ai.visionFallback', { ...fb, model: parseModel(v) })}
            data-testid="setting-vision-model"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
}

/** 模型分工与默认参数（原来设置页上的两组） */
function RolesPanel(): React.JSX.Element {
  const settings = useApp((s) => s.settings);
  const modelOptions = useModelOptions();
  const set = useSet();
  return (
    <div className="models-panel">
      <SettingGroup title="模型分工">
        <SettingRow label="对话模型" description="新对话默认使用；对话里可以随时切换。左边拖到第一位的服务会成为默认">
          <Select style={{ width: 280 }} placeholder="选择模型" value={modelKey(settings['ai.defaultModel']) || undefined} options={modelOptions} onChange={(v: string) => void set('ai.defaultModel', parseModel(v))} data-testid="setting-default-model" />
        </SettingRow>
        <SettingRow label="快速模型" description="用于命令复核、终端 AI 补全、对话压缩；不选时使用对话模型">
          <Select style={{ width: 280 }} allowClear placeholder="使用对话模型" value={modelKey(settings['ai.fastModel']) || undefined} options={modelOptions} onChange={(v?: string) => void set('ai.fastModel', parseModel(v))} />
        </SettingRow>
        <SettingRow label="内网模型" description="内容命中「必须使用私有模型」的敏感数据规则时，改用这个模型（例如内网部署的模型）">
          <Select style={{ width: 280 }} allowClear placeholder="不指定" value={modelKey(settings['ai.sensitiveModel']) || undefined} options={modelOptions} onChange={(v?: string) => void set('ai.sensitiveModel', parseModel(v))} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="默认参数">
        <SettingRow label="默认开启深度思考" description="能开关思考的模型在新对话里默认开启；模型自己的设置优先，对话里可以随时切换">
          <Switch checked={settings['ai.thinkingDefault']} onChange={(v) => void set('ai.thinkingDefault', v)} data-testid="setting-thinking-default" />
        </SettingRow>
        <SettingRow label="默认思考强度" description="越高越慢、越贵，复杂排障建议「高」；模型不支持的档位自动换成最接近的一档">
          <Select
            style={{ width: 180 }}
            value={settings['ai.thinkingEffort'] ?? ''}
            options={[{ value: '', label: '模型默认' }, ...EFFORT_OPTIONS]}
            onChange={(v: Effort | '') => void set('ai.thinkingEffort', v || null)}
            data-testid="setting-thinking-effort"
          />
        </SettingRow>
        <SettingRow label="默认温度" description="0–2，越低回答越稳定；留空使用模型默认值。开启思考时 Claude 和 OpenAI 推理模型不使用温度">
          <InputNumber min={0} max={2} step={0.1} placeholder="模型默认" value={settings['ai.temperature']} onChange={(v) => void set('ai.temperature', v ?? null)} style={{ width: 180 }} data-testid="setting-temperature" />
        </SettingRow>
        <SettingRow label="请求超时" description="单次模型请求最长等待时间">
          <InputNumber min={10} max={900} value={settings['ai.requestTimeoutSec']} onChange={(v) => v && void set('ai.requestTimeoutSec', v)} addonAfter="秒" style={{ width: 180 }} />
        </SettingRow>
      </SettingGroup>
    </div>
  );
}

/**
 * 联网搜索（第二十五轮，文档一 6.39）：独立的工具，不和模型绑定。默认用服务端的配置（管理员在后台配置 Key），
 * 也可以自己配置：DeepSeek 格式，或者自定义（DeepSeek 风格的接口，兼容 Kimi 等字段名）。新对话默认关闭联网。
 */
function WebSearchPanel(): React.JSX.Element {
  const { message } = App.useApp();
  const ws = useApp((s) => s.settings['ai.webSearch']);
  const status = useAgent((s) => s.webStatus);
  const loadStatus = useAgent((s) => s.loadWebStatus);
  const loggedIn = useAccount((s) => !!s.state && s.state.status !== 'none');
  const set = useSet();
  const [key, setKey] = useState('');
  const [urls, setUrls] = useState({ baseUrl: ws.baseUrl, searchUrl: ws.searchUrl, fetchUrl: ws.fetchUrl });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; items?: { title: string; url: string }[] } | null>(null);
  useEffect(() => setUrls({ baseUrl: ws.baseUrl, searchUrl: ws.searchUrl, fetchUrl: ws.fetchUrl }), [ws.baseUrl, ws.searchUrl, ws.fetchUrl]);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const save = async (next: WebSearchSetting): Promise<void> => {
    await set('ai.webSearch', next);
    setResult(null);
    await loadStatus();
  };
  const commitUrl = (k: 'baseUrl' | 'searchUrl' | 'fetchUrl'): void => {
    const v = urls[k].trim();
    if (v === ws[k]) return;
    if (v && !/^https?:\/\/\S+$/i.test(v)) return void message.warning('地址要以 http:// 或 https:// 开头');
    void save({ ...ws, [k]: v });
  };
  const server = status?.server ?? null;
  const personal = ws.source === 'personal';

  return (
    <div className="models-panel">
      <SettingGroup title="联网搜索">
        <Typography.Paragraph type="secondary" className="models-panel-desc">
          打开输入框里的「联网」后，AI 可以搜索和读取公开网页（查官方文档、版本变更、报错信息等）。联网搜索是一个独立的工具，和对话用哪个模型无关，任何能调用工具的模型都能用；按次计费。
          查询词发出前先脱敏，内网地址不会发出去；命中敏感数据规则的对话不联网。
        </Typography.Paragraph>
        <SettingRow
          label="搜索服务"
          description={
            ws.source === 'server'
              ? server
                ? `使用服务端的默认配置：${server.label}（管理员配置 Key，经服务端调用）`
                : loggedIn
                  ? '服务端还没有配置联网搜索，请联系管理员在管理后台「大模型 → 联网搜索」里配置，或者改用自己的 Key'
                  : '使用服务端的默认配置需要登录'
              : '使用自己的 API Key，加密保存在本机'
          }
        >
          <Segmented
            value={ws.source}
            onChange={(v) => void save({ ...ws, source: v as WebSearchSetting['source'] })}
            options={[
              { value: 'server', label: '服务端默认' },
              { value: 'personal', label: '自己配置' },
            ]}
            data-testid="setting-web-source"
          />
        </SettingRow>
        {personal && (
          <>
            <SettingRow label="接口格式" description={WEB_SEARCH_FORMATS.find((f) => f.value === ws.format)?.hint}>
              <Select style={{ width: 200 }} value={ws.format} options={WEB_SEARCH_FORMATS.map((f) => ({ value: f.value, label: f.label }))} onChange={(v) => void save({ ...ws, format: v })} data-testid="setting-web-format" />
            </SettingRow>
            {ws.format === 'deepseek' ? (
              <SettingRow label="接口地址" description="留空使用官方地址 https://api.deepseek.com；走公司代理时填代理的根地址">
                <Input style={{ width: 300 }} placeholder="https://api.deepseek.com" value={urls.baseUrl} onChange={(e) => setUrls({ ...urls, baseUrl: e.target.value })} onBlur={() => commitUrl('baseUrl')} data-testid="setting-web-base" />
              </SettingRow>
            ) : (
              <>
                <SettingRow label="搜索接口地址" description="完整地址，例如 https://api.moonshot.cn/v1/tools/search">
                  <Input style={{ width: 300 }} placeholder="https://…/search" value={urls.searchUrl} onChange={(e) => setUrls({ ...urls, searchUrl: e.target.value })} onBlur={() => commitUrl('searchUrl')} data-testid="setting-web-search-url" />
                </SettingRow>
                <SettingRow label="网页读取接口地址" description="可以留空：留空时 AI 只能搜索，不能读取网页正文">
                  <Input style={{ width: 300 }} placeholder="https://…/fetch（可选）" value={urls.fetchUrl} onChange={(e) => setUrls({ ...urls, fetchUrl: e.target.value })} onBlur={() => commitUrl('fetchUrl')} data-testid="setting-web-fetch-url" />
                </SettingRow>
              </>
            )}
            <SettingRow label="API Key" description={status?.hasKey ? '已保存（重新填写会替换）' : ws.format === 'deepseek' ? 'DeepSeek 的 API Key（可以和对话用同一个，也可以单独申请）' : '搜索服务的 API Key'}>
              <Space.Compact>
                <Input.Password style={{ width: 220 }} placeholder={status?.hasKey ? '••••••••' : 'sk-…'} value={key} autoComplete="new-password" onChange={(e) => setKey(e.target.value.trim())} data-testid="setting-web-key" />
                <Button
                  disabled={!key}
                  onClick={() =>
                    void invoke('web.saveKey', { apiKey: key })
                      .then(() => {
                        setKey('');
                        message.success('已保存');
                        return loadStatus();
                      })
                      .catch((e) => message.error(errorMessage(e)))
                  }
                  data-testid="setting-web-key-save"
                >
                  保存
                </Button>
                {status?.hasKey && (
                  <Button onClick={() => void invoke('web.saveKey', { apiKey: null }).then(() => loadStatus())} data-testid="setting-web-key-clear">
                    清除
                  </Button>
                )}
              </Space.Compact>
            </SettingRow>
          </>
        )}
        <SettingRow label="每次搜索的结果数" description={ws.source === 'server' && server ? `使用服务端配置时按管理员设置的条数（${server.count} 条）` : '每次搜索返回几条结果（AI 可以在单次搜索里调小或调大，最多 20）'}>
          <InputNumber
            min={WEB_SEARCH_COUNT.min}
            max={WEB_SEARCH_COUNT.max}
            value={ws.source === 'server' && server ? server.count : ws.count}
            disabled={ws.source === 'server' && !!server}
            onChange={(v) => v && void save({ ...ws, count: Math.round(v) })}
            addonAfter="条"
            style={{ width: 140 }}
            data-testid="setting-web-count"
          />
        </SettingRow>
        <SettingRow label="新对话默认打开联网" description="默认关闭；对话里可以随时用输入框底部的地球图标开关">
          <Switch checked={ws.defaultOn} onChange={(v) => void save({ ...ws, defaultOn: v })} data-testid="setting-web-default" />
        </SettingRow>
        <SettingRow
          label="测试搜索"
          description={
            <span data-testid="setting-web-status">
              {status ? (status.available ? `当前可以联网搜索：${status.label}${status.fetch ? '' : '（只能搜索，不能读取网页）'}` : status.reason) : '正在读取…'}
            </span>
          }
        >
          <Button
            icon={<SearchOutlined />}
            loading={testing}
            onClick={() => {
              setTesting(true);
              setResult(null);
              invoke('web.test', { setting: ws, apiKey: key || null })
                .then((r) => setResult({ ok: true, text: `${r.label} 搜索成功 · ${r.latencyMs} ms · ${r.results.length} 条结果`, items: r.results }))
                .catch((e) => setResult({ ok: false, text: errorMessage(e) }))
                .finally(() => setTesting(false));
            }}
            data-testid="setting-web-test"
          >
            搜一下试试
          </Button>
        </SettingRow>
        {result && (
          <div className="web-test-result">
            <Alert
              type={result.ok ? 'success' : 'error'}
              showIcon
              message={result.text}
              description={
                result.items?.length ? (
                  <ul className="web-test-list">
                    {result.items.map((r) => (
                      <li key={r.url}>
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : undefined
              }
              data-testid="setting-web-test-result"
            />
          </div>
        )}
      </SettingGroup>
    </div>
  );
}
