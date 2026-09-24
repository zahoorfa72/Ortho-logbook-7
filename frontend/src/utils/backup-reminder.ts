import { storage } from "@/src/utils/storage";

const LAST_BACKUP_KEY = "ortho_last_backup_iso";
const REMINDER_DISMISSED_KEY = "ortho_backup_reminder_dismissed_date";

// Evening cutoff: we start reminding from 6 PM local time.
const EVENING_HOUR = 18;

const todayLocalDate = (d = new Date()) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export async function markBackupTaken(): Promise<void> {
  await storage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
}

export async function getLastBackupIso(): Promise<string | null> {
  const raw = await storage.getItem<string>(LAST_BACKUP_KEY, "");
  return typeof raw === "string" && raw ? raw : null;
}

export async function dismissReminderForToday(): Promise<void> {
  await storage.setItem(REMINDER_DISMISSED_KEY, todayLocalDate());
}

export type ReminderState = {
  show: boolean;
  lastBackupIso: string | null;
  reason: "never" | "stale-day" | null;
};

// Rule:
// - Only remind admins (caller checks role).
// - Only after 6 PM local time.
// - Skip if a backup was taken today (local date).
// - Skip if the reminder was dismissed today (local date).
export async function evaluateReminder(now = new Date()): Promise<ReminderState> {
  const today = todayLocalDate(now);
  const dismissed = await storage.getItem<string>(REMINDER_DISMISSED_KEY, "");
  if (dismissed === today) return { show: false, lastBackupIso: null, reason: null };
  if (now.getHours() < EVENING_HOUR) return { show: false, lastBackupIso: null, reason: null };
  const last = await getLastBackupIso();
  if (!last) return { show: true, lastBackupIso: null, reason: "never" };
  const lastDate = todayLocalDate(new Date(last));
  if (lastDate === today) return { show: false, lastBackupIso: last, reason: null };
  return { show: true, lastBackupIso: last, reason: "stale-day" };
}
