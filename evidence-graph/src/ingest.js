// L0 (raw source) + L1 (normalized evidence units) for qual transcripts.
// Each transcript turn becomes an addressable, citable unit carrying scope metadata.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256 } from './hash.js';

export const NORMALIZER_VERSION = 'v1';

export function ingestFile(path, metadata = {}) {
  const text = readFileSync(path, 'utf8');
  const id = basename(path);
  const content_hash = sha256(text); // L0 identity -> dedup on identical re-upload
  const units = normalizeTranscript(text, id, metadata);
  return { id, path, modality: 'qual_transcript', content_hash, metadata, text, units };
}

// Split into speaker turns ("Interviewer:" / "P:"); each turn is one L1 unit.
function normalizeTranscript(text, source_id, metadata) {
  const lines = text.split(/\r?\n/);
  const units = [];
  let cur = null;
  let ordinal = 0;
  let charpos = 0;
  const flush = () => {
    if (cur && cur.text.trim()) {
      cur.content_hash = sha256(cur.text);
      units.push(cur);
    }
  };
  for (const line of lines) {
    const m = line.match(/^(Interviewer|P):\s?(.*)$/);
    if (m) {
      flush();
      cur = {
        id: `${source_id}#${ordinal}`,
        source_id,
        unit_type: 'turn',
        ordinal: ordinal++,
        speaker: m[1],
        text: m[2],
        span: { char_start: charpos },
        // modality/persona/segment/round denormalized onto the unit for filtering + citation
        metadata: { ...metadata, modality: 'qual_transcript' },
        normalizer_version: NORMALIZER_VERSION,
      };
    } else if (cur) {
      cur.text += `\n${line}`;
    }
    charpos += line.length + 1;
  }
  flush();
  return units;
}

// --- Phase 4: other modalities feeding the SAME L1/L4 layers ---

// Quant source: a CSV of survey metrics. Each row -> a metric_row evidence unit, with a
// rich `label` so lexical/embedding retrieval can match it to NL questions/opportunities.
export function ingestQuant(path) {
  const text = readFileSync(path, 'utf8');
  const id = basename(path);
  const content_hash = sha256(text);
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map((c) => c.trim());
  const units = rows
    .filter(Boolean)
    .map((line, ordinal) => {
      const f = line.split(',');
      const rec = Object.fromEntries(cols.map((c, i) => [c, (f[i] || '').trim()]));
      const utext = `${rec.label} (${rec.segment}): ${rec.value}${rec.unit ? ` ${rec.unit}` : ''} (n=${rec.n || '?'})`;
      return {
        id: `${id}#${ordinal}`,
        source_id: id,
        unit_type: 'metric_row',
        ordinal,
        text: utext,
        value: { metric: rec.metric, value: Number(rec.value), unit: rec.unit, n: Number(rec.n) || null, segment: rec.segment },
        span: { row: ordinal + 2 },
        metadata: { modality: 'quant', segment: rec.segment, metric: rec.metric },
        content_hash: sha256(utext),
        normalizer_version: 'quant-v1',
      };
    });
  return { id, path, modality: 'quant', content_hash, text, units };
}

// Doc source: markdown (stand-in for extracted PDF text). Split on H2 into section units.
export function ingestDoc(path) {
  const text = readFileSync(path, 'utf8');
  const id = basename(path);
  const content_hash = sha256(text);
  const units = [];
  let ordinal = 0;
  for (const part of text.split(/^##\s+/m)) {
    const trimmed = part.trim();
    const nl = trimmed.indexOf('\n');
    const heading = (nl >= 0 ? trimmed.slice(0, nl) : trimmed).replace(/^#\s*/, '').trim();
    const body = (nl >= 0 ? trimmed.slice(nl + 1) : '').trim();
    if (!body) continue; // skip the title-only block
    const utext = `${heading}. ${body}`.replace(/\s+/g, ' ').trim();
    units.push({
      id: `${id}#${ordinal}`,
      source_id: id,
      unit_type: 'section',
      ordinal,
      text: utext,
      heading,
      span: { section: ordinal },
      metadata: { modality: 'doc', heading },
      content_hash: sha256(utext),
      normalizer_version: 'doc-v1',
    });
    ordinal++;
  }
  return { id, path, modality: 'doc', content_hash, text, units };
}
