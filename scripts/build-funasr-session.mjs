import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const revision = 'a2a4d4f34c0960edf1bf78e392de1fbce5a855e6';
const source = resolve(
  process.env.SPEECH_KIT_AUDIOCPP_SOURCE || 'native/target/audiocpp-session-source',
);
const build = resolve(
  process.env.SPEECH_KIT_AUDIOCPP_BUILD || 'native/target/audiocpp-session-build',
);
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const patch = resolve('scripts/patches/audiocpp-session.patch');
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, stdio: 'inherit' });
}
try {
  await access(join(source, '.git'));
} catch {
  await mkdir(resolve(source, '..'), { recursive: true });
  run('git', [
    'clone',
    '--depth',
    '1',
    '--filter=blob:none',
    '--no-checkout',
    '--branch',
    'v0.7.2',
    'https://github.com/0xShug0/audio.cpp.git',
    source,
  ]);
  run(
    'git',
    [
      'sparse-checkout',
      'set',
      'app',
      'src',
      'include',
      'model_specs',
      'external',
      'webui/native',
      'tests/perf',
    ],
    source,
  );
  run('git', ['checkout'], source);
}
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (actual !== revision) throw new Error(`Expected audio.cpp ${revision}, got ${actual}`);
try {
  execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: source, stdio: 'pipe' });
} catch {
  run('git', ['apply', '--check', patch], source);
  run('git', ['apply', patch], source);
}
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DAUDIOCPP_DEPLOYMENT_BUILD=ON',
  '-DAUDIOCPP_MODEL_SET=custom',
  '-DAUDIOCPP_MODELS=fun_asr_nano',
  '-DENGINE_ENABLE_VULKAN=ON',
  '-DENGINE_ENABLE_NATIVE_CPU=OFF',
  '-DBUILD_SHARED_LIBS=OFF',
]);
run('cmake', ['--build', build, '--target', 'audiocpp_cli', '--parallel', '8']);
const destination = resolve('native/target', profile);
await mkdir(destination, { recursive: true });
await copyFile(join(build, 'bin/audiocpp_cli'), join(destination, 'audiocpp_session'));
console.log(`Installed persistent FunASR helper to ${destination}`);
