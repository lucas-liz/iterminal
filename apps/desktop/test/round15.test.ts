import { describe, expect, it } from 'vitest';
import { envelopeError, OLD_SERVER } from '../src/main/util/envelope';
import { commandOf, runnable } from '../src/renderer/src/util/code-run';

describe('服务端响应的错误判断（第十五轮）', () => {
  it('HTTP 200 但 code 不对也算失败；旧版服务端没有接口时提示升级', () => {
    expect(envelopeError(200, { code: 0, message: 'ok', data: {} })).toBeNull();
    expect(envelopeError(200, { code: 200, msg: '操作成功' })).toBeNull();
    expect(envelopeError(200, null)).toBeNull();
    expect(envelopeError(200, { code: 500, msg: 'No static resource api/v1/feedback.' })).toBe(OLD_SERVER);
    expect(envelopeError(200, { code: 404, msg: '接口不存在：/iterminal/grant/options（服务端可能还是旧版本，请升级）' })).toBe(OLD_SERVER);
    expect(envelopeError(200, { code: 500, msg: '数据库错误' })).toBe('数据库错误');
    expect(envelopeError(404, { code: 404, message: '分享码无效或已失效' })).toBe('分享码无效或已失效');
    expect(envelopeError(502, 'Bad Gateway')).toBe('服务端返回 502');
  });
});

describe('回答里的命令在终端运行（第十五轮）', () => {
  it('shell 代码块可以运行；没写语言的短代码块也可以；配置文件不行', () => {
    expect(runnable('systemctl status nginx', 'bash')).toBe(true);
    expect(runnable('df -h\nfree -m', '')).toBe(true);
    expect(runnable('server {\n  listen 80;\n}', 'nginx')).toBe(false);
    expect(runnable(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'), '')).toBe(false);
    expect(runnable('', '')).toBe(false);
  });

  it('带提示符的 console 代码块只取命令，去掉输出', () => {
    expect(commandOf('$ uptime\n 10:01 up 3 days\n$ df -h /\n', 'console')).toBe('uptime\ndf -h /');
    expect(commandOf('cd /opt/app && ./run.sh status\n', 'bash')).toBe('cd /opt/app && ./run.sh status');
    expect(commandOf('# reboot\nnot a prompt', 'console')).toBe('reboot');
  });
});
