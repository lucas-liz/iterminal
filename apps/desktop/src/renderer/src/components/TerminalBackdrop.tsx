import { useEffect, useRef } from 'react';
import type { TerminalBackground } from '@itm/protocol';

/** 背景文件的地址（主进程的 itm-media 协议，只能读当前档案 appearance/ 里的文件） */
export const backgroundUrl = (file: string): string => `itm-media://bg/${encodeURIComponent(file)}`;

/**
 * 终端背景（第十二轮）：图片或视频铺在终端下面，上面盖一层终端底色（dim 越大越淡），终端本身透明。
 * 视频静音循环播放；终端看不见的时候（切到别的标签、窗口最小化）暂停，不占用解码。
 */
export function TerminalBackdrop({ bg, color }: { bg: TerminalBackground; color: string }): React.JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    const box = boxRef.current;
    if (!v || !box) return;
    let visible = false;
    const sync = (): void => {
      if (visible && document.visibilityState === 'visible') void v.play().catch(() => undefined);
      else v.pause();
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      sync();
    });
    io.observe(box);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [bg.kind, bg.file]);
  if (bg.kind === 'none' || !bg.file) return null;
  const url = backgroundUrl(bg.file);
  const filter = bg.blur ? `blur(${bg.blur}px)` : undefined;
  // 模糊会让边缘透出底色：稍微放大一点盖住
  const scale = bg.blur ? `scale(${1 + bg.blur / 100})` : undefined;
  return (
    <div className="term-backdrop" ref={boxRef} data-testid="term-backdrop" aria-hidden>
      {bg.kind === 'video' ? (
        <video ref={videoRef} className="term-backdrop-media" src={url} muted loop playsInline autoPlay style={{ objectFit: bg.fit === 'tile' ? 'cover' : bg.fit, filter, transform: scale }} />
      ) : bg.fit === 'tile' ? (
        <div className="term-backdrop-media" style={{ backgroundImage: `url("${url}")`, backgroundRepeat: 'repeat', filter, transform: scale }} />
      ) : (
        <img className="term-backdrop-media" src={url} alt="" draggable={false} style={{ objectFit: bg.fit, filter, transform: scale }} />
      )}
      <div className="term-backdrop-dim" style={{ background: color, opacity: bg.dim }} />
    </div>
  );
}
