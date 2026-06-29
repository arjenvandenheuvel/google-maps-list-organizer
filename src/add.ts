import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chromium, Browser, Page } from 'playwright';

// Adds curated locations from trip JSON files into Google Maps lists.
//
// Unlike move.ts (which moves places already saved in a source list), this script
// SAVES brand-new places. Each entry carries its own target list in the `list` field,
// so a single file can populate several lists at once.
//
// Two levels of de-duplication keep re-runs cheap:
//   1. File level — a file is skipped once its filename + content hash appear in the
//      handled manifest (tmp/add-handled.json). Editing or renaming it counts as new.
//   2. Location level — every successfully handled place is recorded in the master file
//      (tmp/master-locations.json), keyed by name + rounded coords + target list. A new
//      file only adds the locations that aren't already in the master, so overlap between
//      files is skipped without touching the browser. The master also doubles as resume:
//      a place is recorded the instant it succeeds, so an interrupted run picks up where
//      it left off.
//
// Input JSON shape: { meta: {...}, locations: [{ id, name, lat, lng, list, ... }] }
//
// CLI flags:
//   --dir=PATH    inbox folder to scan (default: DEFAULT_INBOX_DIR)
//   --file=PATH   process a single file instead of scanning the inbox
//   --force       ignore both dedup layers (reprocess handled files and master hits)
//   --limit=N     process at most N locations total (across files)
//   --dry-run     navigate only, no clicks, no manifest/master writes

interface TripLocation {
  id: string;
  name: string;
  name_jp?: string;
  region?: string;
  list: string;
  lat: number;
  lng: number;
}

interface HandledEntry {
  hash: string;
  handledAt: string;
  counts: { added: number; already: number; skipped: number; failed: number };
}
type HandledManifest = Record<string, HandledEntry>; // keyed by file basename

interface MasterEntry {
  key: string;
  id: string;
  name: string;
  list: string;
  lat: number;
  lng: number;
  result: 'added' | 'already';
  sourceFile: string;
  savedAt: string;
}

// Paths are relative to project root, Docker-compatible
const DEFAULT_INBOX_DIR = process.env.INBOX_DIR || 'blackhole';
const HANDLED_FILE = 'tmp/add-handled.json';
const MASTER_FILE = process.env.MASTER_FILE || 'master-locations.json';
const FAILED_FILE = 'tmp/add-failed.json';
const PAUSE_MS = 2000;
const BETWEEN_PLACES_MS = () => 3000 + Math.random() * 2000; // 3–5s between places

const args = process.argv.slice(2);
const dirArg = args.find(a => a.startsWith('--dir='))?.split('=')[1];
const fileArg = args.find(a => a.startsWith('--file='))?.split('=')[1];
const inboxDir = dirArg ?? DEFAULT_INBOX_DIR;
const force = args.includes('--force');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 'Infinity');
const dryRun = args.includes('--dry-run');

function searchUrl(loc: TripLocation): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(loc.name)}/@${loc.lat},${loc.lng},18z`;
}

// Identity used for cross-file location dedup: normalized name + coords (4 dp ≈ 11m) + list.
function locationKey(loc: TripLocation): string {
  const norm = (s: string) => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${norm(loc.name)}|${loc.lat.toFixed(4)}|${loc.lng.toFixed(4)}|${norm(loc.list)}`;
}

function fileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function loadHandled(): HandledManifest {
  if (!fs.existsSync(HANDLED_FILE)) return {};
  return JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf-8')) as HandledManifest;
}

function saveHandled(m: HandledManifest) {
  fs.writeFileSync(HANDLED_FILE, JSON.stringify(m, null, 2));
}

function loadMaster(): MasterEntry[] {
  if (!fs.existsSync(MASTER_FILE)) return [];
  return JSON.parse(fs.readFileSync(MASTER_FILE, 'utf-8')) as MasterEntry[];
}

function saveMaster(entries: MasterEntry[]) {
  fs.mkdirSync(path.dirname(MASTER_FILE), { recursive: true });
  fs.writeFileSync(MASTER_FILE, JSON.stringify(entries, null, 2));
}

type Result = 'added' | 'already' | 'failed';

async function addPlaceToList(page: Page, loc: TripLocation): Promise<Result> {
  await page.goto(searchUrl(loc), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(PAUSE_MS);

  if (dryRun) return 'added';

  // The save button is "Save" when unsaved, "Saved (N)" once in a list.
  const saveBtn = page.locator('button[data-value="Save"], button[data-value^="Saved"]');

  // If no card is shown, the search returned a results list — open the first result.
  if (!await saveBtn.first().isVisible().catch(() => false)) {
    const firstResult = page.locator('div[role="article"]').first();
    if (await firstResult.isVisible().catch(() => false)) {
      await firstResult.click();
      await page.waitForTimeout(PAUSE_MS);
    }
  }

  const found = await saveBtn.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!found) {
    const slug = loc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const shotPath = `tmp/screenshots/add-failure-${slug}.png`;
    fs.mkdirSync('tmp/screenshots', { recursive: true });
    await page.screenshot({ path: shotPath });
    console.log(`  ✗ Save button not found (screenshot → ${shotPath})`);
    return 'failed';
  }

  await saveBtn.first().click();
  await page.waitForTimeout(PAUSE_MS);

  const listItems = page.locator('div[role="menuitemradio"]');
  if (!await listItems.first().isVisible().catch(() => false)) {
    console.log(`  ✗ List picker did not open`);
    await page.keyboard.press('Escape');
    return 'failed';
  }

  const target = listItems.filter({ hasText: loc.list }).first();
  if (!await target.isVisible().catch(() => false)) {
    console.log(`  ✗ List "${loc.list}" not found in picker`);
    await page.keyboard.press('Escape');
    return 'failed';
  }

  if (await target.getAttribute('aria-checked') === 'true') {
    await page.keyboard.press('Escape');
    return 'already';
  }

  await target.click();
  await page.waitForTimeout(PAUSE_MS);

  if (await page.locator('text=Failed to save').isVisible().catch(() => false)) {
    console.log(`  ✗ Google reported "Failed to save"`);
    await page.keyboard.press('Escape');
    return 'failed';
  }

  await page.keyboard.press('Escape');
  return 'added';
}

interface TripFile {
  pathName: string;
  basename: string;
  hash: string;
  locations: TripLocation[];
}

// Discover candidate JSON files (the inbox, or a single --file), skipping invalid
// and already-handled ones. Returns the files that still need processing, annotated
// with how many of their locations are genuinely new vs. already in the master.
function discoverNewFiles(handled: HandledManifest, masterKeys: Set<string>): TripFile[] {
  let candidates: string[];
  if (fileArg) {
    candidates = [path.resolve(fileArg)];
  } else {
    fs.mkdirSync(inboxDir, { recursive: true });
    candidates = fs.readdirSync(inboxDir)
      .filter(f => f.toLowerCase().endsWith('.json'))
      .map(f => path.join(inboxDir, f))
      .sort();
  }

  console.log(fileArg ? `File: ${fileArg}` : `Inbox: ${inboxDir}`);

  const newFiles: TripFile[] = [];
  let alreadyHandled = 0, invalid = 0;

  for (const pathName of candidates) {
    if (!fs.existsSync(pathName)) {
      console.log(`  ✗ ${pathName} — not found`);
      invalid++;
      continue;
    }
    const content = fs.readFileSync(pathName, 'utf-8');
    const basename = path.basename(pathName);

    let locations: TripLocation[];
    try {
      const parsed = JSON.parse(content);
      locations = parsed.locations ?? parsed;
      if (!Array.isArray(locations) || locations.length === 0) throw new Error('no locations array');
    } catch (e) {
      console.log(`  ✗ ${basename} — not a valid trip file (${(e as Error).message})`);
      invalid++;
      continue;
    }

    const hash = fileHash(content);
    // Skip when filename + content hash both match a handled entry.
    if (!force && handled[basename]?.hash === hash) {
      alreadyHandled++;
      continue;
    }

    newFiles.push({ pathName, basename, hash, locations });
  }

  const parts = [`${candidates.length} JSON file(s) found`];
  if (alreadyHandled) parts.push(`${alreadyHandled} already handled`);
  if (invalid) parts.push(`${invalid} skipped (invalid)`);
  parts.push(`${newFiles.length} new`);
  console.log(parts.join(', '));

  for (const f of newFiles) {
    const reallyNew = force ? f.locations.length : f.locations.filter(l => !masterKeys.has(locationKey(l))).length;
    const dup = f.locations.length - reallyNew;
    console.log(`  • ${f.basename} — ${f.locations.length} locations: ${reallyNew} new${dup ? `, ${dup} already in master` : ''}`);
  }

  return newFiles;
}

async function main() {
  fs.mkdirSync('tmp', { recursive: true });

  const handled = loadHandled();
  const master = loadMaster();
  const masterKeys = new Set(master.map(e => e.key));

  const newFiles = discoverNewFiles(handled, masterKeys);
  console.log(dryRun ? '\nDRY RUN — navigating only, no changes\n' : '');

  if (newFiles.length === 0) {
    console.log('No new files to process.');
    return;
  }

  // Connect to Chrome lazily — if every location is already in the master, we never
  // touch the browser at all.
  let browser: Browser | undefined;
  let page: Page | undefined;
  async function ensurePage(): Promise<Page> {
    if (page) return page;
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch((): never => {
      console.error('Could not connect to Chrome. Run `pnpm run launch-chrome` first, then try again.');
      process.exit(1);
    });
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.newPage();
    return page;
  }

  const allFailed: Array<TripLocation & { file: string }> = [];
  let added = 0, already = 0, skipped = 0, processed = 0;

  for (const file of newFiles) {
    if (processed >= limit) break;
    console.log(`\n=== ${file.basename} ===`);

    const counts = { added: 0, already: 0, skipped: 0, failed: 0 };
    let fullyProcessed = true;
    let i = 0;

    for (const loc of file.locations) {
      i++;
      const key = locationKey(loc);
      if (!force && masterKeys.has(key)) { counts.skipped++; skipped++; continue; }
      if (processed >= limit) { fullyProcessed = false; break; }

      process.stdout.write(`[${i}/${file.locations.length}] "${loc.name}" → ${loc.list} ... `);
      const page = await ensurePage();
      const result = await addPlaceToList(page, loc);
      processed++;

      if (result === 'failed') {
        counts.failed++;
        fullyProcessed = false;
        allFailed.push({ file: file.basename, ...loc });
        fs.writeFileSync(FAILED_FILE, JSON.stringify(allFailed, null, 2));
      } else {
        if (!dryRun) {
          master.push({
            key, id: loc.id, name: loc.name, list: loc.list, lat: loc.lat, lng: loc.lng,
            result, sourceFile: file.basename, savedAt: new Date().toISOString(),
          });
          masterKeys.add(key);
          saveMaster(master);
        }
        if (result === 'already') { counts.already++; already++; console.log('✓ (already saved)'); }
        else { counts.added++; added++; console.log('✓'); }
      }
      await page.waitForTimeout(BETWEEN_PLACES_MS());
    }

    if (!dryRun && fullyProcessed && counts.failed === 0) {
      handled[file.basename] = { hash: file.hash, handledAt: new Date().toISOString(), counts };
      saveHandled(handled);
      const extra = counts.skipped ? `, ${counts.skipped} already in master` : '';
      console.log(`  ✓ ${file.basename} fully handled (${counts.added} added, ${counts.already} already${extra})`);
    } else if (!dryRun) {
      const why = counts.failed ? `${counts.failed} failed` : 'limit reached';
      console.log(`  ⚠ ${file.basename} left unhandled (${why}) — will retry next run`);
    }
  }

  const tail = skipped ? `, Skipped (already in master): ${skipped}` : '';
  console.log(`\nDone. ${dryRun ? 'Navigated' : 'Added'}: ${added}${already ? `, Already saved: ${already}` : ''}${tail}, Failed: ${allFailed.length}`);
  if (allFailed.length > 0) console.log(`Failed entries → ${FAILED_FILE} (re-run to retry)`);
  if (browser) await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
