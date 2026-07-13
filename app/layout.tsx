import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deepcut — your tastegraph",
  description:
    "Deepcut builds your tastegraph — a weighted map of your music taste from your real listening history.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        {children}
      </body>
    </html>
  );
}
