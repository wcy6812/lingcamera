package com.fimagina.cam

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Rational
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject

/**
 * Camera2 取景 + 曝光包围控制器，作为原生面置于 WebView 背后（WebView 透明叠加 UI/比例框）。
 *
 * - start()      打开后置相机，SurfaceView 取景
 * - setRatio()   按比例居中 letterbox 取景窗（可被 WebView 比例框遮罩辅助）
 * - capture()    单帧 JPEG -> base64
 * - captureBurst(evs) 对目标连拍 N 张不同 EV 的 JPEG，曝光补偿按传入 ev 序列依次施加
 */
class CameraViewController(
    private val activity: Activity,
    @Suppress("unused") private var bridgeContext: Context,
    private val host: ViewGroup
) {

    private val context: Context get() = bridgeContext
    private val manager: CameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val mainHandler = Handler(activity.mainLooper)

    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var previewSurface: SurfaceView? = null
    private var imageReader: ImageReader? = null

    private var ratio: Float = 1.5f // 默认 3:2

    // ---- 生命周期 ----
    fun start(onError: (String) -> Unit) {
        val granted = ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            onError("CAMERA 权限未授权")
            return
        }
        ensureThread()
        ensureViewfinder()
        openCamera(onError)
    }

    fun stop() {
        closeCamera()
        host.post { previewSurface?.let { host.removeView(it) }; previewSurface = null }
    }

    fun setRatio(r: Float) {
        ratio = if (r in 0.2f..4f) r else 1.5f
        layoutViewfinder()
    }

    private fun ensureThread() {
        if (cameraThread == null) {
            cameraThread = HandlerThread("CameraBg").also { it.start() }
            cameraHandler = Handler(cameraThread!!.looper)
        }
    }

    // ---- 取景 ----
    private fun ensureViewfinder() {
        if (previewSurface != null) return
        val vf = SurfaceView(context)
        vf.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { openIfReady() }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) { openIfReady() }
            override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
        })
        host.post {
            vf.layoutParams = ViewGroup.LayoutParams(1, 1)
            host.addView(vf, 0) // 置于 WebView 之后
            previewSurface = vf
            layoutViewfinder()
            openIfReady()
        }
    }

    // 取景画面铺满 host（整屏），画面比例由 WebView 的比例引导框提示构图；
    // SurfaceView 始终填满 host 保证无黑边。
    private fun layoutViewfinder() {
        val vf = previewSurface ?: return
        host.post {
            val pw = host.width
            val ph = host.height
            if (pw > 0 && ph > 0) vf.layoutParams = ViewGroup.LayoutParams(pw, ph)
        }
    }

    private fun openIfReady() {
        val vf = previewSurface ?: return
        if (!vf.holder.isCreating && !vf.holder.surface.isValid) return
        if (cameraDevice == null) openCamera { /* 失败静默，等 start 处回调 */ }
        else createPreviewSession()
    }

    // ---- 打开/关闭相机 ----
    private fun openCamera(onError: (String) -> Unit) {
        val id = pickBackCamera() ?: run { onError("未找到后置摄像头"); return }
        try {
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    createPreviewSession()
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close(); cameraDevice = null }
                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close(); cameraDevice = null
                    mainHandler.post { onError("相机打开失败 err=$error") }
                }
            }, cameraHandler)
        } catch (e: Exception) {
            mainHandler.post { onError("无法打开相机: ${e.message}") }
        }
    }

    private fun pickBackCamera(): String? {
        for (id in manager.cameraIdList) {
            val ch = manager.getCameraCharacteristics(id)
            if (ch.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK) return id
        }
        return manager.cameraIdList.firstOrNull()
    }

    private fun createPreviewSession() {
        val device = cameraDevice ?: return
        val vf = previewSurface ?: return
        val surf = vf.holder.surface
        if (!surf.isValid) return
        val reader = ImageReader.newInstance(5120, 3840, ImageFormat.JPEG, 2)
        imageReader = reader

        try {
            device.createCaptureSession(
                listOf(surf, reader.surface),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (cameraDevice == null) return
                        captureSession = session
                        val b = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                            addTarget(surf)
                            set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                        }
                        session.setRepeatingRequest(b.build(), null, cameraHandler)
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) = Unit
                },
                cameraHandler
            )
        } catch (e: Exception) {
            // 取景 surface 未就绪时应等待回调，忽略
        }
    }

    private fun closeCamera() {
        captureSession?.close(); captureSession = null
        cameraDevice?.close(); cameraDevice = null
        imageReader?.close(); imageReader = null
        cameraThread?.quitSafely(); cameraThread = null; cameraHandler = null
    }

    // ---- 捕获 ----
    /** evs：以 0 为中心的 EV 偏移序列，如 [-1, 0, 1]。返回 base64s 与对应 evs。 */
    @Synchronized
    fun captureBurst(evs: List<Float>, quality: Int, onDone: (List<String>) -> Unit) {
        val device = cameraDevice
        val session = captureSession
        val reader = imageReader
        if (device == null || session == null || reader == null) { onDone(emptyList()); return }

        val chars = manager.getCameraCharacteristics(device.id)
        val compRange = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE) ?: android.util.Range(-6, 6)
        val step = (chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP) ?: Rational(1, 3)).toFloat()

        val requests = evs.map { ev ->
            device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.JPEG_QUALITY, quality.coerceIn(1, 100).toByte())
                set(CaptureRequest.JPEG_ORIENTATION, 90)
                if (ev != 0f) {
                    val units = (ev / step).toInt().coerceIn(compRange.lower, compRange.upper)
                    set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, units)
                }
            }.build()
        }

        val collected = mutableListOf<ByteArray>()
        val lock = Any()
        val listener = ImageReader.OnImageAvailableListener { ir ->
            var image: Image? = null
            try {
                image = ir.acquireNextImage() ?: return@OnImageAvailableListener
                val buffer = image!!.planes[0].buffer
                val bytes = ByteArray(buffer.remaining()); buffer.get(bytes)
                synchronized(lock) { collected.add(bytes) }
            } catch (e: Exception) {
                // 单帧失败忽略
            } finally { image?.close() }
        }
        reader.setOnImageAvailableListener(listener, cameraHandler)

        var completed = 0
        session.captureBurst(requests, object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(
                session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult
            ) {
                completed++
                if (completed >= requests.size) {
                    cameraHandler?.postDelayed({ deliver(lock, collected, onDone) }, 60)
                }
            }
        }, cameraHandler)

        // 兜底超时
        cameraHandler?.postDelayed({ deliver(lock, collected, onDone) }, 1600)
    }

    private fun deliver(lock: Any, collected: MutableList<ByteArray>, onDone: (List<String>) -> Unit) {
        val bytes: List<ByteArray>
        synchronized(lock) { bytes = collected.toList() }
        if (bytes.isNotEmpty()) {
            val b64s = bytes.map { Base64.encodeToString(it, Base64.NO_WRAP) }
            mainHandler.post { onDone(b64s) }
        }
    }
}