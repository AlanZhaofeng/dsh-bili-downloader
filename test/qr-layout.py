"""Dump the QR function-module layout (before data mapping) for one version.

Used only for debugging the JS encoder against the reference implementation:
    python test/qr-layout.py 7
prints `free=<count>` then a grid of '#' (function module) / '.' (data module).
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "pylib")))

import qrcode  # noqa: E402
from qrcode import constants  # noqa: E402

version = int(sys.argv[1]) if len(sys.argv) > 1 else 7
count = version * 4 + 17

qr = qrcode.QRCode(version=version, error_correction=constants.ERROR_CORRECT_M, border=0)
qr.modules_count = count
qr.modules = [[None] * count for _ in range(count)]
qr.setup_position_probe_pattern(0, 0)
qr.setup_position_probe_pattern(count - 7, 0)
qr.setup_position_probe_pattern(0, count - 7)
qr.setup_position_adjust_pattern()
qr.setup_timing_pattern()
qr.setup_type_number(False)
qr.setup_type_info(False, 0)

free = sum(1 for row in qr.modules for cell in row if cell is None)
print(f"free={free}")
for row in qr.modules:
    print("".join("." if cell is None else "#" for cell in row))

