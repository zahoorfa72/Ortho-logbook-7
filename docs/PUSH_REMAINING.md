# Complete push (required once)

The GitHub connector cannot run `git push` (no stored username/password).
All fixes are **committed locally** on branch `main` (5 commits ahead of origin).

## On your PC / laptop (with this repo + GitHub login):

```bash
cd Ortho-logbook-7
git pull origin main   # pick up connector commits (inventory, stats, etc.)
git push origin main   # upload ALL remaining source + icons
```

If pull has conflicts on `inventory.tsx`, prefer the version with `showCategoryHeader` and `params.categoryName`.

Then rebuild the APK so the phone gets:
- Lab branch dropdown
- Lab scan ranges from saved tests only
- Drive PDF download fixes
- Inventory category headers
- App icon (white SASIMS)

## Already on GitHub via connector
- frontend/app/(tabs)/inventory.tsx (category headers)
- frontend/app/(tabs)/stats.tsx (from–to dates)
- frontend/src/utils/storage/backup-file.ts (share fix)
- frontend/src/utils/storage/patient-image-archive.ts
- frontend/app.json (icon backgrounds)
- docs/ALL_FIXES_OCT26.md
