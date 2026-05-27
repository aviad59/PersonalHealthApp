import type { Metadata, Viewport } from "next";
import "./globals.css";
import BottomNav from "@/components/BottomNav";
import LangProvider from "@/components/LangProvider";
import PWARegister from "@/components/PWARegister";

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
  themeColor: "#0a0a0b",
  // viewportFit: cover lets the app draw under the status bar / nav bar when
  // installed as a PWA — needed for the immersive feel on Android.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-white">
        <LangProvider>
          <div className="mx-auto w-full max-w-md sm:max-w-lg lg:max-w-xl min-h-dvh flex flex-col">
            <main className="flex-1 pb-28 safe-top">{children}</main>
            <BottomNav />
          </div>
        </LangProvider>
        {/* Registers the service worker on the client. Kept as a tiny
            standalone client component so we don't have to turn this whole
            layout into a client component just for one effect. */}
        <PWARegister />
      </body>
    </html>
  );
}
