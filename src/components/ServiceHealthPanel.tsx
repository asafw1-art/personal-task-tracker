import { RotateCcw, Activity } from "lucide-react";
import { serviceReasonLabels, serviceStateLabels, type ServiceHealthOverview, type ServiceId } from "@/lib/serviceHealth";

const date = (value: string | null) => value ? new Date(value).toLocaleString("he-IL") : "אין נתון";
export function ServiceHealthPanel({ overview, busy, error, onRefresh }: {
  overview: ServiceHealthOverview | null; busy: boolean; error: string; onRefresh: (probe?: ServiceId) => void;
}) {
  return <section className="service-health-panel" aria-label="מצב שירותים">
    <div className="panel-heading"><h2>מצב שירותים</h2><button type="button" className="icon-button" aria-label="רענון מצב שירותים" title="רענון מצב שירותים" disabled={busy} onClick={() => onRefresh()}><RotateCcw size={18} /></button></div>
    {error && <p role="alert" className="service-warning">{error}</p>}
    {!overview && <p>{busy ? "טוען מצב שירותים..." : "אין עדיין נתוני ניטור."}</p>}
    {overview && !overview.monitoringAvailable && <p className="service-warning" role="alert">רישום הניטור אינו זמין. המידע עשוי להיות חלקי ואינו מוכיח רציפות שירות.</p>}
    {overview?.services.map((service) => <article className={`service-health-row service-${service.state}`} key={service.id}>
      <div className="service-health-heading"><strong>{service.label}</strong><span>{serviceStateLabels[service.state]}</span></div>
      <p>{serviceReasonLabels[service.reason] || "נדרשת בדיקה"}</p>
      <dl><dt>הגדרה</dt><dd>{service.configured ? "מוגדר" : "חסר"} · {service.enabled ? "מופעל" : "מושבת"}</dd>
        {service.model && <><dt>מודל</dt><dd dir="ltr">{service.model}</dd></>}
        {service.privacyVerified !== undefined && <><dt>פרטיות</dt><dd>{service.privacyVerified ? "תצורה אושרה בידי המפעיל" : "טרם אומתה"}</dd></>}
        <dt>בדיקה אחרונה</dt><dd>{date(service.checkedAt)}</dd><dt>הצלחה אחרונה</dt><dd>{date(service.lastSuccessAt)}</dd>
        <dt>מקור</dt><dd>{({ policy: "הגדרות שרת", request: "בקשת משתמש", probe: "בדיקה יזומה", scheduler: "ריצה מתוזמנת", backup_records: "רשומות גיבוי, ללא בדיקת קובץ חדשה" })[service.source] || "אין נתון"}</dd>
      </dl>
      {["gemini", "gateway"].includes(service.id) && <button type="button" className="secondary-action" disabled={busy || !service.enabled || !service.configured} onClick={() => onRefresh(service.id)}><Activity size={16} aria-hidden="true" />בדיקה ללא מידע אישי</button>}
    </article>)}
  </section>;
}
