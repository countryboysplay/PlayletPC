/**
 * Policy tests for the playback client ladder.
 *
 * These exist because of a specific, expensive failure: `SIGNED_IN_LADDER` put `tv`
 * first, on the belief that an account token lifted YouTube's 60-second serve limit.
 * It does not. So signed-in users got capped URLs and every video froze around 18
 * seconds, while signed-out users - and every automated test, all of which run signed
 * out - were completely fine. The asymmetry hid it for a long time.
 *
 * The lesson these assert: never let a half-working client into the ladder, and never
 * let sign-in state change which client serves playback.
 */

import { PLAYER_CLIENT_LADDER, SIGNED_IN_LADDER, CAPPED_CLIENTS } from '../src/lib/api/player-clients'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')) }
}

console.log('\nplayback client ladder')

check('visionos leads the ladder', PLAYER_CLIENT_LADDER[0] === 'visionos', PLAYER_CLIENT_LADDER[0])

// IOS answers OK and hands over direct URLs, then stops serving at exactly 60.000s.
// Everything short of playing past a minute reports it as healthy.
for (const capped of CAPPED_CLIENTS) {
  check('no capped client in the ladder: ' + capped,
    !PLAYER_CLIENT_LADDER.includes(capped as never),
    PLAYER_CLIENT_LADDER.join(' -> '))
}

check('signing in does not change the playback client',
  JSON.stringify(SIGNED_IN_LADDER) === JSON.stringify(PLAYER_CLIENT_LADDER),
  'signed-in: ' + SIGNED_IN_LADDER.join(' -> '))

for (const capped of CAPPED_CLIENTS) {
  check('no capped client in the signed-in ladder: ' + capped,
    !SIGNED_IN_LADDER.includes(capped as never))
}

check('the ladder is not empty and has a fallback', PLAYER_CLIENT_LADDER.length >= 2,
  PLAYER_CLIENT_LADDER.length + ' clients')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
