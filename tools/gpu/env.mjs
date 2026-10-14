// Reads the project's .env (AWS and Docker Hub credentials, API keys) without
// putting anything into process.env, so secrets stay scoped to whoever asks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readEnv(root = ROOT) {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

/** AWS SDK client options from .env. */
export function awsConfig(env = readEnv()) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not in .env');
  return {
    region: env.AWS_DEFAULT_REGION || 'us-east-1',
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  };
}
