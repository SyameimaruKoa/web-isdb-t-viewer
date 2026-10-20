import { prepareIQ, mixFrequency, resample, completeIQ } from './dsp.js';
import { resampleGPU, disableGPU } from './gpu-resample.js';
import { decodeTransport } from './transport.js';

let gpuVerified = false;
const now = () => performance.now();
const round = (n) => Math.round(n * 10) / 10;

function displayProfile(timing, result, isDecode) {
  const rows = {};
  for (const [stage, time] of Object.entries(timing))
    if (stage.endsWith('Ms') && Number.isFinite(time)) rows[stage] = round(time);
  const packets = result.transport;
  const header = [
    '[ISDB-T]', isDecode ? 'decode' : 'monitor',
    round(timing.totalMs) + ' ms',
    'FIR=' + timing.backend,
    packets ? ('RS=' + (packets.validPackets ?? 0) + '/' +
      ((packets.validPackets ?? 0) + (packets.failedPackets ?? 0))) : '',
  ].filter(Boolean).join(' | ');
  console.groupCollapsed(header);
  console.table(rows);
  console.info('Context', {
    captureMiB: round(timing.captureBytes / (1024 * 1024)),
    backend: timing.backend,
    gpuFallback: timing.gpuFallback || null,
    viterbiPhases: timing.viterbiPhases,
    syncScore: packets?.syncScore,
    tmccFrames: packets?.tmccFrames,
    validPackets: packets?.validPackets,
    failedPackets: packets?.failedPackets,
    transportError: packets?.error,
  });
  console.groupEnd();
}

self.onmessage = async ({ data }) => {
  const timing = { backend: 'CPU', captureBytes: data.buffer.byteLength };
  const started = now();
  const progress = (stage) => self.postMessage({ stage });
  try {
    const prepared = prepareIQ(new Uint8Array(data.buffer), data.options, progress, timing);
    let point = now();
    mixFrequency(prepared.re, prepared.im, prepared.sampleRate, prepared.offset);
    timing.mixMs = now() - point;
    point = now();
    let samples;
    if (data.options?.decode) {
      try {
        progress('WebGPU 64-tap FIR resampling');
        samples = await resampleGPU(prepared.re, prepared.im, prepared.sampleRate);
        timing.backend = 'WebGPU';
        timing.resampleMs = now() - point;
        if (!gpuVerified) {
          const verifyStart = now();
          // Reference check is intentionally small and done only once per worker.
          const prefix = resample(prepared.re.subarray(0, 4096),
            prepared.im.subarray(0, 4096), prepared.sampleRate);
          for (let i = 24; i < Math.min(1200, prefix[0].length); i += 13) {
            if (Math.abs(samples[0][i] - prefix[0][i]) > 0.005 ||
                Math.abs(samples[1][i] - prefix[1][i]) > 0.005)
              throw new Error('GPU FIR differs from CPU reference');
          }
          gpuVerified = true;
          timing.gpuVerifyMs = now() - verifyStart;
        }
      } catch (error) {
        disableGPU(error);
        timing.gpuFallback = error instanceof Error ? error.message : String(error);
        console.warn('[ISDB-T] WebGPU FIR disabled; CPU fallback:', timing.gpuFallback);
        point = now();
        samples = resample(prepared.re, prepared.im, prepared.sampleRate);
        timing.resampleMs = now() - point;
        timing.backend = 'CPU fallback';
      }
    } else {
      samples = resample(prepared.re, prepared.im, prepared.sampleRate);
      timing.resampleMs = now() - point;
    }
    const result = completeIQ(prepared, ...samples, progress, timing);
    if (data.options?.decode)
      result.transport = decodeTransport(result.carriers, result.metrics, progress, timing);
    delete result.carriers;
    timing.totalMs = now() - started;
    result.profile = timing;
    displayProfile(timing, result, !!data.options?.decode);
    const transfers = [
      result.spectrum.x.buffer,
      result.spectrum.y.buffer,
      result.correlation.buffer,
      result.raw.buffer,
      result.points.buffer,
    ];
    if (result.transport) transfers.push(result.transport.bytes.buffer);
    self.postMessage({ result }, transfers);
  } catch (error) {
    timing.totalMs = now() - started;
    console.error('[ISDB-T] Decoder failed', {
      reason: error instanceof Error ? error.message : String(error), timing,
    });
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
