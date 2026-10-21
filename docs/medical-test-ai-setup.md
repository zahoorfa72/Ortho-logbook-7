# AI-assisted lab-test medical information

This optional feature keeps the OpenAI API key on the backend. The app sends only the generic lab-test name and configured aliases. Never add patient names, MR numbers, measured values, reference ranges, report text, or photos to this endpoint. Existing patient records and the offline source cache remain local.

## Backend environment

Configure these variables on the service hosting backend/server.py:

- OPENAI_API_KEY: secret API key created in the OpenAI Platform setup flow. Never put it in the app, source code, or GitHub files.
- LAB_MEDICAL_INFO_ENABLE_EXTERNAL_PROCESSING=true: explicitly enables this endpoint.
- LAB_MEDICAL_INFO_CLIENT_TOKEN: a long random bearer token shared with the app build configuration below. Rotate it if exposed.
- Optional LAB_MEDICAL_INFO_MODEL=gpt-4o-mini.

The existing backend also requires its existing MONGO_URL and DB_NAME settings to start. The medical-info endpoint itself does not read or write the database.

## GitHub Actions app-build secrets

In repository Settings → Secrets and variables → Actions, add:

- MEDICAL_INFO_API_URL: HTTPS base URL of the deployed backend, without a trailing slash and without /api.
- MEDICAL_INFO_CLIENT_TOKEN: exactly the same token as LAB_MEDICAL_INFO_CLIENT_TOKEN on the backend.

Android, iOS simulator and web/Windows validation workflows pass these values into Expo as build-time environment variables. If they are missing, the app still works and falls back to existing MedlinePlus/PubMed/trusted-site lookup; AI remains inactive. Build a new APK after adding the GitHub secrets.

## Behavior and safety

- AI lookup uses OpenAI Responses API web search and returns citations only from an allowlist of trusted medical/academic domains.
- If AI is down or lacks trusted citations, the app falls back to the existing trusted-source lookup; uncited AI output is not displayed.
- Successful summaries are cached by test name and remain available offline.
- Educational information is not a diagnosis or substitute for clinician judgment. No patient-specific result interpretation is sent to this endpoint.
- The client token is a basic access gate, not a substitute for strong per-user authentication. The endpoint also applies a modest per-IP request limit.


## AI lab-image scanning without a backend

The lab-image scanner also supports direct phone-to-OpenAI mode. In Lab Test Reference Ranges, enter the OpenAI API key into the direct AI-vision setting and enable its explicit permission switch. That lab-image path does not require this backend or MongoDB. The key is stored in device secure storage and is not intentionally included in app backups or source code. However, OpenAI advises against embedding client-side API keys in mobile apps because they can be extracted; use direct mode only on a personally controlled device with a dedicated restricted API project/key, usage limits and monitoring. Do not distribute a shared-key APK.

For multi-user or hospital deployment, prefer the hosted backend route described in `docs/lab-vision-endpoint.md` so the API key remains server-side. In both modes, images are sent only after local OCR detects likely lab-report content and the administrator explicitly enables processing. AI-suggested rows remain subject to administrator review, and images may contain patient identifiers; obtain appropriate approval before external processing.

The separate AI medical-test explanation feature documented above still uses its configured backend endpoint; switching lab-image scanning to direct mode does not change that feature.
