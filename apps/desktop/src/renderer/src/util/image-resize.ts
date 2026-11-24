import { MAX_AGENT_IMAGE_BYTES } from '@itm/protocol';
import { fitSize } from './image-size';

/**
 * 发给模型前缩小图片（第二十四轮，文档一 6.38）：各家模型都会把大图缩到 1–2 百万像素左右再理解
 * （DeepSeek 约 1300×1300，Claude 长边 1568），原图发过去只是白占请求体（团队代理单次上限 20MB）。
 * 长边超过 MAX_IMAGE_EDGE（image-size.ts）或文件超过 KEEP_BYTES 时按比例缩小并重新编码；GIF 可能是动图，原样发送。
 */
/** 小于这个大小、尺寸也不超的图片原样发送 */
const KEEP_BYTES = 1024 * 1024;
/** 截图（PNG）缩小后仍超过这个大小时改用 JPEG */
const PNG_MAX_BYTES = 1536 * 1024;
/** 选择 / 粘贴的图片最大 20MB（缩小后再按每张 5MB 检查） */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

export interface PreparedImage {
  name: string;
  mediaType: string;
  data: string;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('读取图片失败'));
    r.onload = () => {
      const url = String(r.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : '');
    };
    r.readAsDataURL(blob);
  });
}

/** 读取并（需要时）缩小一张图片；结果超过每张 5MB 的上限时报错 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const name = file.name || `截图-${new Date().toLocaleTimeString().replace(/:/g, '')}.png`;
  const original = async (): Promise<PreparedImage> => {
    if (file.size > MAX_AGENT_IMAGE_BYTES) throw new Error(`「${name}」超过 5MB`);
    return { name, mediaType: file.type, data: await toBase64(file) };
  };
  if (file.type === 'image/gif') return original();
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return original();
  }
  try {
    const size = fitSize(bmp.width, bmp.height);
    if (size.width === bmp.width && file.size <= KEEP_BYTES) return await original();
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return await original();
    ctx.imageSmoothingQuality = 'high';
    const encode = (type: string, quality?: number): Promise<Blob | null> => new Promise((r) => canvas.toBlob(r, type, quality));
    const draw = (opaque: boolean): void => {
      ctx.clearRect(0, 0, size.width, size.height);
      // JPEG 没有透明通道：先铺白底，透明截图不会变黑
      if (opaque) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size.width, size.height);
      }
      ctx.drawImage(bmp, 0, 0, size.width, size.height);
    };
    // 截图保持 PNG（文字更清楚），太大再换 JPEG；照片用原格式
    const type = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
    draw(type === 'image/jpeg');
    let blob = await encode(type, 0.9);
    if (blob && type === 'image/png' && blob.size > PNG_MAX_BYTES) {
      draw(true);
      blob = await encode('image/jpeg', 0.88);
    }
    // 没变小（已经压缩得很好的图片）：用原图
    if (!blob || (blob.size >= file.size && size.width === bmp.width)) return await original();
    if (blob.size > MAX_AGENT_IMAGE_BYTES) throw new Error(`「${name}」缩小后仍超过 5MB`);
    return { name, mediaType: blob.type || type, data: await toBase64(blob) };
  } finally {
    bmp.close();
  }
}
