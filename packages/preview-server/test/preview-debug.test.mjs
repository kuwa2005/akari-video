#!/usr/bin/env node
/**
 * Playwright integration test for preview-server debug diagnostics.
 *
 * Usage:
 *   node packages/preview-server/test/preview-debug.test.mjs
 *   PREVIEW_PROJECT=/path/to/project node packages/preview-server/test/preview-debug.test.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SERVER_CWD = path.join(REPO_ROOT, 'packages/preview-server');
const VALID_PROJECT = path.join(REPO_ROOT, 'test-project');
const EMPTY_PROJECT = process.env.PREVIEW_PROJECT
  || path.join(os.homedir(), 'my-first-video');
const PORT = Number(process.env.PREVIEW_PORT || 4568);

function createTempEmptyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akari-preview-empty-'));
  fs.writeFileSync(path.join(dir, 'edit.json'), '{}\n');
  return dir;
}

async function waitForServer(url, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Server did not start within ${timeout}ms: ${url}`);
}

function startServer(projectRoot, port) {
  const proc = spawn('node', [
    'src/server.mjs',
    projectRoot,
    '--port',
    String(port),
    '--no-lint',
  ], {
    cwd: SERVER_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => process.stdout.write(`[srv:${port}] ${chunk}`));
  proc.stderr.on('data', (chunk) => process.stderr.write(`[srv:${port}] ${chunk}`));
  return proc;
}

async function collectPreviewDiagnostics(page, baseUrl) {
  const consoleLogs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[preview]')) {
      consoleLogs.push({ type: msg.type(), text });
    }
  });

  await page.goto(baseUrl, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__akariPreviewDebugState?.ready === true, null, {
    timeout: 10000,
  });

  const debugBuffer = await page.evaluate(() => window.__akariPreviewDebug || []);
  const debugState = await page.evaluate(() => window.__akariPreviewDebugState || {});
  const messageText = await page.locator('#preview-message-text').textContent().catch(() => '');
  const videoSrc = await page.evaluate(() => document.getElementById('preview-video')?.src || '');

  return { consoleLogs, debugBuffer, debugState, messageText, videoSrc };
}

async function runScenario({ label, projectRoot, port, expectations }) {
  const baseUrl = `http://localhost:${port}`;
  const proc = startServer(projectRoot, port);

  try {
    await waitForServer(`${baseUrl}/api/codec-info`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const diag = await collectPreviewDiagnostics(page, baseUrl);
    await browser.close();

    const failures = [];
    for (const [name, fn] of Object.entries(expectations)) {
      try {
        fn(diag);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    }

    console.log(`\n=== ${label} ===`);
    console.log(`project: ${projectRoot}`);
    console.log(`debugState: ${JSON.stringify(diag.debugState, null, 2)}`);
    console.log(`video.src: ${diag.videoSrc || '(empty)'}`);
    console.log(`message: ${diag.messageText || '(none)'}`);
    console.log(`[preview] console lines: ${diag.consoleLogs.length}`);
    for (const entry of diag.debugBuffer) {
      console.log(`  • ${entry.event}${entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : ''}`);
    }

    if (failures.length > 0) {
      console.log('FAIL');
      for (const failure of failures) console.log(`  ❌ ${failure}`);
      return { label, ok: false, failures, diag };
    }

    console.log('PASS');
    return { label, ok: true, diag };
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.on('close', resolve);
      setTimeout(resolve, 1000);
    });
  }
}

async function main() {
  const emptyProject = fs.existsSync(path.join(EMPTY_PROJECT, 'edit.json'))
    ? EMPTY_PROJECT
    : createTempEmptyProject();

  const emptyEdit = JSON.parse(fs.readFileSync(path.join(emptyProject, 'edit.json'), 'utf8'));
  const usingTempEmpty = emptyProject !== EMPTY_PROJECT;

  console.log('AKARI preview-server debug Playwright test');
  console.log(`empty project: ${emptyProject}${usingTempEmpty ? ' (temp fixture)' : ''}`);
  console.log(`empty edit.json keys: ${Object.keys(emptyEdit).join(', ') || '(none)'}`);

  const results = [];

  results.push(await runScenario({
    label: 'valid test-project',
    projectRoot: VALID_PROJECT,
    port: PORT,
    expectations: {
      'init succeeds': ({ debugState }) => {
        if (debugState.initError) throw new Error(debugState.initError);
      },
      'has cuts': ({ debugState }) => {
        if (!debugState.hasCuts) throw new Error('expected cuts in edit.json');
      },
      'has clips': ({ debugState }) => {
        if ((debugState.clipCount ?? 0) < 1) throw new Error('expected timeline clips');
      },
      'video source assigned': ({ debugState, videoSrc }) => {
        if (!debugState.videoSrc && !videoSrc) throw new Error('expected preview video src');
      },
      'debug buffer populated': ({ debugBuffer }) => {
        if (!debugBuffer.some((e) => e.event === 'init complete')) {
          throw new Error('missing init complete debug entry');
        }
      },
      'console preview logs': ({ consoleLogs }) => {
        if (consoleLogs.length < 3) throw new Error(`expected preview console logs, got ${consoleLogs.length}`);
      },
    },
  }));

  results.push(await runScenario({
    label: 'empty edit.json (my-first-video-like)',
    projectRoot: emptyProject,
    port: PORT + 1,
    expectations: {
      'init completes without throw': ({ debugState }) => {
        if (!debugState.ready) throw new Error('debug state not ready');
        if (debugState.initError) throw new Error(`unexpected init error: ${debugState.initError}`);
      },
      'no cuts detected': ({ debugState }) => {
        if (debugState.hasCuts) throw new Error('expected empty edit.json to have no cuts');
      },
      'no clips in timeline': ({ debugState }) => {
        if ((debugState.clipCount ?? 0) !== 0) throw new Error(`expected 0 clips, got ${debugState.clipCount}`);
      },
      'no video source': ({ debugState, videoSrc }) => {
        if (debugState.videoSrc || videoSrc) throw new Error('expected no video src for empty edit.json');
      },
      'buildSegments reports no cuts': ({ debugBuffer }) => {
        if (!debugBuffer.some((e) => e.event === 'buildSegments: no cuts')) {
          throw new Error('missing buildSegments: no cuts debug entry');
        }
      },
      'init complete logged': ({ debugBuffer, debugState }) => {
        const complete = debugBuffer.find((e) => e.event === 'init complete');
        if (!complete) throw new Error('missing init complete debug entry');
        if (complete.data?.state?.hasCuts !== false) {
          throw new Error('init complete state should report hasCuts=false');
        }
        if (debugState.totalDuration !== 0) {
          throw new Error(`expected totalDuration=0, got ${debugState.totalDuration}`);
        }
      },
    },
  }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`結果: ${results.length - failed.length}/${results.length} scenarios passed`);
  for (const result of results) {
    console.log(`${result.ok ? '✅' : '❌'} ${result.label}`);
  }
  console.log(`${'═'.repeat(50)}`);

  if (usingTempEmpty) {
    fs.rmSync(emptyProject, { recursive: true, force: true });
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
