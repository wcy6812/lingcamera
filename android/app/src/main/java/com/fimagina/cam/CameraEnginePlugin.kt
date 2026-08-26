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
 * 权限链：先请求相机，通过后请求存储（写入相册需要）。
 *   - API <= 28  : WRITE_EXTERNAL_STORAGE
 *   - API >= 33  : READ_MEDIA_IMAGES
 *   - API 29-32  : MediaStore 写入无需存储权限
 * 相机被拒 -> reject(code = "CAMERA_PERMISSION_DENIED")，前端可引导用户去系统设置开启。
 *
 * 桥接方法：
 *   requestCamera() -> { storageGranted }              请求权限并启动原生取景
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
        if (hasPermission("camera")) {
            requestStorageThenStart(call)
        } else {
            requestPermissionForAlias("camera", call, "cameraPermsCallback")
        }
    }

    @PermissionCallback
    private fun cameraPermsCallback(call: PluginCall) {
        if (hasPermission("camera")) {
            requestStorageThenStart(call)
        } else {
            call.reject(
                "相机权限被拒绝。请点击「去设置」手动开启相机权限后再试。",
                "CAMERA_PERMISSION_DENIED"
            )
        }
    }

    /** 相机已授权 -> 继续请求存储（保存照片用），存储被拒不阻断取景 */
    private fun requestStorageThenStart(call: PluginCall) {
        val alias = storageAlias()
        if (alias == null || hasPermission(alias)) {
            startPreviewAndWait(call)
        } else {
            requestPermissionForAlias(alias, call, "storagePermsCallback")
        }
    }

    @PermissionCallback
    private fun storagePermsCallback(call: PluginCall) {
        // 存储被拒：相机照常可用，仅提示无法写入相册
        startPreviewAndWait(call)
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
                resolvePending(JSObject().put("storageGranted", hasStorageGranted()))
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
                resolvePending(JSObject().put("storageGranted", hasStorageGranted()))
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

    private fun storageAlias(): String? = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> "storage33" // READ_MEDIA_IMAGES
        Build.VERSION.SDK_INT <= Build.VERSION_CODES.P -> "storageLegacy"   // WRITE_EXTERNAL_STORAGE
        else -> null // API 29-32 MediaStore 写入无需权限
    }

    private fun hasStorageGranted(): Boolean {
        val alias = storageAlias() ?: return true
        return hasPermission(alias)
    }

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
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && !hasPermission("storageLegacy")) {
            call.reject(
                "没有文件权限，无法保存照片。请先授权存储权限或到系统设置开启。",
                "STORAGE_PERMISSION_DENIED"
            )
            return
        }
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