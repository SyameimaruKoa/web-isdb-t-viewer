import test from 'node:test';
import assert from 'node:assert/strict';
import FC0012, { FC0012_GAINS } from '../src/radio/fc0012.js';
import { detectTuner } from '../src/radio/rtl2823u.js';

function mockCom(chipId = 0xa1) {
    const writes = [];
    const pins = [];
    const registers = new Map([[0x00, chipId], [0x0e, 0x20], [0x13, 0x00]]);
    return {
        writes,
        pins,
        i2c: {
            readRegister: async (address, register) => {
                assert.equal(address, 0xc6);
                return registers.get(register) ?? 0;
            },
            writeRegister: async (address, register, value) => {
                assert.equal(address, 0xc6);
                assert.ok(value >= 0 && value <= 255);
                writes.push([register, value]);
                if (register !== 0x0e) registers.set(register, value);
            },
        },
        gpio: {
            setBit: async (pin, high) => pins.push([pin, high]),
        },
    };
}

test('FC0012 chip identification uses address 0xc6 and ID 0xa1', async () => {
    assert.equal(await FC0012.check(mockCom()), true);
    assert.equal(await FC0012.check(mockCom(0x00)), false);
});

test('FC0012 initialization programs its chip registers', async () => {
    const com = mockCom();
    const tuner = new FC0012(com, 28800000);
    await tuner.init();
    assert.equal(com.writes.length, 21);
    assert.deepEqual(com.writes[0], [1, 0x05]);
    assert.deepEqual(com.writes.at(-1), [0x15, 0x04]);
});

test('FC0012 UHF tuning programs 6 MHz bandwidth and GPIO6', async () => {
    const com = mockCom();
    const tuner = new FC0012(com, 28800000);
    const frequency = 473142857;
    assert.equal(await tuner.setFrequency(frequency), frequency);
    assert.deepEqual(com.pins, [[6, true]]);
    const written = Object.fromEntries(com.writes.filter(([register]) => register >= 1 && register <= 6));
    assert.equal(written[6] & 0xc0, 0x80);
    assert.ok(com.writes.some(([register, value]) => register === 0x0e && value === 0x80));
    assert.ok(com.writes.some(([register, value]) => register === 0x0e && value === 0x00));
});

test('FC0012 gain controls handle all 5 device-supported gains', async () => {
    const com = mockCom();
    const tuner = new FC0012(com, 28800000);
    assert.deepEqual(FC0012_GAINS, [-9.9, -4.0, 7.1, 17.9, 19.2]);
    for (const gain of FC0012_GAINS) await tuner.setManualGain(gain);
    const values = com.writes.filter(([register]) => register === 0x13).map(([, value]) => value);
    assert.deepEqual(values, [0x02, 0x00, 0x08, 0x17, 0x10]);
    await tuner.setAutoGain();
    assert.deepEqual(com.writes.slice(-2), [[0x0d, 0x02], [0x13, 0x00]]);
});

test('FC0012 detection retries after the upstream GPIO4 tuner-reset sequence', async () => {
    let reads = 0;
    const pins = [];
    const com = {
        i2c: {
            readRegister: async (addr, reg) => {
                assert.equal(addr, 0xc6);
                assert.equal(reg, 0);
                return ++reads === 1 ? 0xff : 0xa1;
            },
        },
        gpio: {
            setOutput: async (pin) => pins.push(['output', pin]),
            setBit: async (pin, level) => pins.push(['bit', pin, level]),
        },
    };
    const detected = await detectTuner(com);
    assert.equal(detected.type, 'FC0012');
    assert.equal(reads, 2);
    assert.deepEqual(pins, [['output', 4], ['bit', 4, true], ['bit', 4, false]]);
    assert.equal(detected.attempts[0].chipId, '0xff');
    assert.equal(detected.attempts[2].chipId, '0xa1');
});

test('FC0012 first-pass detection does not reset a healthy tuner', async () => {
    const pins = [];
    const com = {
        i2c: { readRegister: async () => 0xa1 },
        gpio: { setOutput: async (pin) => pins.push(pin) },
    };
    const detected = await detectTuner(com);
    assert.equal(detected.type, 'FC0012');
    assert.deepEqual(pins, []);
    assert.equal(detected.attempts.length, 1);
});

test('tuner failures preserve I2C and reset diagnostics', async () => {
    const com = {
        i2c: { readRegister: async () => { throw new Error('USB I2C stalled'); } },
        gpio: {
            setOutput: async () => {},
            setBit: async () => { throw new Error('GPIO unavailable'); },
        },
    };
    const detected = await detectTuner(com);
    assert.equal(detected.type, null);
    assert.match(detected.attempts[0].error, /USB I2C stalled/);
    assert.match(detected.attempts[1].error, /GPIO unavailable/);
    assert.match(detected.attempts[2].error, /USB I2C stalled/);
});
