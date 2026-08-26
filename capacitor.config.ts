import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fimagina.cam',
  appName: 'Fimagina',
  webDir: 'www',
  backgroundColor: '#0a0a0c',
  android: {
    backgroundColor: '#0a0a0c',
    allowMixedContent: false,
    // 让 WebView 也能显示在最顶层，原生取景 SurfaceView 在其背后
    captureInput: false
  },
  server: {
    androidScheme: 'https'
  }
}

export default config