"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type AdminUser = {
  id: string;
  email: string | null;
  displayName: string;
  status: "pending" | "active" | "disabled";
  hasWorkouts: boolean;
  isAdmin: boolean;
  trainingNotes: string | null;
  hevyKeyEnv: string | null;
  hasHevyApiKey?: boolean;
  createdAt: string;
};

const STATUS_LABEL: Record<AdminUser["status"], string> = {
  pending: "Pending",
  active: "Active",
  disabled: "Disabled",
};
const STATUS_CLASS: Record<AdminUser["status"], string> = {
  pending: "bg-amber-500/15 text-amber-400",
  active: "bg-emerald-500/15 text-emerald-400",
  disabled: "bg-white/10 text-white/50",
};

export default function AdminUsersClient() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/admin/users", { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "load failed");
      const j = await r.json();
      setUsers(j.users);
    } catch (e: any) {
      setErr(e?.message || "load failed");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(id: string, fields: Partial<AdminUser>) {
    setBusyId(id);
    setErr(null);
    try {
      const r = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...fields }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "update failed");
      setUsers(j.users ?? null);
      if (!j.users) await load();
    } catch (e: any) {
      setErr(e?.message || "update failed");
    } finally {
      setBusyId(null);
    }
  }

  const pending = users?.filter((u) => u.status === "pending") ?? [];
  const others = users?.filter((u) => u.status !== "pending") ?? [];

  return (
    <div className="px-5 pt-6 pb-24 space-y-5 md:max-w-3xl md:mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-white/60 mt-1">Approve new sign-ins and manage access.</p>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/admin/analyzer" className="text-[13px] text-accent-brand">
            Analyzer Lab
          </Link>
          <Link href="/profile" className="text-[13px] text-accent-brand">
            Done
          </Link>
        </div>
      </div>

      {err && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-300">
          {err}
        </div>
      )}

      {users === null && !err && (
        <div className="text-sm text-white/40">Loading…</div>
      )}

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-400/80">
            Pending approval ({pending.length})
          </h2>
          {pending.map((u) => (
            <UserCard key={u.id} user={u} busy={busyId === u.id} onPatch={patch} />
          ))}
        </section>
      )}

      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">
            Members ({others.length})
          </h2>
          {others.map((u) => (
            <UserCard key={u.id} user={u} busy={busyId === u.id} onPatch={patch} />
          ))}
        </section>
      )}
    </div>
  );
}

function UserCard({
  user,
  busy,
  onPatch,
}: {
  user: AdminUser;
  busy: boolean;
  onPatch: (id: string, fields: Partial<AdminUser>) => void;
}) {
  const [name, setName] = useState(user.displayName);
  const [notes, setNotes] = useState(user.trainingNotes ?? "");
  const [hevy, setHevy] = useState(user.hevyKeyEnv ?? "");
  // The stored key is never sent to the browser; blank means "leave as is".
  const [hevyKey, setHevyKey] = useState("");
  const [open, setOpen] = useState(false);

  // Keep local edit fields in sync when the row is refreshed from the server.
  useEffect(() => {
    setName(user.displayName);
    setNotes(user.trainingNotes ?? "");
    setHevy(user.hevyKeyEnv ?? "");
  }, [user.displayName, user.trainingNotes, user.hevyKeyEnv]);

  const dirty =
    name.trim() !== user.displayName ||
    notes !== (user.trainingNotes ?? "") ||
    hevy.trim() !== (user.hevyKeyEnv ?? "") ||
    hevyKey.trim() !== "";

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{user.displayName}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_CLASS[user.status]}`}>
              {STATUS_LABEL[user.status]}
            </span>
            {user.isAdmin && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-brand/15 text-accent-brand">
                Admin
              </span>
            )}
          </div>
          <div className="text-xs text-white/50 truncate mt-0.5">{user.email || "—"}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {user.status === "pending" ? (
            <button
              onClick={() => onPatch(user.id, { status: "active" })}
              disabled={busy}
              className="rounded-full bg-accent-brand px-4 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              Approve
            </button>
          ) : user.status === "active" ? (
            <button
              onClick={() => onPatch(user.id, { status: "disabled" })}
              disabled={busy}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-white/60 disabled:opacity-40"
            >
              Disable
            </button>
          ) : (
            <button
              onClick={() => onPatch(user.id, { status: "active" })}
              disabled={busy}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-white/70 disabled:opacity-40"
            >
              Re-enable
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-white/45"
          >
            {open ? "Hide settings" : "Settings"}
          </button>
        </div>
      </div>

      {/* Quick toggles */}
      <div className="flex flex-wrap gap-2">
        <Toggle
          label="Workouts"
          on={user.hasWorkouts}
          disabled={busy}
          onClick={() => onPatch(user.id, { hasWorkouts: !user.hasWorkouts })}
        />
        <Toggle
          label="Admin"
          on={user.isAdmin}
          disabled={busy}
          onClick={() => onPatch(user.id, { isAdmin: !user.isAdmin })}
        />
      </div>

      {open && (
        <div className="space-y-3 pt-1">
          <Field label="Display name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </Field>
          <Field
            label={`Hevy API key ${user.hasHevyApiKey ? "(stored — type to replace)" : "(paste the key itself)"}`}
          >
            <input
              type="password"
              value={hevyKey}
              onChange={(e) => setHevyKey(e.target.value)}
              placeholder={user.hasHevyApiKey ? "•••••••• stored" : "paste your Hevy API key"}
              className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Advanced: env var name instead (blank = HEVY_API_KEY_ID)">
            <input
              value={hevy}
              onChange={(e) => setHevy(e.target.value)}
              placeholder={`HEVY_API_KEY_${user.id.toUpperCase()}`}
              className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Training notes (standing coaching direction)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-lg bg-bg-elev border border-border px-3 py-2 text-sm resize-none"
            />
          </Field>
          <button
            onClick={() =>
              onPatch(user.id, {
                displayName: name.trim() || user.id,
                trainingNotes: notes.trim() ? notes : null,
                hevyKeyEnv: hevy.trim() ? hevy.trim() : null,
                // Only send when typed, so saving other fields doesn't wipe it.
                ...(hevyKey.trim() ? { hevyApiKey: hevyKey.trim() } : {}),
              } as Partial<AdminUser>)
            }
            disabled={busy || !dirty}
            className="rounded-full bg-accent-brand px-4 py-2 text-xs font-semibold disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  on,
  disabled,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors disabled:opacity-40 ${
        on
          ? "border-accent-brand/50 bg-accent-brand/15 text-accent-brand"
          : "border-border text-white/50"
      }`}
    >
      {label}: {on ? "On" : "Off"}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-white/50 mb-1">{label}</span>
      {children}
    </label>
  );
}
