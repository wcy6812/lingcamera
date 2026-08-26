import type { ExposureFrame } from './types'

/*
 * Joint‑HDRDN 风格的多曝光「联合去噪 + HDR 融合」。
 * 思想（受 CVPR23「Joint HDR Denoising and Fusion」与 Lucky imaging 启发）：
 *   - 对每一帧做曝光归一化 + 线性化；
 *   - 按「是否处于良好曝光区间」以及「与参考帧是否一致（去鬼影）」为每个像素分配权重；
 *   - 加权平均天然完成多帧降噪 + 动态范围扩展；
 *   - 再做一次保边的联合去噪，最后电影系 tone‑map 回显示域。
 * 输入必须是同一场景、不同 EV 的包围序列；输出返回合并后的 full‑frame canvas。
 */

const EV_BASE = 0.18 // 18% 中灰

/** sRGB 0..1 -> 线性 */
function srgbToLinear(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
/** 线性 0..1 -> sRGB 0..255 */
function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.min(255, Math.max(0, c * 255))
}

/** 良好曝光权重：在 log 亮度空间里衡量是否临近中灰，避免过曝/欠曝帧主导 */
function wellExposedWeight(logLum: number): number {
  const d = (logLum - 0) / 3 // 3 EV 半宽
  return Math.exp(-0.5 * d * d)
}

/** 与参考一致（去鬼影）权重：log 亮度差异近似，越小越一致 */
function consistencyWeight(dLog: number): number {
  return Math.exp(-0.5 * (dLog / 0.35) * (dLog / 0.35))
}

/** 传入 Worker / 纯数据的曝光帧（RGBA 图像数据） */
export interface RawFrame {
  data: Uint8ClampedArray
  width: number
  height: number
  ev: number
}

/** 主线程友好：把 canvas 曝光帧转成 RawFrame */
export function framesFromCanvases(frames: ExposureFrame[]): RawFrame[] {
  return frames.map((f) => {
    const ctx = f.canvas.getContext('2d', { willReadFrequently: true })!
    return {
      data: ctx.getImageData(0, 0, f.canvas.width, f.canvas.height).data,
      width: f.canvas.width,
      height: f.canvas.height,
      ev: f.ev
    }
  })
}

/**
 * 合并多曝光帧（纯数据核心，可运行在 Worker）。
 * @param rawFrames 帧列表（含各自 EV），顺序无所谓
 * @param denoiseRadius 联合去噪半径（0 = 关）
 * @returns 合并后的 RGBA ImageData 像素数据
 */
export function mergeHdrPixels(rawFrames: RawFrame[], denoiseRadius = 1): {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
} {
  if (rawFrames.length === 0) throw new Error('无可用帧')
  const w = rawFrames[0].width
  const h = rawFrames[0].height
  const n = rawFrames.length
  const px = w * h

  // 依 EV 与 0 的距离选参考帧（通常最居中的曝光最稳）
  let refIdx = 0
  let refDist = Infinity
  rawFrames.forEach((f, i) => {
    const d = Math.abs(f.ev)
    if (d < refDist) {
      refDist = d
      refIdx = i
    }
  })

  // 解出每帧线性 RGB 与 log 亮度
  const lin = rawFrames.map((f) => {
    const scale = Math.pow(2, f.ev)
    const rgba = f.data
    const out = new Float32Array(px * 3)
    const lum = new Float32Array(px)
    for (let i = 0; i < px; i++) {
      const j = i * 4
      const r = srgbToLinear(rgba[j]) * scale
      const g = srgbToLinear(rgba[j + 1]) * scale
      const b = srgbToLinear(rgba[j + 2]) * scale
      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
      lum[i] = Math.log2(Math.max(1e-6, 0.2126 * r + 0.7152 * g + 0.0722 * b) / EV_BASE)
    }
    return { out, lum }
  })

  const refLum = lin[refIdx].lum

  // 累加器：加权和 与 权重和
  const acc = new Float32Array(px * 3)
  const wsum = new Float32Array(px)

  for (let i = 0; i < n; i++) {
    const L = lin[i]
    for (let p = 0; p < px; p++) {
      const lum = L.lum[p]
      const well = wellExposedWeight(lum)
      const consist = consistencyWeight(lum - refLum[p])
      // 保留一定的 base，避免全 0 权重导致空洞
      let weight = well * (consist * 0.85 + 0.15) + 0.01
      // 参考帧略微增强，稳定整体亮度
      if (i === refIdx) weight += 0.2
      const wgt = weight
      const o = p * 3
      acc[o] += L.out[o] * wgt
      acc[o + 1] += L.out[o + 1] * wgt
      acc[o + 2] += L.out[o + 2] * wgt
      wsum[p] += wgt
    }
  }

  for (let p = 0; p < px; p++) {
    const inv = 1 / Math.max(1e-6, wsum[p])
    acc[p * 3] *= inv
    acc[p * 3 + 1] *= inv
    acc[p * 3 + 2] *= inv
  }

  // 联合保边去噪（对合并后的亮度做 3-邻域 bilateral 平滑）
  if (denoiseRadius > 0) {
    bilateralDenoise(acc, w, h, px, denoiseRadius)
  }

  // 电影 tone‑map（Reinhard）+ 写回 sRGB（Worker 环境无 ImageData 构造时用手动数组）
  const data = new Uint8ClampedArray(px * 4) as Uint8ClampedArray<ArrayBuffer>
  for (let p = 0; p < px; p++) {
    let r = acc[p * 3]
    let g = acc[p * 3 + 1]
    let b = acc[p * 3 + 2]
    // 亮度归一化 + Reinhard 压缩
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const tm = lum / (1 + lum)
    const s = lum > 1e-6 ? tm / lum : 1
    r *= s
    g *= s
    b *= s
    const j = p * 4
    data[j] = linearToSrgb(r)
    data[j + 1] = linearToSrgb(g)
    data[j + 2] = linearToSrgb(b)
    data[j + 3] = 255
  }

  return { data, width: w, height: h }
}

/** 主线程便捷入口：传入 canvas 曝光帧，返回合并后的 full‑frame canvas */
export function mergeHdr(frames: ExposureFrame[], denoiseRadius = 1): HTMLCanvasElement {
  const { data, width, height } = mergeHdrPixels(framesFromCanvases(frames), denoiseRadius)
  const outCanvas = document.createElement('canvas')
  outCanvas.width = width
  outCanvas.height = height
  outCanvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0)
  return outCanvas
}

/** 3x3 双边滤波，作用于线性亮度，保边缘去噪 */
function bilateralDenoise(
  linear: Float32Array,
  w: number,
  h: number,
  px: number,
  radius: number
): void {
  const lum = new Float32Array(px)
  for (let p = 0; p < px; p++) {
    lum[p] = 0.2126 * linear[p * 3] + 0.7152 * linear[p * 3 + 1] + 0.0722 * linear[p * 3 + 2]
  }
  const res = new Float32Array(px * 3)
  const sigmaR = 0.08 // 强度差标准差（log 域近似）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y * w + x
      const cLum = lum[c]
      let wsum = 0
      let tr = 0
      let tg = 0
      let tb = 0
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const np = ny * w + nx
          const spatial = Math.exp(-((dx * dx + dy * dy) / (radius + 1)))
          const range = Math.exp(-0.5 * (Math.abs(lum[np] - cLum) / sigmaR) ** 2)
          const wt = spatial * range
          wsum += wt
          tr += linear[np * 3] * wt
          tg += linear[np * 3 + 1] * wt
          tb += linear[np * 3 + 2] * wt
        }
      }
      const i = c * 3
      res[i] = tr / wsum
      res[i + 1] = tg / wsum
      res[i + 2] = tb / wsum
    }
  }
  linear.set(res)
}