# Patient image archive and encrypted settings backup requirements

Status: agreed requirements; implementation and device/restore verification are still required.

## Required behaviour

- Preserve all existing patient, stock, lab, branding, and settings behaviour.
- For patient images older than 30 days, automatically create a patient-specific PDF archive and keep a stable reference on that patient's record. Images newer than 30 days remain directly accessible as images.
- PDF archive links must open the correct patient's archive, including after phone backup restore or Google Drive restore.
- Phone backups and Google Drive backups must include the archive PDFs and any images that have not yet been archived. Do not depend on temporary device-local file paths.
- Preserve image legibility and source quality. Do not resize, recompress, or delete source images until the archive and backup have been verified.
- Encrypt the settings sidecar with a user-selected recovery password. Do not upload sensitive settings in plaintext. The recovery password must be needed to restore the sidecar on a new installation; never hardcode it or store it in the backup itself.
- Include app settings, lab-test branches and reference ranges, branding/logos, OAuth/account configuration, and trash/recovery metadata in the encrypted settings backup.
- Restore and validate all required files before replacing live data. Restore records and their photo/archive references together, prevent duplicate records, and preserve existing backup files until the new backup has been verified.
- Keep the existing manual phone backup and restore workflow available.

## Safety and acceptance checks

1. Verify automatic archival runs only when appropriate and does not repeatedly generate duplicate PDFs.
2. Verify each archive maps to exactly one patient and is opened from that patient's record.
3. Verify images both younger and older than 30 days survive backup/restore.
4. Verify encrypted settings cannot be read without the recovery password and restore correctly with it.
5. Verify missing, damaged, or password-invalid files fail safely without clearing existing patient data.
6. Verify large backup processing avoids loading all image bytes and serialized JSON into memory at once.
7. Run type checks, lint/build checks, and a restore test before describing the feature as complete.

This document records the requested contract; it does not itself implement these behaviours.
