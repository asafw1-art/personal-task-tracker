# Product rules for coding agents

- The interface is Hebrew-first and must remain fully RTL.
- Task IDs are immutable and unique per user and prefix.
- P19, P019, P-019 and P-0019 must all normalize to P19. Apply the same rule to W IDs.
- Never recycle task numbers after completion, cancellation, or deletion.
- Completed and cancelled tasks remain available in history.
- Prioritize mobile usability without degrading desktop use.
- Run lint and build before proposing a completed change.
- Do not replace existing task data without an explicit migration.
