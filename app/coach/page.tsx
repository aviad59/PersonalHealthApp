"use client";

// AI coach chat. Persistent thread per user, full data context, mobile-first
// chat bubbles. The conversation is server-backed (user_coach_messages) so
// it survives refresh / app reinstall.

import React, { useEffect, useRef, useState } from "react";
import { safeFetchJson } from "@/lib/fetch-json";
import { useLang } from "@/components/LangProvider";
import { useBackgroundTasks } from "@/components/BackgroundTasks";
import { t, Lang } from "@/lib/i18n";

const COACH_TASK = "coach-send";

const CACHE_KEY = "coach-messages";
function lsGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function lsSet(key: string, val: unknown) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function lsDel(key: string) { try { localStorage.removeItem(key); } catch {} }

type Msg = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

const STARTER_KEYS = [
  "coach_starter_1",
  "coach_starter_2",
  "coach_starter_3",
  "coach_starter_4",
] as const;

export default function CoachPage() {
  const lang = useLang();
  const bg = useBackgroundTasks();
  // The send itself runs in the background provider so it survives leaving
  // the page — "sending" is derived from the provider, not local state.
  const sending = bg.isPending(COACH_TASK);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const wasSending = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Touch devices (phones/tablets) get a software keyboard with its own send
  // affordance — let Enter insert a newline there and reserve the Send button
  // for sending. Physical keyboards keep Enter-to-send.
  useEffect(() => {
    setIsTouchDevice(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  // Initial load — show cached thread instantly, refresh from server in background.
  useEffect(() => {
    const cached = lsGet<Msg[]>(CACHE_KEY);
    if (cached) {
      setMessages(cached);
      setLoading(false);
    }

    (async () => {
      try {
        const j = await safeFetchJson<{ messages: Msg[] }>("/api/coach", {
          cache: "no-store",
        });
        const msgs = j.messages || [];
        setMessages(msgs);
        lsSet(CACHE_KEY, msgs);
      } catch (e: any) {
        if (!cached) setErr(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-scroll to the bottom whenever the message list changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function reloadThread() {
    try {
      const r = await safeFetchJson<{ messages: Msg[] }>("/api/coach", { cache: "no-store" });
      const msgs = r.messages || [];
      setMessages(msgs);
      lsSet(CACHE_KEY, msgs);
    } catch {
      // non-fatal
    }
  }

  // When a background coach-send finishes (whether we stayed on the page or
  // came back to it mid-flight), pull the thread so the reply appears.
  useEffect(() => {
    if (wasSending.current && !sending) reloadThread();
    wasSending.current = sending;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setErr(null);
    // Optimistic append so the bubble appears immediately, before the round-trip.
    const optimistic: Msg = {
      id: Date.now(),
      role: "user",
      content: trimmed,
    };
    setMessages((m) => [...m, optimistic]);
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";

    try {
      // Runs in the background provider, so navigating away won't abort it
      // and won't throw "failed to fetch". The reply is persisted
      // server-side; the sending-transition effect reloads the thread when
      // it completes. The global spinner shows progress on any page.
      await bg.run(
        COACH_TASK,
        () =>
          safeFetchJson<{ reply: string }>("/api/coach", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: trimmed }),
          }),
        { label: t(lang, "coach_thinking") },
      );
    } catch (e: any) {
      setErr(e.message);
      // Leave the optimistic user bubble visible so the user sees what they sent.
    }
  }

  async function clearThread() {
    if (!confirm(t(lang, "coach_clear_confirm"))) return;
    try {
      await fetch("/api/coach", { method: "DELETE" });
      setMessages([]);
      lsDel(CACHE_KEY);
    } catch {
      // non-fatal
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter to send on physical keyboards; Shift+Enter (or Enter on touch
    // devices) inserts a newline instead.
    if (e.key === "Enter" && !e.shiftKey && !isTouchDevice) {
      e.preventDefault();
      send(input);
    }
  }

  function autoGrow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  return (
    <div
      // -mb-28 cancels the layout <main>'s pb-28 (which is sized generously
      // for scrolling pages); without it there'd be a gap between the
      // composer and the fixed nav. Height then fills exactly from the top
      // safe area down to the top of the nav, so the composer sits flush.
      className="flex flex-col -mb-28 md:mb-0 md:max-w-3xl md:mx-auto md:w-full"
      style={{
        height:
          "calc(100dvh - var(--nav-h) - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
      }}
    >
      {/* Chat header — avatar, name, online status */}
      <div className="px-4 pt-5 pb-3 flex items-center gap-3 border-b border-border">
        <CoachAvatar size={42} />
        <div className="flex-1 min-w-0">
          <div className="text-[16px] font-bold leading-tight">{t(lang, "coach_title")}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-white/50 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {t(lang, "coach_status")}
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearThread}
            className="text-[11px] text-white/40 hover:text-white/70 transition-colors shrink-0"
          >
            {t(lang, "coach_clear")}
          </button>
        )}
      </div>

      {/* Scrollable message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <div className="text-sm text-white/50 px-2 pt-2">{t(lang, "coach_loading")}</div>
        ) : messages.length === 0 ? (
          <EmptyState lang={lang} onPick={(q) => send(q)} />
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
        {sending && <TypingBubble />}
        {err && (
          <div className="text-xs text-red-400 px-2 mt-1">{err}</div>
        )}
      </div>

      {/* Composer */}
      <div className="px-3 pb-3 pt-2 border-t border-border bg-bg-card/70 backdrop-blur">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={input}
            onChange={autoGrow}
            onKeyDown={onKeyDown}
            placeholder={t(lang, "coach_placeholder")}
            dir={input ? (/[֐-׿]/.test(input) ? "rtl" : "ltr") : lang === "he" ? "rtl" : "ltr"}
            rows={1}
            className="flex-1 resize-none rounded-2xl bg-bg-elev border border-border px-4 py-3 text-[15px] leading-snug focus:outline-none focus:border-white/30"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || sending}
            className="rounded-full bg-accent-brand text-white font-semibold px-4 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? "…" : t(lang, "coach_send")}
          </button>
        </div>
      </div>
    </div>
  );
}

function hasHebrew(text: string) {
  return /[֐-׿יִ-ﭏ]/.test(text);
}

function renderContent(text: string): React.ReactNode {
  // Split on **bold** markers and render <strong> for matched segments
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

/** Template coach profile image — a person glyph on the brand gradient. */
function CoachAvatar({ size = 32 }: { size?: number }) {
  return (
    <div
      className="rounded-full bg-gradient-to-br from-[#12b0f0] to-[#0a4e6d] flex items-center justify-center shrink-0 shadow-[0_2px_6px_rgba(0,0,0,0.3)] ring-1 ring-white/15"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.62}
        height={size * 0.62}
        className="text-white"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="8.5" r="3.3" />
        <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
      </svg>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  const rtl = hasHebrew(msg.content);
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          dir={rtl ? "rtl" : "ltr"}
          className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent-brand text-white px-4 py-2.5 text-[14px] leading-snug whitespace-pre-wrap shadow-sm"
        >
          {renderContent(msg.content)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start items-end gap-2">
      <CoachAvatar size={28} />
      <div
        dir={rtl ? "rtl" : "ltr"}
        className="max-w-[80%] rounded-2xl rounded-bl-sm bg-bg-elev border border-border text-white/90 px-4 py-2.5 text-[14px] leading-snug whitespace-pre-wrap shadow-sm"
      >
        {renderContent(msg.content)}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start items-end gap-2">
      <CoachAvatar size={28} />
      <div className="bg-bg-elev border border-border rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ lang, onPick }: { lang: Lang; onPick: (q: string) => void }) {
  const rtl = lang === "he";
  return (
    <div className="pt-8 px-2 space-y-5" dir={rtl ? "rtl" : "ltr"}>
      <div className="flex flex-col items-center text-center space-y-3">
        <CoachAvatar size={64} />
        <div className="text-base font-semibold">{t(lang, "coach_empty_title")}</div>
        <p className="text-[13px] text-white/55 leading-snug max-w-xs">
          {t(lang, "coach_empty_desc")}
        </p>
      </div>
      <div className="space-y-2 md:space-y-0 md:grid md:grid-cols-2 md:gap-2">
        {STARTER_KEYS.map((k) => {
          const q = t(lang, k);
          return (
            <button
              key={k}
              onClick={() => onPick(q)}
              className={`w-full text-[13px] text-white/80 bg-bg-elev border border-border rounded-xl px-3 py-2.5 hover:border-white/30 transition-colors ${
                rtl ? "text-right" : "text-left"
              }`}
            >
              {q}
            </button>
          );
        })}
      </div>
    </div>
  );
}
