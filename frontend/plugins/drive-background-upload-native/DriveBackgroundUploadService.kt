package __PACKAGE__

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.content.pm.ServiceInfo
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class DriveBackgroundUploadService : Service() {
  companion object {
    const val ACTION_START = "ortho.drive.upload.START"
    const val EXTRA_TASK_ID = "taskId"
    const val EXTRA_URL = "url"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_FILE_URI = "fileUri"
    const val EXTRA_TOTAL_BYTES = "totalBytes"
    const val PREFS = "ortho_drive_background_upload"
    private const val CHANNEL = "ortho_drive_backup_upload"
    private const val NOTIFICATION_ID = 4872
    private const val CHUNK_SIZE = 512 * 1024
  }

  private lateinit var taskId: String
  private lateinit var uploadUrl: String
  private lateinit var token: String
  private lateinit var file: File
  private var total = 0L
  private val prefs by lazy { getSharedPreferences(PREFS, 0) }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_START) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: run { stopSelf(startId); return START_NOT_STICKY }
    uploadUrl = intent.getStringExtra(EXTRA_URL) ?: run { fail("Missing Drive upload session URL"); stopSelf(startId); return START_NOT_STICKY }
    token = intent.getStringExtra(EXTRA_TOKEN) ?: run { fail("Missing Google access token"); stopSelf(startId); return START_NOT_STICKY }
    val uri = Uri.parse(intent.getStringExtra(EXTRA_FILE_URI) ?: "")
    file = File(uri.path ?: "")
    total = intent.getLongExtra(EXTRA_TOTAL_BYTES, 0L)
    if (!file.isFile || total <= 0L || file.length() != total) {
      fail("Backup file is missing or its size changed before upload.")
      stopSelf(startId)
      return START_NOT_STICKY
    }
    ensureChannel()
    val notification = notification(0, "Starting Google Drive backup…")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    prefs.edit().putString("$taskId.status", "running").putInt("$taskId.progress", 0).apply()
    Thread {
      try {
        val result = uploadResumable()
        prefs.edit().putString("$taskId.status", "completed")
          .putString("$taskId.result", result.toString())
          .putInt("$taskId.progress", 100).apply()
        updateNotification(100, "Google Drive backup complete")
      } catch (error: Exception) {
        fail(error.message ?: "Google Drive background upload failed.")
        updateNotification(prefs.getInt("$taskId.progress", 0), "Backup failed — open Ortho Logbook to retry")
      } finally {
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
      }
    }.start()
    return START_NOT_STICKY
  }

  private fun uploadResumable(): JSONObject {
    var offset = 0L
    var failures = 0
    var stalls = 0
    var finalResult = JSONObject()
    RandomAccessFile(file, "r").use { input ->
      while (offset < total) {
        val endExclusive = minOf(offset + CHUNK_SIZE, total)
        try {
          val response = sendChunk(input, offset, endExclusive)
          failures = 0
          if (response.first in 200..299) {
            finalResult = parseJson(response.second)
            offset = total
            setProgress(100)
            break
          }
          if (response.first == 308) {
            val next = parseRange(response.third)
            if (next <= offset) {
              stalls++
              if (stalls >= 8) throw IllegalStateException("Google Drive has not confirmed upload progress. Retry on a stable connection.")
              val checked = queryOffset()
              if (checked.first) {
                finalResult = checked.second
                offset = total
              } else if (checked.third > offset) {
                offset = checked.third
                stalls = 0
              } else {
                Thread.sleep(1000L * stalls)
              }
            } else {
              offset = next
              stalls = 0
            }
            setProgress(((offset * 100) / total).toInt())
            continue
          }
          throw IllegalStateException("Google Drive rejected an upload chunk (HTTP ${response.first}): ${response.second.take(300)}")
        } catch (error: Exception) {
          failures++
          if (failures >= 12) throw IllegalStateException("Background upload could not recover after 12 network retries: ${error.message}. Check Wi-Fi/mobile data or Private DNS, then retry; local records are unchanged.")
          Thread.sleep(retryDelayMs(failures))
          val checked = try {
            queryOffset()
          } catch (statusError: Exception) {
            if (failures >= 12) {
              throw IllegalStateException("Google Drive progress could not be checked after 12 network retries: ${statusError.message}. Check Wi-Fi/mobile data or Private DNS, then retry; local records are unchanged.")
            }
            // Keep the current offset and retry the chunk after the next delay.
            continue
          }
          if (checked.first) {
            finalResult = checked.second
            offset = total
            break
          }
          if (checked.third in 0..total) offset = checked.third
          setProgress(((offset * 100) / total).toInt())
        }
      }
    }
    return finalResult
  }

  private fun sendChunk(input: RandomAccessFile, start: Long, endExclusive: Long): Triple<Int, String, String?> {
    val connection = URL(uploadUrl).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"
      connection.connectTimeout = 30000
      connection.readTimeout = 90000
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
      connection.setRequestProperty("Content-Range", "bytes $start-${endExclusive - 1}/$total")
      connection.setFixedLengthStreamingMode(endExclusive - start)
      input.seek(start)
      connection.outputStream.use { output ->
        val buffer = ByteArray(64 * 1024)
        var remaining = endExclusive - start
        while (remaining > 0) {
          val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
          if (count < 0) throw IllegalStateException("Backup file ended unexpectedly.")
          output.write(buffer, 0, count)
          remaining -= count
        }
      }
      val code = connection.responseCode
      val body = try {
        val stream = if (code >= 400) connection.errorStream else connection.inputStream
        stream?.bufferedReader()?.use { it.readText() } ?: ""
      } catch (_: Exception) { "" }
      return Triple(code, body, connection.getHeaderField("Range"))
    } finally {
      connection.disconnect()
    }
  }

  private fun queryOffset(): Triple<Boolean, JSONObject, Long> {
    val connection = URL(uploadUrl).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"
      connection.connectTimeout = 20000
      connection.readTimeout = 30000
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Content-Range", "bytes */$total")
      connection.setFixedLengthStreamingMode(0)
      connection.outputStream.use { }
      val code = connection.responseCode
      val body = try {
        val stream = if (code >= 400) connection.errorStream else connection.inputStream
        stream?.bufferedReader()?.use { it.readText() } ?: ""
      } catch (_: Exception) { "" }
      if (code in 200..299) return Triple(true, parseJson(body), total)
      if (code == 308) return Triple(false, JSONObject(), parseRange(connection.getHeaderField("Range")))
      throw IllegalStateException("Could not resume Drive upload (HTTP $code): ${body.take(200)}")
    } finally {
      connection.disconnect()
    }
  }

  // DNS/network interruptions on Android may last longer than a normal request timeout.
  // Keep the foreground service alive and back off for several minutes before failing.
  private fun retryDelayMs(attempt: Int): Long {
    val exponent = (attempt - 1).coerceIn(0, 4)
    return minOf(2000L * (1L shl exponent), 30000L)
  }

  private fun parseRange(range: String?): Long {
    val match = Regex("bytes=0-(\\d+)", RegexOption.IGNORE_CASE).find(range ?: "") ?: return 0L
    return (match.groupValues[1].toLongOrNull() ?: -1L) + 1L
  }

  private fun parseJson(body: String) = try { JSONObject(body) } catch (_: Exception) { JSONObject() }

  private fun setProgress(progress: Int) {
    val value = progress.coerceIn(0, 100)
    prefs.edit().putInt("$taskId.progress", value).apply()
    updateNotification(value, "Uploading backup to Google Drive… $value%")
  }

  private fun fail(message: String) {
    if (::taskId.isInitialized) prefs.edit().putString("$taskId.status", "error").putString("$taskId.error", message).apply()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Google Drive backup", NotificationManager.IMPORTANCE_LOW))
    }
  }

  private fun notification(progress: Int, message: String): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    builder.setContentTitle("Ortho Logbook")
      .setContentText(message)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(progress < 100)
    if (progress in 1..99) builder.setProgress(100, progress, false)
    return builder.build()
  }

  private fun updateNotification(progress: Int, message: String) {
    val manager = getSystemService(NotificationManager::class.java)
    manager.notify(NOTIFICATION_ID, notification(progress, message))
  }
}
