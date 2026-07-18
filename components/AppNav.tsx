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

// Insights and Workouts intentionally omitted from the nav: insights are
// generated/viewed from the Home insights card, and workouts auto-sync on
// Home open. Both routes still exist and are reachable via Home links.
const items: NavItem[] = [
  { href: "/", labelKey: "nav_today", icon: HomeIcon },
  { href: "/stats", labelKey: "nav_stats", icon: ChartIcon },
  { href: "/meals/log", labelKey: "nav_log", icon: CameraIcon },
  { href: "/coach", labelKey: "nav_coach", icon: ChatIcon },
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
      {/* Desktop navigation rail (M3-flavored sidebar) */}
      <nav className="hidden md:flex md:flex-col md:w-56 md:shrink-0 md:h-dvh md:sticky md:top-0 border-e border-border bg-bg-card/40 px-3 py-6 gap-1">
        <div className="px-3 mb-6 text-lg font-bold tracking-tight">Health</div>
        {visible.map((it) => {
          const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`state-layer flex items-center gap-3 rounded-full px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "text-accent-on-sec-container bg-accent-sec-container"
                  : "text-white/55 hover:text-white/85"
              }`}
            >
              <it.icon className={`h-5 w-5 shrink-0 ${active ? "text-accent-on-sec-container" : ""}`} />
              <span>{t(lang, it.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      {/* Mobile Navigation Bar — matches the Home header: same sky-blue
          gradient, rounded top corners, and glow. */}
      <nav className="mobile-nav md:hidden fixed bottom-0 left-0 right-0 z-40 rounded-t-[28px] overflow-hidden bg-gradient-to-br from-[#12b0f0] via-[#0b82b6] to-[#0a4e6d] shadow-[0_-10px_30px_-12px_rgba(14,165,233,0.55)] safe-bottom">
        {/* soft decorative glow, mirrors the header banner */}
        <div className="absolute -top-10 -left-8 w-36 h-24 rounded-full bg-white/10 blur-2xl pointer-events-none" />
        <div className="relative mx-auto w-full max-w-md sm:max-w-lg flex justify-between items-center px-1.5 h-[var(--nav-h)]">
          {visible.map((it) => {
            const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className="flex-1 min-w-0 flex flex-col items-center gap-1 py-1"
              >
                {/* Active indicator pill — a frosted white chip on the
                    gradient (like the header's logo/avatar tiles). Flexible
                    width with a cap so tabs never overflow a narrow phone. */}
                <span
                  className={`relative flex items-center justify-center h-8 w-full max-w-[3.25rem] rounded-full transition-colors ${
                    active ? "bg-white/25" : "bg-transparent"
                  }`}
                >
                  {active && (
                    <span
                      className="absolute inset-0 rounded-full bg-white/25"
                      style={{ animation: "m3-indicator-in 220ms ease" }}
                    />
                  )}
                  <it.icon
                    className={`relative h-[21px] w-[21px] shrink-0 transition-colors ${
                      active ? "text-white" : "text-white/65"
                    }`}
                  />
                </span>
                <span
                  className={`max-w-full truncate px-0.5 text-[10px] leading-tight transition-colors ${
                    active ? "text-white font-semibold" : "text-white/70 font-medium"
                  }`}
                >
                  {t(lang, it.labelKey)}
                </span>
              </Link>
            );
          })}
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
