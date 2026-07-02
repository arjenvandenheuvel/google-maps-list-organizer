import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { config, BOUNDS, destSlug } from './config';

const PORT = 3001;
const API_TOKEN = process.env.API_TOKEN || 'changeme';
const BLACKHOLE_DIR = path.join('/app', 'blackhole');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

interface BlackholeFileStatus {
  name: string;
  status: 'pending' | 'handled';
  handledAt?: string;
  counts?: { added: number; already: number; skipped: number; failed: number };
}

interface JobState {
  id: string;
  command: 'extract' | 'move' | 'add-places';
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  output: string[];
  options?: Record<string, string | number | boolean>;
}

let currentJob: JobState | null = null;
let jobProcess: ChildProcess | null = null;

function generateJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function checkAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(' ');
  return scheme === 'Bearer' && token === API_TOKEN;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function runCommand(command: 'extract' | 'move' | 'add-places', args: string[] = []): JobState {
  const job: JobState = {
    id: generateJobId(),
    command,
    status: 'running',
    startedAt: new Date().toISOString(),
    output: [],
    options: args.length > 0 ? { args: args.join(' ') } : undefined,
  };
  currentJob = job;

  const proc = spawn('pnpm', [command, ...args], {
    cwd: '/app',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  jobProcess = proc;

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.output.push(...lines);
    // Keep only last 200 lines to prevent memory issues
    if (job.output.length > 200) {
      job.output = job.output.slice(-200);
    }
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.output.push(...lines.map((l: string) => `[stderr] ${l}`));
  });

  proc.on('close', (code) => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.completedAt = new Date().toISOString();
    jobProcess = null;
  });

  return job;
}

function getStatus(): object {
  const appDir = '/app';
  const tmpDir = path.join(appDir, 'tmp');
  const blackholeDir = BLACKHOLE_DIR;
  const placesFile = path.join(tmpDir, 'places.json');
  const destFile = path.join(tmpDir, `${destSlug}-places.json`);
  const progressFile = path.join(tmpDir, 'progress.json');
  const failedFile = path.join(tmpDir, 'failed.json');
  const masterFile = process.env.MASTER_FILE || path.join(appDir, 'master-locations.json');
  const addHandledFile = path.join(tmpDir, 'add-handled.json');
  const addFailedFile = path.join(tmpDir, 'add-failed.json');

  let totalPlaces = 0;
  let destPlaces = 0;
  let moved = 0;
  let failed = 0;

  // Blackhole/add stats
  let blackholeFiles: BlackholeFileStatus[] = [];
  let masterLocations = 0;
  let addFailed = 0;

  try {
    if (fs.existsSync(placesFile)) {
      totalPlaces = JSON.parse(fs.readFileSync(placesFile, 'utf-8')).length;
    }
    if (fs.existsSync(destFile)) {
      destPlaces = JSON.parse(fs.readFileSync(destFile, 'utf-8')).length;
    }
    if (fs.existsSync(progressFile)) {
      moved = JSON.parse(fs.readFileSync(progressFile, 'utf-8')).length;
    }
    if (fs.existsSync(failedFile)) {
      failed = JSON.parse(fs.readFileSync(failedFile, 'utf-8')).length;
    }
    // Blackhole stats — match each file against the handled manifest by
    // basename + content hash, same identity add.ts uses for its own dedup.
    if (fs.existsSync(blackholeDir)) {
      const handled: Record<string, { hash: string; handledAt: string; counts: BlackholeFileStatus['counts'] }> =
        fs.existsSync(addHandledFile) ? JSON.parse(fs.readFileSync(addHandledFile, 'utf-8')) : {};
      blackholeFiles = fs.readdirSync(blackholeDir)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map((name): BlackholeFileStatus => {
          const entry = handled[name];
          if (entry) {
            const content = fs.readFileSync(path.join(blackholeDir, name), 'utf-8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            if (hash === entry.hash) {
              return { name, status: 'handled', handledAt: entry.handledAt, counts: entry.counts };
            }
          }
          return { name, status: 'pending' };
        });
    }
    if (fs.existsSync(masterFile)) {
      masterLocations = JSON.parse(fs.readFileSync(masterFile, 'utf-8')).length;
    }
    if (fs.existsSync(addFailedFile)) {
      addFailed = JSON.parse(fs.readFileSync(addFailedFile, 'utf-8')).length;
    }
  } catch {
    // Ignore JSON parse errors
  }

  return {
    config: {
      sourceList: config.sourceList,
      destList: config.destList,
      bounds: config.bounds,
    },
    availableBounds: Object.keys(BOUNDS),
    data: {
      totalPlaces,
      destPlaces,
      moved,
      failed,
      remaining: destPlaces - moved - failed,
    },
    blackhole: {
      files: blackholeFiles,
      fileCount: blackholeFiles.length,
      handledFiles: blackholeFiles.filter(f => f.status === 'handled').length,
      pendingFiles: blackholeFiles.filter(f => f.status === 'pending').length,
      masterLocations,
      addFailed,
    },
    currentJob: currentJob ? {
      id: currentJob.id,
      command: currentJob.command,
      status: currentJob.status,
      startedAt: currentJob.startedAt,
      completedAt: currentJob.completedAt,
    } : null,
  };
}

type DashboardStatus = {
  config: { sourceList: string; destList: string };
  data: { totalPlaces: number; destPlaces: number; moved: number; failed: number; remaining: number };
  blackhole: { files: BlackholeFileStatus[]; fileCount: number; handledFiles: number; pendingFiles: number; masterLocations: number; addFailed: number };
  currentJob: { id: string; command: string; status: string; startedAt: string } | null;
};

const PAGE_STYLES = `
    * { box-sizing: border-box; }
    :root { color-scheme: dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background: #121212;
      color: #e8eaed;
    }
    h1 { color: #f1f3f4; margin-bottom: 5px; }
    .subtitle { color: #9aa0a6; margin-bottom: 20px; }
    .tabs { display: flex; gap: 4px; margin: 14px 0 20px; border-bottom: 1px solid #2d2d2d; }
    .tab { padding: 10px 16px; color: #9aa0a6; text-decoration: none; font-size: 14px; border-bottom: 2px solid transparent; }
    .tab.active { color: #e8eaed; border-bottom-color: #4285f4; }
    .card {
      background: #1e1e1e;
      border: 1px solid #2d2d2d;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    }
    .card h2 { margin-top: 0; font-size: 16px; color: #9aa0a6; }
    .stat { font-size: 24px; font-weight: bold; color: #e8eaed; }
    .stat-row { display: flex; justify-content: space-between; margin: 8px 0; }
    .stat-label { color: #9aa0a6; }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      margin: 5px;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-primary { background: #4285f4; color: white; }
    .btn-secondary { background: #34a853; color: white; }
    .btn-warning { background: #fbbc04; color: #202124; }
    .btn:disabled { background: #3c4043; color: #9aa0a6; cursor: not-allowed; }
    .status-running { color: #8ab4f8; }
    .status-completed { color: #81c995; }
    .status-failed { color: #f28b82; }
    #output {
      background: #0a0a0a;
      color: #d4d4d4;
      padding: 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .actions { text-align: center; margin: 20px 0; }
    .options { margin: 10px 0; }
    .options label { display: block; margin: 5px 0; color: #e8eaed; }
    .options input[type="number"] {
      width: 80px;
      padding: 4px;
      background: #2d2d2d;
      color: #e8eaed;
      border: 1px solid #3c4043;
      border-radius: 4px;
    }
    a { color: #8ab4f8; }
    details summary { color: #9aa0a6; }
    .file-list { margin-top: 10px; border-top: 1px solid #2d2d2d; padding-top: 8px; }
    .file-row { font-size: 13px; margin: 6px 0; }
    .file-name { color: #e8eaed; overflow-wrap: anywhere; padding-right: 10px; }
`;

// Shared client-side helpers included on every page: auth token, API fetch
// wrapper, and the job-status poller. Page-specific actions (extract/move
// vs. add/upload) are appended by each page's own script block.
const SHARED_SCRIPT = `
    const token = localStorage.getItem('apiToken') || prompt('Enter API token:');
    if (token) localStorage.setItem('apiToken', token);

    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    }

    async function runReset() {
      if (confirm('Clear progress and failed files?')) {
        await api('POST', '/reset');
        location.reload();
      }
    }

    async function pollStatus() {
      const data = await api('GET', '/status');
      const jobDiv = document.getElementById('jobStatus');
      const outputDiv = document.getElementById('output');

      if (data.currentJob) {
        jobDiv.innerHTML = '<span class="status-' + data.currentJob.status + '">' +
          data.currentJob.command + ': ' + data.currentJob.status + '</span>';
        outputDiv.style.display = 'block';

        // Fetch job output
        const jobData = await api('GET', '/job/' + data.currentJob.id);
        if (jobData.output) {
          outputDiv.textContent = jobData.output.join('\\n');
          outputDiv.scrollTop = outputDiv.scrollHeight;
        }

        if (data.currentJob.status === 'running') {
          setTimeout(pollStatus, 2000);
        } else {
          // Refresh stats after completion
          setTimeout(() => location.reload(), 1000);
        }
      }
    }
`;

function pageShell(active: 'sort' | 'add', subtitle: string, body: string, pageScript: string, autoPoll: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Maps List Organizer</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>Maps List Organizer</h1>
  <div class="tabs">
    <a class="tab ${active === 'add' ? 'active' : ''}" href="/">Add Places</a>
    <a class="tab ${active === 'sort' ? 'active' : ''}" href="/sort">Sort by City</a>
  </div>
  <p class="subtitle">${subtitle}</p>

  ${body}

  <div class="card">
    <h2>Browser Access</h2>
    <p>To log in to Google or debug:</p>
    <a href="/vnc" target="_blank" class="btn btn-primary">Open Chrome (noVNC)</a>
  </div>

  <script>
    ${SHARED_SCRIPT}
    ${pageScript}
    // Initial poll if job is running
    ${autoPoll ? 'pollStatus();' : ''}
  </script>
</body>
</html>`;
}

function getSortPageHtml(): string {
  const status = getStatus() as DashboardStatus;

  const body = `
  <div class="card">
    <h2>Progress</h2>
    <div class="stat-row">
      <span class="stat-label">Total places (source)</span>
      <span class="stat">${status.data.totalPlaces}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Matching bounds</span>
      <span class="stat">${status.data.destPlaces}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Moved</span>
      <span class="stat" style="color: #81c995">${status.data.moved}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Failed</span>
      <span class="stat" style="color: #f28b82">${status.data.failed}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Remaining</span>
      <span class="stat">${status.data.remaining}</span>
    </div>
  </div>

  <div class="card">
    <h2>Job Status</h2>
    <div id="jobStatus">
      ${status.currentJob
        ? `<span class="status-${status.currentJob.status}">${status.currentJob.command}: ${status.currentJob.status}</span>`
        : '<span style="color:#9aa0a6">No job running</span>'}
    </div>
    <div id="output" style="display: ${status.currentJob ? 'block' : 'none'}; margin-top: 10px;"></div>
  </div>

  <div class="card">
    <h2>Actions</h2>
    <div class="options">
      <label>
        <input type="checkbox" id="dryRun"> Dry run (navigate only)
      </label>
      <label>
        Limit: <input type="number" id="limit" min="1" placeholder="all">
      </label>
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="runExtract()" id="extractBtn">Extract Places</button>
      <button class="btn btn-secondary" onclick="runMove()" id="moveBtn">Move Places</button>
      <button class="btn btn-warning" onclick="runReset()" id="resetBtn">Reset Progress</button>
    </div>
  </div>`;

  const script = `
    async function runExtract() {
      await api('POST', '/extract');
      pollStatus();
    }

    async function runMove() {
      const opts = {};
      if (document.getElementById('dryRun').checked) opts.dryRun = true;
      const limit = document.getElementById('limit').value;
      if (limit) opts.limit = parseInt(limit);
      await api('POST', '/move', opts);
      pollStatus();
    }
  `;

  return pageShell('sort', `${status.config.sourceList} → ${status.config.destList}`, body, script, status.currentJob?.status === 'running');
}

function getAddPageHtml(): string {
  const status = getStatus() as DashboardStatus;

  const body = `
  <div class="card">
    <h2>Blackhole (Add New Places)</h2>
    <div class="stat-row">
      <span class="stat-label">Files in blackhole</span>
      <span class="stat">${status.blackhole.fileCount}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Pending files</span>
      <span class="stat">${status.blackhole.pendingFiles}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Master locations</span>
      <span class="stat" style="color: #81c995">${status.blackhole.masterLocations}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Add failed</span>
      <span class="stat" style="color: #f28b82">${status.blackhole.addFailed}</span>
    </div>
    ${status.blackhole.files.length > 0 ? `
    <div class="file-list">
      ${status.blackhole.files.map(f => `
      <div class="stat-row file-row">
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="${f.status === 'handled' ? 'status-completed' : 'status-running'}">
          ${f.status === 'handled'
            ? `handled${f.counts ? ` &middot; ${f.counts.added} added, ${f.counts.already} already, ${f.counts.failed} failed` : ''}`
            : 'pending'}
        </span>
      </div>`).join('')}
    </div>` : ''}
    <div style="margin-top: 14px;">
      <input type="file" id="uploadFile" accept="application/json,.json">
      <button class="btn" style="background: #9c27b0; color: white;" onclick="uploadFile()" id="uploadBtn">Upload to Blackhole</button>
      <div id="uploadStatus" style="margin-top: 8px; color: #9aa0a6; font-size: 14px;"></div>
    </div>
  </div>

  <div class="card">
    <h2>Job Status</h2>
    <div id="jobStatus">
      ${status.currentJob
        ? `<span class="status-${status.currentJob.status}">${status.currentJob.command}: ${status.currentJob.status}</span>`
        : '<span style="color:#9aa0a6">No job running</span>'}
    </div>
    <div id="output" style="display: ${status.currentJob ? 'block' : 'none'}; margin-top: 10px;"></div>
  </div>

  <div class="card">
    <h2>Actions</h2>
    <div class="options">
      <label>
        <input type="checkbox" id="dryRun"> Dry run (navigate only)
      </label>
      <label>
        Limit: <input type="number" id="limit" min="1" placeholder="all">
      </label>
      <label>
        <input type="checkbox" id="force"> Force (ignore dedup)
      </label>
    </div>
    <div class="actions">
      <button class="btn" style="background: #9c27b0; color: white;" onclick="runAdd()" id="addBtn">Add from Blackhole</button>
    </div>
  </div>`;

  const script = `
    async function runAdd() {
      const opts = {};
      if (document.getElementById('dryRun').checked) opts.dryRun = true;
      if (document.getElementById('force').checked) opts.force = true;
      const limit = document.getElementById('limit').value;
      if (limit) opts.limit = parseInt(limit);
      await api('POST', '/add', opts);
      pollStatus();
    }

    async function uploadFile() {
      const input = document.getElementById('uploadFile');
      const statusDiv = document.getElementById('uploadStatus');
      const file = input.files[0];
      if (!file) {
        statusDiv.textContent = 'Choose a .json file first';
        return;
      }
      statusDiv.textContent = 'Uploading...';
      try {
        const text = await file.text();
        JSON.parse(text); // validate before sending
        const res = await fetch('/upload?filename=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: text
        });
        const data = await res.json();
        if (res.ok) {
          statusDiv.style.color = '#81c995';
          statusDiv.textContent = 'Uploaded ' + data.filename;
          input.value = '';
          setTimeout(() => location.reload(), 1000);
        } else {
          statusDiv.style.color = '#f28b82';
          statusDiv.textContent = 'Error: ' + data.error;
        }
      } catch (err) {
        statusDiv.style.color = '#f28b82';
        statusDiv.textContent = 'Invalid JSON file: ' + err.message;
      }
    }
  `;

  return pageShell('add', 'Add curated places straight to a list', body, script, status.currentJob?.status === 'running');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Dashboard pages - no auth required
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getAddPageHtml());
    return;
  }

  if (pathname === '/sort' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getSortPageHtml());
    return;
  }

  // Redirect to noVNC
  if (pathname === '/vnc') {
    res.writeHead(302, { 'Location': 'http://' + (req.headers.host?.split(':')[0] || 'localhost') + ':6080/vnc.html' });
    res.end();
    return;
  }

  // API endpoints - require auth
  if (!checkAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized. Use Bearer token.' });
    return;
  }

  // GET /status - current status and stats
  if (pathname === '/status' && req.method === 'GET') {
    sendJson(res, 200, getStatus());
    return;
  }

  // GET /job/:id - get job details
  if (pathname.startsWith('/job/') && req.method === 'GET') {
    const jobId = pathname.split('/')[2];
    if (currentJob?.id === jobId) {
      sendJson(res, 200, currentJob);
    } else {
      sendJson(res, 404, { error: 'Job not found' });
    }
    return;
  }

  // POST /extract - run extract
  if (pathname === '/extract' && req.method === 'POST') {
    if (currentJob?.status === 'running') {
      sendJson(res, 409, { error: 'Job already running', job: currentJob });
      return;
    }
    const job = runCommand('extract');
    sendJson(res, 202, { message: 'Extract started', job });
    return;
  }

  // POST /move - run move
  if (pathname === '/move' && req.method === 'POST') {
    if (currentJob?.status === 'running') {
      sendJson(res, 409, { error: 'Job already running', job: currentJob });
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const args: string[] = [];
      try {
        const opts = JSON.parse(body || '{}');
        if (opts.dryRun) args.push('--dry-run');
        if (opts.limit) args.push(`--limit=${opts.limit}`);
        if (opts.retry) args.push('--retry');
      } catch {
        // No body or invalid JSON, use defaults
      }
      const job = runCommand('move', args);
      sendJson(res, 202, { message: 'Move started', job });
    });
    return;
  }

  // POST /add - run add-places (blackhole)
  if (pathname === '/add' && req.method === 'POST') {
    if (currentJob?.status === 'running') {
      sendJson(res, 409, { error: 'Job already running', job: currentJob });
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const args: string[] = [];
      try {
        const opts = JSON.parse(body || '{}');
        if (opts.dryRun) args.push('--dry-run');
        if (opts.force) args.push('--force');
        if (opts.limit) args.push(`--limit=${opts.limit}`);
        if (opts.file) args.push(`--file=${opts.file}`);
      } catch {
        // No body or invalid JSON, use defaults
      }
      const job = runCommand('add-places', args);
      sendJson(res, 202, { message: 'Add started', job });
    });
    return;
  }

  // POST /upload?filename=NAME.json - drop a trip JSON file into the blackhole dir
  if (pathname === '/upload' && req.method === 'POST') {
    const rawName = url.searchParams.get('filename') || '';
    const safeName = path.basename(rawName);
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(safeName)) {
      sendJson(res, 400, { error: 'filename must be a plain .json name (letters, numbers, ._- only)' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        sendJson(res, 413, { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` });
        return;
      }
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Body is not valid JSON' });
        return;
      }
      try {
        fs.mkdirSync(BLACKHOLE_DIR, { recursive: true });
        fs.writeFileSync(path.join(BLACKHOLE_DIR, safeName), body);
        sendJson(res, 200, { message: 'Uploaded', filename: safeName });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to write file', details: String(err) });
      }
    });
    return;
  }

  // POST /reset - clear progress
  if (pathname === '/reset' && req.method === 'POST') {
    try {
      const progressFile = '/app/tmp/progress.json';
      const failedFile = '/app/tmp/failed.json';
      if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
      if (fs.existsSync(failedFile)) fs.unlinkSync(failedFile);
      sendJson(res, 200, { message: 'Progress reset' });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to reset', details: String(err) });
    }
    return;
  }

  // POST /stop - stop current job
  if (pathname === '/stop' && req.method === 'POST') {
    if (jobProcess) {
      jobProcess.kill('SIGTERM');
      sendJson(res, 200, { message: 'Job stopped' });
    } else {
      sendJson(res, 404, { error: 'No job running' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`API server running on http://0.0.0.0:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`noVNC redirect: http://localhost:${PORT}/vnc`);
});
