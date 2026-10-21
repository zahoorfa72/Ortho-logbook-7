# Ortho Logbook AI vision + lab templates

## Direct phone-to-OpenAI mode (no Ortho Logbook backend)

- AI vision is off by default. An administrator must add an OpenAI API key in Lab Test Reference Ranges and explicitly enable direct AI lab scanning.
- The key is stored with Expo SecureStore on that device. It is not written to source code or included in the app's backup data by this feature.
- The image is sent from the phone directly to `https://api.openai.com/v1/chat/completions` over HTTPS. No Ortho Logbook backend or MongoDB is needed for this path.
- The automatic scanner sends an image only when local OCR already identifies likely lab-report content and the administrator has explicitly enabled direct vision. Ordinary patient photos are not sent just because they are attached to a patient.
- The request includes configured lab-test names/aliases and report-layout hints but does not add patient name/MR number fields as request metadata. The image may itself visibly contain identifiers.
- Images over 12 MB or unsupported image formats are skipped; the scanner keeps its local OCR results.
- AI candidates prefill the administrator review form and are labeled as AI vision results. They do not change screening flags or become saved results until an administrator verifies them.
- Test names must match an admin-configured test or alias unambiguously. Alerts use only the saved sex-specific reference range and saved unit.
- If the key is missing, invalid, quota-limited, or the network is unavailable, local OCR remains the fallback.

## API-key security warning

OpenAI advises against using an API key directly in a mobile app because device inspection or a modified APK can expose it and cause unauthorized usage/charges. SecureStore provides at-rest device protection, but does not make a client-side key equivalent to a server-side secret. This direct mode is for a personally controlled device and should not be used to distribute a shared key in public or multi-user APKs. Use a dedicated restricted OpenAI project/key, configure usage limits, monitor usage and rotate/revoke the key if compromise is suspected.

For hospital or multi-user use, prefer a secured backend proxy that holds the key server-side, with authentication and appropriate privacy controls. No patient records are moved to that proxy by this direct lab-vision path.

## Optional hosted-backend compatibility

The request utility still supports the prior HTTPS `/api/lab-vision` endpoint with a client token when no direct OpenAI key is configured. Users without a backend can leave those legacy settings empty and use direct mode.

## Medical privacy

Before enabling external processing, ensure the organization or responsible clinician has approved sending lab-report images to the selected provider. Do not enable this feature until privacy requirements, provider data terms, retention/deletion behavior and applicable healthcare obligations have been reviewed. Disabling the app switch stops new uploads; it cannot recall an image already sent.

## Vision request/response behavior

The direct OpenAI request asks for JSON rows containing a test label, measured result, optional unit, confidence and reason. The scanner abstains from uncertain rows, and never auto-saves results. This is transcription assistance, not diagnosis.