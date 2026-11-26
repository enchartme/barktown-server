import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

export function mountedObjectPath(bucketRoot, key) {
  if (typeof key !== 'string' || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid bucket-relative path');
  }
  const file = path.resolve(bucketRoot, key);
  if (!file.startsWith(bucketRoot + path.sep)) throw new Error('Object path escaped the bucket mount');
  return file;
}

/** A server-side archive copy can take time to appear in a mounted bucket. */
export async function copyMountedHistoricalSource({ bucketRoot, ticket, destination,
  timeoutMs = 120000, intervalMs = 2000, onWait = () => {},
  copyFile = fs.copyFile, stat = fs.stat, sleep = setTimeout, now = Date.now }) {
  const keys = [ticket.archiveKey];
  // The original remains available until the Pi commits the import. Its bytes
  // are checked against the archived source by the Pi's SHA-256 verification.
  if (ticket.original && ticket.original.size === ticket.archive.size && ticket.entry.audioPath !== ticket.archiveKey) {
    keys.push(ticket.entry.audioPath);
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    for (const key of keys) {
      const source = mountedObjectPath(bucketRoot, key);
      try {
        const visible = await stat(source);
        if (visible.size !== ticket.archive.size) continue;
        await copyFile(source, destination);
        if ((await stat(destination)).size === ticket.archive.size) return key;
      } catch (error) {
        // Permission errors and local write failures are not visibility lag.
        if (error.code !== 'ENOENT' || error.path === destination) throw error;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Timed out waiting for the mount to expose a complete source: ${keys.join(' or ')}`);
    onWait(`Mount has not exposed the complete source yet; retrying in ${Math.min(intervalMs, remaining) / 1000}s`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** Mounted writes may finish locally before the Pi can read their objects. */
export async function commitWhenStagedFilesVisible(commit, { timeoutMs = 120000, intervalMs = 2000,
  onWait = () => {}, sleep = setTimeout, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try { return await commit(); }
    catch (error) {
      const pending = error.statusCode === 409
        && /^(Missing or incomplete staged file|Staged file changed during verification): /.test(error.message);
      const remaining = deadline - now();
      if (!pending || remaining <= 0) throw error;
      onWait(`Waiting for mounted uploads to reach the Pi; retrying in ${Math.min(intervalMs, remaining) / 1000}s`);
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}
