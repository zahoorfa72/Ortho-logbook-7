# Medical-test information and local lab AI

The current Ortho Logbook medical-test explanation flow uses trusted medical references and, when downloaded, a Gemma 4 E2B model running on the phone through React Native ExecuTorch. It does not call OpenAI for medical explanations and does not need OpenAI API credits. The model can work offline after its model files and a medical reference summary are available locally. It receives the generic test name, aliases, high/low direction, and trusted source text only; it must not receive patient identity, measured values, reference ranges, report text, or photos. The hosted OpenAI medical-info endpoint described below is legacy/optional and is not needed by the current client flow.

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

## Current medical explanation behavior and safety

- Trusted medical lookup and the curated offline library provide the source material. When the on-device Gemma model is downloaded, it may reformat source material into exactly two sections: `WHAT THIS TEST IS` and `WHAT THE ABNORMAL RESULT MAY MEAN`.
- If the local model is not installed, has an error, or returns an invalid structure, the app falls back to the source-grounded summary; it does not depend on OpenAI credits.
- Successfully retrieved summaries are cached on the device for offline viewing. A new device still needs the model downloaded to that device for local generation.
- The model is not guaranteed to be clinically correct. Its answers must be checked against the displayed source and interpreted by a healthcare professional. No patient-specific result values are sent to online medical explanation services.


## AI lab-image scanning without a backend

The lab-image scanner also supports direct phone-to-OpenAI mode. In Lab Test Reference Ranges, enter the OpenAI API key into the direct AI-vision setting and enable its explicit permission switch. That lab-image path does not require this backend or MongoDB. The key is stored in device secure storage and is not intentionally included in app backups or source code. However, OpenAI advises against embedding client-side API keys in mobile apps because they can be extracted; use direct mode only on a personally controlled device with a dedicated restricted API project/key, usage limits and monitoring. Do not distribute a shared-key APK.

For multi-user or hospital deployment, prefer the hosted backend route described in `docs/lab-vision-endpoint.md` so the API key remains server-side. In both modes, images are sent only after local OCR detects likely lab-report content and the administrator explicitly enables processing. AI-suggested rows remain subject to administrator review, and images may contain patient identifiers; obtain appropriate approval before external processing.

The separate AI medical-test explanation feature documented above still uses its configured backend endpoint; switching lab-image scanning to direct mode does not change that feature.
