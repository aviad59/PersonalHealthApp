"use client";

// Small dismissable banner that appears at the top of the home page when
// Android Chrome/Edge has fired the `beforeinstallprompt` event (captured
// and stashed by <PWARegister />). Tapping "Install" triggers the native
// install dialog; tapping "Later" hides the banner for 14 days.
//
// On iOS Safari beforeinstallprompt never fires, so this component renders
// nothing. iOS users need to use Share → Add to Home Screen manually; we
// keep that copy out of the way since all three of our users are on Android.

import { useEffect, useState } from "react";

const DISMISS_KEY = "pwa_install_dismissed_until";
const SNOOZE_DAYS = 14;

export default function InstallPromptBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Respect the user's "Later" choice for a couple of weeks.
    const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (until > Date.now()) return;

    // Don't show if already installed.
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS-only flag, harmless to check here.
      (window.navigator as any).standalone === true;
    if (isStandalone) return;

    // The event might already be captured by the time we mount, or it might
    // fire shortly after. Poll once then listen.
    function maybeShow() {
      if (window.__pwaInstallPrompt) setShow(true);
    }
    maybeShow();
    const onPrompt = () => maybeShow();
    window.addEventListener("beforeinstallprompt", onPrompt);
    const t = setInterval(maybeShow, 1000);
    const stopPolling = setTimeout(() => clearInterval(t), 5000);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      clearInterval(t);
      clearTimeout(stopPolling);
    };
  }, []);

  if (!show) return null;

  async function install() {
    const ev = window.__pwaInstallPrompt;
    if (!ev) return;
    try {
      await ev.prompt();
      await ev.userChoice;
    } catch {
      // Some browsers throw if the prompt was already shown — non-fatal.
    }
    window.__pwaInstallPrompt = undefined;
    setShow(false);
  }

  function snooze() {
    const until = Date.now() + SNOOZE_DAYS * 86_400_000;
    localStorage.setItem(DISMISS_KEY, String(until));
    setShow(false);
  }

  return (
    <div className="card p-3 flex items-center gap-3 border-accent-brand/40">
      <div className="w-9 h-9 rounded-lg bg-accent-brand/15 border border-accent-brand/40 flex items-center justify-center text-accent-brand text-base font-bold">
        ↓
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold leading-tight">Install Health</div>
        <div className="text-[11px] text-white/50 leading-tight mt-0.5">
          One-tap launch, fullscreen, works offline.
        </div>
      </div>
      <button
        onClick={snooze}
        className="text-[11px] text-white/50 px-2 py-1.5"
      >
        Later
      </button>
      <button
        onClick={install}
        className="text-[12px] font-semibold bg-accent-brand text-white rounded-lg px-3 py-1.5"
      >
        Install
      </button>
    </div>
  );
}
