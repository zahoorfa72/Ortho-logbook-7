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
