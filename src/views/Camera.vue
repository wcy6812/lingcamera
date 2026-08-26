<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, shallowRef } from 'vue'
import { ASPECT_RATIOS, getAspect, frameRectIn } from '../core/ratios'
import { LUT_PRESETS, getAllLuts, registerLut, getCustomLuts, parseCubeLut, applyCube3d, applyCube1d } from '../core/luts'
import type { LutParams } from '../core/types'
import { isNative, nativeCamera } from '../services/cameraEngine'
import { getWebStream } from '../services/cameraAdapter'
import { takeShot, type ShotResult } from '../services/shutter'
import { downloadCanvas } from '../core/image'

// ---- 取景：Web 用真实预取 + 原生用插件背后 SurfaceView（WebView 透明）
const videoEl = ref<HTMLVideoElement | null>(null)
const isNativeClient = isNative()
const errored = ref('')
const ready = ref(false)
/** 相机权限被拒，显示去设置引导 */
const permDenied = ref(false)
/** 存储权限未授予（照片无法保存相册） */
const storageWarn = ref('')

// ---- 滤镜列表（含导入的 .cube LUT）
const lutList = ref<LutParams[]>(getAllLuts())
const aspectId = ref('3:2')
const lutId = ref('teal-orange')
const hdrOn = ref(false)
const hdrFrames = ref(3)
const capturing = ref(false)
const shot = shallowRef<ShotResult | null>(null)
const showPreview = ref(false)

const activeAspect = computed(() => getAspect(aspectId.value))
const activeLut = computed(() => lutList.value.find((l) => l.id === lutId.value) ?? lutList.value[0] ?? LUT_PRESETS[0])

const viewport = ref({ w: window.innerWidth, h: window.innerHeight })
const guide = ref(frameRectIn(viewport.value.w, viewport.value.h, getAspect(aspectId.value).ratio))
const guideStyle = computed(() => {
  const g = guide.value
  return { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` }
})

function updateViewport() {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  guide.value = frameRectIn(viewport.value.w, viewport.value.h, activeAspect.value.ratio)
}
window.addEventListener('resize', updateViewport)

async function init() {
  try {
    restoreCustomLuts()
    if (isNativeClient) {
      const res = await nativeCamera.requestCamera()
      if (res && res.storageGranted === false) {
        storageWarn.value = '未授予存储权限，照片将无法保存到相册'
      }
      await nativeCamera.setRatio(activeAspect.value.ratio)
    } else if (videoEl.value) {
      const stream = await getWebStream()
      videoEl.value.srcObject = stream
      await videoEl.value.play()
    }
    ready.value = true
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'CAMERA_PERMISSION_DENIED') {
      permDenied.value = true
      errored.value = '相机权限被拒绝，无法使用取景器'
    } else if (code === 'STORAGE_PERMISSION_DENIED') {
      storageWarn.value = '未授予存储权限，照片将无法保存到相册'
      ready.value = true
    } else {
      errored.value = e instanceof Error ? e.message : String(e)
    }
  }
}

async function openSystemSettings() {
  try {
    permDenied.value = false
    await nativeCamera.openSettings()
  } catch {
    /* 打开失败静默 */
  }
}

// ---- 导入 .cube LUT ----
const lutFileInput = ref<HTMLInputElement | null>(null)

function onImportLutClick() {
  lutFileInput.value?.click()
}

async function onLutFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const name = file.name.replace(/\.cube$/i, '').replace(/[_-]+/g, ' ').trim() || '自定义 LUT'
    const lut = parseCubeLut(await file.text(), name)
    registerLut(lut)
    lutList.value = getAllLuts()
    lutId.value = lut.id
    persistCustomLuts()
  } catch (err) {
    errored.value = err instanceof Error ? err.message : String(err)
  }
}

function persistCustomLuts() {
  try {
    localStorage.setItem('fimagina.customLuts', JSON.stringify(getCustomLuts()))
  } catch {
    /* 存储失败忽略 */
  }
}

function restoreCustomLuts() {
  try {
    const raw = localStorage.getItem('fimagina.customLuts')
    if (!raw) return
    const arr = JSON.parse(raw) as LutParams[]
    if (!Array.isArray(arr)) return
    let changed = false
    for (const l of arr) {
      if (l && l.cubeLut) {
        registerLut(l)
        changed = true
      }
    }
    if (changed) lutList.value = getAllLuts()
  } catch {
    /* 数据损坏则忽略 */
  }
}

async function capture() {
  if (capturing.value) return
  capturing.value = true
  try {
    const img = await takeShot(videoEl.value, {
      aspectId: aspectId.value,
      lutId: lutId.value,
      hdrFrames: hdrOn.value ? hdrFrames.value : 1,
      hdrEvStep: 1.0
    })
    shot.value = img
    showPreview.value = true
  } catch (e) {
    errored.value = e instanceof Error ? e.message : String(e)
  } finally {
    capturing.value = false
  }
}

async function onAspectChange() {
  updateViewport()
  if (isNativeClient && ready.value) await nativeCamera.setRatio(activeAspect.value.ratio)
}

function toggleHdr() {
  hdrOn.value = !hdrOn.value
  hdrFrames.value = hdrOn.value ? 3 : 1
}

function closePreview() {
  showPreview.value = false
}

function redownload() {
  if (shot.value) downloadCanvas(shot.value.canvas, `fimagina_${Date.now()}.jpg`)
}

function swatchStyle(l: LutParams) {
  // 导入的 LUT：从色块顶部取 4 个代表性角点色，近似其色调
  if (l.cubeLut) {
    const corners = [
      lutSample(l, 0, 0, 0),
      lutSample(l, 255, 0, 0),
      lutSample(l, 0, 0, 255),
      lutSample(l, 255, 255, 255)
    ]
    const stops = corners.map((c, i) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${(i * 33).toFixed(0)}%`)
    return { background: `linear-gradient(135deg, ${stops.join(',')})` }
  }
  const warm = l.temperature > 0.05
  const cool = l.temperature < -0.05 || l.splitToning < -0.2
  const b = l.grayscale
  const a = cool ? '#1b2a3f' : '#2f2b22'
  const c = warm ? '#c98a3a' : b ? '#8a8a8a' : '#3f5c6e'
  const d = l.lift > 0.08 ? '#2a2724' : '#101014'
  return { background: `linear-gradient(150deg, ${a} 0%, ${c} 52%, ${d} 100%)` }
}

/** 用 LUT 模拟 4 角色彩样本（供滤镜色块展示） */
function lutSample(l: LutParams, r: number, g: number, b: number): [number, number, number] {
  const cube = l.cubeLut
  if (!cube) return [r, g, b]
  return cube.type === '1d'
    ? applyCube1d(cube, r, g, b)
    : applyCube3d(cube, r, g, b)
}

onMounted(init)
onBeforeUnmount(() => {
  if (isNativeClient) nativeCamera.stopPreview()
  else if (videoEl.value?.srcObject instanceof MediaStream) {
    videoEl.value.srcObject.getTracks().forEach((t) => t.stop())
  }
})
</script>

<template>
  <div class="camera">
    <div class="viewport" @click="showPreview = false">
      <video ref="videoEl" v-show="!isNativeClient" autoplay muted playsinline class="feed" />

      <!-- 比例引导 + 暗角遮罩 -->
      <div class="vf-guide" :style="guideStyle">
        <div class="frame">
          <div v-for="i in 2" :key="'v' + i" class="third third-v" :style="{ left: i * 33.33 + '%' }" />
          <div v-for="i in 2" :key="'h' + i" class="third third-h" :style="{ top: i * 33.33 + '%' }" />
        </div>
      </div>

      <div class="top-bar">
        <span class="brand">FIMAGINA</span>
        <span class="mode" :class="{ on: hdrOn }">{{ hdrOn ? `HDRDN · ${hdrFrames}张曝光` : 'DIRECT' }}</span>
      </div>
    </div>

    <div class="dock" v-if="!showPreview">
      <div class="bar ratios">
        <button
          v-for="a in ASPECT_RATIOS"
          :key="a.id"
          :class="['chip', { active: aspectId === a.id }]"
          @click="aspectId = a.id; onAspectChange()"
        >
          {{ a.label }}
        </button>
      </div>

      <div class="bar luts">
        <button v-for="l in lutList" :key="l.id" :class="['lut-chip', { active: lutId === l.id }]" @click="lutId = l.id">
          <span class="swatch" :style="swatchStyle(l)" />
          <span class="lut-name">{{ l.name }}</span>
        </button>
        <button class="lut-chip import" @click="onImportLutClick">
          <span class="plus">+</span><span>导入</span>
        </button>
        <input ref="lutFileInput" type="file" accept=".cube" hidden @change="onLutFileChange" />
      </div>

      <div class="shutter-row">
        <button class="hdr-toggle" :class="{ on: hdrOn }" @click="toggleHdr">HDRDN</button>
        <button class="shutter" :class="{ capturing }" @click="capture" :disabled="capturing" />
        <button class="ghost-btn" @click="toggleHdr">{{ hdrFrames }}×</button>
      </div>
    </div>

    <transition name="fade">
      <div v-if="showPreview && shot" class="preview-panel" @click.stop>
        <img v-if="shot" :src="shot.canvas.toDataURL('image/jpeg', 0.9)" class="preview-img" />
        <div class="preview-meta">
          <span>{{ getAspect(activeAspect.id).label }} · {{ activeLut.name }}</span>
          <span class="dim">{{ shot.width }}×{{ shot.height }}</span>
        </div>
        <div class="preview-actions">
          <button class="btn close" @click="closePreview">完成</button>
          <button class="btn ghost" @click="redownload">保存</button>
        </div>
        <div v-if="shot.saveError" class="save-warn">
          <span>未能保存到相册{{ shot.saveError === 'STORAGE_PERMISSION_DENIED' ? '（缺少存储权限）' : '' }}</span>
          <button @click="openSystemSettings">去设置</button>
        </div>
      </div>
    </transition>

    <!-- 相机权限被拒 -->
    <div v-if="permDenied" class="perm-screen" @click.stop>
      <div class="perm-icon">✕</div>
      <p>相机权限被拒绝，无法使用取景器</p>
      <button class="btn close" @click="openSystemSettings">去设置开启</button>
    </div>

    <!-- 存储权限提示 -->
    <div v-if="storageWarn" class="storage-warn" @click.stop>
      <span>{{ storageWarn }}</span>
      <button @click="openSystemSettings">去设置</button>
    </div>

    <div v-if="errored" class="err">{{ errored }}</div>
  </div>
</template>

<style scoped>
.camera {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}

.viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
}
.feed {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.native-slot {
  position: absolute;
  inset: 0;
}

.vf-guide {
  position: absolute;
  z-index: 2;
}
.frame {
  position: relative;
  width: 100%;
  height: 100%;
  box-shadow: 0 0 0 2000px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.35);
}
.third {
  position: absolute;
  background: rgba(255, 255, 255, 0.14);
}
.third-v {
  top: 0;
  bottom: 0;
  width: 1px;
}
.third-h {
  left: 0;
  right: 0;
  height: 1px;
}

.top-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), transparent);
  padding-top: calc(14px + env(safe-area-inset-top));
  padding-right: calc(14px + env(safe-area-inset-right));
  padding-left: calc(14px + env(safe-area-inset-left));
  padding-bottom: 0;
  pointer-events: none;
}
.brand {
  letter-spacing: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #f2f2f4;
}
.mode {
  font-size: 11px;
  letter-spacing: 1px;
  color: #a6a6ad;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  padding: 3px 10px;
}
.mode.on {
  color: #000;
  background: var(--accent);
  border-color: var(--accent);
}

.dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  padding: 16px 12px calc(20px + env(safe-area-inset-bottom));
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.6), transparent);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bar {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px;
}
.bar::-webkit-scrollbar {
  display: none;
}
.chip {
  flex: none;
  font-size: 12px;
  color: #cfcfd6;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 13px;
  transition: 0.15s;
}
.chip.active {
  color: #000;
  background: #f2f2f4;
  border-color: #f2f2f4;
  font-weight: 600;
}

.lut-chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: #cfcfd6;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px 4px 5px;
}
.lut-chip.active {
  background: var(--panel-strong);
  border-color: var(--accent);
}
.lut-chip.import {
  border: 1px dashed rgba(255, 255, 255, 0.35);
  color: #e8e8ec;
}
.lut-chip.import .plus {
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}
.swatch {
  width: 26px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.shutter-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
}
.shutter {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  background: #fff;
  border: 4px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.18);
  position: relative;
  transition: transform 0.12s;
}
.shutter:active {
  transform: scale(0.92);
}
.shutter.capturing {
  background: var(--accent);
  animation: pulse 0.9s infinite;
}
@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(0.9);
  }
}
.hdr-toggle {
  font-size: 11px;
  letter-spacing: 1px;
  color: #a6a6ad;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  padding: 6px 11px;
}
.hdr-toggle.on {
  color: #000;
  background: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.ghost-btn {
  font-size: 12px;
  color: #cfcfd6;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--panel);
  border: 1px solid var(--border);
}

.preview-panel {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: #000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: calc(12px + env(safe-area-inset-top)) 12px calc(18px + env(safe-area-inset-bottom));
}
.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}
.preview-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: #e8e8ec;
}
.preview-meta .dim {
  color: #7c7c84;
}
.preview-actions {
  display: flex;
  gap: 14px;
}
.btn {
  font-size: 14px;
  border-radius: 999px;
  padding: 10px 34px;
}
.btn.close {
  background: var(--accent);
  color: #000;
  font-weight: 600;
}
.btn.ghost {
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: #f2f2f4;
}

.err {
  position: absolute;
  left: 50%;
  bottom: 8%;
  transform: translateX(-50%);
  z-index: 9;
  max-width: 80%;
  background: rgba(0, 0, 0, 0.8);
  color: #ff8f86;
  border: 1px solid #ff8f86;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  text-align: center;
}

/* 权限引导 */
.perm-screen {
  position: absolute;
  inset: 0;
  z-index: 8;
  background: #0a0a0c;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px;
  text-align: center;
  color: #e8e8ec;
  font-size: 14px;
}
.perm-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 2px solid #ff8f86;
  color: #ff8f86;
  font-size: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.storage-warn {
  position: absolute;
  top: calc(46px + env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.78);
  border: 1px solid rgba(255, 200, 100, 0.5);
  color: #ffd88f;
  border-radius: 999px;
  padding: 7px 8px 7px 14px;
  font-size: 11px;
  white-space: nowrap;
}
.storage-warn button {
  color: #000;
  background: #ffd88f;
  border: none;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 600;
}
.save-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #ffd88f;
}
.save-warn button {
  color: #000;
  background: #ffd88f;
  border: none;
  border-radius: 999px;
  padding: 4px 11px;
  font-size: 11px;
  font-weight: 600;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>