import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Empty, Image, Input, Modal, Result, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { CameraOutlined, CloseOutlined, CopyOutlined, EyeOutlined, FolderOpenOutlined, PictureOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import {
  FEEDBACK_CATEGORY_LABEL,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_STATUS_LABEL,
  type FeedbackCategory,
  type FeedbackImage,
  type FeedbackPreview,
  type FeedbackRecord,
  type FeedbackStatus,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAccount } from '../../store/account';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { Markdown } from '../../components/Markdown';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const STATUS_COLOR: Record<FeedbackStatus, string> = { NEW: 'blue', PROCESSING: 'orange', RESOLVED: 'green', CLOSED: 'default' };
const size = (n: number): string => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const time = (t: number | null): string => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');

/** 读取图片文件（选择、粘贴、拖进来）：只要 PNG / JPG / GIF / WebP，每张 ≤ 5MB */
function readImage(file: File): Promise<FeedbackImage> {
  return new Promise((resolve, reject) => {
    if (!IMAGE_TYPES.includes(file.type)) return reject(new Error(`「${file.name}」不是 PNG / JPG / GIF / WebP 图片`));
    if (file.size > FEEDBACK_MAX_IMAGE_BYTES) return reject(new Error(`「${file.name}」超过 5MB`));
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result ?? '');
      resolve({ name: file.name || `粘贴的图片.${file.type.split('/')[1]}`, type: file.type, data: url.slice(url.indexOf(',') + 1), size: file.size });
    };
    r.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    r.readAsDataURL(file);
  });
}

/**
 * 设置 → 问题反馈（第十三轮，文档一 6.27.1）：描述 + 截图 + 自动附带的诊断信息（环境、操作轨迹、错误、日志尾部，已脱敏），
 * 提交到服务端（登录后用账号；本地模式走匿名接口）。登录后可以查看自己提交过的反馈和回复。
 */
export function FeedbackSettings(): React.JSX.Element {
  const { message } = App.useApp();
  const account = useAccount((s) => s.state);
  const loggedIn = !!account && account.status !== 'none';
  const [category, setCategory] = useState<FeedbackCategory>('BUG');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contact, setContact] = useState(account?.email ?? '');
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [maskIps, setMaskIps] = useState(true);
  const [preview, setPreview] = useState<FeedbackPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: number } | null>(null);
  const [mine, setMine] = useState<FeedbackRecord[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (account?.email && !contact) setContact(account.email);
  }, [account?.email]);

  const loadPreview = useCallback(async (mask: boolean) => {
    try {
      setPreview(await invoke('feedback.preview', { maskIps: mask }));
    } catch (e) {
      message.error(errorMessage(e));
    }
  }, []);
  useEffect(() => void loadPreview(maskIps), [maskIps]);

  const loadMine = useCallback(async () => {
    if (!loggedIn) return;
    try {
      setMine(await invoke('feedback.mine'));
      setMineError(null);
    } catch (e) {
      setMineError(errorMessage(e));
    }
  }, [loggedIn]);
  useEffect(() => void loadMine(), [loadMine]);

  const addFiles = async (files: File[]): Promise<void> => {
    const list = files.filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const room = FEEDBACK_MAX_IMAGES - images.length;
    if (room <= 0) return void message.warning(`最多 ${FEEDBACK_MAX_IMAGES} 张图片`);
    const added: FeedbackImage[] = [];
    for (const f of list.slice(0, room)) {
      try {
        added.push(await readImage(f));
      } catch (e) {
        message.error((e as Error).message);
      }
    }
    if (list.length > room) message.warning(`最多 ${FEEDBACK_MAX_IMAGES} 张图片，多出的没有添加`);
    setImages((cur) => [...cur, ...added].slice(0, FEEDBACK_MAX_IMAGES));
  };

  const capture = async (): Promise<void> => {
    if (images.length >= FEEDBACK_MAX_IMAGES) return void message.warning(`最多 ${FEEDBACK_MAX_IMAGES} 张图片`);
    setBusy('capture');
    try {
      const img = await invoke('feedback.capture');
      setImages((cur) => [...cur, img].slice(0, FEEDBACK_MAX_IMAGES));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copyDiagnostics = async (): Promise<void> => {
    try {
      const p = await invoke('feedback.preview', { maskIps });
      const head = title.trim() || description.trim() ? `# ${title.trim() || '问题反馈'}\n\n${description.trim()}\n\n` : '';
      await navigator.clipboard.writeText(head + p.markdown);
      message.success('已复制诊断信息（Markdown），可以发给管理员或粘贴给 AI 工具分析');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const submit = async (): Promise<void> => {
    if (!title.trim()) return void message.warning('请填写标题');
    if (!description.trim()) return void message.warning('请描述一下遇到的问题');
    setBusy('submit');
    try {
      const r = await invoke('feedback.submit', { category, title: title.trim(), description: description.trim(), contact: contact.trim(), images, includeDiagnostics, maskIps });
      setDone(r);
      void loadMine();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reset = (): void => {
    setDone(null);
    setTitle('');
    setDescription('');
    setImages([]);
    setCategory('BUG');
    void loadPreview(maskIps);
  };

  const target = preview?.target;

  return (
    <SettingsSection
      title="问题反馈"
      description="遇到问题或者有建议？描述一下并附上截图。默认附带的诊断信息（环境、最近的操作轨迹、错误和日志，已自动脱敏）能帮助我们——或者 AI——很快定位问题。"
    >
      {done ? (
        <SettingGroup>
          <Result
            status="success"
            title={`反馈已提交，编号 #${done.id}`}
            subTitle={`${loggedIn ? '处理进展和回复会显示在下面的「我的反馈」里。' : '本地模式提交的是匿名反馈；需要回复时请留下联系方式，或者登录后再提交。'}`}
            extra={
              <Button type="primary" onClick={reset} data-testid="feedback-again">
                再提交一条
              </Button>
            }
            data-testid="feedback-done"
          />
        </SettingGroup>
      ) : (
        <div
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        >
          <SettingGroup title="反馈内容">
            <SettingRow label="类型">
              <Segmented<FeedbackCategory>
                value={category}
                onChange={setCategory}
                options={(Object.keys(FEEDBACK_CATEGORY_LABEL) as FeedbackCategory[]).map((k) => ({ value: k, label: FEEDBACK_CATEGORY_LABEL[k] }))}
                data-testid="feedback-category"
              />
            </SettingRow>
            <SettingRow label="标题" block>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} showCount placeholder="一句话说明问题，例如：连接跳板机后的主机时提示认证失败" data-testid="feedback-title" />
            </SettingRow>
            <SettingRow label="描述" block>
              <Input.TextArea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                showCount
                autoSize={{ minRows: 5, maxRows: 14 }}
                placeholder={'做了什么 → 期望的结果 → 实际的结果。\n有报错时把报错原文贴进来；能稳定复现的话写一下步骤。'}
                data-testid="feedback-description"
              />
            </SettingRow>
            <SettingRow
              label={`截图（${images.length} / ${FEEDBACK_MAX_IMAGES}）`}
              description="可以截取当前窗口、选择图片，也可以直接粘贴（⌘ / Ctrl + V）或者拖到下面。每张不超过 5MB。"
              block
            >
              <div
                className={`feedback-images ${dragging ? 'dragging' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void addFiles([...e.dataTransfer.files]);
                }}
                data-testid="feedback-images"
              >
                <Image.PreviewGroup>
                  {images.map((img, i) => (
                    <div key={`${img.name}-${i}`} className="feedback-thumb" data-testid="feedback-thumb">
                      <Image src={`data:${img.type};base64,${img.data}`} width={120} height={80} style={{ objectFit: 'cover' }} />
                      <Tooltip title={`${img.name}（${size(img.size)}）`}>
                        <div className="feedback-thumb-name">{img.name}</div>
                      </Tooltip>
                      <Button size="small" type="text" className="feedback-thumb-del" icon={<CloseOutlined />} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} aria-label="删除图片" />
                    </div>
                  ))}
                </Image.PreviewGroup>
                <Space direction="vertical" size={6} className="feedback-image-actions">
                  <Button icon={<CameraOutlined />} loading={busy === 'capture'} disabled={images.length >= FEEDBACK_MAX_IMAGES} onClick={() => void capture()} data-testid="feedback-capture">
                    截取窗口
                  </Button>
                  <Button icon={<PictureOutlined />} disabled={images.length >= FEEDBACK_MAX_IMAGES} onClick={() => fileInput.current?.click()} data-testid="feedback-pick">
                    选择图片
                  </Button>
                </Space>
                <input
                  ref={fileInput}
                  type="file"
                  accept={IMAGE_TYPES.join(',')}
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                  data-testid="feedback-file"
                />
              </div>
            </SettingRow>
            <SettingRow label="联系方式" description="选填：邮箱、手机或企业微信，方便我们联系你">
              <Input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={100} style={{ width: 260 }} placeholder="选填" data-testid="feedback-contact" />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="诊断信息">
            <SettingRow
              label={
                <Checkbox checked={includeDiagnostics} onChange={(e) => setIncludeDiagnostics(e.target.checked)} data-testid="feedback-diag">
                  附带诊断信息（推荐）
                </Checkbox>
              }
              description={
                preview
                  ? `环境信息、最近 ${preview.breadcrumbs} 条操作轨迹、${preview.errors} 条错误、${size(preview.logBytes)} 日志。密码、令牌、私钥等已经自动隐去；不包含终端内容和文件内容。`
                  : '环境信息、最近的操作轨迹、错误和日志（已自动脱敏）'
              }
            >
              <Button icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)} disabled={!preview} data-testid="feedback-preview">
                预览
              </Button>
            </SettingRow>
            <SettingRow label={<Checkbox checked={maskIps} disabled={!includeDiagnostics} onChange={(e) => setMaskIps(e.target.checked)} data-testid="feedback-mask-ips">隐去 IP 地址</Checkbox>} description="同一个 IP 始终换成同一个 HOST_IP_n，仍然能区分不同的主机" />
            <SettingRow label="不提交也可以" description="把诊断信息复制下来发给管理员，或者打开日志目录查看原始日志">
              <Space>
                <Button icon={<CopyOutlined />} onClick={() => void copyDiagnostics()} data-testid="feedback-copy">
                  复制诊断信息
                </Button>
                <Button icon={<FolderOpenOutlined />} onClick={() => void invoke('diag.openDir')}>
                  打开日志目录
                </Button>
              </Space>
            </SettingRow>
          </SettingGroup>

          <div className="feedback-submit">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {target ? (target.anonymous ? '本地模式：匿名提交' : `以账号 ${account?.displayName || account?.username} 提交`) : ''}
            </Typography.Text>
            <Button type="primary" icon={<SendOutlined />} loading={busy === 'submit'} disabled={!title.trim() || !description.trim()} onClick={() => void submit()} data-testid="feedback-submit">
              提交反馈
            </Button>
          </div>
        </div>
      )}

      {loggedIn && (
        <SettingGroup
          title="我的反馈"
          extra={
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void loadMine()}>
              刷新
            </Button>
          }
        >
          {mineError ? (
            <Alert type="warning" showIcon message={mineError} style={{ margin: 12 }} />
          ) : mine === null ? (
            <Spin style={{ display: 'block', margin: 16 }} />
          ) : mine.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有提交过反馈" />
          ) : (
            <div className="feedback-mine" data-testid="feedback-mine">
              {mine.map((f) => (
                <div key={f.id} className="feedback-mine-item">
                  <div className="feedback-mine-head">
                    <Typography.Text type="secondary">#{f.id}</Typography.Text>
                    <Tag bordered={false}>{FEEDBACK_CATEGORY_LABEL[f.category] ?? f.category}</Tag>
                    <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
                      {f.title}
                    </Typography.Text>
                    <Tag color={STATUS_COLOR[f.status]}>{FEEDBACK_STATUS_LABEL[f.status] ?? f.status}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {time(f.createdAt)}
                    </Typography.Text>
                  </div>
                  {f.reply && (
                    <div className="feedback-mine-reply">
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        回复（{time(f.handledAt)}）：
                      </Typography.Text>
                      <div className="selectable">{f.reply}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </SettingGroup>
      )}

      <Modal open={previewOpen} title="将要发送的诊断信息" width={860} footer={null} onCancel={() => setPreviewOpen(false)} destroyOnHidden>
        {preview && (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="服务端看到的内容和这里一样（另外还有你填写的标题、描述、截图和结构化的 diagnostics.json）。密码、令牌、私钥、手机号已经隐去。"
            />
            <div className="feedback-preview-md" data-testid="feedback-preview-md">
              <Markdown text={preview.markdown} />
            </div>
          </>
        )}
      </Modal>
    </SettingsSection>
  );
}
