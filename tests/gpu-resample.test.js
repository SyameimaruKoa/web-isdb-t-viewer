import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleIndex, resampleGPU } from '../src/receiver/gpu-resample.js';

test('GPU FIR position arithmetic stays exact over an entire capture', () => {
  for (const i of [0, 1, 2, 124, 125, 126, 10001, 1048576, 5892062]) {
    const result = resampleIndex(i);
    const numerator = i * 252;
    assert.equal(result.base, Math.floor(numerator / 125));
    assert.equal(result.phase, Math.floor(((numerator % 125) * 1024) / 125));
    assert.ok(result.phase >= 0 && result.phase < 1024);
  }
});

test('GPU refuses unknown rates instead of silently producing shifted OFDM samples', async () => {
  await assert.rejects(
    resampleGPU(new Float64Array(100), new Float64Array(100), 2047999),
    /exact 2048000 Hz/,
  );
});
