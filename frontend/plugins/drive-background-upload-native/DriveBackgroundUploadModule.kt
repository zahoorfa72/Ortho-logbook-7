package __PACKAGE__

import android.content.Intent
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class DriveBackgroundUploadModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  override fun getName() = "DriveBackgroundUpload"

  @ReactMethod
  fun writeTextChunk(fileUri: String, text: String, append: Boolean, promise: Promise) {
    try {
      val uri = Uri.parse(fileUri)
      val path = uri.path ?: throw IllegalArgumentException("Backup file path is invalid.")
      val file = File(path)
      file.parentFile?.mkdirs()
      FileOutputStream(file, append).use { stream ->
        stream.write(text.toByteArray(Charsets.UTF_8))
        stream.flush()
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("DRIVE_BACKUP_STAGE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun startUpload(url: String, token: String, fileUri: String, totalBytes: Double, promise: Promise) {
    try {
      val taskId = java.util.UUID.randomUUID().toString()
      val intent = Intent(context, DriveBackgroundUploadService::class.java).apply {
        action = DriveBackgroundUploadService.ACTION_START
        putExtra(DriveBackgroundUploadService.EXTRA_TASK_ID, taskId)
        putExtra(DriveBackgroundUploadService.EXTRA_URL, url)
        putExtra(DriveBackgroundUploadService.EXTRA_TOKEN, token)
        putExtra(DriveBackgroundUploadService.EXTRA_FILE_URI, fileUri)
        putExtra(DriveBackgroundUploadService.EXTRA_TOTAL_BYTES, totalBytes.toLong())
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      promise.resolve(taskId)
    } catch (error: Exception) {
      promise.reject("DRIVE_UPLOAD_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getStatus(taskId: String, promise: Promise) {
    try {
      val prefs = context.getSharedPreferences(DriveBackgroundUploadService.PREFS, 0)
      val map = Arguments.createMap()
      map.putString("status", prefs.getString("$taskId.status", "running"))
      map.putInt("progress", prefs.getInt("$taskId.progress", 0))
      map.putDouble("uploadedBytes", prefs.getLong("$taskId.uploadedBytes", 0L).toDouble())
      map.putString("result", prefs.getString("$taskId.result", ""))
      map.putString("error", prefs.getString("$taskId.error", ""))
      promise.resolve(map)
    } catch (error: Exception) {
      promise.reject("DRIVE_UPLOAD_STATUS_FAILED", error.message, error)
    }
  }
}
