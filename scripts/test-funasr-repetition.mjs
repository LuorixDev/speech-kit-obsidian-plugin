import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the exact guard in the shipped patch to test actual C++ behavior.
const patch = await readFile('scripts/patches/audiocpp-repetition.patch', 'utf8');
const guard = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1)).join('\n').replace('if (repeating) break;', 'return repeating;');
assert.match(guard, /out\.token_ids\.resize/);
const dir = await mkdtemp(join(tmpdir(), 'speech-kit-repeat-test-'));
await writeFile(join(dir, 'test.cpp'), `
#include <vector>
#include <cstdint>
#include <cstddef>
#include <cassert>
struct Output { std::vector<int32_t> token_ids; };
bool check(Output &out) { ${guard} }
int main() {
  Output ordinary{{1,2,3,1,2,3}};
  assert(!check(ordinary));
  for (int width : {1, 3, 16, 64}) {
    Output repeated;
    for (int copy=0; copy<6; ++copy)
      for (int token=0; token<width; ++token) repeated.token_ids.push_back(token);
    assert(check(repeated));
    assert(repeated.token_ids.size() == static_cast<size_t>(width*2));
  }
  Output unique;
  for (int token=0; token<500; ++token) unique.token_ids.push_back(token);
  assert(!check(unique));
}
`);
execFileSync('c++', ['-std=c++17', join(dir, 'test.cpp'), '-o', join(dir, 'test')]);
execFileSync(join(dir, 'test'));
console.log('Decoder repetition guard: short, long, and ordinary token sequences passed.');
