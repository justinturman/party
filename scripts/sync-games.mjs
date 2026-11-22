// Downloads every game listed in the catalog into games/ (run at build time).
// Usage:  npm run sync                           (real catalog from GitHub)
//         npm run sync -- --file catalog.local.json   (local folders, for development)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gamesDir = path.join(root, 'games');
const CATALOG_REPO = process.env.CATALOG_REPO || 'justinturman/party-catalog';
const fileFlag = process.argv.indexOf('--file');
const localFile = fileFlag > -1 ? process.argv[fileFlag + 1] : null;

// The catalog is untrusted data, so every field is checked before it is used
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^[a-z0-9-]+$/;

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });

// Fetches one exact commit (or branch) of a GitHub repository into a folder
function fetchRepo(repo, ref, dest) {
  fs.mkdirSync(dest, { recursive: true });
  git(['init', '-q'], dest);
  git(['remote', 'add', 'origin', `https://github.com/${repo}.git`], dest);
  git(['fetch', '-q', '--depth', '1', 'origin', ref], dest);
  git(['checkout', '-q', 'FETCH_HEAD'], dest);
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-sync-'));
try {
  let catalog;
  if (localFile) {
    catalog = JSON.parse(fs.readFileSync(path.resolve(localFile), 'utf8'));
  } else {
    const dest = path.join(tmp, 'catalog');
    fetchRepo(CATALOG_REPO, 'main', dest);
    catalog = JSON.parse(fs.readFileSync(path.join(dest, 'catalog.json'), 'utf8'));
  }
  if (!Array.isArray(catalog.games)) throw new Error('catalog.json needs a "games" list');

  // Start clean, so games removed from the catalog disappear
  fs.rmSync(gamesDir, { recursive: true, force: true });
  fs.mkdirSync(gamesDir, { recursive: true });

  let count = 0;
  for (const [i, entry] of catalog.games.entries()) {
    const staged = path.join(tmp, `game-${i}`);
    if (entry.path) {
      if (!localFile) throw new Error('"path" entries are only allowed with --file');
      fs.cpSync(path.resolve(entry.path), staged, {
        recursive: true,
        filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src),
      });
    } else {
      if (!REPO_RE.test(entry.repo || '') || !SHA_RE.test(entry.commit || '')) {
        throw new Error(`Catalog entry #${i + 1} needs "repo" (owner/name) and a full 40-letter "commit"`);
      }
      fetchRepo(entry.repo, entry.commit, staged);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'game.json'), 'utf8'));
    if (!ID_RE.test(manifest.id || '')) throw new Error(`Entry #${i + 1}: bad game id`);
    const target = path.join(gamesDir, manifest.id);
    if (fs.existsSync(target)) throw new Error(`Two games use the id "${manifest.id}"`);
    fs.cpSync(staged, target, { recursive: true });
    console.log(`Installed ${manifest.name}`);
    count++;
  }
  console.log(`${count} games ready in games/`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}