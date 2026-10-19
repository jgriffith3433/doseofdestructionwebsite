/**
 * Which build a player is on, for Hawkes Analytics (hawkesgen/docs/analytics.md): { version, commit, date }.
 *
 *   - the game gets it as the Vite define __DOD_BUILD__ (src/game/analytics.ts sets window.HAWKES_BUILD from it)
 *   - the static site pages get it from /site/build.js, which the build writes into dist/site/ (pages.yml and
 *     Studio's beta build copy dist/ over the site) and the dev server serves
 *
 * version: releases.json "current" (Studio bumps it at every go live), else package.json. commit: DOD_BUILD_COMMIT or
 * GITHUB_SHA (pages.yml passes it), else `git rev-parse HEAD`. date: DOD_BUILD_DATE, else now.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function buildInfo(root) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return null;
    }
  };
  const version = String(read('releases.json')?.current || read('package.json')?.version || '0.0.0');
  let commit = process.env.DOD_BUILD_COMMIT || process.env.GITHUB_SHA || '';
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // No git here (a copied folder): the build still has its version and date.
    }
  }
  commit = /^[0-9a-f]{4,40}$/i.test(commit) ? commit.slice(0, 12) : undefined;
  const date = process.env.DOD_BUILD_DATE || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return { version, commit, date };
}

const script = (info) =>
  `// Written by the build (tools/buildStamp.mjs): which build this page is, for Hawkes Analytics.\nwindow.HAWKES_BUILD = ${JSON.stringify(info)};\n`;

/** The Vite plugin: the define, dist/site/build.js, and /site/build.js on the dev server. */
export function buildStamp(root) {
  const info = buildInfo(root);
  return {
    name: 'dod-build-stamp',
    config() {
      return { define: { __DOD_BUILD__: JSON.stringify(info) } };
    },
    configureServer(server) {
      server.middlewares.use('/site/build.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(script({ ...info, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'site/build.js', source: script(info) });
    },
  };
}
