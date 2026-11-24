/** 没有自带类型的文档转换库（第二十六轮：笔记导入 Word） */
declare module 'turndown' {
  interface Rule {
    filter: string | string[] | ((node: unknown) => boolean);
    replacement: (content: string, node: unknown) => string;
  }
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown): this;
    addRule(key: string, rule: Rule): this;
    turndown(html: string): string;
  }
}
declare module 'turndown-plugin-gfm' {
  export const gfm: unknown;
}
declare module 'word-extractor' {
  export default class WordExtractor {
    extract(path: string | Buffer): Promise<{ getBody(): string }>;
  }
}
