/**
 * Usage Panel sidecar backend.
 *
 * Read-only HTTP server using Antigravity's SidecarApp SDK.
 * Exposes `GET /api/usage` powered by cached SQLite + protobuf transcript
 * scanning across Antigravity conversations at zero token / zero request cost.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { queryUsage, refreshAntigravityProjects, refreshLiveRatesIfNeeded } from './usage_reader.mjs';

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

const app = new SidecarApp();
refreshLiveRatesIfNeeded();

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
  '/api/usage',
  async (data) => {
    await refreshAntigravityProjects();
    refreshLiveRatesIfNeeded();

    const currentConversationId =
      (typeof data.conversationId === 'string' && data.conversationId.trim()) ||
      app.config.conversationId ||
      '';
    const result = queryUsage({
      period: typeof data.period === 'string' ? data.period : '7d',
      scope: typeof data.scope === 'string' ? data.scope : 'all',
      family: typeof data.family === 'string' ? data.family : '',
      timeZone: typeof data.tz === 'string' ? data.tz : undefined,
      currentConversationId,
    });

    if (data.etag && data.etag === result.etag) {
      return { ok: true, unchanged: true, etag: result.etag };
    }
    return result;
  },
  'GET'
);

app.run();
