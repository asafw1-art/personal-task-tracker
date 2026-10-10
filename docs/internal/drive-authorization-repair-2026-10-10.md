# Drive authorization repair - 2026-10-10

## Goal and status

Asaf approved repairing recurring authorization expiry, truthful backup status and reconnection. Technical changes distinguish an invalid grant from temporary or application configuration failures. They do not publish OAuth, change scopes, rotate keys or establish Google's permission for the backup use case.

The live browser inspection was blocked by the Computer Use URL-identification safeguard on October 10. No live token error code was obtained. The previous External/Testing configuration and seven-day refresh-token expiry remain the leading explanation, not a newly confirmed diagnosis.

## Implemented behavior

- The token request has a 15-second timeout, validates the token response, and stores only allowlisted OAuth codes with local messages. Provider descriptions and unknown error strings are discarded.
- Confirmed `invalid_grant` is recorded as an error without deleting the encrypted token or changing task data. This also applies when checking an existing backup. Repeated backup attempts stop before the token request until reconnection resets the error.
- The Drive panel reports reconnect-required, failed or overdue instead of green connected whenever backups are not healthy. Health means connected and successful backup within the last 24 hours; it is not a new connectivity probe.
- The existing admin service monitor and notification mechanism receive a reconnect-specific reason. Scheduled backup runs also update Drive health. These are in-app notifications, not an independent email or push service.
- Existing `Bad Request` records are not retrospectively classified as expired. No success is fabricated.

## Remaining completion gates

1. Inspect the current live OAuth Audience/Branding and the actual failure after browser access resumes.
2. Resolve C01: prior written Google consent for this application's backup use case. No evidence of consent exists in the project record. Asaf was asked whether consent has since been obtained.
3. Review and approve the existing public information/privacy/terms drafts for publication; they remain unpublished. Inspect actual Google publication requirements before changing Audience.
4. After these prerequisites, publish the existing OAuth client as authorized and reconnect the same account with the existing least-privilege `openid email drive.file` permissions. Preserve the encryption/signature key and callback.
5. Create a fresh backup, read it using the integrity preview, and verify the next scheduled run. Do not restore into Production as a test. Beyond-seven-day success is a later observation, not a result to claim at release time.

## Prepared question to Google (not sent)

Subject: Request for clarification and prior written consent for optional Drive backup of a task-management application

We operate a small Hebrew-language task-management web application. Users may optionally connect their own Google Drive account using the non-sensitive drive.file scope. The application creates JSON files containing that user's task records, application settings and related task metadata in an application-created folder. It retains a limited number of hourly and daily copies and can read them for integrity checking and user-confirmed recovery. It does not request access to all Drive files, distribute the files publicly or use Drive as a CDN.

The Drive API Terms, Customer implementation section, list backup of user or app content to Drive as requiring Google's express prior written consent. Please confirm the appropriate application process for this use case and whether you can grant such consent. We will not treat OAuth verification or Production publication as equivalent to that consent. Please identify any implementation or disclosure requirements needed for approval.

This draft is ready for Asaf's review. Sending it, selecting a Google support channel and publishing policy pages are separate external actions; no request has been submitted.

## Sources

- https://developers.google.com/identity/protocols/oauth2#expiration (checked October 10)
- https://developers.google.com/workspace/drive/api/terms (checked October 10)
- Existing decisions: `backup-readiness-2026-09-22.md`, C01 in `data-compliance-register.md`.
