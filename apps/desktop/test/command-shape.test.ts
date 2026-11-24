import { describe, expect, it } from 'vitest';
import { blockingReason } from '../src/main/services/ai/command-shape';

describe('交互式 / 不会结束的命令（第三十三轮）', () => {
  it('拦下来并给出改法', () => {
    for (const c of [
      'tail -f /var/log/nginx/error.log',
      'tail -fn 100 a.log',
      'sudo -u app tail -F x',
      'journalctl -fu nginx',
      'top',
      'top -c',
      'htop',
      'vim /etc/hosts',
      'cat a | less',
      'watch -n 1 df -h',
      'ping 10.0.0.1',
      'docker logs -f web',
      'kubectl logs pod-1 --follow',
      'docker stats',
      'vmstat 1',
      'sar -u 2',
      'tcpdump -i eth0 port 80',
      'kubectl get pods -w',
      'dmesg -w',
      'cd /tmp && nano a.txt',
      'yes | apt-get install x',
    ])
      expect(blockingReason(c), c).not.toBeNull();
  });

  it('正常的命令和已经限定了次数 / 时间的不拦', () => {
    for (const c of [
      'tail -n 200 /var/log/messages',
      'journalctl -u nginx -n 100 --no-pager',
      'top -b -n 1',
      'top -bn1 | head -20',
      'ping -c 4 10.0.0.1',
      'ping -c4 10.0.0.1',
      'docker logs --tail 200 web',
      'docker stats --no-stream',
      'vmstat 1 5',
      'vmstat',
      'iostat -x',
      'tcpdump -c 100 -i eth0',
      'timeout 10 tail -f a.log',
      'timeout -s INT 5 tcpdump -i any',
      'echo "tail -f x" > notes.txt',
      'grep -r vim /etc',
      'sed -n 1,20p a 2>&1',
      'ls -la && df -h; free -m',
      'kubectl get pods',
    ])
      expect(blockingReason(c), c).toBeNull();
  });
});
