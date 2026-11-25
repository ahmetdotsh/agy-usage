/**
 * Read-only Antigravity usage telemetry reader.
 *
 * Scans Antigravity conversation SQLite databases (app, cli, ide, backup),
 * decodes protobuf step & generation usage records using node:sqlite,
 * deduplicates retries across roots, resolves model families and API-equivalent
 * costs/cache savings, and caches unchanged databases by stat + WAL fingerprint.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';

function normalizePathKey(p) {
  const resolved = resolve(p);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const QUARTER_HOUR_MS = 900000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LITELLM_RATES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const RATES_TTL_MS = 86400000;
const RATES_RETRY_FLOOR_MS = 60000;
const PROJECTS_TTL_MS = 30000;

export const MODEL_IDS = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4',
  282: 'claude-sonnet-4',
  290: 'claude-opus-4',
  291: 'claude-opus-4',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b-medium',
  1016: 'gemini-3.1-pro',
  1036: 'gemini-3.1-pro',
  1037: 'gemini-3.1-pro',
  1018: 'gemini-3-flash-preview',
  1047: 'gemini-3-flash-preview',
  1084: 'gemini-3-flash-preview',
  1020: 'gemini-3.5-flash-medium',
  1021: 'gemini-3.1-flash-image',
  1026: 'claude-opus-4-6',
  1035: 'claude-sonnet-4-6',
  1050: 'gemini-3.1-flash-lite',
  1071: 'gemini-3.6-flash-high',
  1072: 'gemini-3.6-flash-medium',
  1073: 'gemini-3.6-flash-low',
  1132: 'gemini-3.5-flash-high',
  1133: 'gemini-3.5-flash-high',
  1187: 'gemini-3.5-flash-extra-low',
  1196: 'gemini-3.6-flash',
  1266: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash-high',
  1299: 'gemini-3.7-flash-medium',
  1300: 'gemini-3.7-flash-low',
  1301: 'gemini-3.7-flash-tiered',
  1318: 'gemini-3.8-flash-high',
  1319: 'gemini-3.8-flash-medium',
  1320: 'gemini-3.8-flash-low',
  1322: 'gemini-3.8-flash-tiered',
  1400: 'claude-opus-5-5-low',
  1401: 'claude-opus-5-5-medium',
  1402: 'claude-opus-5-5-high',
  1403: 'claude-sonnet-5-5-low',
  1404: 'claude-sonnet-5-5-medium',
  1405: 'claude-sonnet-5-5-high',
  1417: 'gemini-4-argon-high',
  1418: 'gemini-4-argon-medium',
  1419: 'gemini-4-argon-low',
  1427: 'gemini-4-carbon-high',
  1437: 'gemini-4-carbon-medium',
  1438: 'gemini-4-carbon-low',
  1525: 'gemini-4-hydrogen-high',
  1526: 'gemini-4-hydrogen-medium',
  1527: 'gemini-4-hydrogen-low',
  1528: 'gemini-4-hydrogen-xhigh',
  1667: 'gemini-pro-orchestrator',
  1669: 'gemini-flash-worker-agy',
  1681: 'gemini-pro-orchestrator-argon',
};

export const FAMILIES = [
  { id: 'carbon', label: 'Gemini 4 Carbon', colorVar: '--f-carbon' },
  { id: 'argon', label: 'Gemini 4 Argon', colorVar: '--f-argon' },
  { id: 'hydrogen', label: 'Gemini 4 Hydrogen', colorVar: '--f-hydrogen' },
  { id: 'flash', label: 'Gemini Flash', colorVar: '--f-flash' },
  { id: 'claude', label: 'Claude', colorVar: '--f-claude' },
  { id: 'other', label: 'Other', colorVar: '--f-other' },
];

// Built-in standard (non-promotional) API-equivalent rates (USD per 1M tokens)
export const RATE_TABLE = {
  'gemini-4-carbon': { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 4 },
  'gemini-pro-orchestrator': { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 4 },
  'gemini-pro-orchestrator-argon': { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 4 },
  'gemini-4-argon': { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 4 },
  'gemini-4-hydrogen': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.075, cwPerM: 1.5 },
  'gemini-3.8-flash': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.15, cwPerM: 1.5 },
  'gemini-flash-worker-agy': { inPerM: 1.5, outPerM: 7.5, crPerM: 0.15, cwPerM: 1.5 },
  'gemini-3.7-flash': { inPerM: 0.75, outPerM: 3.75, crPerM: 0.075, cwPerM: 0.75 },
  'gemini-3.6-flash': { inPerM: 0.75, outPerM: 3.75, crPerM: 0.075, cwPerM: 0.75 },
  'gemini-3.5-flash': { inPerM: 1.5, outPerM: 9, crPerM: 0.15, cwPerM: 1.5 },
  'gemini-3.5-flash-lite': { inPerM: 0.3, outPerM: 2.5, crPerM: 0.03, cwPerM: 0.3 },
  'gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5, crPerM: 0.03, cwPerM: 0.3 },
  'gemini-3.1-flash-lite': { inPerM: 0.25, outPerM: 1.5, crPerM: 0.025, cwPerM: 0.25 },
  'gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4, crPerM: 0.01, cwPerM: 0.1 },
  'gemini-3-flash-preview': { inPerM: 0.5, outPerM: 3, crPerM: 0.05, cwPerM: 0.5 },
  'gemini-3.1-flash-image': { inPerM: 0.5, outPerM: 3, crPerM: 0.05, cwPerM: 0.5 },
  'gemini-3.1-pro': { inPerM: 2, outPerM: 12, crPerM: 0.2, cwPerM: 2 },
  'gemini-2.5-pro': { inPerM: 1.25, outPerM: 10, crPerM: 0.125, cwPerM: 1.25 },
  'claude-opus-5-5': { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 5 },
  'claude-opus-5': { inPerM: 5, outPerM: 25, crPerM: 0.5, cwPerM: 6.25 },
  'claude-opus-4-6': { inPerM: 5, outPerM: 25, crPerM: 0.5, cwPerM: 6.25 },
  'claude-opus-4-5': { inPerM: 5, outPerM: 25, crPerM: 0.5, cwPerM: 6.25 },
  'claude-opus-4': { inPerM: 15, outPerM: 75, crPerM: 1.5, cwPerM: 18.75 },
  'claude-sonnet-5-5': { inPerM: 2, outPerM: 10, crPerM: 0.1, cwPerM: 2.5 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15, crPerM: 0.3, cwPerM: 3.75 },
  'claude-sonnet-4-5': { inPerM: 3, outPerM: 15, crPerM: 0.3, cwPerM: 3.75 },
  'claude-sonnet-4': { inPerM: 3, outPerM: 15, crPerM: 0.3, cwPerM: 3.75 },
  'claude-haiku-5-5': { inPerM: 0.1, outPerM: 0.5, crPerM: 0.01, cwPerM: 0.125 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5, crPerM: 0.1, cwPerM: 1.25 },
  'gpt-oss-120b': { inPerM: 0.15, outPerM: 0.6, crPerM: 0.15, cwPerM: 0.15 },
};

const EFFORT_RE = /-(?:extra-low|low|medium|high|xhigh|tiered|thinking|control|agent|safety-le|customtools)$/;
const VARIANT_RE = /-(?:agent(?:-[ab])?|[abfn])$/;

// ---------------------------------------------------------------------------
// Protobuf Wire Decoder
// ---------------------------------------------------------------------------

function decodeFields(bytes) {
  const result = new Map();
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return result;
  let offset = 0;

  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf varint');
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error('Malformed protobuf varint');
  };

  while (offset < bytes.length) {
    const tag = readVarint();
    if (typeof tag !== 'number') break;
    const fieldNumber = Math.floor(tag / 8);
    const wire = tag % 8;
    if (fieldNumber === 0) break;

    if (wire === 0) {
      const v = readVarint();
      let arr = result.get(fieldNumber);
      if (!arr) {
        arr = [];
        result.set(fieldNumber, arr);
      }
      arr.push(v);
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? readVarint() : wire === 1 ? 8 : 4;
      if (typeof length !== 'number' || length < 0 || length > bytes.length - offset) break;
      const slice = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire === 2) {
        let arr = result.get(fieldNumber);
        if (!arr) {
          arr = [];
          result.set(fieldNumber, arr);
        }
        arr.push(slice);
      }
    } else {
      break;
    }
  }
  return result;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function numAt(map, key) {
  const v = map.get(key)?.[0];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bytesAt(map, key) {
  const v = map.get(key)?.[0];
  return v instanceof Uint8Array ? v : undefined;
}

function nested(map, key) {
  const b = bytesAt(map, key);
  if (!b) return new Map();
  try {
    return decodeFields(b);
  } catch {
    return new Map();
  }
}

function textAt(map, key) {
  const b = bytesAt(map, key);
  if (!b) return '';
  try {
    return textDecoder.decode(b).trim();
  } catch {
    return '';
  }
}

function timestampMsAt(map) {
  const seconds = numAt(map, 1);
  if (seconds <= 0) return null;
  const nanos = numAt(map, 2);
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

function toBytes(raw) {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Model Normalization, Classification & Rate Resolution
// ---------------------------------------------------------------------------

export function normalizeModelSlug(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  let s = rawName
    .trim()
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, '-$1')
    .replace(/\s+/g, '-');
  if (s.startsWith('claude-')) {
    s = s
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, 'claude-$2-$1')
      .replaceAll('.', '-');
  }
  return s;
}

function isConcreteModel(model) {
  return (
    (model === 'gemini-pro-orchestrator' ||
      model === 'gemini-pro-orchestrator-argon' ||
      model === 'gemini-flash-worker-agy' ||
      /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model)) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model) &&
    !/^gemini-4-argon-[bf]$/.test(model) &&
    !/^gemini-3\.8-flash-n$/.test(model)
  );
}

function pickBestModelName(rawNames) {
  const normalized = rawNames.map(normalizeModelSlug).filter(Boolean);
  return (
    normalized.find(isConcreteModel) ??
    normalized.find((n) => n && !/^model[_-]/.test(n)) ??
    ''
  );
}

export function classifyFamily(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('orchestrator-argon') || m.startsWith('gemini-4-argon')) {
    return 'argon';
  }
  if (m.startsWith('gemini-4-carbon') || m.startsWith('gemini-pro-orchestrator')) {
    return 'carbon';
  }
  if (m.startsWith('gemini-4-hydrogen')) {
    return 'hydrogen';
  }
  if (m.startsWith('gemini-flash') || /^gemini-.*-flash/.test(m)) {
    return 'flash';
  }
  if (m.startsWith('claude-')) {
    return 'claude';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Standard (Non-Promo) Pricing + Live 24h LiteLLM Sync
// ---------------------------------------------------------------------------

const rateLookupCache = new Map();
let liveRateMap = new Map();
let liveRatesMeta = {
  fetchedAtMs: 0,
  lastAttemptMs: 0,
  updatedAt: null,
  source: 'builtin',
  version: 1,
};
let ratesInFlight = null;

function applyStandardNonPromoOverride(slug, rate) {
  if (!rate) return null;
  const s = String(slug || '').toLowerCase();
  const isCarbonOrArgon =
    s.startsWith('gemini-4-carbon') ||
    s.startsWith('gemini-4-argon') ||
    s.startsWith('gemini-pro-orchestrator');
  if (isCarbonOrArgon && Math.abs(rate.inPerM - 2) < 0.01 && Math.abs(rate.outPerM - 10) < 0.01) {
    return { inPerM: 4, outPerM: 20, crPerM: 0.2, cwPerM: 4 };
  }
  const is38Flash = s.startsWith('gemini-3.8-flash') || s === 'gemini-flash-worker-agy';
  if (is38Flash && Math.abs(rate.inPerM - 0.75) < 0.01 && Math.abs(rate.outPerM - 3.75) < 0.01) {
    return { inPerM: 1.5, outPerM: 7.5, crPerM: 0.15, cwPerM: 1.5 };
  }
  return rate;
}

function parseLiteLlmDocument(document) {
  const map = new Map();
  if (!document || typeof document !== 'object') return map;
  const prio = new Map();

  for (const [rawKey, entry] of Object.entries(document)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.mode && entry.mode !== 'chat') continue;
    if (typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') {
      continue;
    }

    let bareKey = rawKey.toLowerCase();
    let score = 0;
    if (!bareKey.includes('/')) {
      score = 4;
    } else if (bareKey.startsWith('gemini/') || bareKey.startsWith('anthropic/')) {
      bareKey = bareKey.slice(bareKey.indexOf('/') + 1);
      score = 3;
    } else if (bareKey.startsWith('vertex_ai/')) {
      bareKey = bareKey.slice('vertex_ai/'.length);
      score = 2;
    } else {
      continue;
    }

    const slug = normalizeModelSlug(bareKey);
    if (!slug) continue;
    if ((prio.get(slug) || 0) >= score) continue;
    prio.set(slug, score);

    const inPerM = Number((entry.input_cost_per_token * 1e6).toFixed(6));
    const outPerM = Number((entry.output_cost_per_token * 1e6).toFixed(6));
    const crPerM =
      typeof entry.cache_read_input_token_cost === 'number'
        ? Number((entry.cache_read_input_token_cost * 1e6).toFixed(6))
        : Number((inPerM * 0.1).toFixed(6));
    const cwPerM =
      typeof entry.cache_creation_input_token_cost === 'number'
        ? Number((entry.cache_creation_input_token_cost * 1e6).toFixed(6))
        : slug.startsWith('claude-')
          ? Number((inPerM * 1.25).toFixed(6))
          : inPerM;

    map.set(slug, { inPerM, outPerM, crPerM, cwPerM });
  }
  return map;
}

function getRatesCachePath(geminiDir = join(homedir(), '.gemini')) {
  return join(geminiDir, 'antigravity', 'plugin_data', 'usage', 'model-rates.json');
}

function initLiveRatesSync(geminiDir = join(homedir(), '.gemini')) {
  const cachePath = getRatesCachePath(geminiDir);
  try {
    if (existsSync(cachePath)) {
      const parsedFile = JSON.parse(readFileSync(cachePath, 'utf8'));
      const doc = parsedFile?.document || parsedFile;
      const parsedMap = parseLiteLlmDocument(doc);
      if (parsedMap.size > 0) {
        liveRateMap = parsedMap;
        liveRatesMeta = {
          fetchedAtMs: Number(parsedFile?.fetchedAtMs) || statSync(cachePath).mtimeMs,
          lastAttemptMs: 0,
          updatedAt: parsedFile?.fetchedAtMs
            ? new Date(Number(parsedFile.fetchedAtMs)).toISOString()
            : null,
          source: 'litellm-cache',
          version: liveRatesMeta.version + 1,
        };
        return;
      }
    }
  } catch {
    // ignore corrupt cache and fall back
  }

  // Optional local seed from ~/.t3/userdata/usage-model-rates.json on first boot
  const t3SeedPath = join(homedir(), '.t3', 'userdata', 'usage-model-rates.json');
  try {
    if (geminiDir === join(homedir(), '.gemini') && existsSync(t3SeedPath)) {
      const seed = JSON.parse(readFileSync(t3SeedPath, 'utf8'));
      const parsedMap = parseLiteLlmDocument(seed?.document);
      if (parsedMap.size > 0) {
        liveRateMap = parsedMap;
        const ts = Number(seed?.fetchedAtMs) || Date.now();
        liveRatesMeta = {
          fetchedAtMs: ts,
          lastAttemptMs: 0,
          updatedAt: new Date(ts).toISOString(),
          source: 'litellm-cache',
          version: liveRatesMeta.version + 1,
        };
        try {
          mkdirSync(dirname(cachePath), { recursive: true });
          writeFileSync(
            cachePath,
            JSON.stringify({ fetchedAtMs: ts, source: LITELLM_RATES_URL, document: seed.document })
          );
        } catch {
          // ignore read-only FS errors
        }
      }
    }
  } catch {
    // ignore missing or invalid seed
  }
}

initLiveRatesSync();

export function refreshLiveRatesIfNeeded(geminiDir = join(homedir(), '.gemini')) {
  const now = Date.now();
  if (liveRatesMeta.fetchedAtMs > 0 && now - liveRatesMeta.fetchedAtMs < RATES_TTL_MS) {
    return ratesInFlight || Promise.resolve(false);
  }
  if (now - liveRatesMeta.lastAttemptMs < RATES_RETRY_FLOOR_MS) {
    return ratesInFlight || Promise.resolve(false);
  }
  if (ratesInFlight) return ratesInFlight;

  liveRatesMeta.lastAttemptMs = now;
  ratesInFlight = (async () => {
    try {
      const res = await fetch(LITELLM_RATES_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const doc = await res.json();
      const parsedMap = parseLiteLlmDocument(doc);
      if (parsedMap.size === 0) return false;

      const fetchedAtMs = Date.now();
      liveRateMap = parsedMap;
      liveRatesMeta = {
        fetchedAtMs,
        lastAttemptMs: fetchedAtMs,
        updatedAt: new Date(fetchedAtMs).toISOString(),
        source: LITELLM_RATES_URL,
        version: liveRatesMeta.version + 1,
      };
      rateLookupCache.clear();
      cachedIndex.atMs = 0;
      cachedIndex.signature = '';

      try {
        const cachePath = getRatesCachePath(geminiDir);
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ fetchedAtMs, source: LITELLM_RATES_URL, document: doc }));
      } catch {
        // non-fatal if disk write fails
      }
      return true;
    } catch {
      return false;
    } finally {
      ratesInFlight = null;
    }
  })();

  return ratesInFlight;
}

function getBaseRate(slug) {
  return liveRateMap.get(slug) ?? RATE_TABLE[slug] ?? null;
}

export function lookupRate(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw || raw === 'antigravity-unknown' || raw.startsWith('antigravity-model-')) {
    return null;
  }
  if (rateLookupCache.has(raw)) {
    return rateLookupCache.get(raw);
  }

  let matchedSlug = raw;
  let found = getBaseRate(raw);

  if (!found) {
    let cur = raw;
    for (let i = 0; i < 4; i++) {
      const next = cur.replace(EFFORT_RE, '').replace(VARIANT_RE, '');
      if (next === cur) break;
      cur = next;
      const r = getBaseRate(cur);
      if (r) {
        found = r;
        matchedSlug = cur;
        break;
      }
    }
    if (!found) {
      let fallbackKey = '';
      if (cur === 'gemini-3-flash' || /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(raw)) {
        fallbackKey = 'gemini-3-flash-preview';
      } else if (cur.startsWith('gemini-4-argon')) {
        fallbackKey = 'gemini-4-argon';
      } else if (cur.startsWith('gemini-4-carbon')) {
        fallbackKey = 'gemini-4-carbon';
      } else if (cur.startsWith('gemini-4-hydrogen')) {
        fallbackKey = 'gemini-4-hydrogen';
      } else if (cur.startsWith('gemini-3.8-flash')) {
        fallbackKey = 'gemini-3.8-flash';
      } else if (cur.startsWith('gemini-3.7-flash')) {
        fallbackKey = 'gemini-3.7-flash';
      } else if (cur.startsWith('gemini-3.6-flash')) {
        fallbackKey = 'gemini-3.6-flash';
      } else if (cur.startsWith('gemini-3.5-flash-lite')) {
        fallbackKey = 'gemini-3.5-flash-lite';
      } else if (cur.startsWith('gemini-3.5-flash')) {
        fallbackKey = 'gemini-3.5-flash';
      } else if (cur.startsWith('claude-opus-5-5')) {
        fallbackKey = 'claude-opus-5-5';
      } else if (cur.startsWith('claude-sonnet-5-5')) {
        fallbackKey = 'claude-sonnet-5-5';
      }
      if (fallbackKey) {
        found = getBaseRate(fallbackKey);
        matchedSlug = fallbackKey;
      }
    }
  }

  const finalRate = applyStandardNonPromoOverride(matchedSlug, found);
  rateLookupCache.set(raw, finalRate);
  return finalRate;
}

function scoreRecordPricing(model, totals) {
  const rate = lookupRate(model);
  if (!rate) {
    return {
      costUsd: 0,
      cacheSavingsUsd: 0,
      catCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      priced: false,
    };
  }
  const input = (totals.uncachedInputTokens / 1e6) * rate.inPerM;
  const cacheRead = (totals.cachedInputTokens / 1e6) * rate.crPerM;
  const cacheWrite = (totals.cacheCreationTokens / 1e6) * (rate.cwPerM ?? rate.inPerM);
  const output = (totals.outputTokens / 1e6) * rate.outPerM;
  const costUsd = input + cacheRead + cacheWrite + output;
  const cacheSavingsUsd = (totals.cachedInputTokens / 1e6) * Math.max(0, rate.inPerM - rate.crPerM);
  return {
    costUsd,
    cacheSavingsUsd,
    catCost: { input, cacheRead, cacheWrite, output },
    priced: true,
  };
}

// ---------------------------------------------------------------------------
// SQLite Protobuf Extraction & Fingerprint Cache
// ---------------------------------------------------------------------------

function extractMetadataEntry(bytes, isStep) {
  const root = decodeFields(bytes);
  if (!isStep && bytesAt(root, 1) === undefined) return null;
  const data = isStep ? root : nested(root, 1);
  const modelMsg = isStep ? nested(data, 24) : data;
  const primaryUsageBytes = bytesAt(data, isStep ? 9 : 4);
  let primaryUsage = null;
  if (primaryUsageBytes) {
    try {
      primaryUsage = decodeFields(primaryUsageBytes);
    } catch {
      primaryUsage = null;
    }
  }
  const usages = primaryUsage ? [primaryUsage] : [];

  for (const retryBytes of data.get(isStep ? 28 : 17) ?? []) {
    if (!(retryBytes instanceof Uint8Array)) continue;
    try {
      const retryUsageBytes = bytesAt(decodeFields(retryBytes), 2);
      if (retryUsageBytes) usages.push(decodeFields(retryUsageBytes));
    } catch {
      // skip malformed retry block
    }
  }

  const rawNames = [
    textAt(modelMsg, isStep ? 12 : 19),
    textAt(modelMsg, isStep ? 8 : 21),
  ];
  const model = pickBestModelName(rawNames);
  const modelId = numAt(modelMsg, isStep ? 1 : 3) || (primaryUsage ? numAt(primaryUsage, 1) : 0);
  const timestampMs = isStep
    ? timestampMsAt(nested(data, 8)) ?? timestampMsAt(nested(data, 1))
    : timestampMsAt(nested(nested(data, 9), 4));

  return { model, modelId, timestampMs, usages };
}

function readConversationDb(dbPath, sessionId, surface, fallbackTimestampMs) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const tables = new Set(tableRows.map((r) => r.name));
    if (!tables.has('gen_metadata') && !tables.has('steps')) {
      return { candidates: [], models: new Map() };
    }

    const generations = [];
    if (tables.has('gen_metadata')) {
      const rowIds = db.prepare('SELECT rowid AS rowid FROM gen_metadata ORDER BY rowid').all();
      const getGen = db.prepare('SELECT idx, data FROM gen_metadata WHERE rowid = ?');
      for (const { rowid } of rowIds) {
        const row = getGen.get(rowid);
        const bytes = toBytes(row?.data);
        if (!bytes) continue;
        try {
          const entry = extractMetadataEntry(bytes, false);
          if (entry) generations.push({ idx: Number(row.idx), entry });
        } catch {
          // ignore unreadable blob
        }
      }
    }

    let trajectoryTimestampMs = null;
    if (tables.has('trajectory_metadata_blob')) {
      const tRows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
      for (const row of tRows) {
        const bytes = toBytes(row?.data);
        if (!bytes) continue;
        try {
          const root = decodeFields(bytes);
          trajectoryTimestampMs = timestampMsAt(nested(root, 2));
          if (trajectoryTimestampMs !== null) break;
        } catch {
          // ignore
        }
      }
    }

    const steps = [];
    if (tables.has('steps')) {
      const sRows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').all();
      for (const row of sRows) {
        const bytes = toBytes(row?.metadata);
        if (!bytes) continue;
        try {
          const entry = extractMetadataEntry(bytes, true);
          if (entry) steps.push({ idx: Number(row.idx), entry });
        } catch {
          // ignore
        }
      }
    }

    const models = new Map();
    for (const { entry } of [...generations, ...steps]) {
      if (entry.modelId > 0 && isConcreteModel(entry.model)) {
        const prev = models.get(entry.modelId);
        if (prev === undefined) {
          models.set(entry.modelId, entry.model);
        } else if (prev !== null && prev !== entry.model) {
          models.set(entry.modelId, null);
        }
      }
    }

    const genByIdx = new Map(generations.map((g) => [g.idx, g.entry]));
    const candidates = [];

    for (const [source, list] of [['step', steps], ['generation', generations]]) {
      for (let i = 0; i < list.length; i++) {
        const { idx, entry } = list[i];
        for (let u = 0; u < entry.usages.length; u++) {
          const usage = entry.usages[u];
          const modelId = numAt(usage, 1) || entry.modelId;
          const genEntry = source === 'step' ? genByIdx.get(idx) : undefined;
          const matchesId = (meta) => modelId === 0 || meta.modelId === modelId;
          const model =
            matchesId(entry) && entry.model
              ? entry.model
              : genEntry && matchesId(genEntry)
                ? genEntry.model
                : '';

          const outputTokens = Math.max(numAt(usage, 3), numAt(usage, 9) + numAt(usage, 10));
          const totals = {
            uncachedInputTokens: numAt(usage, 2),
            cachedInputTokens: numAt(usage, 5),
            cacheCreationTokens: numAt(usage, 4),
            outputTokens,
            reasoningTokens: Math.min(outputTokens, numAt(usage, 9)),
          };
          if (
            totals.uncachedInputTokens +
              totals.cachedInputTokens +
              totals.cacheCreationTokens +
              totals.outputTokens ===
            0
          ) {
            continue;
          }

          const keys = [11, 12, 7].flatMap((k) => {
            const id = textAt(usage, k);
            return id ? [`${k}:${id}`] : [];
          });

          candidates.push({
            sessionId,
            surface,
            model,
            modelId,
            modelQuality: isConcreteModel(model) ? 4 : model ? 1 : 0,
            timestampMs: entry.timestampMs ?? trajectoryTimestampMs ?? fallbackTimestampMs,
            timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestampMs !== null ? 1 : 0,
            totals,
            keys,
            dedupeKey: keys[0] ?? `${sessionId}:${source}:${i}:${u}`,
          });
        }
      }
    }

    return { candidates, models };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Workspace & Session Metadata Discovery
// ---------------------------------------------------------------------------

const dbCache = new Map();       // canonicalPath -> { fingerprint, data }
const summaryCache = new Map();  // summaryDbPath -> { fingerprint, map }
const realpathCache = new Map(); // fullPath -> canonicalPath
let projectsCache = { loadedAtMs: 0, sig: '', byId: new Map(), byPath: new Map() };
let projectsInFlight = null;
let cachedIndex = { signature: '', geminiDir: '', atMs: 0, records: [], sessionsMeta: new Map(), errorCount: 0 };

function fileFingerprint(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const walPath = `${filePath}-wal`;
    let walPart = '-';
    if (existsSync(walPath)) {
      try {
        const wst = statSync(walPath);
        walPart = `${wst.size}:${wst.mtimeMs}:${wst.ctimeMs}`;
      } catch {
        walPart = '?';
      }
    }
    return {
      stat: st,
      fingerprint: `${st.size}:${st.mtimeMs}:${st.ctimeMs}/${walPart}`,
    };
  } catch {
    return null;
  }
}

function getProjectsCachePath(geminiDir = join(homedir(), '.gemini')) {
  return join(geminiDir, 'antigravity', 'plugin_data', 'usage', 'projects-cache.json');
}

function fileUriToResolvedPath(uri) {
  let fsPath = String(uri || '').trim();
  if (!fsPath) return '';
  if (fsPath.startsWith('file://')) {
    try {
      fsPath = fileURLToPath(fsPath);
    } catch {
      try {
        fsPath = decodeURIComponent(new URL(fsPath).pathname);
      } catch {
        fsPath = fsPath.slice(7);
      }
      if (IS_WIN && /^\/[a-zA-Z]:/.test(fsPath)) {
        fsPath = fsPath.slice(1);
      }
    }
  }
  return resolve(fsPath);
}

function buildProjectsState(items) {
  const byId = new Map();
  const byPath = new Map();
  const clean = [];
  for (const item of items) {
    if (!item || !item.id || !item.name) continue;
    const folderPaths = [...new Set((item.folderPaths || []).map((p) => resolve(p)).filter(Boolean))];
    const entry = { id: String(item.id), name: String(item.name).trim(), folderPaths };
    if (!entry.name) continue;
    byId.set(entry.id, entry);
    for (const fp of folderPaths) {
      byPath.set(normalizePathKey(fp), entry);
    }
    clean.push(entry);
  }
  clean.sort((a, b) => a.id.localeCompare(b.id));
  const sig = clean.map((p) => `${p.id}:${p.name}:${p.folderPaths.join(',')}`).join(';');
  return { byId, byPath, sig, clean };
}

function initProjectsCache(geminiDir = join(homedir(), '.gemini')) {
  const cachePath = getProjectsCachePath(geminiDir);
  try {
    if (!existsSync(cachePath)) return;
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!Array.isArray(raw?.projects)) return;
    const built = buildProjectsState(raw.projects);
    if (built.byId.size > 0) {
      projectsCache = {
        loadedAtMs: Number(raw.updatedAtMs) || 0,
        sig: built.sig,
        byId: built.byId,
        byPath: built.byPath,
      };
    }
  } catch {
    // ignore invalid project cache on boot
  }
}

initProjectsCache();

function extractProjectFolderPaths(project) {
  const resources = project?.projectResources?.resources;
  if (!Array.isArray(resources)) return [];
  const paths = [];
  for (const res of resources) {
    const uri = res?.folderUri || res?.gitFolder?.folderUri;
    if (typeof uri === 'string' && uri.trim()) {
      const p = fileUriToResolvedPath(uri);
      if (p) paths.push(p);
    }
  }
  return [...new Set(paths)];
}

function fallbackProjectsFromDb(geminiDir) {
  const legacyNames = new Map();
  try {
    const legacyPath = join(geminiDir, 'projects.json');
    if (existsSync(legacyPath)) {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8'));
      if (raw && typeof raw.projects === 'object' && raw.projects !== null) {
        for (const [fsPath, name] of Object.entries(raw.projects)) {
          if (typeof fsPath === 'string' && typeof name === 'string' && name.trim()) {
            legacyNames.set(normalizePathKey(fsPath), name.trim());
          }
        }
      }
    }
  } catch {
    // ignore projects.json read errors
  }

  const found = new Map();
  const dbPath = join(geminiDir, 'antigravity', 'conversation_summaries.db');
  if (!existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT project_id, workspace_uris FROM conversation_summaries WHERE project_id IS NOT NULL')
      .all();
    for (const row of rows) {
      const pid = String(row.project_id || '').trim();
      if (!UUID_RE.test(pid)) continue;
      const paths = parseWorkspaceUris(row.workspace_uris);
      const entry = found.get(pid) || { id: pid, name: '', folderPaths: [] };
      for (const p of paths) {
        if (!entry.folderPaths.includes(p)) entry.folderPaths.push(p);
        const norm = normalizePathKey(p);
        if (!entry.name && legacyNames.has(norm)) entry.name = legacyNames.get(norm);
      }
      if (!entry.name && paths[0]) entry.name = basename(paths[0]) || paths[0];
      found.set(pid, entry);
    }
  } catch {
    // ignore busy DB
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return [...found.values()].filter((e) => e.name);
}

/**
 * Queries Antigravity Language Server for the user's real registered projects
 * (skipping internal sidecar projects and `outside-of-project`), caching the map
 * on disk with a 30s TTL. Falls back gracefully if LS is offline.
 */
export async function refreshAntigravityProjects(geminiDir = join(homedir(), '.gemini')) {
  const now = Date.now();
  if (projectsCache.loadedAtMs > 0 && now - projectsCache.loadedAtMs < PROJECTS_TTL_MS && projectsCache.byId.size > 0) {
    return projectsCache;
  }
  if (projectsInFlight) return projectsInFlight;

  projectsInFlight = (async () => {
    const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    const prevSig = projectsCache.sig;

    if (addr) {
      try {
        const headers = {
          'content-type': 'application/json',
          ...(csrf ? { 'x-codeium-csrf-token': csrf } : {}),
        };
        const callLs = async (method, body) => {
          const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/${method}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(1500),
          });
          if (!res.ok) throw new Error(`LS ${method} ${res.status}`);
          return res.json();
        };

        const list = await callLs('ListProjects', {});
        const ids = Array.isArray(list?.projectIds)
          ? list.projectIds.filter((id) => typeof id === 'string' && id && id !== 'outside-of-project')
          : [];
        const details = await Promise.all(
          ids.map((id) => callLs('ReadProject', { id }).catch(() => null))
        );
        const items = [];
        for (const res of details) {
          const proj = res?.project;
          if (!proj || !proj.id || proj.id === 'outside-of-project') continue;
          if (proj.sidecar?.sidecarId) continue;
          if (!UUID_RE.test(proj.id)) continue;
          const folderPaths = extractProjectFolderPaths(proj);
          const name = String(proj.name || basename(folderPaths[0] || '') || proj.id).trim();
          items.push({ id: proj.id, name, folderPaths });
        }

        const built = buildProjectsState(items);
        const updatedAtMs = Date.now();
        projectsCache = {
          loadedAtMs: updatedAtMs,
          sig: built.sig,
          byId: built.byId,
          byPath: built.byPath,
        };
        if (built.sig !== prevSig) {
          cachedIndex.atMs = 0;
          cachedIndex.signature = '';
        }
        try {
          const cachePath = getProjectsCachePath(geminiDir);
          mkdirSync(dirname(cachePath), { recursive: true });
          writeFileSync(cachePath, JSON.stringify({ updatedAtMs, projects: built.clean }));
        } catch {
          // non-fatal if read-only
        }
        return projectsCache;
      } catch {
        // LS unreachable; fall through to cache/DB fallback
      }
    }

    if (projectsCache.byId.size === 0) {
      const fbItems = fallbackProjectsFromDb(geminiDir);
      if (fbItems.length > 0) {
        const built = buildProjectsState(fbItems);
        projectsCache = {
          loadedAtMs: Date.now(),
          sig: built.sig,
          byId: built.byId,
          byPath: built.byPath,
        };
        if (built.sig !== prevSig) {
          cachedIndex.atMs = 0;
          cachedIndex.signature = '';
        }
      }
    }
    return projectsCache;
  })().finally(() => {
    projectsInFlight = null;
  });

  return projectsInFlight;
}

function parseWorkspaceUris(rawUris) {
  let uris = [];
  if (typeof rawUris === 'string' && rawUris.trim()) {
    try {
      const parsed = JSON.parse(rawUris);
      if (Array.isArray(parsed)) uris = parsed.filter((u) => typeof u === 'string' && u);
    } catch {
      // ignore non-json
    }
  }
  const paths = [];
  for (const uri of uris) {
    const resolved = fileUriToResolvedPath(uri);
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

function resolveSessionProject(meta, projects) {
  if (!meta) return { projectKey: 'none', projectLabel: '' };
  const candidateIds = [meta.projectId, meta.rootProjectId].filter(Boolean);
  for (const pid of candidateIds) {
    const hit = projects.byId.get(pid);
    if (hit) return { projectKey: hit.id, projectLabel: hit.name };
  }
  for (const rawWsPath of meta.workspaceKeys || []) {
    const wsPath = normalizePathKey(rawWsPath);
    const exact = projects.byPath.get(wsPath);
    if (exact) return { projectKey: exact.id, projectLabel: exact.name };
    for (const [projPath, entry] of projects.byPath) {
      const prefix = projPath.endsWith(sep) ? projPath : `${projPath}${sep}`;
      if (wsPath.startsWith(prefix)) {
        return { projectKey: entry.id, projectLabel: entry.name };
      }
    }
  }
  return { projectKey: 'none', projectLabel: '' };
}

function readSummariesForRoot(rootDir, surface) {
  const dbPath = join(rootDir, 'conversation_summaries.db');
  const fp = fileFingerprint(dbPath);
  if (!fp) return new Map();
  const cached = summaryCache.get(dbPath);
  if (cached && cached.fingerprint === fp.fingerprint) return cached.map;

  const map = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT conversation_id, title, workspace_uris, project_id, agent_name,
                parent_conversation_id, nesting_depth, last_modified_time
         FROM conversation_summaries`
      )
      .all();
    for (const row of rows) {
      const id = String(row.conversation_id || '');
      if (!id) continue;
      map.set(id, {
        conversationId: id,
        title: String(row.title || '').trim(),
        workspaceKeys: parseWorkspaceUris(row.workspace_uris),
        projectId: String(row.project_id || '').trim(),
        agentName: String(row.agent_name || '').trim(),
        parentConversationId: String(row.parent_conversation_id || '').trim(),
        nestingDepth: Number(row.nesting_depth) || 0,
        lastModifiedMs: row.last_modified_time ? Date.parse(String(row.last_modified_time)) || 0 : 0,
        surface,
      });
    }
  } catch {
    // keep partial map if DB busy
  } finally {
    try {
      db?.close();
    } catch {}
  }

  summaryCache.set(dbPath, { fingerprint: fp.fingerprint, map });
  return map;
}

function loadUsageIndex(geminiDir = join(homedir(), '.gemini')) {
  const indexNowMs = Date.now();
  if (
    cachedIndex.records.length > 0 &&
    cachedIndex.geminiDir === geminiDir &&
    indexNowMs - cachedIndex.atMs < 1200
  ) {
    return cachedIndex;
  }

  const roots = [
    { dir: join(geminiDir, 'antigravity'), surface: 'app' },
    { dir: join(geminiDir, 'antigravity-cli'), surface: 'cli' },
    { dir: join(geminiDir, 'antigravity-ide'), surface: 'ide' },
    { dir: join(geminiDir, 'antigravity-backup'), surface: 'backup' },
  ];

  const sessionsMeta = new Map();
  const visitedDbPaths = new Set();
  const pending = [];
  const learnedModels = new Map();
  let signatureParts = [];
  let errorCount = 0;

  for (const { dir, surface } of roots) {
    if (!existsSync(dir)) continue;

    const rootSummaries = readSummariesForRoot(dir, surface);
    for (const [id, meta] of rootSummaries) {
      const existing = sessionsMeta.get(id);
      if (!existing || meta.lastModifiedMs >= existing.lastModifiedMs) {
        sessionsMeta.set(id, meta);
      }
    }

    const convDir = join(dir, 'conversations');
    if (!existsSync(convDir)) continue;
    let files;
    try {
      files = readdirSync(convDir).filter((f) => f.endsWith('.db')).sort();
    } catch {
      errorCount += 1;
      continue;
    }

    for (const file of files) {
      const fullPath = join(convDir, file);
      let canonical = realpathCache.get(fullPath);
      if (!canonical) {
        try {
          canonical = realpathSync(fullPath);
        } catch {
          canonical = fullPath;
        }
        realpathCache.set(fullPath, canonical);
      }
      if (visitedDbPaths.has(canonical)) continue;
      visitedDbPaths.add(canonical);

      const fp = fileFingerprint(canonical);
      if (!fp) continue;
      signatureParts.push(`${canonical}=${fp.fingerprint}`);

      let cached = dbCache.get(canonical);
      if (!cached || cached.fingerprint !== fp.fingerprint) {
        const sessionId = basename(file, '.db');
        try {
          const data = readConversationDb(canonical, sessionId, surface, fp.stat.mtimeMs);
          cached = { fingerprint: fp.fingerprint, data };
          dbCache.set(canonical, cached);
        } catch {
          errorCount += 1;
          continue;
        }
      }

      for (const [id, model] of cached.data.models) {
        const prev = learnedModels.get(id);
        if (prev === undefined) {
          learnedModels.set(id, model);
        } else if (prev !== null && prev !== model) {
          learnedModels.set(id, null);
        }
      }

      if (cached.data.candidates.length > 0) {
        pending.push(cached.data.candidates);
      }
    }
  }

  for (const key of dbCache.keys()) {
    if (!visitedDbPaths.has(key)) dbCache.delete(key);
  }

  // Inherit projectId, workspaceKeys & rootSessionId along parent chains
  for (const [id, meta] of sessionsMeta) {
    let rootId = id;
    let cur = meta;
    let inheritedProjectId = meta.projectId || '';
    let inheritedWorkspaces = meta.workspaceKeys || [];
    let hops = 0;
    while (cur?.parentConversationId && hops < 6) {
      rootId = cur.parentConversationId;
      cur = sessionsMeta.get(cur.parentConversationId);
      if (
        cur?.projectId &&
        (!inheritedProjectId ||
          inheritedProjectId === 'outside-of-project' ||
          inheritedProjectId === 'default-cli-project')
      ) {
        inheritedProjectId = cur.projectId;
      }
      if (inheritedWorkspaces.length === 0 && cur?.workspaceKeys?.length > 0) {
        inheritedWorkspaces = cur.workspaceKeys;
      }
      hops += 1;
    }
    meta.rootSessionId = rootId;
    meta.rootTitle = cur?.title || '';
    meta.rootProjectId = inheritedProjectId;
    if ((!meta.workspaceKeys || meta.workspaceKeys.length === 0) && inheritedWorkspaces.length > 0) {
      meta.workspaceKeys = inheritedWorkspaces;
    }
  }

  // Include active project signature, live rates version & summary fingerprints
  for (const s of summaryCache.values()) {
    signatureParts.push(`sum=${s.fingerprint}`);
  }
  signatureParts.push(`proj=${projectsCache.sig}`);
  signatureParts.push(`rates=${liveRatesMeta.version}`);
  const signature = signatureParts.join('|');

  if (cachedIndex.signature === signature && cachedIndex.records.length > 0) {
    cachedIndex.atMs = indexNowMs;
    return cachedIndex;
  }

  // Resolve models & deduplicate across files/steps/gen_metadata via Union-Find
  const groups = [];
  const identities = new Map();

  const find = (index) => {
    let root = index;
    while (groups[root].parent !== root) root = groups[root].parent;
    while (index !== root) {
      const next = groups[index].parent;
      groups[index].parent = root;
      index = next;
    }
    return root;
  };

  const merge = (left, right) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a].size < groups[b].size) [a, b] = [b, a];
    const target = groups[a];
    const source = groups[b];
    const first = target.owner < source.owner ? target : source;
    const bestModel =
      source.modelQuality === target.modelQuality
        ? first
        : source.modelQuality > target.modelQuality
          ? source
          : target;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.timestampMs < target.timestampMs)
        ? source
        : target;

    const x = target.totals;
    const y = source.totals;
    target.sessionId = first.sessionId;
    target.surface = first.surface;
    target.model = bestModel.model;
    target.modelQuality = bestModel.modelQuality;
    target.timestampMs = bestTime.timestampMs;
    target.timestampQuality = bestTime.timestampQuality;
    target.owner = first.owner;
    target.totals = {
      uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
      cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
      cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
      outputTokens: Math.max(x.outputTokens, y.outputTokens),
      reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
    };
    target.size += source.size;
    source.parent = a;
    return a;
  };

  for (const list of pending) {
    for (const c of list) {
      const learned = learnedModels.get(c.modelId);
      const fallback = MODEL_IDS[c.modelId];
      const model =
        (c.modelQuality === 4 ? c.model : '') ||
        (learned || undefined) ||
        fallback ||
        c.model ||
        (c.modelId > 0 ? `antigravity-model-${c.modelId}` : 'antigravity-unknown');
      const modelQuality =
        c.modelQuality === 4 ? 4 : learned ? 3 : fallback ? 2 : c.modelQuality;

      const idx = groups.length;
      groups.push({
        parent: idx,
        size: 1,
        owner: idx,
        sessionId: c.sessionId,
        surface: c.surface,
        model,
        modelQuality,
        timestampMs: c.timestampMs,
        timestampQuality: c.timestampQuality,
        totals: { ...c.totals },
      });

      for (const k of c.keys) {
        const existing = identities.get(k);
        if (existing !== undefined) merge(idx, existing);
        else identities.set(k, idx);
      }
    }
  }

  const records = [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].parent !== i) continue;
    const g = groups[i];
    const meta = sessionsMeta.get(g.sessionId);
    const proj = resolveSessionProject(meta, projectsCache);
    const pricing = scoreRecordPricing(g.model, g.totals);
    const processedTokens =
      g.totals.uncachedInputTokens +
      g.totals.cachedInputTokens +
      g.totals.cacheCreationTokens +
      g.totals.outputTokens;
    records.push({
      sessionId: g.sessionId,
      surface: meta?.surface || g.surface,
      rootSessionId: meta?.rootSessionId || g.sessionId,
      isSubagent: Boolean(meta?.parentConversationId),
      projectKey: proj.projectKey,
      projectLabel: proj.projectLabel,
      workspaceLabel: proj.projectLabel,
      model: g.model,
      family: classifyFamily(g.model),
      timestampMs: g.timestampMs,
      totals: g.totals,
      processedTokens,
      costUsd: pricing.costUsd,
      cacheSavingsUsd: pricing.cacheSavingsUsd,
      catCost: pricing.catCost,
      priced: pricing.priced,
    });
  }

  cachedIndex = { signature, geminiDir, atMs: indexNowMs, records, sessionsMeta, errorCount };
  return cachedIndex;
}

// ---------------------------------------------------------------------------
// Time Bucketing & Query Aggregation
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dayFormatterCache = new Map();
const hourShortFmtCache = new Map();
const hourTooltipFmtCache = new Map();

function makeDayFormatter(timeZone) {
  const cacheKey = typeof timeZone === 'string' ? timeZone : '';
  const cachedFmt = dayFormatterCache.get(cacheKey);
  if (cachedFmt) return cachedFmt;

  let fmt;
  let resolvedZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: resolvedZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    resolvedZone = 'UTC';
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  const slotCache = new Map();
  const wrapper = {
    timeZone: resolvedZone,
    formatDay(ms) {
      const slot = Math.floor(ms / QUARTER_HOUR_MS);
      let cached = slotCache.get(slot);
      if (cached === undefined) {
        const first = fmt.format(new Date(slot * QUARTER_HOUR_MS));
        const end = fmt.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
        cached = first === end ? first : null;
        if (slotCache.size > 40000) slotCache.clear();
        slotCache.set(slot, cached);
      }
      return cached ?? fmt.format(new Date(ms));
    },
  };
  dayFormatterCache.set(cacheKey, wrapper);
  return wrapper;
}

function buildDayWindow(daysCount, nowMs, dayFmt) {
  const todayStr = dayFmt.formatDay(nowMs);
  const [y, m, d] = todayStr.split('-').map(Number);
  const list = [];
  for (let i = daysCount - 1; i >= 0; i--) {
    const dayKey = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    list.push(dayKey);
  }
  return list;
}

function formatDayShort(dayKey) {
  const parts = dayKey.split('-');
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return `${SHORT_MONTHS[m - 1] || ''} ${d}`;
}

function getCachedHourFormatter(cache, timeZone, options) {
  const key = timeZone || 'UTC';
  let fmt = cache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: key });
    cache.set(key, fmt);
  }
  return fmt;
}

function formatHourShort(ts, timeZone) {
  try {
    return getCachedHourFormatter(hourShortFmtCache, timeZone, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

function formatHourTooltip(ts, timeZone) {
  try {
    return getCachedHourFormatter(hourTooltipFmtCache, timeZone, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(5, 16);
  }
}

function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

function emptyAgg() {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    catCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    records: 0,
    unpricedRecords: 0,
    sessions: new Set(),
    rootSessions: new Set(),
    subagentSessions: new Set(),
  };
}

function addRecordToAgg(agg, rec) {
  agg.uncachedInputTokens += rec.totals.uncachedInputTokens;
  agg.cachedInputTokens += rec.totals.cachedInputTokens;
  agg.cacheCreationTokens += rec.totals.cacheCreationTokens;
  agg.outputTokens += rec.totals.outputTokens;
  agg.reasoningTokens += rec.totals.reasoningTokens;
  agg.processedTokens += rec.processedTokens;
  agg.costUsd += rec.costUsd;
  agg.cacheSavingsUsd += rec.cacheSavingsUsd;
  agg.catCost.input += rec.catCost.input;
  agg.catCost.cacheRead += rec.catCost.cacheRead;
  agg.catCost.cacheWrite += rec.catCost.cacheWrite;
  agg.catCost.output += rec.catCost.output;
  agg.records += 1;
  if (!rec.priced) agg.unpricedRecords += 1;
  agg.sessions.add(rec.sessionId);
  if (rec.isSubagent) agg.subagentSessions.add(rec.sessionId);
  else agg.rootSessions.add(rec.sessionId);
}

export function queryUsage(options = {}) {
  const period = ['24h', '7d', '30d', '90d'].includes(options.period) ? options.period : '7d';
  const scope = typeof options.scope === 'string' && options.scope.trim() ? options.scope.trim() : 'all';
  const familyFilter =
    typeof options.family === 'string' && FAMILIES.some((f) => f.id === options.family)
      ? options.family
      : '';
  const currentConversationId =
    typeof options.currentConversationId === 'string' ? options.currentConversationId.trim() : '';

  const index = loadUsageIndex(options.geminiDir);
  const dayFmt = makeDayFormatter(options.timeZone);
  const nowMs = Date.now();
  const isHourly = period === '24h';

  // 1. Build time slots & filter to window
  let slots = [];
  const slotByKey = new Map();
  let sinceMs = 0;
  let untilMs = nowMs;
  let sinceDay = '';
  let untilDay = '';

  if (isHourly) {
    const endHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    sinceMs = endHourMs - 23 * HOUR_MS;
    untilMs = endHourMs + HOUR_MS;
    for (let i = 0; i < 24; i++) {
      const ts = sinceMs + i * HOUR_MS;
      const key = new Date(ts).toISOString();
      const slot = {
        key,
        ts,
        label: formatHourTooltip(ts, dayFmt.timeZone),
        shortLabel: formatHourShort(ts, dayFmt.timeZone),
        processedTokens: 0,
        costUsd: 0,
        records: 0,
        sessions: new Set(),
        byFamily: {},
      };
      slots.push(slot);
      slotByKey.set(key, slot);
    }
    sinceDay = dayFmt.formatDay(sinceMs);
    untilDay = dayFmt.formatDay(nowMs);
  } else {
    const daysCount = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const dayKeys = buildDayWindow(daysCount, nowMs, dayFmt);
    sinceDay = dayKeys[0];
    untilDay = dayKeys[dayKeys.length - 1];
    for (const dayKey of dayKeys) {
      const [y, m, d] = dayKey.split('-').map(Number);
      const slot = {
        key: dayKey,
        ts: Date.UTC(y, m - 1, d),
        label: formatDayShort(dayKey),
        shortLabel: formatDayShort(dayKey),
        processedTokens: 0,
        costUsd: 0,
        records: 0,
        sessions: new Set(),
        byFamily: {},
      };
      slots.push(slot);
      slotByKey.set(dayKey, slot);
    }
  }

  const windowRecords = [];
  for (const rec of index.records) {
    if (isHourly) {
      if (rec.timestampMs < sinceMs || rec.timestampMs >= untilMs) continue;
      const bucketTs = Math.floor(rec.timestampMs / HOUR_MS) * HOUR_MS;
      const key = new Date(bucketTs).toISOString();
      if (!slotByKey.has(key)) continue;
      windowRecords.push({ rec, slotKey: key });
    } else {
      const dayKey = dayFmt.formatDay(rec.timestampMs);
      if (dayKey < sinceDay || dayKey > untilDay || !slotByKey.has(dayKey)) continue;
      windowRecords.push({ rec, slotKey: dayKey });
    }
  }

  // 2. Discover available scopes within the period
  const projectCounts = new Map();
  for (const proj of projectsCache.byId.values()) {
    projectCounts.set(proj.id, {
      id: `project:${proj.id}`,
      label: proj.name,
      tokens: 0,
    });
  }
  const surfaceCounts = new Map();
  let currentConvTokens = 0;
  let allWindowTokens = 0;
  let noProjectTokens = 0;

  for (const { rec } of windowRecords) {
    allWindowTokens += rec.processedTokens;
    surfaceCounts.set(rec.surface, (surfaceCounts.get(rec.surface) || 0) + rec.processedTokens);
    if (rec.projectKey && rec.projectKey !== 'none') {
      const prev = projectCounts.get(rec.projectKey) || {
        id: `project:${rec.projectKey}`,
        label: rec.projectLabel || rec.projectKey,
        tokens: 0,
      };
      prev.tokens += rec.processedTokens;
      projectCounts.set(rec.projectKey, prev);
    } else {
      noProjectTokens += rec.processedTokens;
    }
    if (
      currentConversationId &&
      (rec.sessionId === currentConversationId || rec.rootSessionId === currentConversationId)
    ) {
      currentConvTokens += rec.processedTokens;
    }
  }

  const scopes = [{ id: 'all', label: 'All usage', tokens: allWindowTokens }];
  if (currentConversationId) {
    scopes.push({ id: 'current', label: 'This conversation', tokens: currentConvTokens });
  }
  const sortedProjects = [...projectCounts.values()].sort(
    (a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label)
  );
  for (const proj of sortedProjects) {
    scopes.push(proj);
  }
  if (noProjectTokens > 0 || scope === 'project:none') {
    scopes.push({ id: 'project:none', label: 'No project', tokens: noProjectTokens });
  }
  const surfaceLabels = { app: 'Desktop app', cli: 'CLI', ide: 'IDE' };
  for (const sKey of ['app', 'cli', 'ide']) {
    const tok = surfaceCounts.get(sKey) || 0;
    if (tok > 0) scopes.push({ id: `surface:${sKey}`, label: surfaceLabels[sKey], tokens: tok });
  }

  // 3. Apply scope filter
  const matchesScope = (rec) => {
    if (scope === 'all') return true;
    if (scope === 'current') {
      return (
        Boolean(currentConversationId) &&
        (rec.sessionId === currentConversationId || rec.rootSessionId === currentConversationId)
      );
    }
    if (scope.startsWith('conversation:')) {
      const cid = scope.slice('conversation:'.length);
      return Boolean(cid) && (rec.sessionId === cid || rec.rootSessionId === cid);
    }
    if (scope === 'project:none') {
      return !rec.projectKey || rec.projectKey === 'none';
    }
    if (scope.startsWith('project:')) {
      return rec.projectKey === scope.slice('project:'.length);
    }
    if (scope.startsWith('surface:')) {
      return rec.surface === scope.slice('surface:'.length);
    }
    return true;
  };

  const scopedRecords = windowRecords.filter(({ rec }) => matchesScope(rec));

  // 4. Compute all-family summary for hero family rows (before solo filter)
  const familyTotalsMap = new Map();
  const scopedAllAgg = emptyAgg();
  for (const f of FAMILIES) {
    familyTotalsMap.set(f.id, {
      id: f.id,
      label: f.label,
      colorVar: f.colorVar,
      processedTokens: 0,
      costUsd: 0,
      sessions: new Set(),
      records: 0,
    });
  }
  for (const { rec } of scopedRecords) {
    addRecordToAgg(scopedAllAgg, rec);
    const ft = familyTotalsMap.get(rec.family) || familyTotalsMap.get('other');
    ft.processedTokens += rec.processedTokens;
    ft.costUsd += rec.costUsd;
    ft.sessions.add(rec.sessionId);
    ft.records += 1;
  }

  const families = [...familyTotalsMap.values()]
    .filter((f) => f.processedTokens > 0 || f.records > 0)
    .map((f) => ({
      id: f.id,
      label: f.label,
      colorVar: f.colorVar,
      processedTokens: f.processedTokens,
      costUsd: roundUsd(f.costUsd),
      sessions: f.sessions.size,
      records: f.records,
      tokenShare:
        scopedAllAgg.processedTokens > 0 ? f.processedTokens / scopedAllAgg.processedTokens : 0,
      costShare: scopedAllAgg.costUsd > 0 ? f.costUsd / scopedAllAgg.costUsd : 0,
    }))
    .sort((a, b) => b.processedTokens - a.processedTokens || b.costUsd - a.costUsd);

  // 5. Apply optional family solo filter for totals, chart series, and breakdown
  const activeRecords = familyFilter
    ? scopedRecords.filter(({ rec }) => rec.family === familyFilter)
    : scopedRecords;

  const totalAgg = emptyAgg();
  const byModel = new Map();
  const bySession = new Map();

  for (const { rec, slotKey } of activeRecords) {
    addRecordToAgg(totalAgg, rec);

    // Chart time series
    const slot = slotByKey.get(slotKey);
    if (slot) {
      slot.processedTokens += rec.processedTokens;
      slot.costUsd += rec.costUsd;
      slot.records += 1;
      slot.sessions.add(rec.sessionId);
      const fb = slot.byFamily[rec.family] || { processedTokens: 0, costUsd: 0 };
      fb.processedTokens += rec.processedTokens;
      fb.costUsd += rec.costUsd;
      slot.byFamily[rec.family] = fb;
    }

    // By model
    let mAgg = byModel.get(rec.model);
    if (!mAgg) {
      mAgg = {
        ...emptyAgg(),
        model: rec.model,
        family: rec.family,
        rate: lookupRate(rec.model),
      };
      byModel.set(rec.model, mAgg);
    }
    addRecordToAgg(mAgg, rec);

    // By session
    let sAgg = bySession.get(rec.sessionId);
    if (!sAgg) {
      const meta = index.sessionsMeta.get(rec.sessionId);
      let displayTitle = meta?.title || '';
      if (!displayTitle && meta?.agentName && meta?.rootTitle) {
        displayTitle = `${meta.agentName} · ${meta.rootTitle}`;
      } else if (!displayTitle && meta?.agentName) {
        displayTitle = meta.agentName;
      } else if (!displayTitle) {
        displayTitle = rec.sessionId.slice(0, 8);
      }
      sAgg = {
        ...emptyAgg(),
        sessionId: rec.sessionId,
        title: displayTitle,
        surface: rec.surface,
        workspaceLabel: rec.workspaceLabel,
        isSubagent: rec.isSubagent,
        lastTimestampMs: rec.timestampMs,
        modelCounts: new Map(),
        primaryFamily: rec.family,
      };
      bySession.set(rec.sessionId, sAgg);
    }
    addRecordToAgg(sAgg, rec);
    if (rec.timestampMs > sAgg.lastTimestampMs) sAgg.lastTimestampMs = rec.timestampMs;
    sAgg.modelCounts.set(rec.model, (sAgg.modelCounts.get(rec.model) || 0) + rec.processedTokens);
  }

  const activeSeriesIds = familyFilter ? [familyFilter] : families.map((f) => f.id);
  const seriesMeta = FAMILIES.filter((f) => activeSeriesIds.includes(f.id));

  const timeline = slots.map((slot) => {
    const familyValues = {};
    for (const f of seriesMeta) {
      const entry = slot.byFamily[f.id];
      familyValues[f.id] = {
        processedTokens: entry ? entry.processedTokens : 0,
        costUsd: entry ? roundUsd(entry.costUsd) : 0,
      };
    }
    return {
      key: slot.key,
      ts: slot.ts,
      label: slot.label,
      shortLabel: slot.shortLabel,
      processedTokens: slot.processedTokens,
      costUsd: roundUsd(slot.costUsd),
      records: slot.records,
      sessions: slot.sessions.size,
      byFamily: familyValues,
    };
  });

  const models = [...byModel.values()]
    .map((m) => {
      const inputTotal =
        m.uncachedInputTokens + m.cachedInputTokens + m.cacheCreationTokens;
      return {
        model: m.model,
        family: m.family,
        processedTokens: m.processedTokens,
        uncachedInputTokens: m.uncachedInputTokens,
        cachedInputTokens: m.cachedInputTokens,
        cacheCreationTokens: m.cacheCreationTokens,
        outputTokens: m.outputTokens,
        reasoningTokens: m.reasoningTokens,
        costUsd: roundUsd(m.costUsd),
        cacheSavingsUsd: roundUsd(m.cacheSavingsUsd),
        tokenShare: totalAgg.processedTokens > 0 ? m.processedTokens / totalAgg.processedTokens : 0,
        costShare: totalAgg.costUsd > 0 ? m.costUsd / totalAgg.costUsd : 0,
        cacheHitRate: inputTotal > 0 ? m.cachedInputTokens / inputTotal : 0,
        records: m.records,
        unpriced: m.unpricedRecords === m.records,
        rate: m.rate,
      };
    })
    .sort((a, b) => b.processedTokens - a.processedTokens || b.costUsd - a.costUsd);

  const sessions = [...bySession.values()]
    .map((s) => {
      let topModel = '';
      let topTok = -1;
      for (const [mName, tok] of s.modelCounts) {
        if (tok > topTok) {
          topTok = tok;
          topModel = mName;
        }
      }
      return {
        sessionId: s.sessionId,
        title: s.title,
        surface: s.surface,
        workspaceLabel: s.workspaceLabel,
        isSubagent: s.isSubagent,
        topModel,
        family: topModel ? classifyFamily(topModel) : 'other',
        processedTokens: s.processedTokens,
        costUsd: roundUsd(s.costUsd),
        cacheSavingsUsd: roundUsd(s.cacheSavingsUsd),
        tokenShare: totalAgg.processedTokens > 0 ? s.processedTokens / totalAgg.processedTokens : 0,
        costShare: totalAgg.costUsd > 0 ? s.costUsd / totalAgg.costUsd : 0,
        records: s.records,
        lastTimestampMs: s.lastTimestampMs,
      };
    })
    .sort((a, b) => b.processedTokens - a.processedTokens || b.lastTimestampMs - a.lastTimestampMs)
    .slice(0, 60);

  const timeRows = [...timeline]
    .reverse()
    .map((slot) => ({
      key: slot.key,
      label: slot.label,
      processedTokens: slot.processedTokens,
      costUsd: slot.costUsd,
      tokenShare: totalAgg.processedTokens > 0 ? slot.processedTokens / totalAgg.processedTokens : 0,
      costShare: totalAgg.costUsd > 0 ? slot.costUsd / totalAgg.costUsd : 0,
      sessions: slot.sessions,
      records: slot.records,
    }));

  const inputTotal =
    totalAgg.uncachedInputTokens +
    totalAgg.cachedInputTokens +
    totalAgg.cacheCreationTokens;

  const etag = [
    period,
    scope,
    familyFilter,
    currentConversationId,
    dayFmt.timeZone,
    sinceDay,
    untilDay,
    isHourly ? slots[slots.length - 1]?.key : '',
    totalAgg.processedTokens,
    totalAgg.records,
    totalAgg.sessions.size,
    roundUsd(totalAgg.costUsd),
    liveRatesMeta.version,
    scopes.map((s) => `${s.id}:${s.label}`).join(','),
  ].join('|');

  return {
    ok: true,
    etag,
    period,
    resolution: isHourly ? 'hour' : 'day',
    scope,
    familyFilter,
    timeZone: dayFmt.timeZone,
    sinceDay,
    untilDay,
    pricing: {
      mode: 'standard-non-promo',
      source: liveRatesMeta.source,
      updatedAt: liveRatesMeta.updatedAt,
    },
    scopes,
    families,
    series: seriesMeta,
    totals: {
      processedTokens: totalAgg.processedTokens,
      uncachedInputTokens: totalAgg.uncachedInputTokens,
      cachedInputTokens: totalAgg.cachedInputTokens,
      cacheCreationTokens: totalAgg.cacheCreationTokens,
      outputTokens: totalAgg.outputTokens,
      reasoningTokens: totalAgg.reasoningTokens,
      costUsd: roundUsd(totalAgg.costUsd),
      cacheSavingsUsd: roundUsd(totalAgg.cacheSavingsUsd),
      categoryCostUsd: {
        input: roundUsd(totalAgg.catCost.input),
        cacheRead: roundUsd(totalAgg.catCost.cacheRead),
        cacheWrite: roundUsd(totalAgg.catCost.cacheWrite),
        output: roundUsd(totalAgg.catCost.output),
      },
      cacheHitRate: inputTotal > 0 ? totalAgg.cachedInputTokens / inputTotal : 0,
      sessions: totalAgg.sessions.size,
      rootSessions: totalAgg.rootSessions.size,
      subagentSessions: totalAgg.subagentSessions.size,
      records: totalAgg.records,
      unpricedRecords: totalAgg.unpricedRecords,
    },
    timeline,
    breakdown: {
      models,
      sessions,
      timeRows,
    },
    diagnostics: {
      scannedFiles: dbCache.size,
      errors: index.errorCount,
    },
  };
}
