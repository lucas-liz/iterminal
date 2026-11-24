import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './styles-r26.css';
import './styles-r27.css';
import './styles-r29.css';
import './styles-r31.css';
import './styles-r34.css';
import './styles-r35.css';
import { App } from './App';

// 平台标记（样式里只在 macOS 启用拖动窗口区域，见 styles-r35.css）
document.documentElement.dataset.platform = window.itm.platform;
import { installDiag } from './util/diag';

// 操作轨迹（问题反馈附带，第十三轮）
installDiag();

createRoot(document.getElementById('root')!).render(
  // 不用 StrictMode：它在开发模式下会把 effect 执行两次，每个终端标签都会重复建立一次连接
  <App />,
);
