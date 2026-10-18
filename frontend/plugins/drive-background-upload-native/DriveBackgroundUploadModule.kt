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

  // Stream large restore files with a persistent reader instead of allocating
  // a second full-size Java String in the Expo file-system bridge.
  private val textReaders = java.util.concurrent.ConcurrentHashMap<String, java.io.BufferedReader>()

  @ReactMethod
  fun openTextReader(fileUri: String, promise: Promise) {
    try {
      val uri = Uri.parse(fileUri)
      val path = uri.path ?: throw IllegalArgumentException("Backup file path is invalid.")
      val file = File(path)
      if (!file.isFile) throw IllegalStateException("Downloaded backup file is missing.")
      val id = java.util.UUID.randomUUID().toString()
      textReaders[id] = file.inputStream().bufferedReader(Charsets.UTF_8)
      promise.resolve(id)
    } catch (error: Exception) {
      promise.reject("DRIVE_BACKUP_READ_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun readTextChunk(readerId: String, maxChars: Int, promise: Promise) {
    try {
      val reader = textReaders[readerId] ?: throw IllegalStateException("Backup reader is no longer available.")
      val buffer = CharArray(maxChars.coerceIn(16384, 262144))
      val count = reader.read(buffer)
      val map = Arguments.createMap()
      if (count < 0) {
        textReaders.remove(readerId)?.close()
        map.putString("text", "")
        map.putBoolean("done", true)
      } else {
        map.putString("text", String(buffer, 0, count))
        map.putBoolean("done", false)
      }
      promise.resolve(map)
    } catch (error: Exception) {
      textReaders.remove(readerId)?.runCatching { close() }
      promise.reject("DRIVE_BACKUP_READ_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun closeTextReader(readerId: String, promise: Promise) {
    try {
      textReaders.remove(readerId)?.close()
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("DRIVE_BACKUP_READ_FAILED", error.message, error)
    }
  }

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
  fun startDownload(url: String, token: String, fileUri: String, promise: Promise) {
    try {
      val taskId = java.util.UUID.randomUUID().toString()
      val intent = Intent(context, DriveBackgroundUploadService::class.java).apply {
        action = DriveBackgroundUploadService.ACTION_DOWNLOAD
        putExtra(DriveBackgroundUploadService.EXTRA_TASK_ID, taskId)
        putExtra(DriveBackgroundUploadService.EXTRA_URL, url)
        putExtra(DriveBackgroundUploadService.EXTRA_TOKEN, token)
        putExtra(DriveBackgroundUploadService.EXTRA_FILE_URI, fileUri)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      promise.resolve(taskId)
    } catch (error: Exception) {
      promise.reject("DRIVE_DOWNLOAD_START_FAILED", error.message, error)
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
      map.putDouble("totalBytes", prefs.getLong("$taskId.totalBytes", 0L).toDouble())
      map.putString("result", prefs.getString("$taskId.result", ""))
      map.putString("error", prefs.getString("$taskId.error", ""))
      promise.resolve(map)
    } catch (error: Exception) {
      promise.reject("DRIVE_UPLOAD_STATUS_FAILED", error.message, error)
    }
  }
}
