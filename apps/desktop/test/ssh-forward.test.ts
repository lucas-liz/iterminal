import { describe, expect, it } from 'vitest';
import { buildSshForwardCommand, parseSshForwardCommand } from '@itm/protocol';

const CMD =
  'ssh -p 2222 -L 8848:10.20.0.39:8848 -L 8089:10.20.0.39:8089 -L 18083:10.20.1.4:18083 -L 15005:10.20.0.42:15005 -L 15003:10.20.0.42:15003 ' +
  '-L 14008:10.20.0.42:14008 -L 15008:10.20.0.42:15008 -L 17005:10.20.0.42:17005 -L 13000:10.20.0.42:13000 -L 19999:10.20.0.42:19999 ' +
  '-L 9999:10.20.0.42:9999 -L 16379:10.20.0.39:6379 -L 15601:10.20.0.39:15601 -L 5601:10.20.0.39:5601 root@10.10.0.90';

describe('ssh 命令 ⇄ 端口转发', () => {
  it('导入：主机、端口、14 条本地转发；再生成同样的命令', () => {
    const r = parseSshForwardCommand(CMD);
    expect(r.host).toEqual({ address: '10.10.0.90', port: 2222, username: 'root' });
    expect(r.warnings).toEqual([]);
    expect(r.forwards).toHaveLength(14);
    expect(r.forwards[0]).toEqual({ type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 8848, targetAddr: '10.20.0.39', targetPort: 8848, autoStart: false });
    expect(r.forwards.find((f) => f.bindPort === 16379)).toMatchObject({ targetAddr: '10.20.0.39', targetPort: 6379 });
    expect(buildSshForwardCommand(r.host!, r.forwards)).toBe(CMD);
  });

  it('监听地址、-R / -D、合在一起的选项、-o、-J、ssh:// 地址、引号和续行', () => {
    const r = parseSshForwardCommand(`autossh -M 0 -NfC -L0.0.0.0:3306:db:3306 -L '*:8080:web:80' -R 9000:localhost:9000 -D 1080 -D [::1]:1081 \\
      -o "LocalForward 6000 cache:6379" -o Port=2222 -J jump@10.0.0.1:2200 -i ~/.ssh/id_rsa ssh://ops@bastion.example.com`);
    expect(r.host).toEqual({ address: 'bastion.example.com', port: 2222, username: 'ops' });
    expect(r.jumps).toEqual(['jump@10.0.0.1:2200']);
    expect(r.forwards).toEqual([
      { type: 'LOCAL', bindAddr: '0.0.0.0', bindPort: 3306, targetAddr: 'db', targetPort: 3306, autoStart: false },
      { type: 'LOCAL', bindAddr: '0.0.0.0', bindPort: 8080, targetAddr: 'web', targetPort: 80, autoStart: false },
      { type: 'REMOTE', bindAddr: '127.0.0.1', bindPort: 9000, targetAddr: 'localhost', targetPort: 9000, autoStart: false },
      { type: 'DYNAMIC', bindAddr: '127.0.0.1', bindPort: 1080, targetAddr: null, targetPort: null, autoStart: false },
      { type: 'DYNAMIC', bindAddr: '::1', bindPort: 1081, targetAddr: null, targetPort: null, autoStart: false },
      { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 6000, targetAddr: 'cache', targetPort: 6379, autoStart: false },
    ]);
    expect(r.warnings.join('\n')).toContain('私钥');
    expect(buildSshForwardCommand({ address: 'h', port: 22, username: null }, r.forwards.slice(0, 5), { noShell: true, jumps: ['j@x'] })).toBe(
      'ssh -N -J j@x -L *:3306:db:3306 -L *:8080:web:80 -R 9000:localhost:9000 -D 1080 -D [::1]:1081 h',
    );
  });

  it('写错的转发跳过并说明原因；没有目标主机时提示', () => {
    const r = parseSshForwardCommand('ssh -L 80:abc -L /tmp/s:/tmp/d -R 9000 -L 70000:a:1');
    expect(r.forwards).toEqual([]);
    expect(r.host).toBeNull();
    expect(r.warnings).toEqual([
      '-L 80:abc 写法不对（Unix 套接字转发不支持），已跳过',
      '-L /tmp/s:/tmp/d 写法不对（Unix 套接字转发不支持），已跳过',
      '-R 9000 是远程动态转发，暂不支持，已跳过',
      '-L 70000:a:1 端口或地址不对，已跳过',
      '命令里没有目标主机（[用户@]地址）',
      '命令里没有 -L / -R / -D 转发',
    ]);
  });
});
