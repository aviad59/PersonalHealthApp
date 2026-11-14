import type { Metadata, Viewport } from "next";
import { Heebo, Rubik } from "next/font/google";
import "./globals.css";
import AppNav from "@/components/AppNav";
import LangProvider from "@/components/LangProvider";
import PWARegister from "@/components/PWARegister";
import AuthProvider from "@/components/AuthProvider";
import BackgroundTasksProvider from "@/components/BackgroundTasks";
import { THEME_COLORS, THEME_INIT_SCRIPT } from "@/lib/theme";

// One font per theme (globals.css picks via --font-app): Heebo for the light
// Fresh theme, Rubik for the dark Sunset one. Both cover Hebrew, and
// next/font self-hosts them, so there's no request to Google at runtime.
const heebo = Heebo({ subsets: ["latin", "hebrew"], variable: "--font-heebo", display: "swap" });
const rubik = Rubik({ subsets: ["latin", "hebrew"], variable: "--font-rubik", display: "swap" });

export const metadata: Metadata = {
  title: "Health",
  description: "Personal AI health dashboard",
  // PWA wiring: the manifest + apple touch icon let Android Chrome and Edge
  // offer "Install app" via beforeinstallprompt, and tell iOS Safari which
  // glyph to show if any user later adds it to home screen there.
  manifest: "/manifest.webmanifest",
  applicationName: "Health",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Health",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
  // viewportFit: cover lets the app draw under the status bar / nav bar when
  // installed as a PWA — needed for the immersive feel on Android.
  viewportFit: "cover",
  // When the on-screen keyboard opens, shrink the layout to the space above
  // it so a focused composer sits right above the keyboard (and the nav can
  // be hidden) instead of the keyboard overlaying content.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: THEME_INIT_SCRIPT may set data-theme before
    // React hydrates.
    <html lang="en" className={`${heebo.variable} ${rubik.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-bg text-ink">
        <AuthProvider>
          <LangProvider>
            <BackgroundTasksProvider>
              <div className="md:flex md:min-h-dvh">
                <AppNav />
                <div className="flex-1 md:flex md:justify-center">
                  <div className="mx-auto w-full max-w-md sm:max-w-lg md:max-w-6xl min-h-dvh flex flex-col md:px-8 md:py-8">
                    <main className="flex-1 pb-28 md:pb-0 safe-top">{children}</main>
                  </div>
                </div>
              </div>
            </BackgroundTasksProvider>
          </LangProvider>
        </AuthProvider>
        {/* Registers the service worker on the client. Kept as a tiny
            standalone client component so we don't have to turn this whole
            layout into a client component just for one effect. */}
        <PWARegister />
      </body>
    </html>
  );
}
