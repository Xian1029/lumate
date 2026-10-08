import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/lib/i18n-context";
import { ConnectionStatus } from "@/components/shared/connection-status";
import { SkipLink } from "@/components/shared/skip-link";
import { StudyTimeTracker } from "@/components/shared/study-time-tracker";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export const metadata: Metadata = {
  title: "启知伴 · Lumate",
  description: "启发思考，陪伴成长。",
  applicationName: "启知伴 Lumate",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "启知伴",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.svg?v=lumate-3", sizes: "any", type: "image/svg+xml" },
      { url: "/icons/favicon-lumate.ico?v=lumate-3", sizes: "16x16 32x32 48x48", type: "image/x-icon" },
      { url: "/icons/icon-512.png?v=lumate-3", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png?v=lumate-3", sizes: "192x192" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <body className="antialiased">
        <ConnectionStatus />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <LocaleProvider>
            <Suspense fallback={null}><StudyTimeTracker /></Suspense>
            <TooltipProvider>
              <SkipLink />
              <main id="main-content">
                {children}
              </main>
            </TooltipProvider>
            <Toaster />
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
