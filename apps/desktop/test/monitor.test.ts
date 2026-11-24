import { describe, expect, it } from 'vitest';
import { parseSample, toSnapshot } from '../src/main/services/monitor/monitor-script';
import { bigFilesCommand, checkScanPaths, parseBigFiles, parseListenLine, parseNet, parseProcs, parseStatic, procName, procsCommand } from '../src/main/services/monitor/monitor-detail';

/** 真实 CentOS 7 上采集到的一个数据块（节选），第二块只改变计数器 */
function block(cpu: string, eth0: string, sda: string, cores = ['cpu0 500 0 250 4000 50 0 0 0 0 0', 'cpu1 500 0 250 4000 50 0 0 0 0 0']): string {
  return `
@host co-server-8-91 3.10.0-1160.el7.x86_64
@stat
${cpu}
${cores.join('\n')}
@cores 4
@mem
MemTotal:       16266280 kB
MemFree:          812000 kB
MemAvailable:    4229232 kB
Buffers:            2100 kB
Cached:          3600000 kB
SwapTotal:       2097148 kB
SwapFree:        1048574 kB
@load 0.12 0.30 0.25 1/512 23811
@uptime 5925661.21 23380000.00
@net
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  ens160: ${eth0}
docker0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
@ip
lo 127.0.0.1/8
ens160 10.10.0.91/24
@route
Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
ens160	00000A0A	00000000	0001	0	0	100	00FFFFFF	0	0	0
ens160	00000000	01000A0A	0003	0	0	100	00000000	0	0	0
@diskstats
   8       0 sda ${sda}
   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0
 253       0 dm-0 900 0 9000 0 900 0 9000 0 0 0 0
@df
/dev/mapper/centos-root  52403200 15203200 37200000  30% /
devtmpfs                  8120000        0  8120000   0% /dev
tmpfs                     8133140        0  8133140   0% /dev/shm
/dev/sda1                 1038336   155000   883336  15% /boot
overlay                  52403200 15203200 37200000  30% /var/lib/docker/overlay2/abc/merged
10.0.0.5:/export/data   104857600 10485760 94371840  10% /mnt/nfs
@temp
45000
51500
@ps
23811 root 12.5  1.2 204800 java
 1022 mysql  3.1 10.4 1700000 mysqld
@gpu
Tesla T4, 37, 2048, 15360, 52, 27.61, 40
@shells
23901 pts/0 /root/ifms-cloud/update-jar
23950 pts/1 /var/log
`;
}

const first = parseSample(block('cpu  1000 0 500 8000 100 0 0 0 0 0', '5000000 100 0 0 0 0 0 0 2000000 50 0 0 0 0 0 0', '1000 0 20000 0 500 0 10000 0 0 0 0'), 0);
const second = parseSample(
  block('cpu  1060 0 520 8100 120 0 0 0 0 0', '5068000 120 0 0 0 0 0 0 2034000 70 0 0 0 0 0 0', '1100 0 24000 0 600 0 12000 0 0 0 0', [
    // cpu0 忙 30 / 共 100 → 30%；cpu1 没有变化 → 0
    'cpu0 520 0 260 4060 60 0 0 0 0 0',
    'cpu1 500 0 250 4000 50 0 0 0 0 0',
  ]),
  2000,
);

describe('监控数据解析', () => {
  it('解析主机信息、内存、负载、分区（排除 tmpfs / overlay，保留 NFS）', () => {
    const snap = toSnapshot('h1', null, first);
    if (snap.state !== 'ok') throw new Error('state');
    expect(snap.hostname).toBe('co-server-8-91');
    expect(snap.load).toEqual([0.12, 0.3, 0.25]);
    expect(Math.round(snap.uptimeSec / 86400)).toBe(69);
    expect(snap.mem.total).toBe(16266280 * 1024);
    expect(snap.mem.used).toBe((16266280 - 4229232) * 1024);
    expect(snap.mem.swapUsed).toBe((2097148 - 1048574) * 1024);
    expect(snap.disks.map((d) => d.mount)).toEqual(['/', '/boot', '/mnt/nfs']);
    expect(snap.disks[0].usePct).toBeCloseTo(29, 0);
    expect(snap.tempC).toBe(51.5);
    expect(snap.gpus[0]).toMatchObject({ name: 'Tesla T4', util: 37, memUsed: 2048, memTotal: 15360, tempC: 52, fanPct: 40 });
    // 内存分项、默认网关（/proc/net/route 里小端序的十六进制）
    expect(snap.mem).toMatchObject({ free: 812000 * 1024, buffers: 2100 * 1024, cached: 3600000 * 1024 });
    expect(snap.gateway).toBe('10.10.0.1');
    expect(snap.procs[0]).toMatchObject({ pid: 23811, user: 'root', cpu: 12.5, command: 'java' });
    // 第一次采样没有速率
    expect(snap.cpu).toBeNull();
    expect(snap.net.find((n) => n.name === 'ens160')).toMatchObject({ ip: '10.10.0.91', rxBps: 0 });
    expect(snap.net.some((n) => n.name === 'lo')).toBe(false);
  });

  it('两次采样之间计算 CPU 使用率、网络和磁盘 IO 速率', () => {
    const snap = toSnapshot('h1', first, second);
    if (snap.state !== 'ok') throw new Error('state');
    // 总增量 60+20+100+20 = 200，空闲 100+20 = 120 → 使用率 40%
    expect(snap.cpu).toMatchObject({ usage: 40, user: 30, system: 10, iowait: 10, cores: 4, perCore: [30, 0] });
    const eth = snap.net.find((n) => n.name === 'ens160')!;
    expect(eth.rxBps).toBe(34000);
    expect(eth.txBps).toBe(17000);
    // 只统计整块磁盘 sda（不含分区 sda1 和 dm-0）：读 4000 扇区、写 2000 扇区，2 秒
    expect(snap.diskIo).toEqual({ readBps: (4000 * 512) / 2, writeBps: (2000 * 512) / 2 });
  });

  it('解析同一连接下各交互 shell 的当前目录', () => {
    expect(second.shells).toEqual([
      { pid: 23901, tty: 'pts/0', cwd: '/root/ifms-cloud/update-jar' },
      { pid: 23950, tty: 'pts/1', cwd: '/var/log' },
    ]);
  });

  it('计数器回绕时速率按 0 处理', () => {
    const wrapped = parseSample(block('cpu  1060 0 520 8100 120 0 0 0 0 0', '10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0', '1100 0 24000 0 600 0 12000 0 0 0 0'), 4000);
    const snap = toSnapshot('h1', second, wrapped);
    if (snap.state !== 'ok') throw new Error('state');
    expect(snap.net.find((n) => n.name === 'ens160')!.rxBps).toBe(0);
  });
});

describe('监控详情（按需执行的只读命令）', () => {
  it('进程排行：按 CPU / 内存排序，程序名取命令行第一段的文件名', () => {
    expect(procsCommand('mem', 20)).toContain('--sort=-rss');
    expect(procsCommand('cpu', 999)).toContain('head -n 100');
    const list = parseProcs(
      [
        '57340 elastic+  4.8 10.3 3355443 /usr/share/elasticsearch/jdk/bin/java -Xshare:auto -Des.networkaddress.cache.ttl=60',
        '  811 root      0.4  0.1  20480 sshd: root@pts/0',
        '    2 root      0.0  0.0      0 [kthreadd]',
        'garbage',
      ].join('\n'),
    );
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ pid: 57340, user: 'elastic+', cpu: 4.8, mem: 10.3, rss: 3355443, name: 'java' });
    expect(list[0].args).toContain('-Xshare:auto');
    expect(list[1].name).toBe('sshd');
    expect(list[2].name).toBe('[kthreadd]');
    expect(procName('nginx: worker process')).toBe('nginx');
  });

  it('主机信息：系统版本、CPU 型号、lspci 的显卡', () => {
    const r = parseStatic(['@os', 'Ubuntu 22.04.4 LTS', '@cpu', ' Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', '@gpu', '00:02.0 VGA compatible controller: Cirrus Logic GD 5446'].join('\n'));
    expect(r).toEqual({ os: 'Ubuntu 22.04.4 LTS', cpuModel: 'Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', gpus: ['00:02.0 VGA compatible controller: Cirrus Logic GD 5446'] });
    expect(parseStatic('@os\n@cpu\n@gpu\n')).toEqual({ os: null, cpuModel: null, gpus: [] });
  });

  it('网络：连接按状态计数、UDP、文件句柄、监听端口（ss 和 netstat 两种格式）', () => {
    const out = [
      '@sockstat',
      'sockets: used 507',
      'TCP: inuse 60 orphan 0 tw 1 alloc 70 mem 10',
      '@filenr',
      '7776	0	9223372036854775807',
      '@tcp',
      '     30 01',
      '      1 06',
      '     37 0A',
      '@udp',
      '65',
      '@listen',
      'tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1207,fd=3))',
      'tcp   LISTEN 0      128             [::]:22           [::]:*    users:(("sshd",pid=1207,fd=4))',
      'udp   UNCONN 0      0          0.0.0.0:111       0.0.0.0:*    users:(("rpcbind",pid=1,fd=5))',
      'udp   UNCONN 0      0    [fe80::f816:3eff:fe9f:e17b]%eth0:546   [::]:*  users:(("NetworkManager",pid=846,fd=22))',
      'tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1207,fd=3))',
    ].join('\n');
    const r = parseNet(out);
    expect(r.sockets).toBe(507);
    expect(r.tcp).toBe(68);
    expect(r.tcpStates).toEqual({ ESTABLISHED: 30, TIME_WAIT: 1, LISTEN: 37 });
    expect(r.udp).toBe(65);
    expect(r.fileHandles).toEqual({ allocated: 7776, max: 9223372036854775807 });
    expect(r.ports).toEqual([
      { proto: 'tcp', port: 22, address: '0.0.0.0', process: 'sshd', pid: 1207 },
      { proto: 'tcp', port: 22, address: '[::]', process: 'sshd', pid: 1207 },
      { proto: 'udp', port: 111, address: '0.0.0.0', process: 'rpcbind', pid: 1 },
      { proto: 'udp', port: 546, address: '[fe80::f816:3eff:fe9f:e17b]%eth0', process: 'NetworkManager', pid: 846 },
    ]);
    // netstat -tulnp（没有 ss 时）；没有权限时进程是「-」
    expect(parseListenLine('tcp        0      0 0.0.0.0:3306            0.0.0.0:*               LISTEN      1022/mysqld')).toEqual({ proto: 'tcp', port: 3306, address: '0.0.0.0', process: 'mysqld', pid: 1022 });
    expect(parseListenLine('udp        0      0 127.0.0.53:53           0.0.0.0:*                           -')).toEqual({ proto: 'udp', port: 53, address: '127.0.0.53', process: null, pid: null });
    expect(parseListenLine('tcp        0      0 10.0.0.2:22             10.0.0.9:51234          ESTABLISHED -')).toBeNull();
  });

  it('大文件扫描：路径加引号、大小换成 KB；只接受绝对路径', () => {
    const cmd = bigFilesCommand(['/home', "/data/it's here"], 100, 20);
    expect(cmd).toContain("find '/home' '/data/it'\\''s here' -xdev -type f -size +102400k");
    expect(cmd).toContain('head -n 20');
    expect(parseBigFiles('2097152\t/var/log/big.log\n1048576\t/home/a b.tar\n')).toEqual([
      { size: 2097152 * 1024, path: '/var/log/big.log' },
      { size: 1048576 * 1024, path: '/home/a b.tar' },
    ]);
    expect(checkScanPaths(['/var', 'relative', '/ok\nrm -rf /', ' /opt '])).toEqual(['/var', '/opt']);
  });
});
