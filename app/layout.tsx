import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Truestock",
  description: "Inventory, counted and costed. Truestock.",
};

export const viewport: Viewport = {
  // The counting UI is operated one-handed while holding a bottle. Pinch-zoom
  // stays enabled (never `maximumScale: 1` — that breaks zoom for anyone who
  // needs it, and WCAG 1.4.4 requires it), but `viewportFit: cover` lets the
  // fixed bottom action bar sit correctly against a phone's home indicator.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Root layout carries fonts and resets only — deliberately NO theme class.
 * Theme is decided per route group (docs/design-system.md §1): `(count)`
 * hardcodes `.dark` because the counting app is always dark regardless of the
 * phone's OS setting, and `(office)` renders light for desk use.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
