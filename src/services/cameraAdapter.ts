import type { ExposureFrame } from '../core/types'
import { base64ToCanvas } from '../core/image'
import { nativeCamera, isNative } from './cameraEngine'

/** Web 端：请求摄像头视频流 */
export async function getWebStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  })
}

/** 从 <video> 抓取当前帧作为 full‑frame canvas */
export function captureFromVideo(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  return canvas
}

/** Web 端无法真实包围曝光：把单帧线性缩放，模拟一组不同 EV 的曝光帧（演示实验 pipeline） */
export function simulateBurstFromCanvas(base: HTMLCanvasElement, frames: number, evStep: number): ExposureFrame[] {
  const evs: number[] = []
  const start = -Math.ceil(frames / 2)
  for (let i = 0; i < frames; i++) evs.push((start + i) * evStep)
  return evs.map((ev) => ({ canvas: exposureVariant(base, ev), ev }))
}

/** 把基准帧做成指定 EV 的变体（亮度缩放），返回新 canvas */
export function exposureVariant(base: HTMLCanvasElement, ev: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = base.width
  out.height = base.height
  const ctx = out.getContext('2d')!
  if (ev === 0) {
    ctx.drawImage(base, 0, 0)
    return out
  }
  const scale = Math.pow(2, ev)
  // 使用 multiply 分步逼近增益；为控制范围用 filter brightness
  ctx.filter = `brightness(${scale * 100}%)`
  ctx.drawImage(base, 0, 0)
  ctx.filter = 'none'
  return out
}

/** 原生端：真曝光包围连拍 -> ExposureFrame[] */
export async function nativeBurst(frames: number, evStep: number, quality = 92): Promise<ExposureFrame[]> {
  const res = await nativeCamera.captureBurst(frames, evStep, quality)
  const out: ExposureFrame[] = []
  for (let i = 0; i < res.base64s.length; i++) {
    const canvas = await base64ToCanvas(res.base64s[i])
    out.push({ canvas, ev: res.evs[i] ?? 0 })
  }
  return out
}

/** 原生端：普通单帧 -> full‑frame canvas */
export async function nativeSingle(quality = 92): Promise<HTMLCanvasElement> {
  const res = await nativeCamera.capture(quality)
  return base64ToCanvas(res.base64)
}

export { isNative }