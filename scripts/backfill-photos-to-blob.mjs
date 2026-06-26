#!/usr/bin/env node
/**
 * One-off backfill: move full-size meal photos that are still stored as
 * inline base64 data URIs (legacy rows, from before the Vercel Blob
 * migration) out into Blob storage, replacing the column value with the
 * short Blob pathname.
 *
 * Thumbnails are left alone — they're small and meant to stay inline.
 *
 * Requires:
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN  — same DB the app uses
 *   BLOB_READ_WRITE_TOKEN                  — same Blob store the app uses
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-photos-to-blob.mjs
 *   (or with prod env vars exported directly, to run against prod)
 *
 * Safe to re-run: rows already migrated (pathname, not a data: URI) are
 * skipped. Each row is committed independently, so a failure partway
 * through just leaves the remaining rows for the next run.
 */

import { createClient } from "@libsql/client";
import { put } from "@vercel/blob";

const dbUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!dbUrl) {
  console.error("TURSO_DATABASE_URL is not set.");
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set.");
  process.exit(1);
}

const db = createClient({ url: dbUrl, authToken });

function mimeFromDataUri(dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUri);
  return match ? { mime: match[1], base64: match[2] } : null;
}

async function migrateColumn(column) {
  const res = await db.execute({
    sql: `SELECT id, user_id, ${column} AS val FROM meals WHERE ${column} LIKE 'data:%'`,
    args: [],
  });

  console.log(`${column}: ${res.rows.length} legacy row(s) to migrate`);
  let migrated = 0;
  let failed = 0;

  for (const row of res.rows) {
    const id = row.id;
    const userId = row.user_id;
    const decoded = mimeFromDataUri(String(row.val));
    if (!decoded) {
      console.warn(`  skip meal ${id}: ${column} doesn't look like a data URI`);
      failed++;
      continue;
    }
    try {
      const buffer = Buffer.from(decoded.base64, "base64");
      const result = await put(`meals/${userId}/${Date.now()}-${id}-${column}.jpg`, buffer, {
        access: "private",
        contentType: decoded.mime,
        addRandomSuffix: true,
      });
      await db.execute({
        sql: `UPDATE meals SET ${column} = ? WHERE id = ?`,
        args: [result.pathname, id],
      });
      migrated++;
      console.log(`  meal ${id}: migrated (${buffer.length} bytes -> ${result.pathname})`);
    } catch (err) {
      failed++;
      console.error(`  meal ${id}: FAILED — ${err.message}`);
    }
  }

  console.log(`${column}: ${migrated} migrated, ${failed} failed`);
  return { migrated, failed };
}

const a = await migrateColumn("photo_path");
const b = await migrateColumn("photo_path_2");

console.log(`\nTotal: ${a.migrated + b.migrated} migrated, ${a.failed + b.failed} failed`);
if (a.failed + b.failed > 0) process.exitCode = 1;
