import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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

/**
 * Scans ~/.claude/projects for transcript files, most recently modified
 * first, so the app can offer "attach to a session already running
 * elsewhere" without the user hunting down a file path themselves.
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
        cwd: peekCwd(filePath) || dirEnt.name.replace(/^-/, '/').replace(/-/g, '/'),
        lastModified: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    }
  }

  results.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return results;
}
