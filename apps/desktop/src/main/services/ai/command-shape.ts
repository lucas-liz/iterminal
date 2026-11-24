/**
 * 执行前识别交互式 / 不会自己结束的命令（第三十三轮，把提示词里「不要执行 vim、top、tail -f…」做成程序检查）：
 * Agent 的命令在独立的 exec 通道里执行、标准输入关闭，这类命令要么马上失败，要么一直等到「连续 30 秒没有输出」才被终止。
 * 执行前直接拒绝并给出非交互的写法，模型下一步就能改对，不用白等。用 timeout 包起来的不拦。
 */

/** 去掉引号里的内容（只用来切分和找参数，不用于执行） */
function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** 按 && || ; | 换行 切成几段简单命令 */
function segments(command: string): string[][] {
  return stripQuoted(command)
    .split(/&&|\|\||;|\||\n|&(?!>)/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length > 0);
}

/** 去掉前面的环境变量赋值、sudo（含它的选项）、nohup、command / exec、nice */
function unwrap(words: string[]): { name: string; args: string[]; timed: boolean } | null {
  let i = 0;
  let timed = false;
  for (;;) {
    const w = words[i];
    if (w === undefined) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (w === 'sudo' || w === 'doas') {
      i++;
      while (words[i]?.startsWith('-')) i += /^-[ugCDhpRrTt]$/.test(words[i]) ? 2 : 1;
    } else if (w === 'nohup' || w === 'command' || w === 'exec' || w === 'builtin') i++;
    else if (w === 'nice' || w === 'ionice') {
      i++;
      while (words[i]?.startsWith('-')) i += /^-[ncp]$/.test(words[i]) ? 2 : 1;
    } else if (w === 'timeout') {
      timed = true;
      i++;
      while (words[i]?.startsWith('-')) i += /^-[sk]$/.test(words[i]) ? 2 : 1;
      i++; // 时长
    } else break;
  }
  const name = words[i].replace(/^.*\//, '');
  return { name, args: words.slice(i + 1), timed };
}

/** 有没有这个选项：长选项可以带 =值；短选项可以和别的短选项合写（-bn1、-fn 100）或者直接带值（-c4） */
const has = (args: string[], ...flags: string[]): boolean =>
  args.some((a) =>
    flags.some((f) => {
      if (f.startsWith('--')) return a === f || a.startsWith(`${f}=`);
      if (a === f) return true;
      if (!/^-[A-Za-z]/.test(a) || a.startsWith('--')) return false;
      return (/^-([A-Za-z]*)/.exec(a)?.[1] ?? '').includes(f[1]);
    }),
  );
const numbers = (args: string[]): number => args.filter((a) => /^\d+(\.\d+)?$/.test(a)).length;

const EDITORS = new Set(['vim', 'vi', 'nvim', 'view', 'nano', 'pico', 'joe', 'mcedit', 'ed', 'emacs']);
const PAGERS = new Set(['less', 'more', 'most']);
const TUI = new Set(['htop', 'atop', 'btop', 'iftop', 'nload', 'glances', 'nmon', 'ctop', 'mytop', 'innotop', 'nethogs', 'bmon', 'ncdu', 'mc', 'tmux', 'screen']);
const SAMPLERS = new Set(['vmstat', 'iostat', 'mpstat', 'pidstat', 'sar', 'dstat', 'nfsiostat', 'ifstat']);

/** 这条命令会卡住时返回原因和改法；正常的命令返回 null */
export function blockingReason(command: string): string | null {
  for (const words of segments(command)) {
    const u = unwrap(words);
    if (!u || u.timed) continue;
    const { name, args } = u;
    if (EDITORS.has(name) && !(name === 'emacs' && has(args, '--batch'))) return `${name} 是交互式编辑器，在 Agent 的执行通道里用不了：查看文件用 cat / sed -n '1,200p' / grep，修改文件用 sftp_write`;
    if (PAGERS.has(name)) return `${name} 是分页器，会等待按键：直接用 cat、head -n 或 tail -n`;
    if (TUI.has(name)) return `${name} 是全屏交互程序：改用一次性输出的命令（例如 top -b -n 1、ps aux --sort=-%cpu | head、ss -s、du -sh *）`;
    if (name === 'top' && !has(args, '-b', '--batch')) return 'top 默认是交互界面：改用 top -b -n 1（批处理模式，输出一次就结束）';
    if (name === 'iotop' && !has(args, '-b', '--batch')) return 'iotop 默认是交互界面：改用 iotop -b -n 3 -o';
    if (name === 'tail' && has(args, '-f', '-F', '--follow', '--retry')) return 'tail -f 会一直跟踪不结束：改用 tail -n 200（需要观察新增内容时用 timeout 10 tail -f 文件）';
    if (name === 'journalctl' && has(args, '-f', '--follow')) return 'journalctl -f 会一直跟踪：改用 journalctl -n 200 --no-pager（可以加 -u 服务名、--since）';
    if (name === 'dmesg' && has(args, '-w', '--follow', '-W', '--follow-new')) return 'dmesg -w 会一直等待新消息：去掉 -w，用 dmesg -T | tail -n 200';
    if (name === 'watch') return 'watch 会一直刷新：直接执行一次被 watch 的命令，需要观察变化时分几次执行或者用 for 循环加 sleep 并限定次数';
    if ((name === 'ping' || name === 'ping6') && !has(args, '-c', '-w', '--count')) return `${name} 不加次数会一直执行：加上 -c 4`;
    if ((name === 'docker' || name === 'podman' || name === 'kubectl' || name === 'crictl' || name === 'nerdctl') && args.includes('logs') && has(args, '-f', '--follow'))
      return `${name} logs -f 会一直跟踪：去掉 -f，用 --tail 200（kubectl 用 --tail=200）`;
    if ((name === 'docker' || name === 'podman' || name === 'nerdctl') && args[0] === 'stats' && !has(args, '--no-stream')) return `${name} stats 会一直刷新：加上 --no-stream`;
    if ((name === 'docker' || name === 'podman' || name === 'kubectl') && args.includes('events') && !has(args, '--until')) return `${name} events 会一直等待事件：加上 --since / --until 限定时间`;
    if (name === 'kubectl' && args[0] === 'get' && has(args, '-w', '--watch', '--watch-only')) return 'kubectl get -w 会一直监听：去掉 -w，执行一次';
    if (SAMPLERS.has(name) && numbers(args) === 1) return `${name} 只给了间隔没给次数，会一直输出：加上次数，例如 ${name} 1 5`;
    if ((name === 'tcpdump' || name === 'tshark') && !has(args, '-c')) return `${name} 不加 -c 会一直抓包：加上 -c 100，或者用 timeout 10 ${name} …`;
    if (name === 'yes') return 'yes 会一直输出：需要自动确认时用命令自带的 -y / --yes 选项';
  }
  return null;
}
