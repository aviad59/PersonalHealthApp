// User picker shown when no `cowork_user` cookie is set, and reachable
// from the Profile page's "Switch user" button. Two big buttons — one
// per known user — set the cookie and navigate home.

"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { USER_LIST, USER_COOKIE, type UserId } from "@/lib/user";

export default function SelectUserPage() {
  // Suspense wrapper required because useSearchParams() forces dynamic
  // rendering, and Next 14 requires it to live inside a boundary so the
  // surrounding page can statically render the layout shell.
  return (
    <Suspense fallback={<PickerFallback />}>
      <Picker />
    </Suspense>
  );
}

function PickerFallback() {
  return (
    <div className="px-5 pt-16 pb-10 space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Who&apos;s using the app?</h1>
      </div>
    </div>
  );
}

function Picker() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // After picking, send the user back to whichever page they came from
  // (defaults to home). Profile's "switch user" link passes ?next=/profile.
  const next = searchParams?.get("next") || "/";

  function pick(id: UserId) {
    // 1 year, lax, available to client JS so the picker can switch.
    document.cookie = `${USER_COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.push(next);
    router.refresh();
  }

  return (
    <div className="px-5 pt-16 pb-10 space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Who&apos;s using the app?</h1>
        <p className="text-sm text-white/60">
          Pick your profile. You can switch any time from the Profile tab.
        </p>
      </div>

      <div className="space-y-3">
        {USER_LIST.map((u) => (
          <button
            key={u.id}
            onClick={() => pick(u.id)}
            className="w-full card p-5 flex items-center gap-4 active:scale-[0.99] transition-transform"
          >
            <div className="w-14 h-14 rounded-full bg-bg-elev border border-border flex items-center justify-center text-2xl font-semibold">
              {u.displayName[0]}
            </div>
            <div className="flex-1 text-left">
              <div className="text-lg font-semibold">{u.displayName}</div>
              <div className="text-[12px] text-white/50 mt-0.5">
                {u.hasWorkouts
                  ? "Meals, workouts & recovery"
                  : "Meals & macros (no workouts)"}
              </div>
            </div>
            <div className="text-white/30 text-2xl">→</div>
          </button>
        ))}
      </div>

      <p className="text-[11px] text-white/30 text-center">
        Each profile has its own meals, weight log, insights, and goals.
      </p>
    </div>
  );
}
