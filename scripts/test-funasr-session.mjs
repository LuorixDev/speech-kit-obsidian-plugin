import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const model = process.env.SPEECH_KIT_FUNASR_MODEL;
if (!model)
  throw new Error(
    'Set SPEECH_KIT_FUNASR_MODEL to an installed Nano 2512 GGUF. No downloads are performed.',
  );
const helper = resolve(
  process.env.SPEECH_KIT_FUNASR_HELPER || 'native/target/release/audiocpp_session',
);
const start = performance.now();
const child = spawn(
  helper,
  [
    '--task',
    'asr',
    '--family',
    'fun_asr_nano',
    '--model',
    model,
    '--backend',
    process.env.SPEECH_KIT_FUNASR_BACKEND || 'vulkan',
    '--speech-kit-session',
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
const exit = once(child, 'exit');
const timeout = setTimeout(() => child.kill(), 90_000);
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
async function reply() {
  const line = await lines.next();
  assert.equal(line.done, false, 'helper exited before replying');
  return JSON.parse(line.value);
}
try {
  assert.equal((await reply()).type, 'ready');
  console.log(JSON.stringify({ pid: child.pid, readyMs: performance.now() - start }));
  for (let id = 1; id <= 6; id++) {
    const language = id % 2 === 1 ? 'en' : 'zh';
    const audio = resolve(
      'native/tests/fixtures/audio',
      language === 'en' ? 'jfk.wav' : 'zh-fleurs-1577.wav',
    );
    const requestStart = performance.now();
    child.stdin.write(`${JSON.stringify({ id, audio, language })}\n`);
    const result = await reply();
    assert.equal(result.type, 'result');
    assert.equal(result.id, id);
    assert.ok(result.text.trim().length > 0);
    if (language === 'en') assert.match(result.text, /country/i);
    else assert.match(result.text, /毫无道理/);
    console.log(
      JSON.stringify({
        pid: child.pid,
        id,
        durationMs: performance.now() - requestStart,
        text: result.text,
      }),
    );
  }
  child.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0);
  console.log('One helper handled six requests and exited cleanly.');
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exit;
}
