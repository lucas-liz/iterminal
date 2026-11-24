/** 发给模型的图片长边上限（第二十四轮，文档一 6.38）；纯计算，单元测试可以直接引用 */
export const MAX_IMAGE_EDGE = 2048;

/** 按比例缩到长边不超过 maxEdge */
export function fitSize(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
