# SABR/UMP investigation tools

Standalone Node scripts used to implement and measure YouTube's SABR playback path.
Nothing here is shipped in the app — these exist to produce evidence and fixtures.
Findings live in [`../../docs/STATE-AND-NEXT.md`](../../docs/STATE-AND-NEXT.md) §6.

Requires only Node 24+ and network access. Run from this directory.

| script | what it does |
|---|---|
| `capture.mjs` | One `VideoPlaybackAbrRequest`, dumps every UMP part with a generic protobuf decoder. Follows a `RELOAD_PLAYER_RESPONSE` and retries. |
| `stream.mjs` | The full streaming loop — advances `player_time_ms`, reports `buffered_ranges`, passes the playback cookie back. Prints seconds of media accumulated per track. |
| `seek-probe.mjs` | Fresh stateless request at each of several playback positions. This is what pins the boundary to exactly 60.000 s. |
| `client-matrix.mjs` | Every client (WEB/IOS/ANDROID/MWEB) × bare / `visitorData` / `visitorData`+PoToken. Scrapes the live `INNERTUBE_CLIENT_VERSION` and signature timestamp. |

```bash
node capture.mjs      aqz-KE-bpKQ
node stream.mjs       aqz-KE-bpKQ 300
node seek-probe.mjs   aqz-KE-bpKQ 0,30,55,59,60,120,300
node client-matrix.mjs aqz-KE-bpKQ 30,120
```

`stream.mjs` and `client-matrix.mjs` optionally take a PoToken minter:

```bash
SABR_MINTER=/path/to/mint-node.mjs node client-matrix.mjs
SABR_ATTEST=1 SABR_MINTER=/path/to/mint-node.mjs node stream.mjs
```

The minter is deliberately **not** in this repo. It works by `eval`-ing obfuscated
JavaScript fetched from Google (unavoidable for BotGuard attestation), so where it runs
matters — see the note in `STATE-AND-NEXT.md` §6 before wiring it into the app.

Other environment variables: `SABR_OUT` (capture directory), `SABR_DEBUG=1` (per-round
part counts), `SABR_STALL_WAIT_MS` (sleep and retry on a stall).

## Directories

- `protos/` — reference message definitions fetched from [`LuanRT/googlevideo`](https://github.com/LuanRT/googlevideo),
  kept verbatim so the encoders can be checked against them.
- `captures/` — real request/response bytes. `sabr-response-1.bin` is a successful
  182 KB UMP response with init and media segments for both tracks; move these under
  `tests/fixtures/` when the parser is ported into `src/`.
