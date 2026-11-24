import {
  CodeOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  DockerOutlined,
  FieldBinaryOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileProtectOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  FolderOutlined,
  Html5Outlined,
  JavaOutlined,
  JavaScriptOutlined,
  KeyOutlined,
  LinkOutlined,
  PythonOutlined,
  SettingOutlined,
  SoundOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { FileEntry } from '@itm/protocol';
import { fileKind, type FileKind } from './file-kind';

export { fileKind, opensInEditor, TEXT_KINDS, type FileKind } from './file-kind';

const ICON: Record<FileKind, { icon: React.ReactNode; color: string }> = {
  dir: { icon: <FolderOutlined />, color: '#6e8efb' },
  link: { icon: <LinkOutlined />, color: '#36cfc9' },
  archive: { icon: <FileZipOutlined />, color: '#d4a017' },
  java: { icon: <JavaOutlined />, color: '#e76f51' },
  image: { icon: <FileImageOutlined />, color: '#52c41a' },
  video: { icon: <VideoCameraOutlined />, color: '#eb2f96' },
  audio: { icon: <SoundOutlined />, color: '#13c2c2' },
  pdf: { icon: <FilePdfOutlined />, color: '#f5222d' },
  word: { icon: <FileWordOutlined />, color: '#2f6fde' },
  excel: { icon: <FileExcelOutlined />, color: '#1f9d55' },
  ppt: { icon: <FilePptOutlined />, color: '#fa8c16' },
  markdown: { icon: <FileMarkdownOutlined />, color: '#8c8cf0' },
  script: { icon: <CodeOutlined />, color: '#22b5f0' },
  js: { icon: <JavaScriptOutlined />, color: '#e8c547' },
  python: { icon: <PythonOutlined />, color: '#3776ab' },
  code: { icon: <CodeOutlined />, color: '#a78bfa' },
  html: { icon: <Html5Outlined />, color: '#e34f26' },
  config: { icon: <SettingOutlined />, color: '#8c9bb5' },
  log: { icon: <FileTextOutlined />, color: '#b0a36b' },
  sql: { icon: <ConsoleSqlOutlined />, color: '#f59e0b' },
  db: { icon: <DatabaseOutlined />, color: '#f59e0b' },
  key: { icon: <KeyOutlined />, color: '#faad14' },
  cert: { icon: <FileProtectOutlined />, color: '#52c41a' },
  docker: { icon: <DockerOutlined />, color: '#2496ed' },
  binary: { icon: <FieldBinaryOutlined />, color: '#9b8cff' },
  text: { icon: <FileTextOutlined />, color: 'var(--itm-text-secondary)' },
  file: { icon: <FileOutlined />, color: 'var(--itm-text-secondary)' },
};

export function FileIcon({ entry }: { entry: Pick<FileEntry, 'name' | 'type' | 'perms'> }): React.JSX.Element {
  const k = fileKind(entry);
  const { icon, color } = ICON[k];
  return (
    <span className={`file-icon kind-${k}`} style={{ color }} data-kind={k}>
      {icon}
    </span>
  );
}
