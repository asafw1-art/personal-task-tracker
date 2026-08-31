# Product rules for coding agents

- The interface is Hebrew-first and must remain fully RTL.
- Task IDs are immutable and unique per user and prefix.
- P19, P019, P-019 and P-0019 must all normalize to P19. Apply the same rule to W IDs.
- Never recycle task numbers after completion, cancellation, or deletion.
- Completed and cancelled tasks remain available in history.
- Prioritize mobile usability without degrading desktop use.
- Run lint and build before proposing a completed change.
- Do not replace existing task data without an explicit migration.

## Token-efficient working policy

- Treat each substantial development package as a separate Codex task. At the start, read only `AGENTS.md`, `docs/internal/project-backlog.md`, `docs/internal/known-decisions.md`, and files directly relevant to that package.
- Use targeted searches and bounded line ranges. Do not print complete source files, backlog files, diffs, logs, DOM snapshots, or browser documentation unless required by the tool or the task cannot be completed otherwise.
- Keep tool output limits small and increase them only when truncated information is materially needed.
- Batch related implementation edits and run lint/build once after the implementation stabilizes. Re-run only after a subsequent code change.
- Perform connected browser QA as one focused pass near the end of the package. Cover only the affected workflows and required mobile/desktop or light/dark variants.
- Accept one authoritative verification signal for each fact. Do not verify the same deployment, build, or UI behavior through several equivalent methods without a concrete contradiction.
- Avoid repeated deployment polling. Wait once, then perform one focused Production check; retry only when the result is inconclusive or exposes a defect.
- Above 25% available usage, normal end-to-end package work is allowed. Between 10% and 25%, start only work that can reasonably be completed within the remaining allocation and do not expand scope. Below 10%, do not perform active operations without explicit user approval.
- Before starting implementation, stop if the estimated remaining allocation is insufficient for implementation, lint/build, deployment, and required QA. Use the remaining allocation for planning or a concise handoff instead.
- The instruction `בצע` means complete the approved scope through implementation, lint, build, commit, push, deployment, and focused QA unless the user explicitly excludes a step. It does not authorize unrelated improvements or additional package scope.
