"use client";

// Tiny client component that does two things:
//
// 1) Registers /sw.js so the app becomes installable and benefits from the
//    offline shell cache + cached meal photos.
//
// 2) Captures Android's `beforeinstallprompt` event so we can show our own
//    "Install Health" banner (a one-time, dismissable strip at the top of
//    the home page). Without intercepting this event, Chrome shows its own
//    less-prominent "Install" hint in the address-bar menu that most users
//    never notice.
//
// We don't render anything visible for the install prompt yet — the banner
// UI hook is separate. For now this just stores the event so a later
// "Install" button can call `installPrompt.prompt()` on demand.

import { useEffect } from "react";

// Make the captured event globally available so any component can later
// surface an "Install app" button by calling window.__pwaInstallPrompt.prompt().
declare global {
  interface Window {
    __pwaInstallPrompt?: any;
  }
}

export default function PWARegister() {
  useEffect(() => {
    // Skip registration in dev — Next.js HMR + service workers fight each other
    // and you get stale-asset weirdness. Only register in production builds.
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => {
          // Non-fatal — app still works without the SW.
        });
    };
    // Wait for window load so the SW install doesn't fight with the
    // initial page render for bandwidth.
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    // Capture the install prompt so a button elsewhere can trigger it.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // stop Chrome from auto-showing its mini-infobar
      window.__pwaInstallPrompt = e;
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  return null;
}
