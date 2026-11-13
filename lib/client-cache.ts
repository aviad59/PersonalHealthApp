// Client-only. Pages paint from localStorage snapshots and the service worker
// keeps page HTML and meal photos, so all of it belongs to whoever is signed
// in. Wipe it on sign-out so the next account on this device never sees the
// previous one's meals, totals or coach thread.

export async function clearCachedAppData(): Promise<void> {
  try {
    localStorage.clear();
  } catch {}
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
}
