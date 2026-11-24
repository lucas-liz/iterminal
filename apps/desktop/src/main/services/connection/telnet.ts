/**
 * Telnet 协议（RFC 854 / 855）：从数据流里剥掉 IAC 命令并按需应答选项协商。
 * 支持的选项：终端类型（TTYPE，RFC 1091）、窗口大小（NAWS，RFC 1073）、回显（ECHO）、抑制继续（SGA）、二进制（BINARY）。
 * 只在选项状态变化时应答，避免和对端来回协商形成死循环（RFC 1143 的简化）。
 */
export const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

export const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 } as const;

/** 我们愿意打开的本端选项（对端发 DO 时回 WILL） */
const LOCAL_OK = new Set<number>([OPT.BINARY, OPT.SGA, OPT.TTYPE, OPT.NAWS]);
/** 我们愿意让对端打开的选项（对端发 WILL 时回 DO） */
const REMOTE_OK = new Set<number>([OPT.BINARY, OPT.ECHO, OPT.SGA]);

type State = 'data' | 'iac' | 'opt' | 'sb' | 'sb_iac';

export class TelnetProtocol {
  private state: State = 'data';
  private cmd = 0;
  private sb: number[] = [];
  /** 已经打开的本端选项 / 对端选项 */
  private readonly local = new Set<number>();
  private readonly remote = new Set<number>();

  constructor(
    private readonly send: (b: Buffer) => void,
    private readonly termType: string,
    private cols: number,
    private rows: number,
  ) {}

  /** 对端是否负责回显（远端回显时本地不应该再显示输入） */
  get remoteEcho(): boolean {
    return this.remote.has(OPT.ECHO);
  }

  /** 二进制模式：回车不再按 NVT 规则变成 CR NUL */
  get binary(): boolean {
    return this.local.has(OPT.BINARY);
  }

  /** 处理收到的数据块，返回去掉 Telnet 命令后的数据 */
  receive(chunk: Buffer): Buffer {
    const out: number[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else out.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            out.push(IAC);
            this.state = 'data';
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = 'opt';
          } else if (b === SB) {
            this.sb = [];
            this.state = 'sb';
          } else {
            // NOP、GA、AYT 等：忽略
            this.state = 'data';
          }
          break;
        case 'opt':
          this.negotiate(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb_iac';
          else if (this.sb.length < 1024) this.sb.push(b);
          break;
        case 'sb_iac':
          if (b === SE) {
            this.subnegotiation(this.sb);
            this.state = 'data';
          } else {
            if (b === IAC) this.sb.push(IAC);
            this.state = 'sb';
          }
          break;
      }
    }
    return Buffer.from(out);
  }

  /** 发送前的转换：数据里的 0xFF 写成 IAC IAC；非二进制模式下单独的 CR 写成 CR NUL */
  encode(data: Buffer): Buffer {
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b === IAC) out.push(IAC, IAC);
      else if (b === 13 && !this.binary && data[i + 1] !== 10) out.push(13, 0);
      else out.push(b);
    }
    return Buffer.from(out);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.local.has(OPT.NAWS)) this.sendNaws();
  }

  private negotiate(cmd: number, opt: number): void {
    if (cmd === DO) {
      if (LOCAL_OK.has(opt)) {
        if (!this.local.has(opt)) {
          this.local.add(opt);
          this.reply(WILL, opt);
        }
        if (opt === OPT.NAWS) this.sendNaws();
      } else {
        this.reply(WONT, opt);
      }
    } else if (cmd === DONT) {
      if (this.local.delete(opt)) this.reply(WONT, opt);
    } else if (cmd === WILL) {
      if (REMOTE_OK.has(opt)) {
        if (!this.remote.has(opt)) {
          this.remote.add(opt);
          this.reply(DO, opt);
        }
      } else {
        this.reply(DONT, opt);
      }
    } else if (cmd === WONT) {
      if (this.remote.delete(opt)) this.reply(DONT, opt);
    }
  }

  private subnegotiation(data: number[]): void {
    // TTYPE SEND（1）：回复 TTYPE IS（0）终端类型
    if (data[0] === OPT.TTYPE && data[1] === 1) {
      this.send(Buffer.from([IAC, SB, OPT.TTYPE, 0, ...Buffer.from(this.termType, 'ascii'), IAC, SE]));
    }
  }

  private sendNaws(): void {
    const v = [this.cols >> 8, this.cols & 0xff, this.rows >> 8, this.rows & 0xff].flatMap((x) => (x === IAC ? [IAC, IAC] : [x]));
    this.send(Buffer.from([IAC, SB, OPT.NAWS, ...v, IAC, SE]));
  }

  private reply(cmd: number, opt: number): void {
    this.send(Buffer.from([IAC, cmd, opt]));
  }
}

/**
 * Telnet 自动登录：输出末尾出现 login: / Username: 时填用户名，出现 Password: 时填密码，每样只填一次。
 * 返回要发送的内容；不需要发送时返回 null。
 */
export class AutoLogin {
  private userSent = false;
  private passSent = false;
  private tail = '';

  constructor(
    private readonly username: string,
    private readonly password: string | undefined,
  ) {}

  get done(): boolean {
    return (this.userSent || !this.username) && (this.passSent || !this.password);
  }

  feed(text: string): string | null {
    // 去掉 ANSI 转义后只看最后一行
    this.tail = (this.tail + text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-200);
    const last = this.tail.split(/\r?\n/).pop() ?? '';
    if (!this.userSent && this.username && /(login|user\s*name|username|用户名)\s*[:：]\s*$/i.test(last)) {
      this.userSent = true;
      this.tail = '';
      return `${this.username}\r`;
    }
    if (!this.passSent && this.password && /(password|passcode|密码)\s*[:：]\s*$/i.test(last)) {
      this.passSent = true;
      this.tail = '';
      return `${this.password}\r`;
    }
    return null;
  }
}
