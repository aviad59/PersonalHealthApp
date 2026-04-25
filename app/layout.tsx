import type { Metadata, Viewport } from "next";
import "./globals.css";
import BottomNav from "@/components/BottomNav";

export const metadata: Metadata = {
  title: "Health",
  description: "Personal AI health dashboard",
  manifest: undefined,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0a0b",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-white">
        <div className="mx-auto max-w-md min-h-dvh flex flex-col">
          <main className="flex-1 pb-24 safe-top">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
