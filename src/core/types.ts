/** 自定义比例（宽:高）。ratio 统一用 宽/高 的小数表示。 */
export interface AspectRatio {
  id: string
  label: string
  /** width / height */
  ratio: number
  /** true 表示竖幅（相册/故事），竖向取景时锁定 */
  portrait?: boolean
}

/** 胶片调色预设参数定义 */
export interface LutParams {
  id: string
  name: string
  /** 全局曝光增益（乘） */
  exposure: number
  /** -1..1 色温，负=冷 正=暖 */
  temperature: number
  /** 对比度 0..1.6 */
  contrast: number
  /** 饱和度 0..2 */
  saturation: number
  /** 黑色提升（提灰/褪色）0..1 */
  lift: number
  /** 高光是否压缩（复古）0..1 */
  highlightCompression: number
  /** 青橙 / 分离调色权重，-1暖阴影..1冷阴影 */
  splitToning: number
  /** 红通道曲线（0..255 输入 -> 0..255 输出）可选；未提供则线性 */
  redCurve?: number[]
  greenCurve?: number[]
  blueCurve?: number[]
  grayscale?: boolean
  /** 胶片颗粒强度 0..1 */
  grain?: number
  /** 暗角强度 0..1 */
  vignette?: number
}

/** 一次拍摄及其参数 */
export interface CaptureSettings {
  aspectId: string
  lutId: string
  /** Joint HDRDN 曝光包围张数（1 = 普通单张） */
  hdrFrames: number
  /** 曝光包围 EV 步进 */
  hdrEvStep: number
}

/** 单帧曝光标记 */
export interface ExposureFrame {
  /** canvas 元素（含原始全幅位图） */
  canvas: HTMLCanvasElement
  /** 该帧曝光补偿 EV（0 = 基准） */
  ev: number
}

/** 相机能力抽象，Web 用量网页 / Android 用原生插件实现 */
export interface CameraLike {
  initPreview(): Promise<void>
  destroyPreview(): void
  /** 捕获一帧（返回原始 Full‑frame 位图 canvas，不做任何裁剪/调色） */
  captureSingle(): Promise<HTMLCanvasElement>
  /** Joint HDRDN：连拍多张曝光包围帧 */
  captureBurst(frames: number, evStep: number): Promise<ExposureFrame[]>
  pickFromGallery(): Promise<string | null>
}