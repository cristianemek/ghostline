import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/anonymize-fixture.mjs <raw.ndjson> <out.ndjson>');
  process.exit(1);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const API_ID = /\b(msg|req)_[A-Za-z0-9]{10,}\b/g;
const seen = new Map();

function stable(kind, value, make) {
  const key = `${kind}:${value}`;
  if (!seen.has(key)) {
    const index = [...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
    seen.set(key, make(index));
  }
  return seen.get(key);
}

function scrubString(value) {
  return value
    .replace(UUID, (m) => stable('uuid', m.toLowerCase(), (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))
    .replace(API_ID, (m, kind) => stable(kind, m, (i) => `${kind}_ANON${String(i).padStart(4, '0')}`))
    .replace(/([A-Za-z]:\\Users\\)[^\\"]+/g, '$1user')
    .replace(/(\/(?:home|Users)\/)[^/"]+/g, '$1user');
}

const OVERRIDES = {
  additional_directories: () => [],
  messaging_socket_path: () => '\\\\.\\pipe\\LOCAL\\cc-msg-anon',
  credential_expires_at: () => '2099-01-01T00:00:00.000Z',
  timestamp: () => '2026-01-01T00:00:00.000Z',
  resetsAt: () => 1800000000,
  utilization: (v) => (typeof v === 'number' ? (v > 0.5 ? 0.5 : 0.1) : v),
  surpassedThreshold: (v) => (typeof v === 'number' ? 0.5 : v),
};

function scrub(value, key) {
  if (key && key in OVERRIDES) return OVERRIDES[key](value);
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  }
  return value;
}

const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter((line) => line.trim());
const out = lines.map((line) => {
  try {
    return JSON.stringify(scrub(JSON.parse(line)));
  } catch {
    return scrubString(line);
  }
});
writeFileSync(output, out.join('\n') + '\n');
console.log(`${lines.length} lines -> ${output}`);
