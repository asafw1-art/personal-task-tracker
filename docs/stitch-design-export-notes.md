# Stitch Design Export Notes

This file explains how to use the Stitch design export in this project.

## Source Files

- Product and UX source of truth: `docs/design-brief.md`
- Visual reference export: `docs/stitch-design-export.html`

## Role Of The Stitch Export

The Stitch export is a visual implementation reference. It should guide:

- Layout structure.
- Component proportions.
- Spacing and density.
- Color token usage.
- Typography scale.
- Desktop and mobile treatment.
- Task cards, edit drawer, Kanban, settings, analytics, and AI chat patterns.

It should not replace the current application logic.

## Screens Included In The Export

- Task edit drawer, desktop.
- AI assistant chat, desktop.
- Kanban board, desktop.
- Task list, desktop.
- System settings, desktop.
- Analytics/statistics, desktop.
- Task list, mobile.
- Statistics, mobile.
- Settings, mobile.
- Task edit, mobile.
- AI assistant chat, mobile.

## Implementation Rules

- Keep Hebrew as the default language.
- Keep the interface fully RTL.
- Keep future English/LTR support in mind.
- Do not paste static HTML directly into the app.
- Translate visual patterns into existing React components and CSS.
- Preserve all task numbering rules from `AGENTS.md`.
- Preserve Supabase sync, user isolation, and RLS assumptions.
- Preserve AI action approval and destructive-action limits.
- Do not replace existing task data or local/cloud data flows.

## Design Tokens To Reconcile

The export uses the following important design direction:

- Primary blue: `#2563eb`.
- Soft tinted surfaces.
- IBM Plex Sans Hebrew for UI text.
- IBM Plex Mono for IDs.
- Compact radii and card structures.
- Dense, operational layouts rather than marketing-style sections.
- Distinct desktop and mobile compositions.

## Recommended Usage Order

1. Reconcile global design tokens.
2. Apply task list card improvements.
3. Apply task create/edit drawer improvements.
4. Apply treatment-step improvements.
5. Apply analytics/statistics improvements.
6. Apply Kanban improvements.
7. Apply settings improvements.
8. Apply AI chat improvements.
9. Run full mobile and accessibility review.

