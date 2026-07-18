import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppNav from "@/components/AppNav";
import LangProvider from "@/components/LangProvider";
import PWARegister from "@/components/PWARegister";
import AuthProvider from "@/components/AuthProvider";
import BackgroundTasksProvider from "@/components/BackgroundTasks";

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
  themeColor: "#080c10",
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
    <html lang="en" className="dark">
      <body className="bg-bg text-white">
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
