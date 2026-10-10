import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { decryptBackup, getBackupInfo, mergeBackup, restoreBackup, type BackupFilter } from "../src/utils/storage/backup";
import { pickBackupFile, saveBackupToPhone, shareBackupFile } from "../src/utils/storage/backup-file";
import { storage } from "@/src/utils/storage";
import * as SecureStore from "expo-secure-store";
import { queryClient } from "@/src/query-client";
import { useAuth } from "@/src/auth/AuthContext";
import { Segmented } from "@/src/components/Segmented";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { backupToGoogleDrive, connectGoogleAccount, disconnectGoogleAccount, getConnectedGoogleAccount, restoreLatestFromGoogleDrive, listGoogleDriveBackups, restoreGoogleDriveBackupById } from "@/src/utils/storage/google-drive";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";

 // Selective restore reads from the single complete Drive master snapshot.
 // Period restores merge only records belonging to that period and never wipe
 // unrelated months or years. Current stock quantities are not historical data.
 function filterBackupForPeriod(backup: any, type: "month" | "year", value: string) {
   const prefix = value.trim();
   const valid = type === "month" ? /^\d{4}-\d{2}$/.test(prefix) : /^\d{4}$/.test(prefix);
   if (!valid) throw new Error(type === "month" ? "Enter the month as YYYY-MM." : "Enter the year as YYYY.");
   const inPeriod = (row: any, ...fields: string[]) => fields.some((field) => String(row?.[field] ?? "").startsWith(prefix));
   const periodHistory = (backup.patientHistory || []).filter((row: any) => inPeriod(row, "created_at"));
   const historyPatientIds = new Set(periodHistory.map((row: any) => String(row.patient_id)));
   const patients = (backup.patients || []).filter((row: any) => inPeriod(row, "date") || historyPatientIds.has(String(row.id)));
   const patientIds = new Set(patients.map((row: any) => String(row.id)));
   return {
     ...backup,
     patients,
     patientImplants: (backup.patientImplants || []).filter((row: any) => patientIds.has(String(row.patient_id))),
     patientHistory: periodHistory.filter((row: any) => patientIds.has(String(row.patient_id))),
     expenses: (backup.expenses || []).filter((row: any) => inPeriod(row, "date", "created_at")),
     implantRecords: (backup.implantRecords || []).filter((row: any) => inPeriod(row, "created_at", "updated_at")),
     inventoryMovements: (backup.inventoryMovements || []).filter((row: any) => inPeriod(row, "created_at")),
     inventoryPurchaseReceipts: (backup.inventoryPurchaseReceipts || []).filter((row: any) => inPeriod(row, "added_date", "created_at")),
     stockReceipts: (backup.stockReceipts || []).filter((row: any) => inPeriod(row, "added_date", "created_at")),
     inventory: [],
     filter: { type, value: prefix },
     incremental: false,
     changedTables: undefined,
   };
 }

export default function BackupRestoreScreen() {
  const { user } = useAuth();
  const { colors, branding, setBranding, resetBranding } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [backupPassword, setBackupPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [backupFilter, setBackupFilter] = useState<BackupFilter>({ type: "all" });
  const [filterValue, setFilterValue] = useState("");
  const [restorePeriod, setRestorePeriod] = useState<"all" | "month" | "year">("all");
  const [restorePeriodValue, setRestorePeriodValue] = useState(new Date().toISOString().slice(0, 7));
  const [mode, setMode] = useState<"Merge (safe)" | "Replace">("Merge (safe)");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleCloudProjectId, setGoogleCloudProjectId] = useState("");
  const [googleConfigSaved, setGoogleConfigSaved] = useState(false);
  const [googleAccount, setGoogleAccount] = useState<string | null>(null);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveStatus, setDriveStatus] = useState("");
  const [driveBackups, setDriveBackups] = useState<Array<{id:string;name:string;modifiedTime:string;size?:string}>>([]);
  const [selectedBackup, setSelectedBackup] = useState<{
    name: string;
    backupText: string;
    info: { createdAt: string; encrypted: boolean };
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [clientId, projectId] = await Promise.all([
          SecureStore.getItemAsync("ortho_google_drive_client_id"),
          SecureStore.getItemAsync("ortho_google_drive_cloud_project_id"),
        ]);
        if (clientId) setGoogleClientId(clientId);
        if (projectId) setGoogleCloudProjectId(projectId);
        setGoogleConfigSaved(Boolean(clientId));
        setGoogleAccount(getConnectedGoogleAccount());
      } catch {
        // Configuration is optional and should never block local backup/restore.
      }
    })();
  }, []);

  const saveGoogleConfiguration = async () => {
    const clientId = googleClientId.trim();
    const projectId = googleCloudProjectId.trim();
    if (!clientId) {
      Alert.alert("Client ID required", "Enter the Google OAuth Client ID before saving.");
      return;
    }
    if (!clientId.endsWith(".apps.googleusercontent.com")) {
      Alert.alert("Invalid Client ID", "Enter a valid Google OAuth Client ID ending with .apps.googleusercontent.com.");
      return;
    }
    try {
      await SecureStore.setItemAsync("ortho_google_drive_client_id", clientId);
      if (projectId) {
        await SecureStore.setItemAsync("ortho_google_drive_cloud_project_id", projectId);
      } else {
        await SecureStore.deleteItemAsync("ortho_google_drive_cloud_project_id");
      }
      setGoogleConfigSaved(true);
      triggerAutomaticDriveBackup("appSettings");
      Alert.alert("Google configuration saved", "This configuration is stored on this phone and can be changed without rebuilding the APK.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Unable to save Google configuration.");
    }
  };

  const resetGoogleConfiguration = async () => {
    Alert.alert(
      "Reset Google configuration?",
      "This only removes the Google Drive configuration from this phone. Your patients, inventory, photos and existing phone backups are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            await SecureStore.deleteItemAsync("ortho_google_drive_client_id");
            await SecureStore.deleteItemAsync("ortho_google_drive_cloud_project_id");
            setGoogleClientId("");
            setGoogleCloudProjectId("");
            setGoogleConfigSaved(false);
            triggerAutomaticDriveBackup("appSettings");
          },
        },
      ],
    );
  };

  const handleConnectGoogle = async () => {
    try {
      setDriveLoading(true);
      setDriveStatus("Connecting Google account…");
      const email = await connectGoogleAccount();
      setGoogleAccount(email);
      triggerAutomaticDriveBackup();
      Alert.alert("Google account connected", "Google account connected. Automatic backup will start shortly.");
    } catch (error) {
      Alert.alert("Google connection failed", error instanceof Error ? error.message : "Unable to connect Google.");
    } finally {
      setDriveLoading(false);
      setDriveStatus("");
    }
  };

  const handleDisconnectGoogle = async () => {
    try {
      setDriveLoading(true);
      setDriveStatus("Disconnecting Google account…");
      await disconnectGoogleAccount();
      setGoogleAccount(null);
      Alert.alert("Google account disconnected", "This only signs Ortho Logbook out of Google on this phone. Your Drive backup and local app data are not deleted.");
    } catch (error) {
      Alert.alert("Disconnect failed", error instanceof Error ? error.message : "Unable to disconnect Google.");
    } finally {
      setDriveLoading(false);
    }
  };

  const handleDriveBackup = async () => {
    if (!googleAccount) {
      await handleConnectGoogle();
      return;
    }
    try {
      setDriveLoading(true);
      setDriveStatus("Preparing backup data…");
      // Drive uses one complete master snapshot; range selection is for local/file backups only.
      const result = await backupToGoogleDrive(undefined, { type: "all" }, { onProgress: setDriveStatus });
      const cleanupFailures = Array.isArray((result as any).cleanupFailures) ? (result as any).cleanupFailures : [];
      const migrationPending = (result as any).migrationPending === true;
      Alert.alert(
        migrationPending ? "Master backup saved — older files kept" : "Google Drive backup complete",
        "The single master backup was saved to " + googleAccount + "'s Google Drive." +
          (migrationPending
            ? "\nSome older backup files could not be fully merged, so they were kept for safety. Retry after checking those files."
            : cleanupFailures.length
              ? "\nOld duplicate backup files could not all be permanently deleted: " + cleanupFailures.join("; ")
              : "\nRedundant full/month/year and incremental backup files were permanently deleted after the merged master was verified.")
      );
    } catch (error) {
      Alert.alert("Drive backup failed", error instanceof Error ? error.message : "Unable to back up to Google Drive.");
    } finally {
      setDriveLoading(false);
      setDriveStatus("");
    }
  };

  const handleLoadDriveBackups = async () => {
    try {
      setDriveLoading(true);
      setDriveStatus("Finding the single master backup…");
      const files = await listGoogleDriveBackups();
      setDriveBackups(files);
      if (!files.length) Alert.alert("No master backup yet", "Tap Backup to Google Drive once to merge older month/year backups into one master file. Older files are kept unless every readable record is merged successfully.");
    } catch (error) {
      Alert.alert("Could not list backups", error instanceof Error ? error.message : "Unable to list Google Drive backups.");
    } finally {
      setDriveLoading(false);
      setDriveStatus("");
    }
  };

  const handleChooseDriveBackup = async (file: {id:string;name:string;modifiedTime:string}) => {
    try {
      setDriveLoading(true);
      setDriveStatus("Downloading master backup…");
      const result = await restoreGoogleDriveBackupById(file.id);
      const info = getBackupInfo(result.backupText);
      setSelectedBackup({ name: result.name, backupText: result.backupText, info });
      setRestorePassword("");
      setRestorePeriod("all");
      setRestorePeriodValue(new Date().toISOString().slice(0, 7));
      Alert.alert("Master backup selected", result.name + "\nUpdated: " + new Date(result.modifiedTime).toLocaleString() + "\nChoose all-time or a month/year to restore.");
    } catch (error) {
      Alert.alert("Selected backup failed", error instanceof Error ? error.message : "Unable to download this backup.");
    } finally {
      setDriveLoading(false);
      setDriveStatus("");
    }
  };

  const handleDriveRestore = async () => {
    try {
      setDriveLoading(true);
      setDriveStatus("Finding the latest master backup…");
      const result = await restoreLatestFromGoogleDrive();
      const info = getBackupInfo(result.backupText);
      setSelectedBackup({ name: result.name, backupText: result.backupText, info });
      setRestorePassword("");
      setRestorePeriod("all");
      setRestorePeriodValue(new Date().toISOString().slice(0, 7));
      Alert.alert("Master backup found", "Updated: " + new Date(result.modifiedTime).toLocaleString() + "\nChoose all-time or a month/year to restore.");
    } catch (error) {
      Alert.alert("Drive restore failed", error instanceof Error ? error.message : "Unable to download the latest Google Drive backup.");
    } finally {
      setDriveLoading(false);
    }
  };

  const handleSaveToPhone = async () => {
    if (backupPassword.length < 8) {
      Alert.alert("Password required", "Please enter a backup password with at least 8 characters.");
      return;
    }
    try {
      setLoading(true);
      await saveBackupToPhone(backupPassword, backupFilter);
      Alert.alert("Backup saved", "Your encrypted backup was saved to the folder you selected in the phone's File Manager.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Unable to save backup.");
    } finally {
      setLoading(false);
    }
  };

  const handleBackup = async () => {
    if (backupPassword.length < 8) {
      Alert.alert("Password required", "Please enter a backup password with at least 8 characters.");
      return;
    }
    try {
      setLoading(true);
      await shareBackupFile(backupPassword, backupFilter);
      Alert.alert(
        "Backup created",
        "Share the encrypted backup via WhatsApp, Bluetooth, Drive or email. On the receiving phone, use Sync & Backup → Import to merge it into the admin account.",
      );
    } catch (error) {
      Alert.alert("Backup failed", error instanceof Error ? error.message : "Unable to create backup.");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectBackup = async () => {
    try {
      setLoading(true);
      const result = await pickBackupFile();
      if (!result) return;
      setSelectedBackup({ name: result.name, backupText: result.backupText, info: result.info });
      setRestorePassword("");
    } catch (error) {
      Alert.alert("Invalid backup", error instanceof Error ? error.message : "The selected file is not a valid backup.");
    } finally {
      setLoading(false);
    }
  };

  const runRestore = async () => {
    if (!selectedBackup) return;
    if (selectedBackup.info.encrypted && restorePassword.length < 8) {
      Alert.alert("Password required", "Enter the password used when this encrypted backup was created.");
      return;
    }
    const isPeriodRestore = restorePeriod !== "all";
    if (isPeriodRestore && !(restorePeriod === "month" ? /^\d{4}-\d{2}$/.test(restorePeriodValue.trim()) : /^\d{4}$/.test(restorePeriodValue.trim()))) {
      Alert.alert("Choose a valid period", restorePeriod === "month" ? "Enter the month as YYYY-MM." : "Enter the year as YYYY.");
      return;
    }
    // Period restore is merge-only so other months/years are never wiped.
    const isReplace = !isPeriodRestore && mode === "Replace";
    const title = isPeriodRestore ? "Restore selected period?" : isReplace ? "Replace with backup?" : "Merge backup?";
    const message = isPeriodRestore
      ? "Merge records from " + (restorePeriod === "month" ? "month " : "year ") + restorePeriodValue.trim() + " into this phone. Other periods stay untouched; current stock quantities are not replayed."
      : isReplace
        ? "This wipes all current data and replaces it with the backup. You will be logged out."
        : "New records will be added. Re-importing the same backup will not add inventory again. Inventory from a different phone can be combined by item.";
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: isPeriodRestore ? "Restore Period" : isReplace ? "Replace" : "Merge",
        style: isReplace ? "destructive" : "default",
        onPress: async () => {
          try {
            setLoading(true);
            const completeBackup = await decryptBackup(selectedBackup.backupText, restorePassword);
            const backup = isPeriodRestore
              ? filterBackupForPeriod(completeBackup, restorePeriod as "month" | "year", restorePeriodValue)
              : completeBackup;
            if (isPeriodRestore && !backup.patients.length && !backup.expenses.length && !backup.patientHistory.length &&
                !backup.inventoryMovements.length && !backup.inventoryPurchaseReceipts.length && !backup.stockReceipts.length &&
                !backup.implantRecords.length) {
              Alert.alert("No records in this period", "The master backup contains no restorable records for this month/year.");
              return;
            }
            if (isReplace) {
              const result = await restoreBackup(backup);
              if (backup.branding && typeof backup.branding === "object") await setBranding(backup.branding);
              else if (backup.version >= 6 && backup.branding === null) await resetBranding();
              await storage.secureRemove("ortho_current_user");
              queryClient.clear();
              Alert.alert(
                "Restore complete",
                "Replaced with backup:\nPatients: " + result.patients + "\nInventory categories: " + (result.inventoryCategories || 0) +
                "\nInventory items: " + result.inventory + "\nPatient inventory records: " + (result.patientImplants || 0) +
                "\nProcedures: " + result.procedures + "\nUsers: " + result.users + "\n\nPlease log in again.",
                [{ text: "OK", onPress: () => router.replace("/login") }],
              );
            } else {
              const result = await mergeBackup(backup);
              if (!isPeriodRestore) {
                if (backup.branding && typeof backup.branding === "object") await setBranding(backup.branding);
                else if (backup.version >= 6 && backup.branding === null) await resetBranding();
              }
              queryClient.clear();
              Alert.alert(
                isPeriodRestore ? "Period restore complete" : "Merge complete",
                "Added:\nNew patients: " + result.patients + "\nInventory changes: " + result.inventory +
                "\nInventory categories: " + (result.inventoryCategories || 0) + "\nPatient inventory records: " + (result.patientImplants || 0) +
                "\nNew procedures: " + result.procedures + "\nNew users: " + result.users + "\nHistory entries: " + result.patientHistory,
              );
              setSelectedBackup(null);
              setRestorePassword("");
              setRestorePeriod("all");
            }
          } catch (error) {
            Alert.alert("Restore failed", error instanceof Error ? error.message : "Unable to restore the backup.");
          } finally {
            setLoading(false);
          }
        },
      },
    ]);
  };

  if (user?.role !== "admin") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Sync & Backup</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
          <Text style={styles.blockedSub}>Only the administrator can create or restore backups.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="backup-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Sync & Backup</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.tipCard}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>Multi-phone workflow (offline)</Text>
            <Text style={styles.tipText}>
              Each phone creates an encrypted backup and shares it (WhatsApp, Bluetooth, Wi-Fi share, Drive
              — anything). On the admin phone, tap Import and choose <Text style={styles.tipStrong}>Merge</Text>.
              Data from all phones combines in the admin account.
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Google Drive Configuration</Text>
          <Text style={styles.cardSub}>
            Enter the Google OAuth Client ID for this phone at runtime. Changing this value does not require a new APK build and does not affect your local Ortho Logbook data.
          </Text>
          <TextInput
            value={googleClientId}
            onChangeText={(v) => {
              setGoogleClientId(v);
              setGoogleConfigSaved(false);
            }}
            placeholder="Google OAuth Client ID"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            value={googleCloudProjectId}
            onChangeText={(v) => {
              setGoogleCloudProjectId(v);
              setGoogleConfigSaved(false);
            }}
            placeholder="Google Cloud Project ID (optional)"
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <Text style={styles.hint}>
            Each phone can store a different configuration. The APK package name and permanent signing certificate remain unchanged.
          </Text>
          {googleConfigSaved && (
            <Text style={styles.savedText}>✓ Google configuration saved on this phone</Text>
          )}
          <Pressable style={styles.primaryButton} onPress={saveGoogleConfiguration}>
            <Ionicons name="save-outline" size={18} color={colors.onBrandPrimary} />
            <Text style={styles.primaryText}>Save Google Configuration</Text>
          </Pressable>
          {googleConfigSaved && (
            <Pressable style={[styles.secondaryButton, { marginTop: spacing.sm }]} onPress={resetGoogleConfiguration}>
              <Ionicons name="refresh-outline" size={18} color={colors.onSurface} />
              <Text style={styles.secondaryText}>Reset Google Configuration</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Google Drive Backup</Text>
          <Text style={styles.cardSub}>
            Connect a Google account on this phone. Google Drive keeps one rolling master backup with compressed patient and bill photos. Choose all-time, month, or year after downloading it. Drive backups are unencrypted; phone/file backups remain encrypted.
          </Text>
          {googleAccount ? (
            <>
              <View style={styles.selectedBox}>
                <Text style={styles.selectedTitle}>Connected Google account</Text>
                <Text style={styles.fileName}>{googleAccount}</Text>
              </View>
              <Pressable
                style={[styles.primaryButton, driveLoading && styles.disabledButton, { marginTop: spacing.sm }]}
                onPress={handleDriveBackup}
                disabled={driveLoading}
              >
                {driveLoading ? <ActivityIndicator color={colors.onBrandPrimary} /> : (
                  <>
                    <Ionicons name="cloud-upload-outline" size={18} color={colors.onBrandPrimary} />
                    <Text style={styles.primaryText}>Backup to Google Drive</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, driveLoading && styles.disabledButton, { marginTop: spacing.sm }]}
                onPress={handleDriveRestore}
                disabled={driveLoading}
              >
                <Ionicons name="cloud-download-outline" size={18} color={colors.onSurface} />
                <Text style={styles.secondaryText}>Restore Latest from Google Drive</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, driveLoading && styles.disabledButton, { marginTop: spacing.sm }]}
                onPress={handleLoadDriveBackups}
                disabled={driveLoading}
              >
                <Ionicons name="list-outline" size={18} color={colors.onSurface} />
                <Text style={styles.secondaryText}>Select Master Backup for Period Restore</Text>
              </Pressable>
              {driveBackups.map((file) => (
                <Pressable
                  key={file.id}
                  style={[styles.selectedBox, { marginTop: spacing.xs }]}
                  onPress={() => handleChooseDriveBackup(file)}
                  disabled={driveLoading}
                >
                  <Text style={styles.selectedTitle}>{file.name}</Text>
                  <Text style={styles.fileInfo}>
                    {file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : "Drive backup"}
                    {file.size ? " · " + (Number(file.size) / (1024 * 1024)).toFixed(1) + " MB" : ""}
                  </Text>
                  <Text style={styles.hint}>Tap to download the master backup, then choose all-time, month, or year restore</Text>
                </Pressable>
              ))}
              <Pressable
                style={[styles.secondaryButton, driveLoading && styles.disabledButton, { marginTop: spacing.sm }]}
                onPress={handleDisconnectGoogle}
                disabled={driveLoading}
              >
                <Ionicons name="log-out-outline" size={18} color={colors.onSurface} />
                <Text style={styles.secondaryText}>Change Google Account</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[styles.primaryButton, driveLoading && styles.disabledButton]}
              onPress={handleConnectGoogle}
              disabled={driveLoading}
            >
              {driveLoading ? <ActivityIndicator color={colors.onBrandPrimary} /> : (
                <>
                  <Ionicons name="logo-google" size={18} color={colors.onBrandPrimary} />
                  <Text style={styles.primaryText}>Choose Google Account</Text>
                </>
              )}
            </Pressable>
          )}
          {driveLoading && (
            <Text style={[styles.hint, { marginTop: spacing.md, marginBottom: 0 }]} accessibilityLiveRegion="polite">
              {driveStatus || "Working with Google Drive…"}
            </Text>
          )}
          <Text style={[styles.hint, { marginTop: spacing.md, marginBottom: 0 }]}>
            The Android OAuth client is tied to this app's package/signing certificate; the Google account selected here determines whose Drive is used.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backup Range</Text>
          <Text style={styles.cardSub}>Choose the patient date range for manual Drive snapshots and encrypted phone backups. Google Drive keeps one rolling master backup. Patient photos are compressed in the backup; month/year restore filters this master without storing duplicate full copies.</Text>
          <Segmented
            options={["All", "Date", "Month", "Year"] as any}
            value={backupFilter.type === "all" ? "All" : backupFilter.type.charAt(0).toUpperCase() + backupFilter.type.slice(1)}
            onChange={(v) => {
              const map: any = { All: "all", Date: "date", Month: "month", Year: "year" };
              setBackupFilter({ type: map[v as string] });
              setFilterValue("");
            }}
            testIDPrefix="backup-range"
          />
          {backupFilter.type !== "all" && (
            <TextInput
              testID="backup-filter-value"
              value={filterValue}
              onChangeText={(v) => {
                setFilterValue(v);
                setBackupFilter((x) => ({ ...x, value: v }));
              }}
              placeholder={
                backupFilter.type === "date" ? "YYYY-MM-DD" :
                backupFilter.type === "month" ? "YYYY-MM" : "YYYY"
              }
              keyboardType="numbers-and-punctuation"
              placeholderTextColor={colors.muted}
              style={[styles.input, { marginTop: spacing.md }]}
            />
          )}
          {backupFilter.type !== "all" && (
            <Text style={styles.hint}>
              Date: one day only · Month: one month only · Year: one year only.
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Create Encrypted Backup</Text>
          <Text style={styles.cardSub}>
            All patients, inventory categories/items, patient inventory selections, procedures, expenses, users and history are encrypted before saving.
          </Text>
          <TextInput
            testID="backup-password-input"
            value={backupPassword}
            onChangeText={setBackupPassword}
            placeholder="Create backup password (min. 8 chars)"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <Text style={styles.hint}>
            Remember this password — it is required to restore or merge on any phone.
          </Text>
          <Pressable
            style={[styles.primaryButton, loading && styles.disabledButton]}
            onPress={handleBackup}
            disabled={loading}
            testID="backup-share-button"
          >
            {loading ? (
              <ActivityIndicator color={colors.onBrandPrimary} />
            ) : (
              <>
                <Ionicons name="share-outline" size={18} color={colors.onBrandPrimary} />
                <Text style={styles.primaryText}>Share Encrypted Backup</Text>
              </>
            )}
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, loading && styles.disabledButton, { marginTop: spacing.sm }]}
            onPress={handleSaveToPhone}
            disabled={loading}
            testID="backup-save-button"
          >
            {loading ? (
              <ActivityIndicator color={colors.onSurface} />
            ) : (
              <>
                <Ionicons name="download-outline" size={18} color={colors.onSurface} />
                <Text style={styles.secondaryText}>Save Backup to Phone</Text>
              </>
            )}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Backup</Text>
          <Text style={styles.cardSub}>Choose how to combine incoming data with your local database.</Text>
          <Segmented
            options={["Merge (safe)", "Replace"] as any}
            value={mode}
            onChange={(v) => setMode(v as any)}
            testIDPrefix="backup-mode"
          />
          <View style={{ height: spacing.md }} />

          <Pressable
            style={styles.secondaryButton}
            onPress={handleSelectBackup}
            disabled={loading}
            testID="backup-select-button"
          >
            <Ionicons name="folder-open-outline" size={18} color={colors.onSurface} />
            <Text style={styles.secondaryText}>Select Backup File</Text>
          </Pressable>

          {selectedBackup && (
            <View style={styles.selectedBox}>
              <Text style={styles.selectedTitle}>Selected master backup</Text>
              <Text style={styles.fileName}>{selectedBackup.name}</Text>
              <Text style={styles.fileInfo}>
                Created: {new Date(selectedBackup.info.createdAt).toLocaleString()}
              </Text>
              <Text style={[styles.hint, { marginTop: spacing.md }]}>Restore everything or select a period. Period restore merges records and does not delete other months/years.</Text>
              <Segmented
                options={["All Time", "Month", "Year"] as any}
                value={restorePeriod === "all" ? "All Time" : restorePeriod === "month" ? "Month" : "Year"}
                onChange={(v) => {
                  const next = v === "Month" ? "month" : v === "Year" ? "year" : "all";
                  setRestorePeriod(next as any);
                  setMode("Merge (safe)");
                  if (next === "month") setRestorePeriodValue((old) => /^\d{4}-\d{2}$/.test(old) ? old : new Date().toISOString().slice(0, 7));
                  if (next === "year") setRestorePeriodValue(new Date().toISOString().slice(0, 4));
                }}
                testIDPrefix="restore-period"
              />
              {restorePeriod !== "all" && (
                <TextInput
                  value={restorePeriodValue}
                  onChangeText={setRestorePeriodValue}
                  placeholder={restorePeriod === "month" ? "YYYY-MM" : "YYYY"}
                  keyboardType="numbers-and-punctuation"
                  placeholderTextColor={colors.muted}
                  style={[styles.input, { marginTop: spacing.sm }]}
                />
              )}
            </View>
          )}

          {selectedBackup && (
            <>
              <TextInput
                testID="restore-password-input"
                value={restorePassword}
                onChangeText={setRestorePassword}
                placeholder="Backup password"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              {mode === "Replace" ? (
                <Text style={styles.warning}>
                  Replace mode WIPES current data and installs the backup. Use only if this is a fresh device.
                </Text>
              ) : (
                <Text style={styles.merge}>
                  Merge mode adds only new records. The same backup can be imported repeatedly without duplicating inventory. Inventory from a different phone can be combined by item. Nothing is deleted.
                </Text>
              )}
              <Pressable
                style={[
                  mode === "Replace" ? styles.restoreButton : styles.primaryButton,
                  loading && styles.disabledButton,
                ]}
                onPress={runRestore}
                disabled={loading}
                testID="backup-run-button"
              >
                {loading ? (
                  <ActivityIndicator color={colors.onBrandPrimary} />
                ) : (
                  <Text style={styles.primaryText}>
                    {restorePeriod !== "all" ? "Restore Selected Period" : mode === "Replace" ? "Replace All Data" : "Merge Backup"}
                  </Text>
                )}
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.footerHint}>
          Everything stays on your device — {branding.title} is 100% offline.
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  tipCard: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.brandTertiary,
    marginBottom: spacing.lg,
  },
  tipTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.onBrandTertiary, marginBottom: 4 },
  tipText: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.onBrandTertiary, lineHeight: 20 },
  tipStrong: { fontFamily: fontFamily.bold },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginBottom: spacing.xs },
  cardSub: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.md, lineHeight: 20 },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  hint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginBottom: spacing.md },
  primaryButton: {
    minHeight: 50,
    borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  restoreButton: {
    minHeight: 50,
    borderRadius: radius.md,
    backgroundColor: colors.error,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  disabledButton: { opacity: 0.55 },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  secondaryButton: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  secondaryText: { color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  selectedBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selectedTitle: { fontSize: fontSize.xs, fontFamily: fontFamily.bold, color: colors.muted, textTransform: "uppercase", marginBottom: 4 },
  fileName: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  fileInfo: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 4 },
  warning: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.sm,
    color: colors.onWarning,
    backgroundColor: colors.warning,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  merge: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.sm,
    color: colors.onBrandTertiary,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  savedText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.success, marginBottom: spacing.md },
  footerHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, textAlign: "center", marginTop: spacing.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.xl },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.sm },
  blockedSub: { fontFamily: fontFamily.regular, fontSize: fontSize.base, color: colors.muted, textAlign: "center" },
}));
