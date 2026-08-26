import type { LutParams } from './types'

/**
 * 胶片色调预设（LUT‑style grading）。
 * 每个预设定义一组可解析的参数，具体像素级转换见下方 grade / applyTo 若干函数。
 */

export const LUT_PRESETS: LutParams[] = [
  {
    id: 'none',
    name: '原片',
    exposure: 1,
    temperature: 0,
    contrast: 1,
    saturation: 1,
    lift: 0,
    highlightCompression: 0,
    splitToning: 0,
    grain: 0,
    vignette: 0
  },
  {
    id: 'teal-orange',
    name: '电影·青橙',
    exposure: 1.02,
    temperature: -0.05,
    contrast: 1.16,
    saturation: 0.94,
    lift: 0.012,
    highlightCompression: 0.06,
    splitToning: -0.55, // 阴影偏青
    // 红/绿通道的反差曲线用于强调肤色与高光暖色
    redCurve: buildCurve(1.1, -0.02, 0.08),
    greenCurve: buildCurve(1.0, 0.0, 0.02),
    blueCurve: buildCurve(0.94, 0.03, 0.06),
    grain: 0.03,
    vignette: 0.2
  },
  {
    id: 'portra',
    name: '胶片·负片',
    exposure: 1.04,
    temperature: 0.08,
    contrast: 0.92,
    saturation: 0.86,
    lift: 0.045, // 胶片自然的灰黑
    highlightCompression: 0.14,
    splitToning: -0.18, // 微青阴影，柔和的暖高光
    grain: 0.05,
    vignette: 0.12
  },
  {
    id: 'kodak-gold',
    name: '柯达·金',
    exposure: 1.05,
    temperature: 0.2,
    contrast: 0.98,
    saturation: 1.12,
    lift: 0.02,
    highlightCompression: 0.04,
    splitToning: 0.1,
    redCurve: buildCurve(1.05, 0.01, 0.02),
    blueCurve: buildCurve(0.92, 0.03, 0.04),
    grain: 0.035,
    vignette: 0.1
  },
  {
    id: 'bw',
    name: '黑白·文艺',
    exposure: 1,
    temperature: 0,
    contrast: 1.22,
    saturation: 0,
    lift: 0.03,
    highlightCompression: 0.1,
    splitToning: 0,
    grayscale: true,
    grain: 0.08,
    vignette: 0.18
  },
  {
    id: 'fade',
    name: '褪色·回忆',
    exposure: 1.02,
    temperature: 0.03,
    contrast: 0.78,
    saturation: 0.62,
    lift: 0.14,
    highlightCompression: 0.22,
    splitToning: -0.12,
    grain: 0.06,
    vignette: 0.08
  }
]

export function getLut(id: string): LutParams {
  return LUT_PRESETS.find((l) => l.id === id) ?? LUT_PRESETS[0]
}

/** 根据 对比度/提灰/高光压缩 合成一条 0..255 的色调曲线 */
function buildCurve(contrast = 1, lift = 0, highlightCompression = 0): number[] {
  const lut = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let p = i / 255
    p = p * (1 - lift) + lift // 提灰（黑发灰）
    p = (p - 0.5) * contrast + 0.5 // 对比度
    p -= highlightCompression * Math.pow(Math.max(0, p - 0.5), 2) * 1.6 // 高光软滚降
    p = clamp(p)
    lut[i] = p * 255
  }
  return lut
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 简单 1D 查表插值（未提供曲线时返回原值） */
function curve(v: number, lut?: number[]): number {
  if (!lut) return v
  const pos = (v / 255) * 255
  const i0 = Math.min(255, Math.max(0, Math.floor(pos)))
  const i1 = Math.min(255, i0 + 1)
  const f = pos - Math.floor(pos)
  return lut[i0] * (1 - f) + lut[i1] * f
}

const TONE_CURVE = buildCurve(1.0, 0, 0)

/**
 * 对单个像素应用整体调色（线性到 sRGB 域处理，像素无关，适合逐点并行）。
 * @param rgb 三元数组 [r,g,b]，范围 0..255，原地修改
 * @param lut LUT 参数
 * @param seed 用于颗粒的随机种子（调用方递增，保证每个像素不同）
 */
export function gradePixel(rgb: [number, number, number], lut: LutParams, seed: number): void {
  let [r, g, b] = rgb

  // 1) 白平衡（色温）：负=冷（蓝增），正=暖（红增）
  const temp = lut.temperature
  if (temp !== 0) {
    const warmScale = 1 + temp * 0.18
    const coolScale = 1 - temp * 0.18
    r *= warmScale
    g *= 1 + temp * 0.04
    b *= coolScale
  }

  // 2) 曝光
  if (lut.exposure !== 1) {
    r *= lut.exposure
    g *= lut.exposure
    b *= lut.exposure
  }

  // 3) 通道色调曲线
  r = curve(r, lut.redCurve)
  g = curve(g, lut.greenCurve)
  b = curve(b, lut.blueCurve)
  // 通用曲线（灰度/无自定义时）
  if (!lut.redCurve && !lut.greenCurve && !lut.blueCurve) {
    const lumPre = r * 0.2126 + g * 0.7152 + b * 0.0722
    const c = { contrast: lut.contrast, lift: lut.lift, highlightCompression: lut.highlightCompression }
    const merged = curve(lumPre, TONE_CURVE) // no-op holder
    void merged
    // 直接用统一亮度曲线近似（对比+提灰+高光压缩）
    let p = lumPre / 255
    p = p * (1 - c.lift) + c.lift
    p = (p - 0.5) * c.contrast + 0.5
    p -= c.highlightCompression * Math.pow(Math.max(0, p - 0.5), 2) * 1.6
    const scale = clamp(p) / clamp(lumPre / 255)
    r *= scale
    g *= scale
    b *= scale
  }

  // 4) 分离调色（青橙）：
  //    splitToning<0 阴影偏青、高光偏橙；>0 阴影偏暖、高光偏冷
  if (lut.splitToning !== 0) {
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722
    const shadowMix = clamp(1 - lum / 96) * 0.5
    const highMix = clamp((lum - 160) / 96) * 0.5
    const k = lut.splitToning
    // 阴影着色
    const cR = k < 0 ? 0.94 + k * 0.12 : 1.06 + k * 0.1
    const cB = k < 0 ? 1.08 - k * 0.14 : 0.92 - k * 0.1
    r += (r * cR - r) * shadowMix
    b += (b * cB - b) * shadowMix
    // 高光着色（相反方向）
    const hR = k < 0 ? 1.06 - k * 0.1 : 0.96 - k * 0.14
    const hB = k < 0 ? 0.92 + k * 0.1 : 1.06 + k * 0.12
    r += (r * hR - r) * highMix
    b += (b * hB - b) * highMix
  }

  // 5) 饱和度（亮度域）
  const lum = r * 0.2126 + g * 0.7152 + b * 0.0722
  if (lut.saturation !== 1 || lut.grayscale) {
    const s = lut.grayscale ? 0 : lut.saturation
    r = lum + (r - lum) * s
    g = lum + (g - lum) * s
    b = lum + (b - lum) * s
  }

  // 6) 胶片颗粒
  const grain = lut.grain ?? 0
  if (grain > 0) {
    // Box‑Muller 近似的高斯噪声
    const u = fract(Math.sin(seed * 12.9898) * 43758.5453)
    const noise = (u * 2 - 1) * grain * 38
    r += noise
    g += noise
    b += noise
  }

  rgb[0] = clampPix(r)
  rgb[1] = clampPix(g)
  rgb[2] = clampPix(b)
}

function fract(x: number): number {
  return x - Math.floor(x)
}
function clampPix(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * 对整张 ImageData 应用 LUT（含暗角，暗角与像素位置相关，需逐像素计算）。
 */
export function gradeImage(data: Uint8ClampedArray, w: number, h: number, lut: LutParams): void {
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const maxD = Math.hypot(cx, cy) || 1
  const vg = lut.vignette ?? 0
  const rgb: [number, number, number] = [0, 0, 0]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      rgb[0] = data[i]
      rgb[1] = data[i + 1]
      rgb[2] = data[i + 2]

      gradePixel(rgb, lut, i)

      if (vg > 0) {
        const dx = (x - cx) / maxD
        const dy = (y - cy) / maxD
        const d = Math.min(1, Math.hypot(dx, dy) * 1.55)
        const shadow = 1 - vg * Math.pow(d, 2.3)
        rgb[0] *= shadow
        rgb[1] *= shadow
        rgb[2] *= shadow
      }

      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
    }
  }
}

/** 把某预设转为可保存/导出的轻量描述（用户可随时预览效果名） */
export function describeLut(lut: LutParams): string {
  return `${lut.name} (对比${lut.contrast >= 1 ? '+' : ''}${Math.round((lut.contrast - 1) * 100)} · 饱和${lut.saturation >= 1 ? '+' : ''}${Math.round((lut.saturation - 1) * 100)} ● ${(lut.grain ?? 0) > 0 ? '颗粒' : ''}${(lut.vignette ?? 0) > 0 ? '暗角' : ''})`
}