package com.fimagina.cam

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * 原生相机插件：取景 + 曝光包围连拍。
 *
 * 权限说明：
 *   - 取景只需 CAMERA 权限，启动时单独请求（不再连携请求存储权限）。
 *   - 保存照片：Android 10+ 通过 MediaStore 写入，无需任何运行时存储权限；
 *     Android 9- 在保存时才按需申请 WRITE_EXTERNAL_STORAGE。
 * 相机被拒 -> reject(code = "CAMERA_PERMISSION_DENIED")，前端可引导用户去系统设置开启。
 *
 * 桥接方法：
 *   requestCamera() -> { storageGranted }              请求相机权限并启动原生取景
 *   openSettings()                                     打开应用系统设置页
 *   stopPreview()                                      停止取景并释放相机
 *   setRatio({ ratio })                                更新取景窗口尺寸
 *   capture({ quality })                          -> { base64 }
 *   captureBurst({ frames, evStep, quality })     -> { base64s, evs }
 *   pick()                                        -> { uri, base64|null }  系统相册选图
 *   saveToGallery({ data, name })                 -> { uri }
 */
@CapacitorPlugin(
    name = "CameraEngine",
    permissions = [
        Permission(alias = "camera", strings = [Manifest.permission.CAMERA]),
        Permission(
            alias = "storageLegacy",
            strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE]
        ),
        Permission(
            alias = "storage33",
            strings = [Manifest.permission.READ_MEDIA_IMAGES]
        )
    ]
)
class CameraEnginePlugin : Plugin() {

    private var controller: CameraViewController? = null

    override fun handleOnDestroy() {
        controller?.stop()
        controller = null
        super.handleOnDestroy()
    }

    // ---- 权限链：相机 -> 存储 -> 启动取景 ----

    @PluginMethod
    fun requestCamera(call: PluginCall) {
        // 取景仅需相机权限。保存照片在 Android 10+ 通过 MediaStore 写入，无需任何存储权限，
        // 因此这里不再串联请求 READ_MEDIA_IMAGES/WRITE_EXTERNAL_STORAGE。
        // （原先在同一 call 上连环请求相机+存储，正是“已授权却仍报拒绝/还要文件权限”的根因。）
        if (hasCameraPermission()) {
            startPreviewAndWait(call)
        } else {
            requestPermissionForAlias("camera", call, "cameraPermsCallback")
        }
    }

    @PermissionCallback
    private fun cameraPermsCallback(call: PluginCall) {
        if (hasCameraPermission()) {
            startPreviewAndWait(call)
        } else {
            call.reject(
                "相机权限被拒绝。请点击「去设置」手动开启相机权限后再试。",
                "CAMERA_PERMISSION_DENIED"
            )
        }
    }

    private var pendingOpen: PluginCall? = null

    /** 等相机会话真正就绪后再 resolve；打开失败则 reject，让前端区分处理 */
    private fun startPreviewAndWait(call: PluginCall) {
        if (!hasCameraPermission()) {
            call.reject("相机权限被拒绝或未授予。", "CAMERA_PERMISSION_DENIED")
            return
        }
        val ctl = ensureController()
        if (ctl == null) {
            call.reject("取景器初始化失败", "CAMERA_OPEN_FAILED")
            return
        }
        pendingOpen = call
        var settled = false
        ctl.onReady = {
            if (!settled) {
                settled = true
                resolvePending(JSObject().put("storageGranted", canSaveToGallery()))
            }
        }
        ctl.start { msg ->
            if (!settled) {
                settled = true
                rejectPending(msg, "CAMERA_OPEN_FAILED")
            }
        }
        // 兜底：3.5s 未就绪也返回，避免前端永久等待
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            if (!settled) {
                settled = true
                resolvePending(JSObject().put("storageGranted", canSaveToGallery()))
            }
        }, 3500)
    }

    private fun ensureController(): CameraViewController? {
        if (controller == null) {
            val act = activity ?: return null
            val webView = bridge?.webView
            if (webView !is WebView) return null
            val host = webView.parent as? ViewGroup ?: return null
            controller = CameraViewController(act, context, host)
        }
        return controller
    }

    private fun resolvePending(obj: JSObject) {
        pendingOpen?.let { c ->
            pendingOpen = null
            if (!c.isSaved) c.resolve(obj)
        }
    }

    private fun rejectPending(msg: String, code: String) {
        pendingOpen?.let { c ->
            pendingOpen = null
            if (!c.isSaved) c.reject(msg, code)
        }
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.reject("当前 Activity 不可用")
            return
        }
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + act.packageName)
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        act.startActivity(intent)
        call.resolve()
    }

    /** Android 10+ 通过 MediaStore 写入相册无需任何运行时存储权限；Android 9- 需要写权限 */
    private fun canSaveToGallery(): Boolean =
        Build.VERSION.SDK_INT > Build.VERSION_CODES.P || hasPermission("storageLegacy")

    private fun hasCameraPermission(): Boolean = hasPermission("camera")

    // ---- 相机控制 ----

    @PluginMethod
    fun stopPreview(call: PluginCall) {
        pendingOpen = null
        controller?.stop()
        controller = null
        call.resolve()
    }

    @PluginMethod
    fun setRatio(call: PluginCall) {
        val ratio = call.getDouble("ratio")?.toFloat() ?: 1.5f
        controller?.setRatio(ratio)
        call.resolve()
    }

    @PluginMethod
    fun capture(call: PluginCall) {
        val quality = call.getInt("quality") ?: 92
        burst(call, listOf(0f), quality)
    }

    @PluginMethod
    fun captureBurst(call: PluginCall) {
        val frames = call.getInt("frames")?.coerceIn(2, 7) ?: 3
        val evStep = call.getDouble("evStep")?.toFloat() ?: 1.0f
        val quality = call.getInt("quality") ?: 92
        val evs = buildEvs(frames, evStep)
        burst(call, evs, quality)
    }

    private fun burst(call: PluginCall, evs: List<Float>, quality: Int) {
        val ctl = controller ?: run { call.reject("相机未启动，请先调用 requestCamera"); return }
        ctl.captureBurst(evs, quality) { b64s ->
            if (b64s.isEmpty()) {
                call.reject("捕获失败")
            } else if (evs.size == 1) {
                call.resolve(JSObject().put("base64", b64s[0]))
            } else {
                val obj = JSObject()
                val arr = com.getcapacitor.JSArray()
                b64s.forEach { arr.put(it as Any) }
                obj.put("base64s", arr)
                val evArr = com.getcapacitor.JSArray()
                evs.take(b64s.size).forEach { evArr.put(it as Any) }
                obj.put("evs", evArr)
                call.resolve(obj)
            }
        }
    }

    private fun buildEvs(frames: Int, evStep: Float): List<Float> {
        if (frames <= 1) return listOf(0f)
        val evs = mutableListOf<Float>()
        val start = -(frames / 2)
        for (i in 0 until frames) evs.add(((start + i) * evStep))
        return evs
    }

    @PluginMethod
    fun pick(call: PluginCall) {
        call.reject("系统相册选图请使用 @capacitor/camera 或系统 Intent（可选实现）")
    }

    @PluginMethod
    fun saveToGallery(call: PluginCall) {
        // 仅 Android 9- 需要写权限；Android 10+ 通过 MediaStore 保存无需任何权限。
        // 需要时按需申请一次，授权后再写入（避免启动阶段就弹拍照/文件权限）。
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && !hasPermission("storageLegacy")) {
            requestPermissionForAlias("storageLegacy", call, "storageForSaveCallback")
            return
        }
        doSave(call)
    }

    @PermissionCallback
    private fun storageForSaveCallback(call: PluginCall) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && !hasPermission("storageLegacy")) {
            call.reject(
                "没有文件权限，无法保存照片。请到系统设置开启存储权限。",
                "STORAGE_PERMISSION_DENIED"
            )
            return
        }
        doSave(call)
    }

    /** 将 base64 JPEG 字节通过 MediaStore 写入系统相册 */
    private fun doSave(call: PluginCall) {
        val data = call.getString("data") ?: run { call.reject("缺少 data"); return }
        val name = call.getString("name") ?: "fimagina.jpg"
        try {
            val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
            val dir = context.getExternalFilesDir(null)
                ?: context.cacheDir
            val file = java.io.File(dir, name)
            file.writeBytes(bytes)
            // 通过 MediaStore 写入系统相册
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name)
                put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Fimagina")
                }
            }
            val uri = context.contentResolver.insert(
                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
            )
            if (uri != null) {
                context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                call.resolve(JSObject().put("uri", uri.toString()))
            } else {
                call.resolve(JSObject().put("uri", file.toURI().toString()))
            }
        } catch (e: Exception) {
            call.reject("保存失败: ${e.message}")
        }
    }
}