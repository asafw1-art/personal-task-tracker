import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "המשימות שלי",
  description: "מערכת אישית לניהול ומעקב משימות",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
