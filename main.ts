// The entry <-> env lifecycle, as the trial harness settles it: bind an ephemeral
// port, hand that port to the env, then wait until the env reports the trial is
// finished and leave with code 0. The server itself lives in app.ts; this file is
// only the handshake around it.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial
//      container). With no such variable there is nobody to talk to, so the
//      process leaves at once with code 1.
//   2. The server listens on port 0 and the kernel picks a free one. Port 8080
//      is never ours — the env listens there.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env notes the address the
//      request arrived from together with N and dials that base URL from then
//      on. The first register wins; a 409 means some other entry already took
//      the slot, and this process simply keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The env
//      answers immediately ({"done": false} while the suite is still running),
//      so this is a poll. A failed or slow poll is retried on a short
//      exponential backoff; the process never leaves before the env says done.
//   5. Shut the server and exit 0. The harness then stops the env, which writes
//      the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is given up on. */
const CALL_TIMEOUT_MS = 30_000;
/** The first pause between retries, and the longest pause allowed. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The pause after `failed` unsuccessful requests: doubling, capped, from BACKOFF_START_MS. */
function backoffFor(failed: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(failed, 8));
}

/**
 * POST the bound port until the env takes it. 200 is the ordinary answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network failure or any
 * other status is retried, since the env may still be coming up.
 */
async function announce(port: number): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const answer = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffFor(failed));
  }
}

/** Keep asking GET /done until it answers {"done":true}; never return sooner. */
async function awaitDone(): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const answer = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll ran out of time: it is not
      // done, so ask again.
    }
    await pause(backoffFor(failed));
  }
}

/** Bind the port, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
