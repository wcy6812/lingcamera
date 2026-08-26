/** base64 dataURL / Blob -> 图像元素 */
export function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    if (typeof src === 'string') img.src = src
    else img.src = URL.createObjectURL(src)
  })
}

/** base64 -> 绘制到 canvas（返回原始尺寸的 full‑frame canvas） */
export async function base64ToCanvas(base64: string): Promise<HTMLCanvasElement> {
  const img = await loadImage(base64)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  return canvas
}

/** 把 canvas 中按比例裁切的区域，画到一张指定比例的新 canvas 上（导师台成片裁切） */
export function cropCanvasToRatio(
  src: HTMLCanvasElement,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  outW: number,
  outH: number
): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = outW
  out.height = outH
  const ctx = out.getContext('2d')!
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, outW, outH)
  return out
}

/** 把 canvas 转成 blob（默认 image/jpeg） */
export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))), type, quality)
  })
}

/** 触发浏览器下载（仅 Web 调试用） */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/jpeg', 0.92)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** FileReader：Blob -> base64 dataURL */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new Error('读取失败'))
    fr.readAsDataURL(blob)
  })
}