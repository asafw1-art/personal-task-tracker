# Task Management System - UI/UX Design Brief

## Product Context

This is a personal task management system built with Next.js, Supabase Auth/Database, and Vercel.

The product is Hebrew-first today, with a full RTL interface, but should be designed in a way that supports future multilingual use, especially Hebrew RTL and English LTR.

Core product goals:

- Personal task tracking across desktop and mobile.
- Clear separation between personal and work tasks.
- Persistent, immutable task numbering.
- Cloud sync across devices.
- Fast task creation and updating.
- Status tracking with subtasks / treatment steps.
- Analytics, insights, notifications, and AI assistant support.

## Future i18n Requirement

The UI should be ready for future language switching.

- Hebrew is the default language.
- English support is planned.
- Components should support both RTL and LTR layouts.
- Avoid fixed widths that only work for Hebrew labels.
- Buttons, tabs, filters, chips, cards, status labels, and date displays should tolerate longer English text.
- Icons and layouts should be easy to mirror between RTL and LTR.
- Avoid embedding text directly into visual assets.
- Prefer reusable labels and component patterns that can later be wired to translation files.

## Information Architecture

| Screen / Area | Description |
| --- | --- |
| Authentication Screen | Login screen for connecting to the private task account. |
| Main Dashboard / Task List | Primary working area for viewing, filtering, creating, and updating tasks. |
| Kanban Board | Status-based board view of active tasks. |
| Analytics / Statistics | Metrics, charts, trends, insights, and summaries. |
| Task Create / Edit Drawer | Full task creation and editing interface. |
| Subtasks / Treatment Steps | Expandable task-level workflow steps. |
| Settings Drawer | Central configuration area. |
| Settings: Appearance | Theme, display name, and future language settings. |
| Settings: Topics & Actions | Manage internal topics and action types. |
| Settings: Notifications | Configure notification and insight thresholds. |
| Settings: Sync, Backup & Recovery | Supabase sync, devices, JSON backup/restore, AI chat recovery. |
| AI Assistant Chat | Floating assistant for questions and approved actions. |

There is no separate team, project, or calendar screen currently.

## Key Functionalities By Screen

### Authentication Screen

Primary actions:

- Enter email.
- Send magic login link.
- Connect to Supabase account.
- Display connection/auth errors.
- Prevent access to task data before authentication.

Displayed data:

- App title.
- Login explanation.
- Email input.
- Auth status/error messages.

Design notes:

- Should feel private, calm, and trustworthy.
- Must support Hebrew RTL now and English LTR later.
- Should be mobile friendly.
- Avoid raw technical loading text.

### Main Dashboard / Task List

Primary actions:

- View active tasks.
- Search tasks by title or task ID.
- Filter by status, prefix, topic, action type, and quick filters.
- Create new task using floating `+`.
- Edit task.
- Change task status.
- Mark task as focused/starred.
- Expand/collapse subtasks.
- Add subtask directly from task card.
- Update subtask status.
- Delete subtask with confirmation.
- Sync changes to cloud.

Displayed data:

- Task ID, for example `P20` or `W4`.
- Task title.
- Prefix: `P` personal, `W` work.
- Topic/category.
- Action type.
- Priority.
- Status.
- Due date.
- Created/status changed/completed timestamps where relevant.
- Notes.
- Focus/star state.
- Subtask count and progress.

### Kanban Board

Primary actions:

- View tasks by status columns.
- Change task status from card.
- Edit task.
- Mark task as focused.
- Toggle whether closed tasks are shown.

Displayed data:

- Task ID.
- Task title.
- Status.
- Priority.
- Topic.
- Action type.
- Due date.
- Focus state.
- Subtask summary.

Design notes:

- Default focus should be active work: open, in progress, waiting.
- Done/cancelled should not dominate the default board.
- Column headers should remain clear and sticky.
- Desktop should support multi-column scanning.
- Mobile should avoid narrow unreadable columns.

### Analytics / Statistics

Primary actions:

- Switch analytics range: 7 days, month, all.
- View summary cards.
- Click metrics to filter the task list.
- View insights and recommended actions.
- Review completion pace and workload.
- Identify tasks needing attention.

Displayed data:

- Active task count.
- Completed task count.
- Waiting task count.
- Overdue task count.
- Tasks without due date.
- Focused tasks.
- Tasks with open subtasks.
- Completed subtasks.
- Subtask completion rate.
- Completion trend:
  - daily for 7 days
  - weekly for month
  - monthly for all time
- Topics with load.
- Action types with load.
- Tasks needing attention.

Design notes:

- Should feel like an operational cockpit, not a marketing dashboard.
- Dense but readable.
- Emphasize what needs action, not only counts.

### Task Create / Edit Drawer

Primary actions:

- Create task.
- Edit task.
- Set prefix: personal/work.
- Set title.
- Set topic.
- Set action type.
- Set status.
- Set priority.
- Set due date.
- Add/edit notes.
- Add/edit/delete subtasks.
- Save or cancel.

Displayed fields:

- Prefix: `P` / `W`.
- Auto-generated task number.
- Title.
- Topic/category.
- Action type.
- Status.
- Priority.
- Due date.
- Notes.
- Subtasks.

Design notes:

- Prefix and task number rules are sensitive and should not be broken.
- Task numbers are automatic and immutable.
- Existing task data must not be replaced casually.
- Editing should feel compact but complete.

### Subtasks / Treatment Steps

Primary actions:

- Expand/collapse subtasks from the task card.
- Add a treatment step.
- Edit treatment step title/action/status.
- Mark as not done, done, or cancelled.
- Delete a subtask with confirmation.

Displayed data:

- Subtask title.
- Subtask action type.
- Subtask status.
- Optional status timestamp.
- Internal number exists but is not emphasized in the UI.

Workflow logic:

- Subtasks belong to a parent task.
- If a task has completed subtasks, it usually should not remain in an untouched/open state forever.
- Parent task does not automatically complete when all subtasks are complete.

### Settings Drawer

Settings are centralized under a gear button.

Tabs:

- Appearance.
- Topics & Actions.
- Notifications.
- Sync, Backup & Recovery.

#### Appearance

Primary actions:

- Switch light/dark mode.
- Set personal display name.
- Future: switch language between Hebrew and English.

Displayed data:

- Theme options.
- Display name field.
- Save status.

#### Topics & Actions

Primary actions:

- Manage personal/work topics.
- Manage shared action types.
- Add item.
- Edit item.
- Delete item.

Design notes:

- Preserve `P/W` as the top-level distinction.
- Topics are internal classification.
- Actions are separate classification.

#### Notifications

Primary actions:

- Configure in-app alert behavior.
- Adjust thresholds for stuck tasks.

Current notification examples:

- Overdue tasks.
- Open subtasks.
- No closures this week.
- Waiting tasks.
- Tasks requiring attention.

#### Sync, Backup & Recovery

Primary actions:

- Connect/disconnect Supabase.
- Refresh from cloud.
- Upload local data to cloud.
- Sync between devices.
- View connected devices.
- Export JSON backup.
- Import JSON backup.
- Reset local/base data with safety confirmation.
- Restore deleted AI chat threads.

Displayed data:

- Connected email.
- Local task count.
- Cloud task count.
- Sync status.
- Last sync time.
- Connected devices.
- Backup/restore status.
- Deleted AI chat threads recoverable for 30 days.

### AI Assistant Chat

Primary actions:

- Ask questions about tasks.
- Ask for simple summaries.
- Ask to filter tasks.
- Ask to create a task.
- Ask to update one task status.
- Ask to add/update one subtask.
- Ask to clear AI chat history.
- Approve or reject proposed actions.

Safety constraints:

- AI cannot delete all tasks.
- AI cannot cancel all tasks.
- AI cannot reset the system.
- Bulk destructive operations are only allowed through Settings.
- Any AI action requires user approval.

## Data Model / Fields

### Task

| Field | Description |
| --- | --- |
| `id` | Immutable task ID, e.g. `P20`. |
| `prefix` | `P` personal, `W` work. |
| `number` | Running number per prefix. |
| `title` | Task name. |
| `category` | Topic/category. |
| `actionType` | Type of action. |
| `priority` | high / important / normal / low. |
| `status` | open / in_progress / waiting / done / cancelled. |
| `dueDate` | Target date. |
| `createdAt` | Creation timestamp. |
| `completedAt` | Completion timestamp. |
| `statusChangedAt` | Last status change timestamp. |
| `focused` | Starred/focused task. |
| `notes` | Free text notes. |
| `subtasks` | Treatment steps. |

### Subtask / Treatment Step

| Field | Description |
| --- | --- |
| `id` | Internal ID. |
| `number` | Internal subtask number. |
| `title` | Step title. |
| `status` | open / done / cancelled. |
| `actionType` | Step-level action type. |
| `createdAt` | Creation timestamp. |
| `statusChangedAt` | Last status change timestamp. |

### User Settings

| Field | Description |
| --- | --- |
| `displayName` | Used in the main title. |
| `theme` | Light/dark visual mode. |
| future `language` | Hebrew default, English optional. |

## User Roles

There are no admin/team roles currently.

The app is built around authenticated personal users:

- Each user sees only their own tasks.
- Each user has their own settings.
- Each user has their own taxonomy/topics/actions.
- Each user has their own AI chat history.
- Connected devices are per user.

No team management, task assignment, shared workspace, admin dashboard, or permission hierarchy exists currently.

## Workflow Logic

Happy path from creation to completion:

1. User opens the app and logs in.
2. User clicks floating `+`.
3. User creates a task with prefix, title, topic, action type, priority, optional due date, notes, and subtasks.
4. System assigns the next immutable task ID.
5. Task appears in the main list.
6. User may mark it as focused/starred.
7. User updates status as work progresses.
8. User adds or updates treatment steps.
9. Completed subtasks contribute to progress.
10. User marks the task as done or cancelled.
11. Completed/cancelled task remains available in history.
12. Analytics update based on actual status-change/completion activity.
13. Cloud sync keeps desktop and mobile aligned.

## Critical Product Rules

- Hebrew-first UI.
- Future support for English.
- Full RTL today, with future LTR support.
- Task IDs are immutable.
- `P19`, `P019`, `P-019`, and `P-0019` normalize to `P19`.
- Same normalization rule applies to `W` IDs.
- Never recycle task numbers.
- Completed/cancelled tasks remain in history.
- Do not delete or replace existing task data without explicit migration.
- Supabase sync must preserve user separation.
- Mobile usability is a first-class requirement.
- Destructive actions require confirmation.
- AI actions require approval.

## Technical / Layout Constraints

### RTL and Future LTR

- Current app should remain `dir="rtl"`.
- Text alignment should default right in Hebrew.
- Future English mode should switch to LTR.
- Components should be designed so they can be mirrored.
- Avoid layouts that depend on text being right-aligned only.

### Navigation

Current navigation is intentionally simple:

- Top-level tabs:
  - Tasks
  - Kanban Board
  - Statistics
- Settings open from a gear button.
- Task creation uses floating `+`.
- AI chat uses floating `AI`.

The designer should preserve this lightweight structure unless proposing a deliberate redesign.

### Responsive Behavior

Desktop:

- Dashboard metrics in rows.
- Filters as horizontal controls.
- Kanban multi-column.
- Drawers centered/modal.

Mobile:

- Compact stacked layout.
- Large touch targets.
- Floating buttons remain reachable.
- Forms should avoid horizontal overflow.
- Kanban should not become unreadably narrow.

### Visual System

Current direction:

- Clean card-based UI.
- Soft borders.
- Blue primary action color.
- Light and dark modes.
- Compact operational dashboard feel.
- Avoid oversized marketing-style hero sections.
- Avoid decorative visuals that reduce usability.

## Design Opportunities

1. Improve task card hierarchy.
2. Improve mobile task card density.
3. Make task create/edit faster and less form-heavy.
4. Make subtasks feel like progress inside a task.
5. Turn analytics into actionable insight blocks.
6. Keep settings organized and calm.
7. Make AI proposed actions clear and safe.
8. Polish dark mode consistency.
9. Prepare component layouts for Hebrew and English.
