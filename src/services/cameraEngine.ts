import { Capacitor } from '@capacitor/core'

/**
 * 原生 CameraEngine 插件桥。
 * 该插件（android/app/src/main/java/.../CameraEnginePlugin.kt）暴露：
 *   - setRatio({ ratio })            设置取景/成片比例
 *   - requestCamera()                请求权限 + 启动原生取景
 *   - stopPreview()                  停止原生取景
 *   - capture({}) -> { base64 }      普通单帧
 *   - captureBurst({ frames, evStep }) -> { base64s, evs }  曝光包围连拍
 *   - pick() -> { uri }              从系统相册选图
 *   - saveToGallery({ data: base64 }) -> { uri }  存图
 */

interface CameraEnginePlugin {
  requestCamera(): Promise<{ storageGranted: boolean }>
  openSettings(): Promise<void>
  stopPreview(): Promise<void>
  setRatio(opts: { ratio: number }): Promise<void>
  capture(opts: { quality: number }): Promise<{ base64: string }>
  captureBurst(opts: { frames: number; evStep: number; quality: number }): Promise<{
    base64s: string[]
    evs: number[]
  }>
  pick(): Promise<{ uri: string | null; base64?: string | null }>
  saveToGallery(opts: { data: string; name: string }): Promise<{ uri: string }>
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

function plugin(): CameraEnginePlugin {
  // @ts-ignore Capacitor 运行时注入
  return (window as unknown as { Capacitor: { Plugins: { CameraEngine: CameraEnginePlugin } } })
    .Capacitor.Plugins.CameraEngine
}

export const nativeCamera = {
  isNative,
  requestCamera: async () => plugin().requestCamera(),
  openSettings: async () => plugin().openSettings(),
  stopPreview: async () => plugin().stopPreview(),
  setRatio: async (ratio: number) => plugin().setRatio({ ratio }),
  capture: async (quality = 92) => plugin().capture({ quality }),
  captureBurst: async (frames: number, evStep: number, quality = 92) =>
    plugin().captureBurst({ frames, evStep, quality }),
  pick: async () => plugin().pick(),
  saveToGallery: async (data: string, name: string) => plugin().saveToGallery({ data, name })
}