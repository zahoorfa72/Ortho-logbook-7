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
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class DriveBackgroundUploadService : Service() {
  companion object {
    const val ACTION_START = "ortho.drive.upload.START"
    const val ACTION_DOWNLOAD = "ortho.drive.download.START"
    const val EXTRA_TASK_ID = "taskId"
    const val EXTRA_URL = "url"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_FILE_URI = "fileUri"
    const val EXTRA_TOTAL_BYTES = "totalBytes"
    const val PREFS = "ortho_drive_background_upload"
    private const val CHANNEL = "ortho_drive_backup_upload"
    private const val NOTIFICATION_ID = 4872
    private const val CHUNK_SIZE = 2 * 1024 * 1024
  }

  private lateinit var taskId: String
  private lateinit var uploadUrl: String
  private lateinit var token: String
  private lateinit var file: File
  private var total = 0L
  private val prefs by lazy { getSharedPreferences(PREFS, 0) }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Android may recreate a foreground service after reclaiming the app process.
    // Rehydrate an active download from private preferences so the partial file
    // can resume rather than leaving a dead "running" task behind.
    val command = intent ?: run {
      val savedTask = prefs.getString("activeDownloadTaskId", null)
      if (savedTask.isNullOrBlank()) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
      Intent(this, DriveBackgroundUploadService::class.java).apply {
        action = ACTION_DOWNLOAD
        putExtra(EXTRA_TASK_ID, savedTask)
        putExtra(EXTRA_URL, prefs.getString("$savedTask.url", ""))
        putExtra(EXTRA_TOKEN, prefs.getString("$savedTask.token", ""))
        putExtra(EXTRA_FILE_URI, prefs.getString("$savedTask.fileUri", ""))
      }
    }
    if (command.action != ACTION_START && command.action != ACTION_DOWNLOAD) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    taskId = command.getStringExtra(EXTRA_TASK_ID) ?: run { stopSelf(startId); return START_NOT_STICKY }
    if (command.action == ACTION_DOWNLOAD) {
      startBackgroundDownload(command, startId)
      return START_STICKY
    }
    uploadUrl = command.getStringExtra(EXTRA_URL) ?: run { fail("Missing Drive upload session URL"); stopSelf(startId); return START_NOT_STICKY }
    token = command.getStringExtra(EXTRA_TOKEN) ?: run { fail("Missing Google access token"); stopSelf(startId); return START_NOT_STICKY }
    val uri = Uri.parse(command.getStringExtra(EXTRA_FILE_URI) ?: "")
    file = File(uri.path ?: "")
    total = command.getLongExtra(EXTRA_TOTAL_BYTES, 0L)
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
    prefs.edit().putString("$taskId.status", "running").putInt("$taskId.progress", 0)
      .putLong("$taskId.uploadedBytes", 0L).apply()
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


  private fun startBackgroundDownload(intent: Intent, startId: Int) {
    uploadUrl = intent.getStringExtra(EXTRA_URL) ?: run { fail("Missing Google Drive download URL"); stopSelf(startId); return }
    token = intent.getStringExtra(EXTRA_TOKEN) ?: run { fail("Missing Google access token"); stopSelf(startId); return }
    val uri = Uri.parse(intent.getStringExtra(EXTRA_FILE_URI) ?: "")
    file = File(uri.path ?: "")
    file.parentFile?.mkdirs()
    // Persist enough private task state for Android to restart this foreground
    // service if the app process is reclaimed during a long restore.
    prefs.edit()
      .putString("activeDownloadTaskId", taskId)
      .putString("$taskId.url", uploadUrl)
      .putString("$taskId.token", token)
      .putString("$taskId.fileUri", uri.toString())
      .putString("$taskId.status", "running")
      .apply()
    ensureChannel()
    val notification = notification(0, "Downloading Ortho Logbook backup…")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    Thread {
      try {
        downloadToFile()
        prefs.edit().putString("$taskId.status", "completed").putInt("$taskId.progress", 100).apply()
        updateNotification(100, "Ortho Logbook backup downloaded")
      } catch (error: Exception) {
        fail(error.message ?: "Google Drive background download failed.")
        updateNotification(prefs.getInt("$taskId.progress", 0), "Download failed — open Ortho Logbook to retry")
      } finally {
        prefs.edit().remove("activeDownloadTaskId").remove("$taskId.token").apply()
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
      }
    }.start()
  }

  private fun downloadToFile() {
    var failures = 0
    var lastError: Exception? = null
    // Large medical backups may be downloading over unstable mobile data.
    // Keep retrying for longer and retain all bytes already written.
    while (failures < 30) {
      val existingBytes = if (file.isFile) file.length().coerceAtLeast(0L) else 0L
      val connection = URL(uploadUrl).openConnection() as HttpURLConnection
      try {
        connection.requestMethod = "GET"
        connection.connectTimeout = 30000
        connection.readTimeout = 180000
        connection.setRequestProperty("Authorization", "Bearer " + token)
        if (existingBytes > 0L) connection.setRequestProperty("Range", "bytes=" + existingBytes + "-")
        val code = connection.responseCode
        if (code == 401 || code == 403) {
          val detail = try { connection.errorStream?.bufferedReader()?.use { it.readText() } ?: "" } catch (_: Exception) { "" }
          throw IllegalStateException("Google Drive authorization failed (HTTP " + code + "). Reconnect Google Drive, then retry. " + detail.take(160))
        }
        if (code == 416 && existingBytes > 0L) {
          // Some servers answer Range Not Satisfiable when the previous attempt
          // actually received the last byte but died before marking completion.
          // Verify against the advertised total, if available, before accepting.
          val contentRange = connection.getHeaderField("Content-Range") ?: ""
          val unsatisfied = Regex("bytes\\s+\\*/(\\d+)", RegexOption.IGNORE_CASE).find(contentRange)
          val expected = unsatisfied?.groupValues?.get(1)?.toLongOrNull() ?: 0L
          if (expected > 0L && file.length() == expected) {
            prefs.edit().putLong("$taskId.uploadedBytes", file.length()).putLong("$taskId.totalBytes", expected).apply()
            return
          }
          file.delete()
          throw IllegalStateException("Google Drive could not resume this partial file; restarting safely from byte zero.")
        }
        if (code !in 200..299) {
          val detail = try { connection.errorStream?.bufferedReader()?.use { it.readText() } ?: "" } catch (_: Exception) { "" }
          throw IllegalStateException("Google Drive download failed (HTTP " + code + "): " + detail.take(240))
        }
        val append = code == 206 && existingBytes > 0L
        val rangeHeader = connection.getHeaderField("Content-Range") ?: ""
        val rangeMatch = Regex("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)", RegexOption.IGNORE_CASE).find(rangeHeader)
        if (append && rangeMatch != null && rangeMatch.groupValues[1].toLong() != existingBytes) {
          file.delete()
          throw IllegalStateException("Google Drive resumed at an unexpected byte offset; restarting from byte zero.")
        }
        // If the server ignores Range and returns 200, restart from byte zero
        // instead of appending a duplicate copy to the partial backup.
        val writeAppend = append && (rangeMatch == null || rangeMatch.groupValues[1].toLong() == existingBytes)
        if (existingBytes > 0L && code == 206 && !writeAppend) {
          file.delete()
          throw IllegalStateException("Google Drive returned an invalid resume offset; restarting safely from byte zero.")
        }
        val rangeTotal = if (rangeMatch != null && rangeMatch.groupValues[3] != "*") rangeMatch.groupValues[3].toLongOrNull() ?: 0L else 0L
        val contentLength = connection.contentLengthLong.coerceAtLeast(0L)
        val totalBytes = if (rangeTotal > 0L) rangeTotal else if (writeAppend) existingBytes + contentLength else contentLength
        prefs.edit().putLong("$taskId.totalBytes", totalBytes).apply()
        var received = if (writeAppend) existingBytes else 0L
        connection.inputStream.buffered().use { input ->
          FileOutputStream(file, writeAppend).buffered().use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
              received += count
              val percent = if (totalBytes > 0L) ((received * 100L) / totalBytes).toInt().coerceIn(0, 99) else 0
              prefs.edit().putInt("$taskId.progress", percent).putLong("$taskId.uploadedBytes", received).apply()
              val message = if (totalBytes > 0L) "Downloading backup… " + String.format(java.util.Locale.US, "%.1f", received.toDouble() * 100.0 / totalBytes.toDouble()) + "%"
                else "Downloading backup… " + String.format(java.util.Locale.US, "%.1f", received.toDouble() / 1048576.0) + " MB"
              updateNotification(percent, message)
            }
            output.flush()
          }
        }
        if (!file.isFile || file.length() == 0L || (totalBytes > 0L && file.length() != totalBytes)) {
          throw IllegalStateException("Downloaded backup is incomplete (" + file.length() + " of " + totalBytes + " bytes); resuming automatically.")
        }
        prefs.edit().putLong("$taskId.uploadedBytes", file.length()).putLong("$taskId.totalBytes", totalBytes).apply()
        return
      } catch (error: Exception) {
        lastError = error
        val message = error.message ?: ""
        if (message.contains("authorization failed") || message.contains("HTTP 401") || message.contains("HTTP 403")) throw error
        failures += 1
        if (failures >= 30) break
        val delay = minOf(2000L * (1L shl (failures - 1).coerceIn(0, 4)), 60000L)
        updateNotification(prefs.getInt("$taskId.progress", 0), "Connection interrupted; resuming backup download (" + failures + "/30)…")
        try { Thread.sleep(delay) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); throw IllegalStateException("Background backup download was interrupted.") }
      } finally {
        connection.disconnect()
      }
    }
    throw IllegalStateException("Background backup download paused after 30 retries: " + (lastError?.message ?: "network unavailable") + ". Your partial file is kept; retrying will continue from the saved bytes.")
  }

  private fun uploadResumable(): JSONObject {
    var offset = 0L
    var failures = 0
    var stalls = 0
    var finalResult = JSONObject()
    // Always reconcile with Drive before sending bytes. This is essential after
    // a token refresh or Android restarting the foreground upload service.
    val initialStatus = queryOffset()
    if (initialStatus.first) {
      finalResult = initialStatus.second
      offset = total
    } else {
      offset = initialStatus.third.coerceIn(0L, total)
    }
    if (offset >= total && finalResult.length() > 0) return finalResult
    RandomAccessFile(file, "r").use { input ->
      while (offset < total) {
        val endExclusive = minOf(offset + CHUNK_SIZE, total)
        try {
          val response = sendChunk(input, offset, endExclusive)
          if (response.first == 401) {
            throw IllegalStateException("Google Drive authorization expired (HTTP 401). The upload can resume after token refresh.")
          }
          failures = 0
          if (response.first in 200..299) {
            finalResult = parseJson(response.second)
            offset = total
            setProgress(100, total)
            break
          }
          if (response.first == 308) {
            val next = parseRange(response.third)
            if (next >= total) {
              // A 308 must not silently end the loop at 100% bytes without
              // Drive confirming that the file was finalized. Query the
              // resumable session before deciding the upload is complete.
              val checked = queryOffset()
              if (checked.first) {
                finalResult = checked.second
                offset = total
                setProgress(100, total)
                break
              }
              if (checked.third >= total) {
                // A 308 with the complete byte range is not a completed upload.
                // Re-send the final chunk to prompt Drive to finalize the session;
                // otherwise offset would become total and the loop would exit at 99%.
                stalls++
                if (stalls >= 8) {
                  throw IllegalStateException("Google Drive received all backup bytes but did not finalize the file after repeated final-chunk retries. Local records are unchanged; retry on a stable connection.")
                }
                Thread.sleep(1000L * stalls)
                offset = maxOf(0L, total - CHUNK_SIZE)
                setProgress(((offset * 100) / total).toInt(), offset)
                continue
              }
              offset = checked.third.coerceIn(0L, total)
              stalls = 0
            } else if (next <= offset) {
              stalls++
              if (stalls >= 8) throw IllegalStateException("Google Drive has not confirmed upload progress. Retry on a stable connection.")
              val checked = queryOffset()
              if (checked.first) {
                finalResult = checked.second
                offset = total
                setProgress(100, total)
                break
              } else if (checked.third > offset && checked.third < total) {
                offset = checked.third
                stalls = 0
              } else {
                Thread.sleep(1000L * stalls)
              }
            } else {
              offset = next
              stalls = 0
            }
            setProgress(((offset * 100) / total).toInt(), offset)
            continue
          }
          throw IllegalStateException("Google Drive rejected an upload chunk (HTTP ${response.first}): ${response.second.take(300)}")
        } catch (error: Exception) {
          if (error.message?.contains("HTTP 401") == true || error.message?.contains("authorization expired", ignoreCase = true) == true) {
            throw error
          }
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
          setProgress(((offset * 100) / total).toInt(), offset)
        }
      }
    }
    if (offset < total || finalResult.length() == 0) {
      // Do not report a completed task merely because the byte offset reached
      // the end. Google Drive must return the final file metadata.
      throw IllegalStateException("Google Drive upload reached the end of the file but did not confirm completion. Retry the backup; local records are unchanged.")
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

  private fun setProgress(progress: Int, uploadedBytes: Long) {
    val value = progress.coerceIn(0, 100)
    val bytes = uploadedBytes.coerceIn(0L, total)
    // Persist the acknowledged byte offset even when the whole-number percent
    // has not changed; the UI and stall watchdog use this for large backups.
    prefs.edit().putInt("$taskId.progress", value).putLong("$taskId.uploadedBytes", bytes).apply()
    val precisePercent = if (total > 0L) (bytes.toDouble() * 100.0 / total.toDouble()) else value.toDouble()
    updateNotification(value, "Uploading backup to Google Drive… " + String.format(java.util.Locale.US, "%.1f", precisePercent) + "%")
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
