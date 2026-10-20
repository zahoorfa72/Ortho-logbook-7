# Ortho Logbook AI vision + lab templates

## Implemented behavior

- Existing on-device OCR and conservative row parser remain the fallback.
- Admins can save recurring report templates with distinctive phrases and column headings. The app chooses a template only when its marker phrases match OCR text; a template never supplies medical reference ranges.
- AI vision is off by default. It requires an HTTPS endpoint, a client token stored in phone secure storage, and a separate explicit permission switch.
- The app sends an image only when local OCR detects likely lab-report evidence. Ordinary patient photos are not sent just because they are attached to a patient.
- AI candidates prefill the administrator review form and are labeled with visual confidence. They do not change screening flags or become saved results until an administrator checks the original image and applies manual review.
- Test names must match an admin-configured test or alias unambiguously. Alerts use only the saved sex-specific reference range and saved unit.

## Server configuration

Deploy the repository FastAPI backend behind HTTPS. Set these environment variables on the server:

- LAB_VISION_ENABLE_EXTERNAL_PROCESSING=true only after your organization approves external processing.
- LAB_VISION_CLIENT_TOKEN to a long random secret; enter the same token in the app's Lab Test Reference Ranges settings.
- LAB_VISION_API_KEY to the AI provider API key. This provider key remains on the server and must never be entered into the mobile app.
- Optional LAB_VISION_API_URL (defaults to an OpenAI-compatible chat-completions endpoint) and LAB_VISION_MODEL (defaults to gpt-4o-mini).

Set the mobile endpoint to the deployed backend URL ending in /api/lab-vision. The route requires bearer authentication, accepts image uploads up to 12 MB, does not write uploads to MongoDB, and intentionally avoids logging provider response content.

## Privacy review is required

HTTPS and bearer authentication protect transport and access; they do not themselves guarantee healthcare regulatory compliance or no retention. Before enabling external processing, the hospital must approve the AI provider, data-processing terms, permitted data location, retention/deletion behavior, and no-training setting. Configure the provider account to the strongest suitable privacy controls. The image may itself contain patient identifiers even though the app does not send patient name, MR number, or OCR text as metadata. Do not enable this feature until that review is complete. Disabling the app switch stops new uploads; it cannot recall an image already sent.

## Request/response contract

The app sends multipart fields file and metadata. The server returns JSON containing a rows array, for example:

    {
      "rows": [
        {
          "test": "Hemoglobin",
          "result": "9.2",
          "unit": "g/dL",
          "confidence": 0.91,
          "reason": ""
        }
      ]
    }

The endpoint should abstain from unclear rows. Results are suggestions, not diagnoses. No AI candidate is automatically saved.
