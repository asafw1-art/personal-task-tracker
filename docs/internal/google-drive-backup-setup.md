# הגדרת Google Drive Backup בפרודקשן

## 1. Google Cloud

1. ליצור או לבחור Google Cloud project.
2. להפעיל את Google Drive API.
3. להגדיר OAuth consent screen עם שם האפליקציה וכתובת תמיכה.
4. בזמן בדיקות להוסיף את המשתמשים המורשים כ-Test users.
5. ליצור OAuth Client מסוג Web application.
6. להוסיף Authorized redirect URI:
   `https://personal-task-tracker-nine-vert.vercel.app/api/drive/callback`
7. לשמור את Client ID ואת Client Secret ב-Vercel בלבד.

## 2. Supabase

1. להריץ את `supabase/add-google-drive-backups.sql` ב-SQL Editor.
2. ליצור Secret API key ייעודי בצד השרת, או להשתמש זמנית ב-service role legacy.
3. אין לשמור את המפתח בקוד, ב-SQL או במשתנה שמתחיל ב-`NEXT_PUBLIC_`.

## 3. Vercel Environment Variables

- `NEXT_PUBLIC_APP_URL=https://personal-task-tracker-nine-vert.vercel.app`
- `SUPABASE_SECRET_KEY=<server secret key>`
- `GOOGLE_CLIENT_ID=<Google OAuth client id>`
- `GOOGLE_CLIENT_SECRET=<Google OAuth client secret>`
- `GOOGLE_DRIVE_REDIRECT_URI=https://personal-task-tracker-nine-vert.vercel.app/api/drive/callback`
- `DRIVE_TOKEN_ENCRYPTION_KEY=<random secret of at least 32 characters>`
- `CRON_SECRET=<different random secret of at least 32 characters>`

`DRIVE_TOKEN_ENCRYPTION_KEY` חייב להישאר יציב. החלפתו תנתק חיבורים קיימים ותמנע אימות חתימות של גיבויים ישנים.

## 4. תזמון שעתי

1. לאחר הפריסה להחליף ב-`supabase/configure-google-drive-backup-cron.sql` את placeholder של `CRON_SECRET` באותו ערך שהוגדר ב-Vercel.
2. להריץ את הקובץ ב-Supabase SQL Editor.
3. לבדוק ב-Integrations -> Cron שה-job בשם `personal-task-tracker-drive-backup-hourly` פעיל.

## 5. בדיקת קבלה

1. להתחבר לאפליקציה ולבחור חיבור Google Drive.
2. לאשר את ה-scope המצומצם ליצירת קבצים שהאפליקציה מנהלת.
3. לוודא שנוצרה התיקייה `גיבויי המשימות שלי` וגיבוי ידני ראשון.
4. לפתוח Preview של הגיבוי ולוודא ספירות.
5. לבצע שינוי בדיקתי, ליצור גיבוי נוסף ולבדוק שחזור רק לאחר יצירת גיבוי `pre-restore`.
6. להפעיל ידנית את endpoint ה-cron עם הסוד ולבדוק שנוצר גיבוי שעתי.
7. לוודא שמשתמש שלא חיבר Drive ממשיך להשתמש באפליקציה ללא הפרעה.
