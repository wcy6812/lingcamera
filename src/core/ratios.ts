import type { AspectRatio } from './types'

/**
 * 自定义比例集合。
 * 取景框按此比例显示引导，成片按此比例中心裁切输出。
 */
export const ASPECT_RATIOS: AspectRatio[] = [
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '21:9', label: '2.39:1', ratio: 2.39 }, // 电影宽银幕
  { id: '9:16', label: '9:16', ratio: 9 / 16, portrait: true }
]

/** 默认比例 */
export const DEFAULT_ASPECT_ID = '3:2'

export function getAspect(id: string): AspectRatio {
  return ASPECT_RATIOS.find((a) => a.id === id) ?? ASPECT_RATIOS[0]
}

/**
 * 计算以 source 尺寸为中心、按目标比例 targetRatio 裁切的区域。
 * 返回裁切框相对源图左上角的 {x, y, w, h}（像素，取整、夹在范围内）。
 */
export function computeCenterCrop(
  srcW: number,
  srcH: number,
  targetRatio: number
): { x: number; y: number; w: number; h: number } {
  let w = srcW
  let h = srcH
  const srcRatio = srcW / srcH

  if (srcRatio > targetRatio) {
    // 源更宽，按高度为准，裁两边
    w = Math.round(srcH * targetRatio)
    h = srcH
  } else if (srcRatio < targetRatio) {
    // 源更高，按宽度为准，裁上下
    w = srcW
    h = Math.round(srcW / targetRatio)
  }

  // 夹紧到有效范围
  w = Math.max(1, Math.min(w, srcW))
  h = Math.max(1, Math.min(h, srcH))

  return {
    x: Math.round((srcW - w) / 2),
    y: Math.round((srcH - h) / 2),
    w,
    h
  }
}

/** 依据目标比例与可用视口，算出一个落在可用区域内的取景框矩形（用于覆盖层绘制） */
export function frameRectIn(
  availW: number,
  availH: number,
  targetRatio: number
): { x: number; y: number; w: number; h: number } {
  let w = availW
  let h = availH
  const availRatio = availW / availH

  if (availRatio > targetRatio) {
    // 可用区域宽于目标 —— 高度占满，宽按比例收缩（上下有黑边时由外层裁剪）
    h = availH
    w = Math.round(availH * targetRatio)
  } else {
    w = availW
    h = Math.round(availW / targetRatio)
  }
  return {
    x: Math.round((availW - w) / 2),
    y: Math.round((availH - h) / 2),
    w: Math.max(1, w),
    h: Math.max(1, h)
  }
}