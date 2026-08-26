import type { CaptureSettings } from '../core/types'
import { getAspect, computeCenterCrop } from '../core/ratios'
import { getLut } from '../core/luts'
import { mergeHdrAsync, applyLutAsync } from '../core/pipeline'
import { cropCanvasToRatio, canvasToBlob, blobToBase64 } from '../core/image'
import { isNative, nativeBurst, nativeSingle, captureFromVideo, simulateBurstFromCanvas } from './cameraAdapter'
import { nativeCamera } from './cameraEngine'
import { framesFromCanvases } from '../core/hdr'

export interface ShotResult {
  canvas: HTMLCanvasElement
  width: number
  height: number
  ratio: number
  lutId: string
}

/**
 * 拍摄并流转：捕获（单帧/包围连拍）→ Joint HDRDN 融合 → 按比例裁切 → 胶片 LUT。
 * @param video 非空 = Web（从摄像头抓帧）；为 null = 原生插件取景
 */
export async function takeShot(video: HTMLVideoElement | null, settings: CaptureSettings): Promise<ShotResult> {
  const aspect = getAspect(settings.aspectId)
  const lut = getLut(settings.lutId)
  const hdr = settings.hdrFrames > 1

  let full: HTMLCanvasElement

  if (hdr) {
    const raw =
      isNative()
        ? (await nativeBurst(settings.hdrFrames, settings.hdrEvStep)).map((f) => ({ canvas: f.canvas, ev: f.ev }))
        : video
          ? simulateBurstFromCanvas(captureFromVideo(video), settings.hdrFrames, settings.hdrEvStep)
          : []
    if (raw.length === 0) throw new Error('无法捕获多曝光帧')
    const { data, width, height } = await mergeHdrAsync(framesFromCanvases(raw))
    full = document.createElement('canvas')
    full.width = width
    full.height = height
    full.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0)
  } else {
    full = isNative() ? await nativeSingle() : video ? captureFromVideo(video) : document.createElement('canvas')
  }

  // 按比例中心裁切
  const crop = computeCenterCrop(full.width, full.height, aspect.ratio)
  const cropped = cropCanvasToRatio(full, crop.x, crop.y, crop.w, crop.h, crop.w, crop.h)

  // 胶片 LUT（Worker 内逐像素着色）
  const ctx = cropped.getContext('2d', { willReadFrequently: true })!
  const img = ctx.getImageData(0, 0, cropped.width, cropped.height)
  const graded = await applyLutAsync({ data: img.data, width: img.width, height: img.height }, lut)
  ctx.putImageData(new ImageData(graded, cropped.width, cropped.height), 0, 0)

  // 原生端写回相册
  if (isNative()) {
    try {
      const blob = await canvasToBlob(cropped, 'image/jpeg', 0.92)
      const b64 = await blobToBase64(blob)
      await nativeCamera.saveToGallery(b64.split(',')[1] ?? b64, shotName())
    } catch {
      /* 保存失败不阻断成片展示 */
    }
  }

  return { canvas: cropped, width: cropped.width, height: cropped.height, ratio: aspect.ratio, lutId: settings.lutId }
}

function shotName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `fimagina_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}.jpg`
}