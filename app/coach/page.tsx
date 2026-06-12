"use client";

// AI coach chat. Persistent thread per user, full data context, mobile-first
// chat bubbles. The conversation is server-backed (user_coach_messages) so
// it survives refresh / app reinstall.

import React, { useEffect, useRef, useState } from "react";
import { safeFetchJson } from "@/lib/fetch-json";

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

const STARTER_PROMPTS = [
  "What should I eat for dinner tonight?",
  "Am I on track with my protein this week?",
  "What's my weight trend doing?",
  "Should I train today?",
];

export default function CoachPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setErr(null);
    setSending(true);
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
      const j = await safeFetchJson<{ reply: string }>("/api/coach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      // Reload the real history so message ids/timestamps come from the DB.
      const r = await safeFetchJson<{ messages: Msg[] }>("/api/coach", {
        cache: "no-store",
      });
      const msgs = r.messages || [];
      setMessages(msgs);
      lsSet(CACHE_KEY, msgs);
      // If the reload somehow lost the assistant turn, fall back to the inline reply.
      if (!msgs.some((m) => m.role === "assistant" && m.content === j.reply)) {
        setMessages((m) => [
          ...m,
          { id: Date.now() + 1, role: "assistant", content: j.reply },
        ]);
      }
    } catch (e: any) {
      setErr(e.message);
      // Leave the optimistic user bubble visible so the user sees what they sent.
    } finally {
      setSending(false);
    }
  }

  async function clearThread() {
    if (!confirm("Clear the whole conversation?")) return;
    try {
      await fetch("/api/coach", { method: "DELETE" });
      setMessages([]);
      lsDel(CACHE_KEY);
    } catch {
      // non-fatal
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter to send; Shift+Enter for newline (mobile keyboards send Enter).
    if (e.key === "Enter" && !e.shiftKey) {
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
    <div className="flex flex-col h-[calc(100dvh-7rem)] md:max-w-3xl md:mx-auto md:w-full">
      {/* Header */}
      <div className="px-5 pt-6 pb-3 flex items-end justify-between">
        <div>
          <div className="text-xs text-white/50 uppercase tracking-wider">AI coach</div>
          <h1 className="text-2xl font-bold mt-0.5">Coach</h1>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearThread}
            className="text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Scrollable message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-2 space-y-2">
        {loading ? (
          <div className="text-sm text-white/50 px-2 pt-2">Loading thread…</div>
        ) : messages.length === 0 ? (
          <EmptyState onPick={(q) => send(q)} />
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
            placeholder="Ask anything about your training or nutrition…"
            rows={1}
            className="flex-1 resize-none rounded-2xl bg-bg-elev border border-border px-4 py-3 text-[15px] leading-snug focus:outline-none focus:border-white/30"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || sending}
            className="rounded-2xl bg-accent-brand text-white font-semibold px-4 py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? "…" : "Send"}
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

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  const rtl = hasHebrew(msg.content);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        dir={rtl ? "rtl" : "ltr"}
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-snug whitespace-pre-wrap ${
          isUser
            ? "bg-accent-brand text-white rounded-br-md"
            : "bg-bg-elev border border-border text-white/90 rounded-bl-md"
        }`}
      >
        {renderContent(msg.content)}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="bg-bg-elev border border-border rounded-2xl rounded-bl-md px-4 py-3">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="pt-10 px-2 space-y-5">
      <div className="text-center space-y-2">
        <div className="text-base font-semibold">Ask me anything</div>
        <p className="text-[13px] text-white/55 leading-snug">
          I can see your profile, today's meals, recent weight, and (if you track them) your workouts.
        </p>
      </div>
      <div className="space-y-2 md:space-y-0 md:grid md:grid-cols-2 md:gap-2">
        {STARTER_PROMPTS.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="w-full text-left text-[13px] text-white/80 bg-bg-elev border border-border rounded-xl px-3 py-2.5 hover:border-white/30 transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
