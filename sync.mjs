#!/usr/bin/env node
/**
 * Sitecore Personalize – copy experiences/experiments (flow definitions) and
 * decision models from one tenant (e.g. DEV) to another (e.g. PROD).
 *
 * Node 18+ (uses built-in fetch). No npm dependencies.
 *
 * Usage:
 *   node sync.mjs                         # dry run: export + show plan, no writes
 *   node sync.mjs --apply                 # actually write to target
 *   node sync.mjs --only home_banner,cart_upsell   # only these flow friendlyIds (+ the decision models they use)
 *   node sync.mjs --apply --overwrite     # also update items that already exist in target
 *   node sync.mjs --skip-decision-models  # flows only
 *
 * Config comes from environment variables (or a .env file next to this script).
 * See .env.example.
 *
 * APIs used (Sitecore Personalize REST, OAuth2 bearer token):
 *   POST https://auth.sitecorecloud.io/oauth/token
 *   GET/POST      /v3/flowDefinitions
 *   GET/PUT       /v3/flowDefinitions/{ref}
 *   GET/POST      /v2/decisionModelDefinitions
 *   PUT           /v2/decisionModelDefinitions/{ref}
 *   GET/POST      /v2/decisionModelDefinitions/{ref}/variants
 *   PUT           /v2/decisionModelVariants/{ref}
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config ---
loadDotEnv(path.join(__dirname, '.env'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const APPLY = flag('--apply');
const OVERWRITE = flag('--overwrite');
const SKIP_DM = flag('--skip-decision-models');
const ONLY = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const EXPORT_DIR = path.resolve(__dirname, opt('--export-dir') || 'export');
const ID_MAP_FILE = path.resolve(__dirname, opt('--id-map') || 'id-map.json');

const AUTH_URL = process.env.SC_AUTH_URL || 'https://auth.sitecorecloud.io/oauth/token';
const AUDIENCE = process.env.SC_AUDIENCE || 'https://api.sitecorecloud.io';

const source = makeClient('SOURCE', {
  baseUrl: req('SOURCE_BASE_URL'),
  clientId: req('SOURCE_CLIENT_ID'),
  clientSecret: req('SOURCE_CLIENT_SECRET'),
});
const target = makeClient('TARGET', {
  baseUrl: req('TARGET_BASE_URL'),
  clientId: req('TARGET_CLIENT_ID'),
  clientSecret: req('TARGET_CLIENT_SECRET'),
});

// Fields that belong to the source tenant and must not be sent to the target.
const STRIP = new Set([
  'clientKey', 'href', 'ref', 'modifiedByRef', 'modifiedByUserRef', 'modifiedAt',
  'createdAt', 'createdByRef', 'revision', 'revisions', 'transpiledVariants',
  'transpiledDefinition', 'decisionModelDefinitionRef', 'decisionModelDefinition',
  'inProduction',
]);

// ------------------------------------------------------------------ main ---
main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}${OVERWRITE ? ' + overwrite' : ''}\n`);

  // Manual source->target ref map for things copied with "Copy to tenant"
  // (offers, connections, templates...). Their refs differ per tenant.
  const idMap = fs.existsSync(ID_MAP_FILE) ? JSON.parse(fs.readFileSync(ID_MAP_FILE, 'utf8')) : {};
  console.log(`Loaded ${Object.keys(idMap).length} manual ref mappings from ${path.basename(ID_MAP_FILE)}`);

  // 1. Export source
  let srcFlows = await source.list('/v3/flowDefinitions');
  srcFlows = srcFlows.filter((f) => !f.archived);
  if (ONLY) {
    const missing = ONLY.filter((id) => !srcFlows.some((f) => f.friendlyId === id));
    if (missing.length) throw new Error(`Not found in source: ${missing.join(', ')}`);
    srcFlows = srcFlows.filter((f) => ONLY.includes(f.friendlyId));
  }
  // list endpoint may return summaries – fetch each in full
  srcFlows = await Promise.all(srcFlows.map((f) => source.get(`/v3/flowDefinitions/${f.ref}`)));

  let srcModels = [];
  if (!SKIP_DM) {
    srcModels = (await source.list('/v2/decisionModelDefinitions')).filter((m) => !m.archived);
    for (const m of srcModels) {
      m._variants = (await source.list(`/v2/decisionModelDefinitions/${m.ref}/variants`)).filter((v) => !v.archived);
    }
    if (ONLY) {
      // keep only decision models (or their variants) referenced by the selected flows
      const flowText = JSON.stringify(srcFlows);
      srcModels = srcModels.filter((m) => flowText.includes(m.ref) || m._variants.some((v) => flowText.includes(v.ref)));
    }
  }

  writeExport(srcFlows, srcModels);

  // 2. Read target so we can match existing items
  const tgtFlows = await target.list('/v3/flowDefinitions');
  const tgtModels = SKIP_DM ? [] : await target.list('/v2/decisionModelDefinitions');

  // 3. Decision models first (flows reference them)
  for (const m of srcModels) {
    await syncDecisionModel(m, tgtModels, idMap);
  }

  // 4. Flows (experiences / experiments)
  for (const f of srcFlows) {
    await syncFlow(f, tgtFlows, idMap);
  }

  // 5. Save the full map (useful for next run and for auditing)
  if (APPLY) {
    fs.writeFileSync(ID_MAP_FILE, JSON.stringify(idMap, null, 2));
    console.log(`\nSaved ref map -> ${path.basename(ID_MAP_FILE)}`);
  }
  console.log('\nDone.' + (APPLY ? '' : ' Re-run with --apply to write to the target.'));
}

// ------------------------------------------------------- decision models ---
async function syncDecisionModel(src, tgtModels, idMap) {
  const existing = tgtModels.find((t) => t.name === src.name && !t.archived);
  let tgtModelRef = existing?.ref;
  console.log(`\n[Decision model] ${src.name}  (${src._variants.length} variant(s)) -> ${existing ? 'EXISTS' : 'CREATE'}`);

  if (existing && !OVERWRITE) {
    console.log('  skipped (use --overwrite to update)');
    idMap[src.ref] = existing.ref;
    // still map variants by name so flows resolve
    const tv = await target.list(`/v2/decisionModelDefinitions/${existing.ref}/variants`);
    for (const v of src._variants) {
      const match = tv.find((x) => x.name === v.name);
      if (match) idMap[v.ref] = match.ref;
    }
    return;
  }

  if (!APPLY) {
    PLANNED.add(src.ref);
    src._variants.forEach((v) => { PLANNED.add(v.ref); console.log(`  variant: ${v.name}`); });
    return;
  }

  // Create the parent with an empty deployment config; we set it after variants exist.
  if (!existing) {
    const created = await target.post('/v2/decisionModelDefinitions', {
      name: src.name,
      ...(src.description ? { description: src.description } : {}),
      deploymentConfiguration: { variants: [] },
    });
    tgtModelRef = created.ref;
  }
  idMap[src.ref] = tgtModelRef;

  // Variants
  const tgtVariants = existing ? await target.list(`/v2/decisionModelDefinitions/${tgtModelRef}/variants`) : [];
  const newRevision = {};
  for (const v of src._variants) {
    const body = {
      name: v.name,
      // DMN XML; may contain offer/connection refs -> remap
      definition: remap(v.definition ?? '', idMap),
    };
    const match = tgtVariants.find((x) => x.name === v.name);
    const saved = match
      ? await target.put(`/v2/decisionModelVariants/${match.ref}`, body)
      : await target.post(`/v2/decisionModelDefinitions/${tgtModelRef}/variants`, body);
    idMap[v.ref] = saved.ref;
    newRevision[saved.ref] = saved.revision ?? 1;
    console.log(`  variant ${match ? 'updated' : 'created'}: ${v.name}`);
  }

  // Deployment config: same split/status as source, pointing at target variant refs
  const deployVariants = (src.deploymentConfiguration?.variants || [])
    .filter((d) => idMap[d.variantRef])
    .map((d) => ({
      variantRef: idMap[d.variantRef],
      split: d.split,
      status: d.status, // DRAFT | TEST | PRODUCTION | ARCHIVED
      variantRevision: newRevision[idMap[d.variantRef]] ?? 1,
    }));
  await target.put(`/v2/decisionModelDefinitions/${tgtModelRef}`, {
    name: src.name,
    deploymentConfiguration: { variants: deployVariants },
  });
  console.log(`  deployment: ${deployVariants.map((d) => `${d.status} ${d.split}%`).join(', ') || '(none)'}`);
}

// ----------------------------------------------------------------- flows ---
async function syncFlow(src, tgtFlows, idMap) {
  const existing = tgtFlows.find((t) => t.friendlyId === src.friendlyId);
  console.log(`\n[Flow] ${src.name} (${src.friendlyId}, ${src.type}/${src.subtype}) -> ${existing ? 'EXISTS' : 'CREATE'}`);

  if (existing && !OVERWRITE) {
    console.log('  skipped (use --overwrite to update)');
    idMap[src.ref] = existing.ref;
    return;
  }

  const body = remap(clean(src), idMap);
  if (!body.sampleSizeConfig) {
    body.sampleSizeConfig = { baseValue: 0.02, minimumDetectableDifference: 0.2, confidenceLevel: 0.95 };
  }
  // New flows always land as DRAFT so someone reviews/publishes them in the target.
  // Existing flows keep whatever status they currently have in the target.
  body.status = existing ? existing.status : 'DRAFT';

  const unresolved = findSourceRefs(body, src.ref, idMap);
  if (unresolved.length) {
    console.log(`  ⚠ still contains ${unresolved.length} unmapped ref(s) – add to id-map.json if they are offers/templates/connections:`);
    unresolved.forEach((r) => console.log(`     ${r}`));
  }

  if (!APPLY) return;
  const saved = existing
    ? await target.put(`/v3/flowDefinitions/${existing.ref}`, body)
    : await target.post('/v3/flowDefinitions', body);
  idMap[src.ref] = saved.ref;
  console.log(`  ${existing ? 'updated' : 'created'} (status ${saved.status ?? body.status})`);
}

// --------------------------------------------------------------- helpers ---
function clean(obj, depth = 0) {
  if (Array.isArray(obj)) return obj.map((x) => clean(x, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      // Only strip tenant metadata at the top level; nested "ref"s (e.g. flow
      // variant refs used by traffic.splits) are local to the flow and must stay.
      if (depth === 0 && STRIP.has(k)) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return obj;
}

/** Replace every source ref with its target ref anywhere in the payload. */
function remap(value, idMap) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [from, to] of Object.entries(idMap)) {
    if (from && to && from !== to && !from.startsWith('_')) s = s.split(from).join(to);
  }
  return typeof value === 'string' ? s : JSON.parse(s);
}

/** UUIDs left in the body that aren't the flow's own variant refs – likely unmapped dependencies. */
function findSourceRefs(body, ownRef, idMap) {
  const localRefs = new Set([...(body.variants || []).map((v) => v.ref), ...Object.values(idMap), ...PLANNED]);
  const text = JSON.stringify(body);
  const uuids = new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []);
  return [...uuids].filter((u) => u !== ownRef && !localRefs.has(u));
}

function writeExport(flows, models) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(EXPORT_DIR, stamp);
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'decision-models'), { recursive: true });
  for (const f of flows) fs.writeFileSync(path.join(dir, 'flows', `${f.friendlyId}.json`), JSON.stringify(f, null, 2));
  for (const m of models) fs.writeFileSync(path.join(dir, 'decision-models', `${safe(m.name)}.json`), JSON.stringify(m, null, 2));
  console.log(`Exported ${flows.length} flow(s), ${models.length} decision model(s) -> ${path.relative(process.cwd(), dir)}`);
}

// Source refs that this run will create in the target (used to quiet dry-run warnings).
const PLANNED = new Set();

const safe = (s) => s.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();

function makeClient(label, { baseUrl, clientId, clientSecret }) {
  let token = null;
  let expiresAt = 0;

  async function auth() {
    if (token && Date.now() < expiresAt - 60_000) return token;
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        audience: AUDIENCE,
      }),
    });
    if (!res.ok) throw new Error(`${label} auth failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    token = json.access_token;
    expiresAt = Date.now() + (json.expires_in ?? 900) * 1000;
    return token;
  }

  async function call(method, urlOrPath, body, attempt = 1) {
    const url = urlOrPath.startsWith('http') ? urlOrPath : baseUrl.replace(/\/$/, '') + urlOrPath;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await auth()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return call(method, urlOrPath, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} ${method} ${url} -> ${res.status}\n${text}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    /** GET a collection, following `next.href` pagination if the API returns it. */
    async list(p) {
      const items = [];
      let page = await call('GET', p);
      items.push(...(page.items || []));
      while (page.next?.href) {
        page = await call('GET', page.next.href);
        items.push(...(page.items || []));
      }
      return items;
    },
  };
}

function req(name) {
  const v = process.env[name];
  if (!v) {
    const envLike = fs.readdirSync(__dirname).filter((f) => f.toLowerCase().includes('env'));
    throw new Error(
      `Missing env var ${name}.\n` +
      `  .env loaded from: ${ENV_LOADED || 'NOT FOUND'}\n` +
      `  env-like files in ${__dirname}: ${envLike.join(', ') || '(none)'}\n` +
      `  Put a ".env" file next to sync.mjs with a line like ${name}=... (see .env.example)`
    );
  }
  return v;
}

var ENV_LOADED;
function loadDotEnv(file) {
  // Look next to the script, then in the current folder; also accept ".env.txt"
  // (Windows often hides the .txt extension).
  const candidates = [file, file + '.txt', path.join(process.cwd(), '.env'), path.join(process.cwd(), '.env.txt')];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) return;
  ENV_LOADED = found;

  const buf = fs.readFileSync(found);
  // Handle UTF-16 (PowerShell's default for `>` / Out-File) and UTF-8 BOM.
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  text = text.replace(/^﻿/, '');

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
