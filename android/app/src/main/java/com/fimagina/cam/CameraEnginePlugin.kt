package com.fimagina.cam

import android.Manifest
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
 * 桥接方法：
 *   requestCamera()                                   请求权限并启动原生取景
 *   stopPreview()                                     停止取景并释放相机
 *   setRatio({ ratio })                               更新取景窗口尺寸
 *   capture({ quality })                          -> { base64 }
 *   captureBurst({ frames, evStep, quality })     -> { base64s, evs }
 *   pick()                                        -> { uri, base64|null }  系统相册选图
 *   saveToGallery({ data, name })                 -> { uri }
 */
@CapacitorPlugin(
    name = "CameraEngine",
    permissions = [
        Permission(alias = "camera", strings = [Manifest.permission.CAMERA])
    ]
)
class CameraEnginePlugin : Plugin() {

    private var controller: CameraViewController? = null

    override fun handleOnDestroy() {
        controller?.stop()
        controller = null
        super.handleOnDestroy()
    }

    @PermissionCallback
    private fun cameraPermsCallback(call: PluginCall) {
        if (hasPermission("camera")) {
            startPreview()
            call.resolve()
        } else {
            call.reject("相机权限被拒绝")
        }
    }

    @PluginMethod
    fun requestCamera(call: PluginCall) {
        if (hasPermission("camera")) {
            startPreview()
            call.resolve()
        } else {
            requestPermissionForAlias("camera", call, "cameraPermsCallback")
        }
    }

    @PluginMethod
    fun stopPreview(call: PluginCall) {
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
        val data = call.getString("data") ?: run { call.reject("缺少 data"); return }
        val name = call.getString("name") ?: "fimagina.jpg"
        try {
            val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
            val dir = androidx.core.content.ContextCompat.getExternalFilesDir(context, null)
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

    private fun startPreview() {
        if (controller == null) {
            val activity = activity ?: return
            val webView = bridge?.webView
            if (webView !is WebView) return
            val host = webView.parent as? ViewGroup ?: return
            controller = CameraViewController(activity, context, host)
        }
        controller?.start { err ->
            if (err.isNotEmpty()) {
                android.util.Log.w("CameraEngine", err)
            }
        }
    }
}