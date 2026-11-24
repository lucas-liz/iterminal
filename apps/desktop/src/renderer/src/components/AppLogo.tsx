import logo from '../assets/logo.png';

/** 应用图标（侧栏标题前、AI 对话页标题前、关于页） */
export function AppLogo({ size = 20 }: { size?: number }): React.JSX.Element {
  return <img src={logo} width={size} height={size} alt="" className="app-logo" draggable={false} data-testid="app-logo" />;
}
