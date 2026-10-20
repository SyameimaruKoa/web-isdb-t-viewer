/* oxlint-disable typescript/await-thenable -- Legacy JSDoc omits Promise wrappers on async USB functions. */
// Copyright 2013 Google Inc. All rights reserved.
// Copyright 2018 Sandeep Mistry All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import R820T from './r820t.js';
import FC0012, { FC0012_CHIP_ID, FC0012_I2C_ADDRESS } from './fc0012.js';
import RtlCom from './rtlcom.js';

var CMD = RtlCom.CMD;
var BLOCK = RtlCom.BLOCK;
var REG = RtlCom.REG;

/**
 * Detect supported tuners with a diagnostic trace.
 *
 * FC0012 boards can remain held in reset after an interrupted prior session.
 * librtlsdr toggles GPIO4 (the tuner reset line) before probing FC0012.
 * Start with a non-disruptive probe, then perform the upstream reset sequence
 * only if the first check failed. Never assume that the device is FC0012
 * solely from its RTL2832U USB ID.
 */
export async function detectTuner(com) {
  const attempts = [];
  const readFC0012 = async (name) => {
    try {
      const chipId = await com.i2c.readRegister(FC0012_I2C_ADDRESS, 0x00);
      const found = chipId === FC0012_CHIP_ID;
      attempts.push({ step: name, chipId: '0x' + chipId.toString(16).padStart(2, '0'), found });
      return found;
    } catch (error) {
      attempts.push({ step: name, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  if (await readFC0012('FC0012 initial probe')) return { type: 'FC0012', attempts };

  let resetSucceeded = false;
  try {
    await com.gpio.setOutput(4);
    await com.gpio.setBit(4, true);
    await com.gpio.setBit(4, false);
    resetSucceeded = true;
    attempts.push({ step: 'GPIO4 tuner reset', completed: true });
  } catch (error) {
    attempts.push({ step: 'GPIO4 tuner reset', error: error instanceof Error ? error.message : String(error) });
  }
  if (resetSucceeded && await readFC0012('FC0012 after GPIO4 reset'))
    return { type: 'FC0012', attempts };

  try {
    const found = await R820T.check(com);
    attempts.push({ step: 'R820T probe', found });
    if (found) return { type: 'R820T', attempts };
  } catch (error) {
    attempts.push({ step: 'R820T probe', error: error instanceof Error ? error.message : String(error) });
  }
  return { type: null, attempts };
}

/**
 * Operations on the RTL2832U demodulator.
 * @param {ConnectionHandle} conn The USB connection handle.
 * @param {number} ppm The frequency correction factor, in parts per million.
 * @param {number=} opt_gain The optional gain in dB. If unspecified or null, sets auto gain.
 * @class
 */
export default function RTL2832U(conn, ppm, opt_gain) {
  /**
   * Frequency of the oscillator crystal.
   */
  var XTAL_FREQ = 28800000;

  /**
   * Tuner intermediate frequency.
   */
  var IF_FREQ = 3570000;

  /**
   * The number of bytes for each sample.
   */
  var BYTES_PER_SAMPLE = 2;

  /**
   * Communications with the demodulator via USB.
   */
  var com = new RtlCom(conn);

  /**
   * The tuner used by the dongle.
   */
  var tuner;
  var tunerType = null;

  /**
   * Initialize the demodulator.
   */
  async function open() {
    await com.writeEach([
      [CMD.REG, BLOCK.USB, REG.SYSCTL, 0x09, 1],
      [CMD.REG, BLOCK.USB, REG.EPA_MAXPKT, 0x0200, 2],
      [CMD.REG, BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
    ]);
    await com.iface.claim();
    await com.writeEach([
      [CMD.REG, BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1],
      [CMD.REG, BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1],
      [CMD.DEMODREG, 1, 0x01, 0x14, 1],
      [CMD.DEMODREG, 1, 0x01, 0x10, 1],
      [CMD.DEMODREG, 1, 0x15, 0x00, 1],
      [CMD.DEMODREG, 1, 0x16, 0x0000, 2],
      [CMD.DEMODREG, 1, 0x16, 0x00, 1],
      [CMD.DEMODREG, 1, 0x17, 0x00, 1],
      [CMD.DEMODREG, 1, 0x18, 0x00, 1],
      [CMD.DEMODREG, 1, 0x19, 0x00, 1],
      [CMD.DEMODREG, 1, 0x1a, 0x00, 1],
      [CMD.DEMODREG, 1, 0x1b, 0x00, 1],
      [CMD.DEMODREG, 1, 0x1c, 0xca, 1],
      [CMD.DEMODREG, 1, 0x1d, 0xdc, 1],
      [CMD.DEMODREG, 1, 0x1e, 0xd7, 1],
      [CMD.DEMODREG, 1, 0x1f, 0xd8, 1],
      [CMD.DEMODREG, 1, 0x20, 0xe0, 1],
      [CMD.DEMODREG, 1, 0x21, 0xf2, 1],
      [CMD.DEMODREG, 1, 0x22, 0x0e, 1],
      [CMD.DEMODREG, 1, 0x23, 0x35, 1],
      [CMD.DEMODREG, 1, 0x24, 0x06, 1],
      [CMD.DEMODREG, 1, 0x25, 0x50, 1],
      [CMD.DEMODREG, 1, 0x26, 0x9c, 1],
      [CMD.DEMODREG, 1, 0x27, 0x0d, 1],
      [CMD.DEMODREG, 1, 0x28, 0x71, 1],
      [CMD.DEMODREG, 1, 0x29, 0x11, 1],
      [CMD.DEMODREG, 1, 0x2a, 0x14, 1],
      [CMD.DEMODREG, 1, 0x2b, 0x71, 1],
      [CMD.DEMODREG, 1, 0x2c, 0x74, 1],
      [CMD.DEMODREG, 1, 0x2d, 0x19, 1],
      [CMD.DEMODREG, 1, 0x2e, 0x41, 1],
      [CMD.DEMODREG, 1, 0x2f, 0xa5, 1],
      [CMD.DEMODREG, 0, 0x19, 0x05, 1],
      [CMD.DEMODREG, 1, 0x93, 0xf0, 1],
      [CMD.DEMODREG, 1, 0x94, 0x0f, 1],
      [CMD.DEMODREG, 1, 0x11, 0x00, 1],
      [CMD.DEMODREG, 1, 0x04, 0x00, 1],
      [CMD.DEMODREG, 0, 0x61, 0x60, 1],
      [CMD.DEMODREG, 0, 0x06, 0x80, 1],
      [CMD.DEMODREG, 1, 0xb1, 0x1b, 1],
      [CMD.DEMODREG, 0, 0x0d, 0x83, 1],
    ]);

    var xtalFreq = Math.floor(XTAL_FREQ * (1 + ppm / 1000000));
    await com.i2c.open();
    const detection = await detectTuner(com);
    console.info('[ISDB-T] RTL2832U tuner probe', detection);
    if (detection.type === 'FC0012') {
      tuner = new FC0012(com, xtalFreq);
      tunerType = 'FC0012';
      await com.gpio.setOutput(6);
    } else if (detection.type === 'R820T') {
      tuner = new R820T(com, xtalFreq);
      tunerType = 'R820T';
    } else {
      throw new Error('No compatible FC0012 or R820T tuner detected. See [ISDB-T] RTL2832U tuner probe in Console; reconnect the USB tuner if GPIO4 reset failed.');
    }
    if (tunerType === 'FC0012') {
      // FC0012 uses zero-IF I/Q rather than the R820T's 3.57 MHz IF.
      await com.writeEach([
        [CMD.DEMODREG, 1, 0xb1, 0x1b, 1],
        [CMD.DEMODREG, 0, 0x08, 0xcd, 1],
        [CMD.DEMODREG, 1, 0x19, 0x00, 1],
        [CMD.DEMODREG, 1, 0x1a, 0x00, 1],
        [CMD.DEMODREG, 1, 0x1b, 0x00, 1],
        [CMD.DEMODREG, 1, 0x15, 0x00, 1],
      ]);
    } else {
      var multiplier = -1 * Math.floor((IF_FREQ * (1 << 22)) / xtalFreq);
      await com.writeEach([
        [CMD.DEMODREG, 1, 0xb1, 0x1a, 1],
        [CMD.DEMODREG, 0, 0x08, 0x4d, 1],
        [CMD.DEMODREG, 1, 0x19, (multiplier >> 16) & 0x3f, 1],
        [CMD.DEMODREG, 1, 0x1a, (multiplier >> 8) & 0xff, 1],
        [CMD.DEMODREG, 1, 0x1b, multiplier & 0xff, 1],
        [CMD.DEMODREG, 1, 0x15, 0x01, 1],
      ]);
    }
    await tuner.init();
    await setGain(opt_gain);
    await com.i2c.close();
  }

  /**
   * Sets the requested gain.
   * @param {number|null|undefined} gain The gain in dB, or null/undefined
   *     for automatic gain.
   */
  async function setGain(gain) {
    if (gain == null) {
      await tuner.setAutoGain();
    } else {
      await tuner.setManualGain(gain);
    }
  }

  /**
   * Set the sample rate.
   * @param {number} rate The sample rate, in samples/sec.
   * @returns {number} The sample rate that was actually set as its first parameter.
   */
  async function setSampleRate(rate) {
    var ratio = Math.floor((XTAL_FREQ * (1 << 22)) / rate);
    ratio &= 0x0ffffffc;
    var realRate = Math.floor((XTAL_FREQ * (1 << 22)) / ratio);
    var ppmOffset = -1 * Math.floor((ppm * (1 << 24)) / 1000000);
    await com.writeEach([
      [CMD.DEMODREG, 1, 0x9f, (ratio >> 16) & 0xffff, 2],
      [CMD.DEMODREG, 1, 0xa1, ratio & 0xffff, 2],
      [CMD.DEMODREG, 1, 0x3e, (ppmOffset >> 8) & 0x3f, 1],
      [CMD.DEMODREG, 1, 0x3f, ppmOffset & 0xff, 1],
    ]);
    await resetDemodulator();
    return realRate;
  }

  /**
   * Resets the demodulator.
   */
  async function resetDemodulator() {
    await com.writeEach([
      [CMD.DEMODREG, 1, 0x01, 0x14, 1],
      [CMD.DEMODREG, 1, 0x01, 0x10, 1],
    ]);
  }

  /**
   * Tunes the device to the given frequency.
   * @param {number} freq The frequency to tune to, in Hertz.
   * @returns {number} The actual tuned frequency.
   */
  async function setCenterFrequency(freq) {
    await com.i2c.open();
    var ifFreq = tunerType === 'FC0012' ? 0 : IF_FREQ;
    var actualFreq = await tuner.setFrequency(freq + ifFreq);
    await com.i2c.close();
    return actualFreq - ifFreq;
  }

  /**
   * Resets the sample buffer. Call this before starting to read samples.
   */
  async function resetBuffer() {
    await com.writeEach([
      [CMD.REG, BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
      [CMD.REG, BLOCK.USB, REG.EPA_CTL, 0x0000, 2],
    ]);
  }

  /**
   * Reads a block of samples off the device.
   * @param {number} length The number of samples to read.
   * @returns {ArrayBuffer} An ArrayBuffer containing the read samples, which you
   *     can interpret as pairs of unsigned 8-bit integers; the first one is
   *     the sample's I value, and the second one is its Q value.
   */
  async function readSamples(length) {
    return await com.bulk.readBuffer(length * BYTES_PER_SAMPLE);
  }

  /**
   * Stops the demodulator.
   */
  async function close() {
    await com.i2c.open();
    await tuner.close();
    await com.i2c.close();
    await com.iface.release();
  }

  return {
    open: open,
    getTunerType: () => tunerType,
    setGain: async function (gain) {
      await com.i2c.open();
      try {
        await setGain(gain);
      } finally {
        await com.i2c.close();
      }
    },
    setSampleRate: setSampleRate,
    setCenterFrequency: setCenterFrequency,
    resetBuffer: resetBuffer,
    readSamples: readSamples,
    close: close,
  };
}
