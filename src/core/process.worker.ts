import { gradeImage } from './luts'
import { mergeHdrPixels, type RawFrame } from './hdr'
import type { LutParams } from './types'

interface GradeRequest {
  type: 'grade'
  data: Uint8ClampedArray
  width: number
  height: number
  lut: LutParams
}
interface HdrRequest {
  type: 'hdr'
  frames: RawFrame[]
  denoiseRadius: number
}

type Request = GradeRequest | HdrRequest

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data
  if (req.type === 'grade') {
    gradeImage(req.data, req.width, req.height, req.lut)
    ;(self as unknown as Worker).postMessage(
      { type: 'grade', data: req.data.buffer, width: req.width, height: req.height },
      [req.data.buffer]
    )
  } else if (req.type === 'hdr') {
    const out = mergeHdrPixels(req.frames, req.denoiseRadius)
    ;(self as unknown as Worker).postMessage(
      { type: 'hdr', data: out.data.buffer, width: out.width, height: out.height },
      [out.data.buffer]
    )
  }
}