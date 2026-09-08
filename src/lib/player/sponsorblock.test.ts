/**
 * sponsorblock.test.ts - runnable behaviour checks with a fake host.
 * No test framework: `tsc` it and `node` it.
 *
 *   npx tsc -p tsconfig.test.json && node dist/sponsorblock.test.js
 */

import { SponsorBlockController, type SponsorSegment, type SponsorBlockHost } from './sponsorblock';
import type { TimeUpdatePayload } from './player';

class FakeHost implements SponsorBlockHost {
  time = 0;
  duration = 600;
  muted = false;
  seeks: number[] = [];
  getCurrentTime(): number {
    return this.time;
  }
  getDuration(): number {
    return this.duration;
  }
  seek(t: number): void {
    this.seeks.push(t);
    this.time = t;
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
  isMuted(): boolean {
    return this.muted;
  }
}

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name);
  }
}

/** Advance the fake clock in 100ms ticks, feeding the controller. */
function run(host: FakeHost, sb: SponsorBlockController, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t = Math.round((t + 0.1) * 1000) / 1000) {
    if (host.time > t + 0.5) t = host.time; // a skip moved us forward
    host.time = t;
    const payload: TimeUpdatePayload = { currentTime: t, duration: host.duration, bufferedAhead: 10, seeked: false };
    sb.onTimeUpdate(payload);
    if (host.time !== t) t = host.time;
  }
}

function seekTo(host: FakeHost, sb: SponsorBlockController, t: number): void {
  host.time = t;
  sb.onTimeUpdate({ currentTime: t, duration: host.duration, bufferedAhead: 10, seeked: true });
}

/* 1. basic skip ---------------------------------------------------- */
{
  console.log('basic skip');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
  sb.setHost(host);
  const segs: SponsorSegment[] = [{ category: 'sponsor', actionType: 'skip', segment: [10, 25], UUID: 'a' }];
  sb.setSegments(segs, 600);
  let skipped = 0;
  sb.on('skip', () => skipped++);
  run(host, sb, 9, 12);
  check('seeked past the sponsor', host.time >= 25 && host.time < 25.5);
  check('emitted exactly one skip', skipped === 1);
}

/* 2. overlapping + near-duplicate merge ---------------------------- */
{
  console.log('merge overlapping / near-duplicate');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip', selfpromo: 'skip' } });
  sb.setHost(host);
  sb.setSegments(
    [
      { category: 'sponsor', actionType: 'skip', segment: [30, 45], UUID: 'a' },
      { category: 'sponsor', actionType: 'skip', segment: [30.2, 45.1], UUID: 'b' },
      { category: 'selfpromo', actionType: 'skip', segment: [45.3, 60], UUID: 'c' },
    ],
    600,
  );
  check('merged into one segment', sb.getSegments().length === 1);
  check('merged span is 30 -> 60', sb.getSegments()[0].start === 30 && sb.getSegments()[0].end === 60);
  let skips = 0;
  sb.on('skip', () => skips++);
  run(host, sb, 29, 32);
  check('one seek, not three', host.seeks.length === 1 && skips === 1);
  check('landed after 60', host.time >= 60);
}

/* 3. manual seek back into a skipped segment ----------------------- */
{
  console.log('manual seek back disables the segment');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'sponsor', actionType: 'skip', segment: [10, 25], UUID: 'a' }], 600);
  let disabled = 0;
  sb.on('segmentDisabled', (e) => {
    if (e.reason === 'manual-seek') disabled++;
  });
  run(host, sb, 9, 11);
  check('skipped first', host.time >= 25);
  seekTo(host, sb, 15); // user drags back into the sponsor
  check('segment disabled by manual seek', disabled === 1);
  const seeksBefore = host.seeks.length;
  run(host, sb, 15, 17);
  check('does not re-skip the user back out', host.seeks.length === seeksBefore && host.time < 25);
}

/* 4. seek to before a segment re-arms it --------------------------- */
{
  console.log('seek before segment re-arms');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'sponsor', actionType: 'skip', segment: [10, 25], UUID: 'a' }], 600);
  run(host, sb, 9, 11);
  check('skipped once', host.time >= 25);
  seekTo(host, sb, 5); // user rewinds to before the sponsor
  run(host, sb, 5, 11);
  check('skipped again on the second pass', host.time >= 25);
}

/* 5. poi_highlight and full are never auto-skipped ----------------- */
{
  console.log('poi_highlight / full');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip', poi_highlight: 'notify' } });
  sb.setHost(host);
  let highlight = 0;
  let fullLabel = 0;
  sb.on('highlight', () => highlight++);
  sb.on('fullVideoLabel', () => fullLabel++);
  sb.setSegments(
    [
      { category: 'poi_highlight', actionType: 'poi', segment: [120, 120], UUID: 'h' },
      { category: 'sponsor', actionType: 'full', segment: [0, 600], UUID: 'f' },
    ],
    600,
  );
  check('highlight surfaced', highlight === 1);
  check('full label surfaced', fullLabel === 1);
  check('neither became a skippable segment', sb.getSegments().length === 0);
  run(host, sb, 0, 3);
  check('playhead untouched by a full-video label', host.seeks.length === 0);
  sb.jumpToHighlight();
  check('jumpToHighlight seeks to 120', host.time === 120);
}

/* 6. mute actionType ---------------------------------------------- */
{
  console.log('mute action');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'sponsor', actionType: 'mute', segment: [10, 20], UUID: 'm' }], 600);
  run(host, sb, 9, 12);
  check('muted inside the segment', host.muted === true);
  check('did not seek', host.seeks.length === 0);
  run(host, sb, 12, 21);
  check('unmuted after the segment', host.muted === false);
}

/* 7. no pointless micro-seek near the segment end ------------------ */
{
  console.log('no micro-seek');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'sponsor', actionType: 'skip', segment: [10, 25], UUID: 'a' }], 600);
  seekTo(host, sb, 24.9); // user lands 100ms before the end
  run(host, sb, 24.9, 25.2);
  check('did not seek for 100ms of savings', host.seeks.length === 0);
}

/* 8. outro at the end of the video seeks to the end ---------------- */
{
  console.log('end-of-video outro');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { outro: 'skip' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'outro', actionType: 'skip', segment: [590, 599.7] }], 600);
  run(host, sb, 589, 591);
  check('seeked to the duration, not 599.75', host.time === 600);
}

/* 9. notify mode does not move the playhead ------------------------ */
{
  console.log('notify mode');
  const host = new FakeHost();
  const sb = new SponsorBlockController({ categories: { intro: 'notify' } });
  sb.setHost(host);
  sb.setSegments([{ category: 'intro', actionType: 'skip', segment: [5, 15], UUID: 'i' }], 600);
  let notices = 0;
  let manualSkip: (() => void) | null = null;
  sb.on('notice', (e) => {
    notices++;
    manualSkip = e.skip;
  });
  run(host, sb, 4, 7);
  check('one notice, no seek', notices === 1 && host.seeks.length === 0);
  (manualSkip as unknown as () => void)();
  check('manual skip from the notice works', host.time >= 15);
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + String(failures) + ' FAILURE(S)');
if (failures > 0) process.exitCode = 1;
