/**
 * innertube-dash.test.ts
 *
 * Plain-Node test runner. No npm dependencies, no test framework.
 * Bundle with esbuild (--platform=node --format=esm) and run with node.
 *
 *   esbuild innertube-dash.test.ts --bundle --platform=node --format=esm --outfile=dash.test.mjs
 *   node dash.test.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildDashManifest,
  buildDashManifestDetailed,
  pickProgressiveFallback,
  parseMimeType,
  toIsoDuration,
  xmlEscape,
  type AdaptiveFormatInput,
} from '../src/lib/api/innertube-dash';

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: unknown, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function eq(actual: unknown, expected: unknown, name: string): void {
  ok(
    Object.is(actual, expected),
    name,
    Object.is(actual, expected) ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

/* ------------------------------------------------------------------ *
 * Minimal XML parser (well-formedness + tree), no dependencies
 * ------------------------------------------------------------------ */

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
  parent?: XNode;
}

const ENTITY_RE = /&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/;

function checkEntities(where: string, value: string): void {
  if (ENTITY_RE.test(value)) {
    throw new Error(`unescaped '&' in ${where}: ${value.slice(0, 120)}`);
  }
}

function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const tail = xml.slice(i);
      checkEntities('text', tail);
      stack[stack.length - 1].text += tail;
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      checkEntities('text', text);
      stack[stack.length - 1].text += text;
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      if (end === -1) throw new Error('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) throw new Error('unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end === -1) throw new Error('unterminated CDATA');
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new Error('unterminated declaration');
      i = end + 1;
      continue;
    }

    // Find the end of the tag, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < xml.length) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= xml.length) throw new Error(`unterminated tag near offset ${lt}`);
    const raw = xml.slice(lt + 1, j);
    i = j + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top === root) throw new Error(`closing tag </${name}> with no open element`);
      if (top.name !== name) throw new Error(`mismatched tag: <${top.name}> closed by </${name}>`);
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error(`malformed tag: <${raw}>`);
    const name = nameMatch[1];

    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const attrSrc = body.slice(nameMatch[1].length);
    // Anything that is not whitespace and not a well-formed name="value" pair is invalid.
    let consumed = '';
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrSrc)) !== null) {
      const value = m[3] !== undefined ? m[3] : m[4];
      checkEntities(`attribute ${name}@${m[1]}`, value);
      if (Object.prototype.hasOwnProperty.call(attrs, m[1])) {
        throw new Error(`duplicate attribute ${m[1]} on <${name}>`);
      }
      attrs[m[1]] = decodeEntities(value);
      consumed += m[0];
    }
    const leftover = attrSrc.replace(/\s+/g, '');
    if (leftover.length !== consumed.replace(/\s+/g, '').length) {
      throw new Error(`malformed attributes on <${name}>: ${attrSrc.trim().slice(0, 120)}`);
    }

    const node: XNode = { name, attrs, children: [], text: '', parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    throw new Error(`unclosed element <${stack[stack.length - 1].name}>`);
  }
  const elements = root.children;
  if (elements.length !== 1) throw new Error(`expected exactly 1 root element, got ${elements.length}`);
  return elements[0];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function findAll(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

function childrenNamed(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => c.name === name);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const FIXTURE_DIR = process.env.PLAYLET_FIXTURES ?? path.join(process.cwd(), 'tests', 'fixtures');

function loadFixture(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

/** The real rewrite shape: a Tauri custom scheme with a base64url-encoded target. */
function rewriteUrl(url: string): string {
  return `playlet-stream://seg/${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/* ================================================================== *
 * Tests
 * ================================================================== */

section('unit: helpers');
eq(toIsoDuration(635), 'PT0H10M35S', 'toIsoDuration(635) === PT0H10M35S');
eq(toIsoDuration(213), 'PT0H3M33S', 'toIsoDuration(213) === PT0H3M33S');
eq(toIsoDuration(3661.5), 'PT1H1M1.5S', 'toIsoDuration(3661.5) === PT1H1M1.5S');
eq(toIsoDuration(0), 'PT0H0M0S', 'toIsoDuration(0) === PT0H0M0S');
eq(toIsoDuration(100), 'PT0H1M40S', 'toIsoDuration(100) keeps trailing digits (no 100 -> 1 bug)');
eq(toIsoDuration(-5), 'PT0H0M0S', 'toIsoDuration(negative) clamps to zero');
eq(xmlEscape('a&b<c>"d\'e'), 'a&amp;b&lt;c&gt;&quot;d&apos;e', 'xmlEscape escapes all five XML metacharacters');
eq(parseMimeType('video/webm; codecs="vp09.00.51.08"')?.codecs, 'vp09.00.51.08', 'parseMimeType extracts codecs');
eq(parseMimeType('video/webm; codecs="vp09.00.51.08"')?.base, 'video/webm', 'parseMimeType extracts mime base');
eq(parseMimeType('audio/mp4; codecs="mp4a.40.2"')?.type, 'audio', 'parseMimeType extracts top-level type');

/* ------------------------------------------------------------------ */

section('fixture: player.ios.json (635s, 32 adaptiveFormats)');

const fx1 = loadFixture('player.ios.json');
const formats1: AdaptiveFormatInput[] = fx1.streamingData.adaptiveFormats;
const dur1 = Number(fx1.videoDetails.lengthSeconds);
eq(formats1.length, 32, 'fixture 1 has 32 adaptiveFormats');
eq(dur1, 635, 'fixture 1 duration is 635s');

const res1 = buildDashManifestDetailed(formats1, { durationSeconds: dur1, rewriteUrl });
const mpd1 = res1.mpd;

let doc1: XNode | null = null;
try {
  doc1 = parseXml(mpd1);
  ok(true, 'MPD parses as well-formed XML');
} catch (e) {
  ok(false, 'MPD parses as well-formed XML', String(e));
}

if (doc1) {
  eq(doc1.name, 'MPD', 'root element is <MPD>');
  eq(doc1.attrs.type, 'static', 'MPD@type is "static"');
  eq(doc1.attrs.mediaPresentationDuration, 'PT0H10M35S', 'MPD@mediaPresentationDuration is PT0H10M35S for 635s');
  ok(/^PT[\d.HMS]+$/.test(doc1.attrs.minBufferTime ?? ''), 'MPD@minBufferTime is an ISO-8601 duration', doc1.attrs.minBufferTime);
  ok((doc1.attrs.profiles ?? '').includes('isoff-on-demand'), 'MPD@profiles is the on-demand profile');

  const periods = childrenNamed(doc1, 'Period');
  eq(periods.length, 1, 'exactly one <Period>');
  const period = periods[0];
  eq(period.attrs.duration, 'PT0H10M35S', 'Period@duration matches the presentation duration');

  const sets = childrenNamed(period, 'AdaptationSet');
  ok(sets.length >= 2, `at least 2 AdaptationSets (got ${sets.length})`);

  // --- video and audio must be in SEPARATE adaptation sets -------------
  let mixedSet = false;
  let videoSets = 0;
  let audioSets = 0;
  for (const s of sets) {
    const reps = childrenNamed(s, 'Representation');
    const types = new Set(reps.map((r) => (r.attrs.mimeType ?? s.attrs.mimeType ?? '').split('/')[0]));
    if (types.size > 1) mixedSet = true;
    const t = [...types][0];
    if (t === 'video') videoSets++;
    if (t === 'audio') audioSets++;
  }
  ok(!mixedSet, 'no AdaptationSet mixes video and audio representations');
  ok(videoSets > 0 && audioSets > 0, `both video (${videoSets}) and audio (${audioSets}) AdaptationSets exist`);

  // --- one codec family per set (representations must be switchable) ---
  let mixedCodec = false;
  for (const s of sets) {
    const reps = childrenNamed(s, 'Representation');
    const fams = new Set(reps.map((r) => (r.attrs.codecs ?? '').split('.')[0]));
    if (fams.size > 1) mixedCodec = true;
  }
  ok(!mixedCodec, 'every AdaptationSet holds a single codec family');

  let mixedContainer = false;
  for (const s of sets) {
    const reps = childrenNamed(s, 'Representation');
    const mimes = new Set(reps.map((r) => r.attrs.mimeType));
    if (mimes.size > 1) mixedContainer = true;
  }
  ok(!mixedContainer, 'every AdaptationSet holds a single container/mimeType');

  // --- every Representation is complete --------------------------------
  const reps1 = findAll(doc1, 'Representation');
  ok(reps1.length > 0, `MPD contains representations (${reps1.length})`);
  eq(reps1.length, res1.representationCount, 'reported representationCount matches emitted <Representation> count');

  let missingBaseUrl = 0;
  let badSegmentBase = 0;
  let badInit = 0;
  let notRewritten = 0;
  let badBandwidth = 0;
  const rangeRe = /^\d+-\d+$/;
  for (const r of reps1) {
    const base = childrenNamed(r, 'BaseURL');
    if (base.length !== 1 || !base[0].text.trim()) missingBaseUrl++;
    else if (!base[0].text.trim().startsWith('playlet-stream://')) notRewritten++;

    const sb = childrenNamed(r, 'SegmentBase');
    if (sb.length !== 1 || !rangeRe.test(sb[0].attrs.indexRange ?? '')) badSegmentBase++;
    else {
      const init = childrenNamed(sb[0], 'Initialization');
      if (init.length !== 1 || !rangeRe.test(init[0].attrs.range ?? '')) badInit++;
    }
    const bw = Number(r.attrs.bandwidth);
    if (!Number.isFinite(bw) || bw <= 0) badBandwidth++;
  }
  eq(missingBaseUrl, 0, 'every Representation has exactly one non-empty <BaseURL>');
  eq(badSegmentBase, 0, 'every Representation has <SegmentBase indexRange="n-n">');
  eq(badInit, 0, 'every SegmentBase has <Initialization range="n-n">');
  eq(notRewritten, 0, 'rewriteUrl was applied to every BaseURL');
  eq(badBandwidth, 0, 'every Representation has a positive @bandwidth');

  ok(!mpd1.includes('googlevideo.com'), 'no raw googlevideo.com appears anywhere in the MPD');
  ok(!mpd1.includes('&sig='), 'no unescaped raw query separators leaked into the XML');

  // --- video-specific attributes ---------------------------------------
  const videoReps = reps1.filter((r) => (r.attrs.mimeType ?? '').startsWith('video/'));
  const audioReps = reps1.filter((r) => (r.attrs.mimeType ?? '').startsWith('audio/'));
  ok(
    videoReps.every((r) => r.attrs.width && r.attrs.height && r.attrs.frameRate),
    'every video Representation carries width, height and frameRate',
  );
  ok(
    audioReps.every((r) => r.attrs.audioSamplingRate),
    'every audio Representation carries audioSamplingRate',
  );
  ok(
    audioReps.every((r) => childrenNamed(r, 'AudioChannelConfiguration').length === 1),
    'every audio Representation carries <AudioChannelConfiguration>',
  );

  // --- 2160p survives ---------------------------------------------------
  const uhd = videoReps.filter((r) => Number(r.attrs.height) === 2160);
  ok(uhd.length >= 1, `a 2160p representation survives (${uhd.length} found: itags ${uhd.map((r) => r.attrs.id).join(',')})`);
  const maxH = Math.max(...videoReps.map((r) => Number(r.attrs.height)));
  eq(maxH, 2160, 'max emitted video height is 2160');

  // --- bandwidth sorting within each set --------------------------------
  let unsorted = 0;
  for (const s of sets) {
    const bws = childrenNamed(s, 'Representation').map((r) => Number(r.attrs.bandwidth));
    for (let k = 1; k < bws.length; k++) if (bws[k] < bws[k - 1]) unsorted++;
  }
  eq(unsorted, 0, 'representations are sorted by ascending bandwidth within every AdaptationSet');

  // --- unique representation ids ---------------------------------------
  const ids = reps1.map((r) => r.attrs.id);
  eq(new Set(ids).size, ids.length, 'all Representation@id values are unique');

  // --- DRC duplicates are collapsed -------------------------------------
  const drcInput = formats1.filter((f: any) => f.isDrc === true).length;
  ok(drcInput > 0, `fixture 1 contains ${drcInput} DRC duplicate audio formats`);
  eq(
    res1.skipped.filter((s) => s.reason.includes('DRC')).length,
    drcInput,
    'all DRC duplicates are dropped (same rung, would flap loudness during ABR)',
  );

  console.log(
    `     [info] fixture 1 => ${res1.adaptationSetCount} AdaptationSets, ${res1.representationCount} Representations, ` +
      `${res1.skipped.length} skipped, max height ${maxH}`,
  );
}

/* ------------------------------------------------------------------ */

section('fixture: player.ios.captions.json (213s, 27 adaptiveFormats, 6 caption tracks)');

const fx2 = loadFixture('player.ios.captions.json');
const formats2: AdaptiveFormatInput[] = fx2.streamingData.adaptiveFormats;
const dur2 = Number(fx2.videoDetails.lengthSeconds);
eq(formats2.length, 27, 'fixture 2 has 27 adaptiveFormats');
ok(typeof fx2.streamingData.hlsManifestUrl === 'string', 'fixture 2 has an hlsManifestUrl (unused by this module)');
eq(
  fx2.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length,
  6,
  'fixture 2 has 6 caption tracks (out of scope for the MPD, asserted for fixture sanity)',
);

const res2 = buildDashManifestDetailed(formats2, { durationSeconds: dur2, rewriteUrl });
let doc2: XNode | null = null;
try {
  doc2 = parseXml(res2.mpd);
  ok(true, 'fixture 2 MPD parses as well-formed XML');
} catch (e) {
  ok(false, 'fixture 2 MPD parses as well-formed XML', String(e));
}
if (doc2) {
  eq(doc2.attrs.mediaPresentationDuration, 'PT0H3M33S', 'fixture 2 duration is PT0H3M33S for 213s');
  const reps2 = findAll(doc2, 'Representation');
  eq(reps2.length, 27, 'fixture 2 emits all 27 formats (no DRC duplicates in this response)');
  ok(
    reps2.every((r) => childrenNamed(r, 'BaseURL').length === 1 && childrenNamed(r, 'SegmentBase').length === 1),
    'fixture 2: every Representation has BaseURL + SegmentBase',
  );
  ok(!res2.mpd.includes('googlevideo.com'), 'fixture 2: no raw googlevideo.com in the MPD');
  console.log(
    `     [info] fixture 2 => ${res2.adaptationSetCount} AdaptationSets, ${res2.representationCount} Representations, ` +
      `${res2.skipped.length} skipped`,
  );
}

/* ------------------------------------------------------------------ */

section('maxHeight');

const capped = buildDashManifestDetailed(formats1, { durationSeconds: dur1, rewriteUrl, maxHeight: 1080 });
const capDoc = parseXml(capped.mpd);
const capHeights = findAll(capDoc, 'Representation')
  .map((r) => Number(r.attrs.height))
  .filter((h) => Number.isFinite(h));
eq(Math.max(...capHeights), 1080, 'maxHeight:1080 caps the emitted video ladder at 1080p');
ok(
  capped.skipped.some((s) => s.reason.includes('exceeds maxHeight')),
  'formats above maxHeight are reported as skipped',
);
ok(
  findAll(capDoc, 'Representation').some((r) => (r.attrs.mimeType ?? '').startsWith('audio/')),
  'maxHeight does not remove audio representations',
);

/* ------------------------------------------------------------------ */

section('exclusion of formats that cannot be segment-indexed');

const sample = formats1.find((f: any) => f.height === 720)!;
const synthetic: AdaptiveFormatInput[] = [
  { ...sample, itag: 9001, initRange: undefined, indexRange: { start: '0', end: '10' } },
  { ...sample, itag: 9002, initRange: { start: '0', end: '10' }, indexRange: undefined },
  { ...sample, itag: 9003, initRange: undefined, indexRange: undefined },
  { ...sample, itag: 9004, url: undefined },
  { ...sample, itag: 9005, url: '' },
  { ...sample, itag: 9006, initRange: { start: '0', end: '10' }, indexRange: { start: '11', end: '20' } },
];
const synthRes = buildDashManifestDetailed(synthetic, { durationSeconds: 60, rewriteUrl });
const synthDoc = parseXml(synthRes.mpd);
const synthIds = findAll(synthDoc, 'Representation').map((r) => r.attrs.id);
eq(synthIds.length, 1, 'only the fully-indexable synthetic format survives');
eq(synthIds[0], '9006', 'the surviving representation is the one with both ranges and a url');
ok(
  synthRes.skipped.some((s) => s.itag === '9001' && s.reason.includes('initRange')),
  'format missing initRange is skipped for that reason',
);
ok(
  synthRes.skipped.some((s) => s.itag === '9002' && s.reason.includes('indexRange')),
  'format missing indexRange is skipped for that reason',
);
ok(
  synthRes.skipped.some((s) => s.itag === '9004' && s.reason === 'missing url'),
  'format missing url is skipped for that reason',
);
ok(
  synthRes.skipped.some((s) => s.itag === '9005' && s.reason === 'missing url'),
  'format with an empty url is skipped for that reason',
);

/* ------------------------------------------------------------------ */

section('multiple audio tracks / disableAutoDubbed');

const audioSample = formats1.find((f: any) => String(f.mimeType).startsWith('audio/mp4') && !f.isDrc)!;
const multiTrack: AdaptiveFormatInput[] = [
  ...formats1.filter((f: any) => String(f.mimeType).startsWith('video/mp4') && String(f.mimeType).includes('avc1')),
  { ...audioSample, itag: 140, audioTrack: { id: 'en.4', displayName: 'English original', audioIsDefault: true } },
  { ...audioSample, itag: 140, bitrate: 129000, audioTrack: { id: 'es-419.3', displayName: 'Spanish (Latin America)', audioIsDefault: false } },
  { ...audioSample, itag: 140, bitrate: 128500, audioTrack: { id: 'ja.3', displayName: 'Japanese', audioIsDefault: false } },
];

const mt = buildDashManifestDetailed(multiTrack, { durationSeconds: dur1, rewriteUrl });
const mtDoc = parseXml(mt.mpd);
const mtAudioSets = childrenNamed(childrenNamed(mtDoc, 'Period')[0], 'AdaptationSet').filter(
  (s) => s.attrs.contentType === 'audio',
);
eq(mtAudioSets.length, 3, 'three audio tracks produce three audio AdaptationSets');
const langs = mtAudioSets.map((s) => s.attrs.lang).sort();
ok(langs.join(',') === 'en,es-419,ja', `AdaptationSet@lang derived from audioTrack.id (${langs.join(',')})`);
ok(
  mtAudioSets.some((s) => s.attrs.lang === 'en' && childrenNamed(s, 'Role')[0]?.attrs.value === 'main'),
  'the default audio track is marked Role=main',
);
ok(
  mtAudioSets.filter((s) => s.attrs.lang !== 'en').every((s) => childrenNamed(s, 'Role')[0]?.attrs.value === 'alternate'),
  'non-default audio tracks are marked Role=alternate',
);
ok(
  mtAudioSets.some((s) => s.attrs.label === 'English original'),
  'AdaptationSet@label carries audioTrack.displayName',
);
eq(
  new Set(findAll(mtDoc, 'Representation').map((r) => r.attrs.id)).size,
  findAll(mtDoc, 'Representation').length,
  'duplicate itag 140 across audio tracks still yields unique Representation@id',
);

const mtOff = buildDashManifestDetailed(multiTrack, { durationSeconds: dur1, rewriteUrl, disableAutoDubbed: true });
const mtOffDoc = parseXml(mtOff.mpd);
const mtOffAudioSets = childrenNamed(childrenNamed(mtOffDoc, 'Period')[0], 'AdaptationSet').filter(
  (s) => s.attrs.contentType === 'audio',
);
eq(mtOffAudioSets.length, 1, 'disableAutoDubbed leaves exactly one audio AdaptationSet');
eq(mtOffAudioSets[0].attrs.lang, 'en', 'disableAutoDubbed keeps the default (original) audio track');

/* ------------------------------------------------------------------ */

section('XML escaping of real googlevideo URLs');

const identity = buildDashManifest(formats1, { durationSeconds: dur1, rewriteUrl: (u) => u });
let identityDoc: XNode | null = null;
try {
  identityDoc = parseXml(identity);
  ok(true, 'MPD with raw (unrewritten) URLs is still well-formed — ampersands are escaped');
} catch (e) {
  ok(false, 'MPD with raw (unrewritten) URLs is still well-formed — ampersands are escaped', String(e));
}
if (identityDoc) {
  const base = findAll(identityDoc, 'BaseURL')[0];
  const original = (formats1 as any[]).find((f) => String(f.itag) === '315')!.url as string;
  const decoded = decodeEntities(base.text.trim());
  ok(identity.includes('&amp;'), 'raw URLs are emitted with &amp; entities');
  ok(
    findAll(identityDoc, 'BaseURL').some((b) => decodeEntities(b.text.trim()) === original),
    'a BaseURL round-trips to the exact original URL after entity decoding',
  );
  ok(decoded.startsWith('https://'), 'decoded BaseURL is a valid absolute URL');
}

/* ------------------------------------------------------------------ */

section('edge cases');

const emptyMpd = buildDashManifest([], { durationSeconds: 100, rewriteUrl });
try {
  const d = parseXml(emptyMpd);
  ok(childrenNamed(childrenNamed(d, 'Period')[0], 'AdaptationSet').length === 0, 'empty input yields a valid, empty MPD');
} catch (e) {
  ok(false, 'empty input yields a valid, empty MPD', String(e));
}

let threw = false;
try {
  // @ts-expect-error deliberately invalid
  buildDashManifest(formats1, { durationSeconds: 10 });
} catch {
  threw = true;
}
ok(threw, 'missing rewriteUrl throws rather than emitting raw googlevideo URLs');

const nullSafe = buildDashManifestDetailed(
  [null as any, undefined as any, { itag: 1, mimeType: 'text/plain', url: 'x' } as any],
  { durationSeconds: 10, rewriteUrl },
);
ok(nullSafe.representationCount === 0, 'garbage entries are skipped without throwing');

/* ------------------------------------------------------------------ */

section('pickProgressiveFallback');

eq(pickProgressiveFallback(fx1.streamingData.formats, {}), null, 'IOS fixture 1 has no muxed formats -> null');
eq(pickProgressiveFallback(fx2.streamingData.formats, {}), null, 'IOS fixture 2 has no muxed formats -> null');
eq(pickProgressiveFallback(undefined), null, 'undefined input -> null');
eq(pickProgressiveFallback([]), null, 'empty input -> null');
eq(
  pickProgressiveFallback(formats1 as any),
  null,
  'adaptive (single-codec) formats are never chosen as a progressive fallback',
);

const muxed: AdaptiveFormatInput[] = [
  { itag: 18, url: 'https://x/18', mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 500000, width: 640, height: 360, qualityLabel: '360p', fps: 30 },
  { itag: 22, url: 'https://x/22', mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', bitrate: 2000000, width: 1280, height: 720, qualityLabel: '720p', fps: 30 },
  { itag: 59, url: '', mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"', bitrate: 900000, width: 854, height: 480 },
];
eq(pickProgressiveFallback(muxed)?.itag, '22', 'picks the highest muxed rendition (itag 22 / 720p)');
eq(pickProgressiveFallback(muxed, { maxHeight: 480 })?.itag, '18', 'maxHeight:480 falls back to itag 18 / 360p');
eq(pickProgressiveFallback(muxed)?.qualityLabel, '720p', 'returns the qualityLabel');
eq(pickProgressiveFallback(muxed)?.mimeType, 'video/mp4', 'returns the mime base');
eq(
  pickProgressiveFallback(muxed, { rewriteUrl })?.url,
  rewriteUrl('https://x/22'),
  'rewriteUrl is applied to the progressive fallback url when supplied',
);
eq(pickProgressiveFallback(muxed)?.url, 'https://x/22', 'url is left untouched when no rewriteUrl is supplied');

/* ------------------------------------------------------------------ */

section('self-check: the XML parser actually rejects bad XML');

const badCases: Array<[string, string]> = [
  ['<a><b></a></b>', 'mismatched nesting'],
  ['<a>', 'unclosed element'],
  ['<a>raw & ampersand</a>', 'unescaped ampersand in text'],
  ['<a href="x & y"/>', 'unescaped ampersand in attribute'],
  ['<a></a><b></b>', 'two root elements'],
];
for (const [xml, label] of badCases) {
  let rejected = false;
  try {
    parseXml(xml);
  } catch {
    rejected = true;
  }
  ok(rejected, `parser rejects: ${label}`);
}
ok(parseXml('<a x="1"><b/><c>t</c></a>').children.length === 2, 'parser accepts valid XML');

/* ------------------------------------------------------------------ *
 * Tally
 * ------------------------------------------------------------------ */

console.log('\n============================================');
console.log(`passed: ${passed}   failed: ${failed}   total: ${passed + failed}`);
if (failed) {
  console.log('failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('============================================');
process.exit(failed ? 1 : 0);
