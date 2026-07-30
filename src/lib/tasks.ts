export type TaskStatus = "open" | "in_progress" | "waiting" | "done" | "cancelled";
export type TaskPriority = "high" | "important" | "normal" | "low";
export type TaskPrefix = "P" | "W";

export type Task = {
  id: string;
  prefix: TaskPrefix;
  number: number;
  title: string;
  category: string;
  actionType?: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate?: string;
  createdAt?: string;
  completedAt?: string;
  notes?: string;
};

export function canonicalTaskId(value: string): string | null {
  const match = value.trim().toUpperCase().match(/^([PW])[-\s]?0*(\d+)$/);
  if (!match) return null;
  return `${match[1]}${Number(match[2])}`;
}

export const initialTasks: Task[] = [
  { id: "P1", prefix: "P", number: 1, title: "להעביר כסף לחשבון לאומי", category: "כספים", priority: "high", status: "done" },
  { id: "P2", prefix: "P", number: 2, title: "להתעדכן עם ענבר", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P3", prefix: "P", number: 3, title: "להתקשר לאדיר גמליאל", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P4", prefix: "P", number: 4, title: "לקבוע עם אלפי", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P5", prefix: "P", number: 5, title: "לדבר עם נועם בנושא רישוי Microsoft", category: "מחשוב", priority: "normal", status: "done" },
  { id: "P6", prefix: "P", number: 6, title: "התקנת Office עם נועם הירש", category: "מחשוב", priority: "normal", status: "done" },
  { id: "P7", prefix: "P", number: 7, title: "להזמין אוזניות וטאבלט מ-KSP", category: "רכישות", priority: "normal", status: "done" },
  { id: "P8", prefix: "P", number: 8, title: "פגישה עם רומן", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P9", prefix: "P", number: 9, title: "פגישה עם יובל", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P10", prefix: "P", number: 10, title: "לקבוע מפגש עם הודיה", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P11", prefix: "P", number: 11, title: "לדבר עם אלדר", category: "בית", priority: "important", status: "done" },
  { id: "P12", prefix: "P", number: 12, title: "להירשם למרוץ חבר – 10 ק״מ", category: "בריאות", priority: "normal", status: "done" },
  { id: "P13", prefix: "P", number: 13, title: "לאסוף חבילה ממכולת ניסנוב", category: "סידורים", priority: "normal", status: "done" },
  { id: "P14", prefix: "P", number: 14, title: "להעביר קופת גמל לאלטשולר", category: "כספים", priority: "important", status: "done" },
  { id: "P15", prefix: "P", number: 15, title: "לקבוע עם יוסי עזר", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P16", prefix: "P", number: 16, title: "לקבוע ערב עם עידו – יום הולדת ועזרה עם הבית", category: "תיאומים", priority: "normal", status: "done" },
  { id: "P17", prefix: "P", number: 17, title: "לכתוב טיוטת חוזה השכרה לכרם חמד 14", category: "בית", priority: "high", status: "done" },
  { id: "P18", prefix: "P", number: 18, title: "אספקת האי למטבח", category: "בית", priority: "normal", status: "done" },
  { id: "P19", prefix: "P", number: 19, title: "לשלוח הודעה למעוז לגבי מערכת התר״ש", category: "עבודה", priority: "important", status: "done" },
  { id: "P20", prefix: "P", number: 20, title: "לחתום אצל עו״ד אמיר", category: "אישי", priority: "high", status: "open" },
  { id: "P21", prefix: "P", number: 21, title: "מרכז הפרט והחזרים", category: "כספים", priority: "high", status: "open" },
  { id: "P22", prefix: "P", number: 22, title: "לסיים טיפול ודיווח על התאונה", category: "אישי", priority: "high", status: "open" },
  { id: "P23", prefix: "P", number: 23, title: "לסגור את תשלום הארנונה", category: "בית", priority: "high", status: "open" },
  { id: "P24", prefix: "P", number: 24, title: "לפתוח תיקי השקעות לבנות", category: "כספים", priority: "important", status: "open" },
  { id: "P25", prefix: "P", number: 25, title: "לקבוע פגישה עם איציק עמר", category: "פרישה", priority: "important", status: "open" },
  { id: "P26", prefix: "P", number: 26, title: "לקבוע הפניה לרופא שיניים", category: "בריאות", priority: "important", status: "open" },
  { id: "P27", prefix: "P", number: 27, title: "לקבוע הפניה לקרדיולוגיה", category: "בריאות", priority: "important", status: "open" },
  { id: "P28", prefix: "P", number: 28, title: "לקבוע פגישת המשך עם רומן", category: "תיאומים", priority: "important", status: "open" },
  { id: "P29", prefix: "P", number: 29, title: "לקבוע פגישת המשך עם יובל", category: "תיאומים", priority: "important", status: "open" },
  { id: "P30", prefix: "P", number: 30, title: "להשלים הגשת החזרים לקייטנות של הבנות", category: "כספים", priority: "important", status: "open" },
  { id: "P31", prefix: "P", number: 31, title: "לקבוע עם טל וסיוון", category: "תיאומים", priority: "normal", status: "open" },
  { id: "P32", prefix: "P", number: 32, title: "לקבוע עם בן", category: "תיאומים", priority: "normal", status: "open" },
  { id: "P33", prefix: "P", number: 33, title: "לקבוע פגישה עם מירי מיכאלי", category: "תיאומים", priority: "normal", status: "open" },
  { id: "P34", prefix: "P", number: 34, title: "לקנות מדיח", category: "בית", priority: "normal", status: "open" },
  { id: "P35", prefix: "P", number: 35, title: "לקנות מאווררי תקרה", category: "בית", priority: "normal", status: "open" },
  { id: "P36", prefix: "P", number: 36, title: "המשך טיפול בנושא הסורגים והרשתות", category: "בית", priority: "important", status: "waiting" },
  { id: "W1", prefix: "W", number: 1, title: "לשלוח הודעה לעומר בנושא גיא קריב", category: "עבודה", priority: "high", status: "open" },
  { id: "W2", prefix: "W", number: 2, title: "לעקוב מול נדב קוק לגבי ההגשה ל-Galaxy", category: "עבודה", priority: "high", status: "open" },
  { id: "W3", prefix: "W", number: 3, title: "בדיקת ימי חופש", category: "עבודה", priority: "important", status: "open" },
  { id: "W4", prefix: "W", number: 4, title: "קביעת הפניות", category: "עבודה", priority: "important", status: "open" }
];
