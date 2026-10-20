# LT-DT306BK / Fitipower FC0012 support

This fork adds FC0012 I2C detection, GPIO6 VHF/UHF selection, tuner PLL tuning,
6 MHz RF filter selection, gain settings and RTL2832U zero-IF mode.
The pre-existing R820T path is preserved.

## Hardware
- Detected hardware: Generic RTL2832U with Fitipower FC0012 (`rtl_test`).
- Device reported gains: -9.9, -4.0, 7.1, 17.9, and 19.2 dB.
- Local mock tests cover identification, initialization, UHF tuning and gain mapping.
- Real LT-DT306BK WebUSB and ISDB-T reception testing has not yet been performed.
- Close SDR# and rtl_test before testing a browser connection.

## Licenses
FC0012 control logic is adapted from [osmocom/rtl-sdr](https://github.com/osmocom/rtl-sdr)
(FC0012 code by Hans-Frieder Vogt / Steve Markgraf, GPL-2.0-or-later).
The adapted driver is distributed under GPL-3.0-or-later; see
`LICENSES/GPL-3.0.txt`. Original Apache-2.0-licensed files retain their notices.
Combined redistributed builds must comply with applicable GPL-3.0 requirements.
