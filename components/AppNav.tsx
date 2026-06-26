"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useLang } from "@/components/LangProvider";
import { t } from "@/lib/i18n";
import { isUserId, getUserConfig } from "@/lib/user";

type NavItem = {
  href: string;
  labelKey: "nav_today" | "nav_log" | "nav_stats" | "nav_insights" | "nav_coach" | "nav_workouts" | "nav_profile";
  icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element;
  workoutsOnly?: boolean;
};

const items: NavItem[] = [
  { href: "/", labelKey: "nav_today", icon: HomeIcon },
  { href: "/meals/log", labelKey: "nav_log", icon: CameraIcon },
  { href: "/stats", labelKey: "nav_stats", icon: ChartIcon },
  { href: "/coach", labelKey: "nav_coach", icon: ChatIcon },
  { href: "/insights", labelKey: "nav_insights", icon: SparklesIcon },
  { href: "/workouts", labelKey: "nav_workouts", icon: DumbbellIcon, workoutsOnly: true },
  { href: "/profile", labelKey: "nav_profile", icon: UserIcon },
];

/**
 * App navigation. Renders as a bottom tab bar on mobile/tablet and as a
 * sticky left sidebar on desktop (md and up), sharing the same item list
 * and active-state logic.
 */
export default function AppNav() {
  const pathname = usePathname() || "/";
  const lang = useLang();
  const { data: session } = useSession();
  const appUserId = (session as any)?.appUserId;
  const hideWorkouts = isUserId(appUserId) ? !getUserConfig(appUserId).hasWorkouts : false;

  if (pathname.startsWith("/onboarding")) return null;
  if (pathname.startsWith("/signin")) return null;
  const visible = items.filter((it) => !(it.workoutsOnly && hideWorkouts));

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex md:flex-col md:w-56 md:shrink-0 md:h-dvh md:sticky md:top-0 border-e border-border bg-bg-card/40 px-3 py-6 gap-1">
        <div className="px-3 mb-6 text-lg font-bold tracking-tight">Health</div>
        {visible.map((it) => {
          const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "text-white bg-accent-brand/15"
                  : "text-white/50 hover:text-white/80 hover:bg-white/5"
              }`}
            >
              <it.icon className={`h-5 w-5 shrink-0 ${active ? "text-accent-brand" : ""}`} />
              <span>{t(lang, it.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 safe-bottom">
        <div className="mx-auto w-full max-w-md sm:max-w-lg">
          <div className="mx-3 mb-3 rounded-3xl border border-border bg-bg-card/80 backdrop-blur-xl shadow-elev px-1.5 py-1.5 flex justify-between gap-0.5">
            {visible.map((it) => {
              const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`flex-1 min-w-0 flex flex-col items-center gap-1 rounded-2xl py-2 text-[10px] font-medium transition-all active:scale-95 ${
                    active
                      ? "text-white bg-accent-brand/15"
                      : "text-white/45 hover:text-white/80 hover:bg-white/5"
                  }`}
                >
                  <it.icon
                    className={`h-5 w-5 shrink-0 transition-colors ${
                      active ? "text-accent-brand" : ""
                    }`}
                  />
                  <span className="max-w-full truncate px-0.5">{t(lang, it.labelKey)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}

function HomeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}
function CameraIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
function SparklesIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
    </svg>
  );
}
function DumbbellIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 4v16M3 7v10M18 4v16M21 7v10M6 12h12" />
    </svg>
  );
}
function ChartIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="12" y="8" width="3" height="10" rx="0.5" />
      <rect x="17" y="5" width="3" height="13" rx="0.5" />
    </svg>
  );
}
function UserIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}
function ChatIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
