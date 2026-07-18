"use client";

// A tiny "keep this running across page navigation" registry.
//
// Long requests (coach replies, meal analysis) used to be owned by the page
// component, so navigating away mid-request unmounted the owner and the
// fetch surfaced as "failed to fetch". This provider lives in the root
// layout — above the routed page — so a task started here runs to
// completion regardless of what page is mounted, records its result, and
// shows a global "still working" indicator on every screen.
//
// Because coach replies and meal saves are persisted server-side, leaving
// the page never loses the work; returning simply reloads it. Ephemeral
// results (a meal analysis not yet saved) are stashed here so the
// originating page can pick them back up on remount via `consume`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type TaskState<T = any> = {
  status: "pending" | "done" | "error";
  result?: T;
  error?: string;
  label?: string;
};

type Ctx = {
  run: <T>(key: string, fn: () => Promise<T>, opts?: { label?: string }) => Promise<T>;
  isPending: (key: string) => boolean;
  /** Returns and clears a completed (done/error) task's state, if any. */
  consume: (key: string) => TaskState | undefined;
};

const BgCtx = createContext<Ctx | null>(null);

export function useBackgroundTasks(): Ctx {
  const c = useContext(BgCtx);
  if (!c) throw new Error("useBackgroundTasks must be used within BackgroundTasksProvider");
  return c;
}

export default function BackgroundTasksProvider({ children }: { children: ReactNode }) {
  // Source of truth is a ref so reads (isPending/consume) are always
  // synchronous and reliable — a setState updater runs asynchronously, so
  // returning a value out of one (the old consume) returned undefined.
  const statesRef = useRef<Record<string, TaskState>>({});
  // `tick` exists only to trigger re-renders of consumers when the ref
  // changes; it's threaded into the context value below.
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const setTask = useCallback(
    (key: string, st: TaskState | null) => {
      const next = { ...statesRef.current };
      if (st === null) delete next[key];
      else next[key] = st;
      statesRef.current = next;
      bump();
    },
    [bump],
  );

  const run = useCallback(
    <T,>(key: string, fn: () => Promise<T>, opts?: { label?: string }): Promise<T> => {
      setTask(key, { status: "pending", label: opts?.label });
      // The IIFE keeps running even if the caller (a page component) unmounts
      // and abandons its await — this provider is always mounted.
      return (async () => {
        try {
          const result = await fn();
          setTask(key, { status: "done", result, label: opts?.label });
          return result;
        } catch (e: any) {
          setTask(key, { status: "error", error: e?.message ?? "failed", label: opts?.label });
          throw e;
        }
      })();
    },
    [setTask],
  );

  const isPending = useCallback((key: string) => statesRef.current[key]?.status === "pending", []);

  const consume = useCallback(
    (key: string): TaskState | undefined => {
      const st = statesRef.current[key];
      if (!st || st.status === "pending") return undefined;
      setTask(key, null);
      return st;
    },
    [setTask],
  );

  // `tick` is included so the context value changes when a task's state
  // changes, re-rendering consumers that read via isPending/consume.
  const value = useMemo(() => ({ run, isPending, consume }), [run, isPending, consume, tick]);

  const pendingLabels = Object.values(statesRef.current)
    .filter((s) => s.status === "pending" && s.label)
    .map((s) => s.label as string);

  return (
    <BgCtx.Provider value={value}>
      {children}
      {pendingLabels.length > 0 && (
        <div className="fixed left-1/2 -translate-x-1/2 z-50 bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+0.75rem)] md:bottom-4 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-bg-elev border border-border px-4 py-2 shadow-elev text-[12px] text-white/85">
            <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/25 border-t-accent-brand animate-spin" />
            {pendingLabels[0]}
            {pendingLabels.length > 1 && <span className="text-white/40">+{pendingLabels.length - 1}</span>}
          </div>
        </div>
      )}
    </BgCtx.Provider>
  );
}
