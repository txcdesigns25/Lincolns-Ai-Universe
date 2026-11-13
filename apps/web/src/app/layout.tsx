import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "AI Universe", description: "Business operating system for seven AI-run businesses" };
export const viewport: Viewport = { themeColor: "#07090d" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans min-h-screen">{children}</body>
    </html>
  );
}
