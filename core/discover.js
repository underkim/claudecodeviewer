import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Overridable so tests can point discovery at a synthetic directory
// instead of the real ~/.claude.
export const PROJECTS_DIR =
  process.env.CLAUDE_VIEWER_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

// A session's cwd never changes once its transcript exists, but discovery
// runs on every watcher tick (every ~2s) — without this cache each tick
// would open and read 8KB of every transcript on the machine. Only
// successful peeks are cached: a just-created file may not have logged a
// cwd-bearing line yet, and should be re-peeked until it has.
const cwdCache = new Map(); // transcriptPath -> cwd

// Every message in a transcript carries its own `cwd`, so peeking at the
// first few KB (rather than decoding the lossy, hyphen-joined project
// directory name) gets the real working directory.
function peekCwd(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) return obj.cwd;
      } catch {
        // Likely a truncated final line from the byte cap — skip it.
      }
    }
  } catch {
    // File unreadable — fall through to the directory-name fallback.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return null;
}

function cachedCwd(filePath) {
  const hit = cwdCache.get(filePath);
  if (hit !== undefined) return hit;
  const cwd = peekCwd(filePath);
  if (cwd !== null) cwdCache.set(filePath, cwd);
  return cwd;
}

/**
 * Scans ~/.claude/projects for transcript files, most recently modified
 * first. This is the app's entire notion of "what sessions exist" — every
 * session Claude Code has ever run on this machine has a transcript here,
 * so a scan needs no registration step and no cooperation from the
 * session's side.
 */
export function discoverSessions() {
  const results = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return results;
  }

  for (const dirEnt of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dirEnt.name);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;

      results.push({
        sessionId: file.replace(/\.jsonl$/, ''),
        transcriptPath: filePath,
        cwd: cachedCwd(filePath) || dirEnt.name.replace(/^-/, '/').replace(/-/g, '/'),
        lastModified: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    }
  }

  results.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return results;
}
