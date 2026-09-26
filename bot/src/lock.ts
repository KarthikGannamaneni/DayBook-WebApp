import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * One process per WhatsApp session, enforced with a PID file.
 *
 * WhatsApp allows a single connection per linked device. Two processes sharing an
 * auth directory do not queue politely: each connection evicts the other with
 * `conflict type="replaced"`, both reconnect, and the result is a reconnect storm
 * that corrupts the group cipher state — real messages then arrive as "failed to
 * decrypt message: Received message with old counter". It looks like several
 * unrelated bugs and is one.
 *
 * The lock lives BESIDE the auth directory rather than inside it, so nothing here
 * can be mistaken for a Baileys key file.
 */
export function acquireLock(authDir: string): () => void {
  const lockPath = `${authDir.replace(/\/+$/, '')}.lock`;

  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
      throw new Error(
        `another bot is already running (pid ${pid}) on ${authDir}.\n\n` +
        `  WhatsApp allows one connection per linked device. Starting a second\n` +
        `  makes the two evict each other until the session breaks.\n\n` +
        `  Stop it first:  kill ${pid}\n` +
        `  Then start again.`,
      );
    }
    // The holder is gone — a crash or a kill -9. Safe to take over.
    unlinkSync(lockPath);
  }

  writeFileSync(lockPath, String(process.pid), 'utf8');

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      // Already gone, or never written. Nothing to undo.
    }
  };

  process.on('exit', release);
  return release;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else.
    return (error as { code?: string }).code === 'EPERM';
  }
}
