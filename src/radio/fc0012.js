// SPDX-License-Identifier: GPL-3.0-or-later
// FC0012 tuner support for the RTL2832U WebUSB receiver.
// Based on Fitipower FC0012 routines by Hans-Frieder Vogt (2012),
// adapted to librtlsdr by Steve Markgraf (2012).
// References: https://github.com/osmocom/rtl-sdr/blob/master/src/tuner_fc0012.c
//             https://github.com/osmocom/rtl-sdr/blob/master/src/librtlsdr.c

export const FC0012_I2C_ADDRESS = 0xc6;
export const FC0012_CHIP_ID = 0xa1;
const I2C_ADDRESS = FC0012_I2C_ADDRESS;
const IDENTIFICATION = FC0012_CHIP_ID;

export const FC0012_GAINS = [-9.9, -4.0, 7.1, 17.9, 19.2];

const PLL_DIVIDERS = [
    [37084000, 96, 0x82, 0x00],
    [55625000, 64, 0x82, 0x02],
    [74167000, 48, 0x42, 0x00],
    [111250000, 32, 0x42, 0x02],
    [148334000, 24, 0x22, 0x00],
    [222500000, 16, 0x22, 0x02],
    [296667000, 12, 0x12, 0x00],
    [445000000, 8, 0x12, 0x02],
    [593334000, 6, 0x0a, 0x00],
    [Infinity, 4, 0x0a, 0x02],
];

export default function FC0012(com, crystalHz) {
    const write = (register, value) => com.i2c.writeRegister(I2C_ADDRESS, register, value);
    const read = (register) => com.i2c.readRegister(I2C_ADDRESS, register);

    async function init() {
        // Values indexed by FC0012 register address; register 0x00 is read-only.
        const defaults = [
            0x00, 0x05, 0x10, 0x00, 0x00, 0x0f, 0x00, 0x20,
            0xff, 0x6e, 0xb8, 0x82, 0xfe, 0x02, 0x00, 0x00,
            0x00, 0x00, 0x1f, 0x00, 0x00, 0x04,
        ];
        for (let register = 1; register < defaults.length; register++) {
            await write(register, defaults[register]);
        }
    }

    async function setFrequency(frequencyHz) {
        if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
            throw new RangeError('FC0012 frequency must be positive and finite');
        }

        // GPIO6 switches between VHF and UHF input filtering.
        await com.gpio.setBit(6, frequencyHz > 300000000);

        const config = PLL_DIVIDERS.find(([limit]) => frequencyHz < limit);
        const [, multiplier, dividerA, dividerB] = config;
        const pllHz = frequencyHz * multiplier;
        const halfXtalHz = crystalHz / 2;
        const registers = new Uint8Array(7);
        registers[5] = dividerA;
        registers[6] = dividerB;

        const highVco = pllHz >= 3060000000;
        if (highVco) registers[6] |= 0x08;

        let xdiv = Math.floor(pllHz / halfXtalHz);
        if (pllHz - xdiv * halfXtalHz >= halfXtalHz / 2) xdiv++;

        let p = Math.floor(xdiv / 8);
        let a = xdiv % 8;
        if (a < 2) {
            a += 8;
            p--;
        }
        if (p > 31) {
            registers[1] = a + 8 * (p - 31);
            registers[2] = 31;
        } else {
            registers[1] = a;
            registers[2] = p;
        }
        if (registers[1] > 15 || registers[2] < 11) {
            throw new RangeError('FC0012 PLL divider not available for ' + frequencyHz + ' Hz');
        }

        // Program the 15-bit fractional-N divider and force 6 MHz bandwidth.
        registers[6] |= 0x20;
        const fractionHz = pllHz - Math.floor(pllHz / halfXtalHz) * halfXtalHz;
        let fraction = Math.floor(fractionHz / 1000);
        fraction = Math.floor(fraction * 32768 / (halfXtalHz / 1000));
        if (fraction >= 16384) fraction += 32768;
        registers[3] = fraction >>> 8;
        registers[4] = fraction & 0xff;
        registers[6] = (registers[6] & 0x3f) | 0x80;
        registers[5] |= 0x07;

        for (let register = 1; register <= 6; register++) {
            await write(register, registers[register]);
        }
        const calibrate = async () => {
            await write(0x0e, 0x80);
            await write(0x0e, 0x00);
        };
        await calibrate();
        await write(0x0e, 0x00);
        const voltage = (await read(0x0e)) & 0x3f;
        if ((highVco && voltage > 0x3c) || (!highVco && voltage < 0x02)) {
            registers[6] ^= 0x08;
            await write(0x06, registers[6]);
            await calibrate();
        }
        return frequencyHz;
    }

    async function setManualGain(gainDb) {
        const gainTenths = Math.round(gainDb * 10);
        let setting;
        if (gainTenths < -40) setting = 0x02;
        else if (gainTenths < 71) setting = 0x00;
        else if (gainTenths < 179) setting = 0x08;
        else if (gainTenths < 192) setting = 0x17;
        else setting = 0x10;
        const current = await read(0x13);
        await write(0x13, (current & 0xe0) | setting);
    }

    async function setAutoGain() {
        // FC0012 has no distinct software AGC-mode switch in librtlsdr.
        await write(0x0d, 0x02);
        await write(0x13, 0x00);
    }

    return {
        init,
        setFrequency,
        setManualGain,
        setAutoGain,
        close: async () => {},
    };
}

FC0012.check = async function (com) {
    return (await com.i2c.readRegister(I2C_ADDRESS, 0x00)) === IDENTIFICATION;
};
