# Orthopaedic Intelligence workspace

This branch adds an optional, additive workspace to Ortho Logbook. Existing patient, implant inventory, procedure, laboratory, PDF and backup screens are not replaced.

## Available modules

- Anatomy locator: structured body-region, side, bone and fracture/classification details (2D region selector; not a 3D anatomical model).
- X-ray timeline: patient-linked studies, dated notes, app-private image storage, and a side-by-side comparison of the two latest images for the same patient.
- Implant passport: manufacturer, catalogue/model, batch/lot, serial, expiry, supplier, size, compatibility group, compatible components, instrument set and manual verification details; barcode/QR capture.
- Patient journey: combines the existing patient record, patient-history snapshots, recorded patient implants, and new intelligence entries into a chronological view.
- X-ray review: stores clinician-entered observations and measurements. No automated image diagnosis or fracture-detection model is included.
- Rehabilitation: records pain (0–10), range of motion, weight-bearing, mobility and exercises; shows patient-specific pain-score trend history.
- Surgical checklist: editable checklist rows and sign-off fields.
- Clinical notes: structured complaint, examination, diagnosis, plan and follow-up fields. Voice entry uses the device keyboard's dictation facility; no separate app speech-recognition engine is bundled.
- Follow-up radar: due-date/status queue with overdue and due-soon categories; it is not a clinical risk prediction model.
- Research studio: aggregate category summaries and CSV export. Counts smaller than five are suppressed; patient identifiers and exact dates are omitted.
- Knowledge library: administrator-managed, locally stored clinician-approved references.
- Recovery: edit snapshots, archive/restore, revision restore, and backup integration.

## Data and compatibility

The module uses new SQLite tables prefixed "ortho_intelligence_". Creation is additive and does not alter existing tables. Module visibility can be toggled by an administrator without deleting data.

Backup schema advances to version 12. New records, revisions, settings and knowledge articles are included in full and incremental exports, including optional X-ray media. Older backup files default missing module arrays to empty during import.

## Clinical and operational boundaries

- AI-assisted X-ray interpretation, an actual rotatable 3D skeleton and native in-app speech recognition are not represented as implemented. Those require separately validated imaging models, 3D assets/rendering and speech packages.
- Implant compatibility notes are documentation fields for clinician verification, not an automatic device-safety decision.
- Local device storage remains subject to the device's encryption, access-control and backup configuration. Enable the existing encrypted backup workflow for off-device recovery.
- Research exports are aggregate helpers, not a substitute for institutional ethics approval, de-identification review or statistical validation.

## Validation

The branch adds a GitHub Actions workflow that runs TypeScript validation and an Expo web-export smoke test on branch pushes and pull requests.
