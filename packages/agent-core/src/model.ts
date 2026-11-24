import type { AiModelConfig, AiProvider, CallParams } from '@itm/protocol';

/** 解析后的模型（带解密后的 Key）：只在主进程和 Agent 进程之间传递，不会发给渲染进程 */
export interface ResolvedModel {
  provider: Pick<AiProvider, 'id' | 'name' | 'type' | 'baseUrl'> & Partial<AiProvider>;
  apiKey: string | null;
  model: AiModelConfig;
  /** 思考与采样参数（文档一 6.15.5）；不传时按模型默认（Claude 支持的模型开启 adaptive thinking） */
  params?: CallParams;
}
