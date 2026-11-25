/**
 * Context Panel sidecar backend.
 *
 * Read-only HTTP server using Antigravity's SidecarApp SDK.
 * Exposes `GET /api/context` powered by on-disk transcript token accounting
 * and customization discovery at zero token / zero request cost.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ID_RE,
  analyzeConversation,
  listRecentConversations,
  resolveConversationAppData,
} from './analyzer.mjs';

const { SidecarApp, Response } = await import('sidecar_sdk').catch(() =>
  import(
    pathToFileURL(
      join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs')
    ).href
  )
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};
const NO_STORE = { 'Cache-Control': 'no-store' };

function parseWorkspaceUris(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u) : [];
    } catch {
      return [];
    }
  }
  return trimmed
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: NO_STORE,
}));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType, headers: NO_STORE }),
    'GET'
  );
}

app.api(
  '/api/context',
  async (data) => {
    const requestedConv = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    const hostConv = app.config.conversationId || '';
    const conv = requestedConv || hostConv || listRecentConversations(1)[0]?.id || '';

    const workspaceUris = parseWorkspaceUris(data.workspaces);

    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: conv || null, found: false };
    }

    const appData = resolveConversationAppData(conv);
    if (!appData) {
      return { conversationId: conv, found: false };
    }

    const snap = await analyzeConversation(appData, conv, { workspaceUris });
    if (!snap.found) {
      return { conversationId: conv, found: false };
    }

    const subSig = snap.details.spawnedSubagents
      .map((s) => `${s.conversationId || ''}:${s.stats?.steps || 0}`)
      .join(',');
    const etag = [
      conv,
      snap.contextLimit,
      snap.model?.id || '',
      workspaceUris.join(','),
      snap.transcriptStats.mtime,
      snap.transcriptStats.size,
      snap.stepCount,
      snap.compaction.count,
      snap.usedTokens,
      snap.categories.mcpDeferred,
      snap.categories.skillsDeferred,
      snap.details.artifacts.length,
      subSig,
    ].join('|');

    if (data.etag && data.etag === etag) {
      return { conversationId: conv, found: true, unchanged: true, etag };
    }

    return { ...snap, etag };
  },
  'GET'
);

app.run();
