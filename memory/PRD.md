# Ortho Logbook — Product Requirements

## What this app is
A 100% offline mobile app (Expo/React Native) that lets an orthopaedic clinic keep a patient logbook, track implant inventory, and produce printable reports. All data stays on the device in a local SQLite database — no cloud, no internet required.

## Key features

### Patient logbook
- Add / edit / delete patients with photos (multi-photo, no cropping).
- Search by name, MR number, diagnosis, procedure or implant.
- **Duplicate patient tracking**: if a record with the same Name + MR Number already exists, the new record is still added but is automatically labelled as "2nd time operated", "3rd time operated", etc. The badge appears on the list, the patient form, and inside the PDF export.
- Per-record photo strip, diagnosis, procedure, implants, address and edit history.
- **Type-ahead autocomplete (Sep 24, 2026)**: Procedure, Implant and Implant II fields in the patient form show near-match suggestions after typing 1+ letters (prefix matches ranked first). Tap a suggestion to autofill. Procedure suggestions come from the procedure catalogue + past patient records; implant suggestions come from inventory (with live stock count shown). Each field has a one-tap clear button. The suggestion list renders inline below the input (an absolute overlay with dynamic zIndex caused an Android focus/scroll jump mid-typing — fixed same day).

### Inventory
- Track implants with quantity, unit, minimum stock.
- Quick +/- buttons, plus a full **edit / delete** modal (admin only).
- Movement history for each item.
- "Low Stock" filter.

### Statistics
- Total surgeries per month/year.
- Procedure breakdown with visual bars.

### PDF exports (admin only)
Three one-tap PDFs, each stamped with the current app title and logo:
1. **Patient List** — includes duplicate ordinal badges.
2. **Statistics** — for the chosen month/year.
3. **Inventory / Low Stock** — full inventory or only low-stock items.

### Branding (admin only)
Fully customizable, saved on the device:
- App title (used across the app and PDFs).
- Logo image (used on login, and in PDF headers).
- Full colour theme — primary, secondary, tertiary, background, surface, text, muted text — with 5 built-in presets and a hex-code editor.

### Multi-phone workflow (offline)
- Each phone can export an encrypted backup file (`XSalsa20-Poly1305`, password-protected).
- Share via WhatsApp / Bluetooth / Wi-Fi share / Drive — anything that moves a file between phones.
- On the admin phone, choose **Merge** mode to combine incoming data (skips duplicates by ID, sums inventory by name). Or **Replace** for a full wipe-and-install.
- Everything is offline. No server.

### Admin PIN
- Optional 4-6 digit PIN gates Branding, PDF exports, Sync & Backup, and User Management.
- Complements the existing email/password login (role: admin).

### Users & roles
- Bootstrap admin from signup, more accounts created by admin.
- Doctor / staff can only see and edit their own records; admin sees all.

## Data
- SQLite on device (`ortho-logbook.db`), migrated non-destructively.
- Tables: `patients`, `procedures`, `inventory`, `expenses`, `users`, `patient_history`, `inventory_movements`.
- Branding + PIN hash stored in AsyncStorage / SecureStore.

## Non-goals
- No cloud sync.
- No real-time device-to-device sync (Expo Go does not support LAN servers). Multi-phone works via shared backup files.
