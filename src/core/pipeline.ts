import type { LutParams } from './types'
import type { RawFrame } from './hdr'
import { gradeImage } from './luts'

/**
 * 在 Web Worker 中执行耗时图像处理，避免阻塞相机取景/UI。
 * 懒创建单例 Worker；不支持 Worker 的环境自动回退到主线程同步执行。
 */

type WorkerResult =
  | { type: 'grade'; data: ArrayBuffer; width: number; height: number }
  | { type: 'hdr'; data: ArrayBuffer; width: number; height: number }
  | { type: 'error'; message: string }

let worker: Worker | null = null
let pending: { resolve: (r: WorkerResult) => void; onerror: () => void } | null = null
let spinning = false

function getWorker(): Worker | null {
  if (worker !== null) return worker
  try {
    const w = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerResult>) => {
      const p = pending
      pending = null
      if (p) p.resolve(e.data)
    }
    w.onerror = () => {
      const p = pending
      pending = null
      spinning = false
      if (p) p.onerror()
      try {
        w.terminate()
      } catch {
        /* noop */
      }
      worker = null
    }
    worker = w
    return w
  } catch {
    return null
  }
}

/** 单飞：同一时刻只处理一个任务，保证结果与请求对应 */
function post(msg: unknown, transfer: Transferable[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const w = getWorker()
    if (!w) return reject(new Error('no worker available'))
    if (spinning) return reject(new Error('worker busy'))
    spinning = true
    pending = { resolve, onerror: () => reject(new Error('worker error')) }
    try {
      w.postMessage(msg, transfer)
    } catch {
      spinning = false
      pending = null
      reject(new Error('post failed'))
    }
  })
}

/** 应用胶片 LUT，返回着色后的新像素数据（不污染原始数据）。 */
export async function applyLutAsync(
  source: { data: Uint8ClampedArray; width: number; height: number },
  lut: LutParams
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const copy = source.data.slice() as Uint8ClampedArray<ArrayBuffer>
  try {
    const res = await post({ type: 'grade', data: copy, width: source.width, height: source.height, lut }, [
      copy.buffer
    ])
    if (res.type === 'grade') return new Uint8ClampedArray<ArrayBuffer>(res.data)
    spinning = false
    gradeImage(copy, source.width, source.height, lut)
    return copy
  } catch {
    spinning = false
    gradeImage(copy, source.width, source.height, lut)
    return copy
  }
}

export async function applyLutToImageData(img: ImageData, lut: LutParams): Promise<ImageData> {
  const data = await applyLutAsync({ data: img.data, width: img.width, height: img.height }, lut)
  return new ImageData(data, img.width, img.height)
}

/** Joint HDRDN 风格多曝光去噪融合。返回合并后的像素数据。 */
export async function mergeHdrAsync(
  rawFrames: RawFrame[],
  denoiseRadius = 1
): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }> {
  const clones: RawFrame[] = rawFrames.map((f) => ({ ...f, data: f.data.slice() }))
  const transfer = clones.map((f) => f.data.buffer as ArrayBuffer)
  try {
    const res = await post({ type: 'hdr', frames: clones, denoiseRadius }, transfer)
    if (res.type === 'hdr') {
      return { data: new Uint8ClampedArray<ArrayBuffer>(res.data), width: res.width, height: res.height }
    }
    spinning = false
    const { mergeHdrPixels } = await import('./hdr')
    const out = mergeHdrPixels(rawFrames, denoiseRadius)
    return { data: new Uint8ClampedArray<ArrayBuffer>(out.data.buffer), width: out.width, height: out.height }
  } catch {
    spinning = false
    const { mergeHdrPixels } = await import('./hdr')
    const out = mergeHdrPixels(rawFrames, denoiseRadius)
    return { data: new Uint8ClampedArray<ArrayBuffer>(out.data.buffer), width: out.width, height: out.height }
  }
}