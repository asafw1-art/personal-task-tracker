# Production security checklist

Run this checklist after security-sensitive changes, Supabase schema changes, or AI assistant changes.

## Authentication

- Open the production URL in a private browser window.
- Verify that no task data is visible before login.
- Send a magic link and confirm that login succeeds only through the authenticated session.
- Log out and refresh the page.
- Verify that task data is hidden after logout.

## User isolation

- Log in as user A and create a test task.
- Log out, then log in as user B.
- Verify that user B cannot see, edit, or sync user A's task.
- Verify that user B has separate taxonomy, settings, devices, and assistant history.

## Supabase RLS

- Confirm these tables have RLS enabled:
  - `tasks`
  - `user_devices`
  - `user_settings`
  - `task_taxonomy_items`
  - `assistant_threads`
  - `assistant_messages`
  - `assistant_actions`
- Confirm all policies use `auth.uid() = user_id`.
- Confirm update policies include both `using` and `with check`.

## Secrets

- Search the repository for private keys before pushing:
  - `SERVICE_ROLE`
  - `PRIVATE_KEY`
  - `SECRET`
  - `GEMINI_API_KEY`
  - `AI_GATEWAY_API_KEY`
  - `VERCEL_AI_GATEWAY_API_KEY`
- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` may be visible to the browser.
- Never expose Supabase service-role keys in client code or public environment variables.

## AI assistant

- Verify `/api/assistant` requires a valid session token.
- Verify missing or invalid tokens return 401.
- Verify repeated calls are rate-limited.
- Verify very large requests are rejected.
- Verify the assistant cannot propose bulk deletion, bulk cancellation, or full task reset.
- Verify every AI-proposed data change still requires a user confirmation click.

## Production smoke test

- Create a task.
- Edit title, topic, action, priority, status, due date, and notes.
- Add, edit, cancel, delete, and restore workflow around subtasks where relevant.
- Refresh the page and verify the data persists.
- Check from mobile viewport.
- Confirm `npm.cmd run lint` passes.
- Confirm `npm.cmd run build` passes.

## Last local security audit

Updated: 2026-08-17

- `/api/assistant` requires a valid Supabase session token and returns `401` for missing or invalid tokens.
- AI assistant requests have request-size limits and per-user in-memory rate limits.
- AI actions are sanitized server-side and bulk delete/cancel/reset actions are not allowed from the chat.
- Client-visible environment variables are limited to the Supabase public URL and publishable key in `.env.local`.
- Server-only AI provider keys are referenced only inside the server route.
- Supabase SQL files define RLS for `tasks`, `user_devices`, `user_settings`, `task_taxonomy_items`, `assistant_threads`, `assistant_messages`, and `assistant_actions`.
- Security headers are configured in `next.config.ts`.

Manual follow-up that still requires two real accounts:

- Log in as user A and user B and verify that each user sees only their own tasks, taxonomy, settings, devices, and assistant history.
