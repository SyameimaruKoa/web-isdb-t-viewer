import { SAMPLE_RATE, getResampleTable } from './dsp.js';

// Exact input/output sample coordinates use the rational ratio 252/125.
// Calculating i * 2.016 in f32 loses sample precision on long captures.
const wgsl = `
struct Size { inputLength: u32, outputLength: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<storage,read> sourceI: array<f32>;
@group(0) @binding(1) var<storage,read> sourceQ: array<f32>;
@group(0) @binding(2) var<storage,read> coeff: array<f32>;
@group(0) @binding(3) var<storage,read_write> destination: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> dims: Size;
@compute @workgroup_size(128)
fn fir(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= dims.outputLength) { return; }
  let pos = i * 252u;
  let first = i32(pos / 125u) - 31;
  let phase = ((pos % 125u) * 1024u / 125u) * 64u;
  var real = 0.0;
  var imag = 0.0;
  for (var t = 0u; t < 64u; t++) {
    let j = first + i32(t);
    if (j >= 0 && u32(j) < dims.inputLength) {
      let w = coeff[phase + t];
      real += w * sourceI[u32(j)];
      imag += w * sourceQ[u32(j)];
    }
  }
  destination[i] = vec2<f32>(real, imag);
}
`;
let cachedDevice;
let cachedBuffers;
let failure;

export function resampleIndex(index) {
  const pos = index * 252;
  return { base: Math.floor(pos / 125), phase: Math.floor(((pos % 125) * 1024) / 125) };
}
async function initialize() {
  if (!globalThis.navigator?.gpu) throw new Error('WebGPU unavailable in decoder Worker');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto', compute: { module, entryPoint: 'fir' },
  });
  const table = Float32Array.from(getResampleTable());
  const tableBuffer = device.createBuffer({
    size: table.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(tableBuffer, 0, table);
  device.lost.then((event) => {
    failure = 'GPU lost: ' + event.message;
    cachedDevice = null;
    cachedBuffers = null;
  });
  return { device, pipeline, tableBuffer };
}
function gpu() {
  if (failure) throw new Error(failure);
  return (cachedDevice ??= initialize());
}
function ensureBuffers(state, length, outputLength) {
  if (cachedBuffers?.length === length && cachedBuffers?.outputLength === outputLength)
    return cachedBuffers;
  for (const b of cachedBuffers?.owned ?? []) b.destroy();
  const { device } = state;
  const inputBytes = length * 4, outputBytes = outputLength * 8;
  if (Math.max(inputBytes, outputBytes) > device.limits.maxStorageBufferBindingSize)
    throw new Error('WebGPU buffer-size limit');
  const inputI = device.createBuffer({ size: inputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const inputQ = device.createBuffer({ size: inputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputI } }, { binding: 1, resource: { buffer: inputQ } },
      { binding: 2, resource: { buffer: state.tableBuffer } },
      { binding: 3, resource: { buffer: output } }, { binding: 4, resource: { buffer: uniforms } },
    ],
  });
  return (cachedBuffers = { length, outputLength, inputI, inputQ, output, staging, uniforms,
    bindGroup, owned: [inputI, inputQ, output, staging, uniforms] });
}

// Includes staging, upload, compute dispatch, readback, and Float64 conversion.
export async function resampleGPU(re, im, sampleRate) {
  if (sampleRate !== SAMPLE_RATE) throw new Error('GPU FIR currently requires exact 2048000 Hz');
  const state = await gpu();
  const count = Math.floor(re.length * 125 / 252);
  const b = ensureBuffers(state, re.length, count), { device } = state;
  device.queue.writeBuffer(b.inputI, 0, Float32Array.from(re));
  device.queue.writeBuffer(b.inputQ, 0, Float32Array.from(im));
  device.queue.writeBuffer(b.uniforms, 0, new Uint32Array([re.length, count, 0, 0]));
  device.pushErrorScope('validation');
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, b.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 128));
    pass.end();
    encoder.copyBufferToBuffer(b.output, 0, b.staging, 0, count * 8);
    device.queue.submit([encoder.finish()]);
    await b.staging.mapAsync(GPUMapMode.READ);
    const source = new Float32Array(b.staging.getMappedRange());
    const r = new Float64Array(count), q = new Float64Array(count);
    for (let i = 0; i < count; i++) { r[i] = source[2 * i]; q[i] = source[2 * i + 1]; }
    b.staging.unmap();
    const err = await device.popErrorScope();
    if (err) throw new Error(err.message);
    return [r, q];
  } catch (err) {
    if (b.staging.mapState === 'mapped') b.staging.unmap();
    await device.popErrorScope().catch(() => {});
    throw err;
  }
}
export function disableGPU(err) {
  failure = err instanceof Error ? err.message : String(err);
  cachedDevice = null;
  for (const b of cachedBuffers?.owned ?? []) b.destroy();
  cachedBuffers = null;
}
