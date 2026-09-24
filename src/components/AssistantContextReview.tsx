import { Check, X } from "lucide-react";
import type { AssistantContextPreview } from "@/lib/assistantPrivacy";

export function AssistantContextReview({ preview, busy, onConfirm, onCancel, onDetails }: {
  preview: AssistantContextPreview; busy: boolean; onConfirm: () => void; onCancel: () => void; onDetails: (include: boolean) => void;
}) {
  return <section className="assistant-context-review" aria-label="אישור מידע לספק AI">
    <div className="assistant-context-heading"><strong>לפני שליחה לספק חיצוני</strong>
      <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="ביטול שליחה לספק" title="ביטול"><X size={18} /></button>
    </div>
    <p>יישלחו ההודעה והפרטים המוצגים בלבד, ללא היסטוריית השיחה וללא משימות שהתקבלו בשיתוף. המידע נלקח מהענן; שינויים שטרם סונכרנו אינם נכללים.</p>
    <p>ספקים אפשריים לפי סדר: {preview.providers.map((provider) => `${provider.label} (${provider.model})`).join(" ← ")}</p>
    {preview.providers.some((provider) => !provider.privacyVerified) && <p className="service-warning" role="note">התאמת מסלול הספק לפרטיות טרם אומתה. Gateway עשוי לנתב לספק נוסף שטרם אומת. אין לשלוח מידע אישי רגיש, רפואי, סיסמאות או סודות גישה.</p>}
    <div className="assistant-context-data" tabIndex={0}>
      <strong>הודעתך</strong><p className="assistant-context-message">{preview.message}</p>
      {preview.tasks.length === 0 ? <p>לא מצורפים פרטי משימות.</p> : preview.tasks.map((task) => <dl key={task.id}>
        <dt>משימה</dt><dd>{task.id}</dd>
        <dt>סטטוס</dt><dd>{task.status}</dd><dt>עדיפות</dt><dd>{task.priority}</dd>
        {task.dueDate && <><dt>יעד</dt><dd>{task.dueDate}</dd></>}
        {task.title && <><dt>שם</dt><dd>{task.title}</dd></>}
        {task.notes && <><dt>הערות</dt><dd>{task.notes}</dd></>}
        {task.subtasks?.map((step) => <div className="assistant-context-step" key={step.number}><dt>צעד {step.number}</dt><dd>{step.title} ({step.status})</dd></div>)}
      </dl>)}
    </div>
    {preview.tasks.length > 0 && <label className="assistant-context-options"><input type="checkbox" checked={preview.includeDetails} disabled={busy} onChange={(event) => onDetails(event.target.checked)} />צירוף כותרות, הערות ועד 8 צעדים לכל משימה שנבחרה</label>}
    <button type="button" className="assistant-context-confirm" disabled={busy} onClick={onConfirm}><Check size={18} aria-hidden="true" />אישור ושליחה</button>
  </section>;
}
