// Where the shared art folders live: the env var when set, else the first that exists of a sibling of this checkout,
// the cloud server's /srv/hawkes/<name>, and J's C:\Projects\<name>. Used by vite.config.js and tools/maps/make.mjs.
import fs from 'node:fs';
import path from 'node:path';

export function sharedRoot(name, envVar, repoRoot = process.cwd()) {
  if (process.env[envVar]) return process.env[envVar];
  const candidates = [path.resolve(repoRoot, '..', name), `/srv/hawkes/${name}`, `C:\\Projects\\${name}`];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}
