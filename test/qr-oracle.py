"""Ground truth for the JS QR encoder: block tables + module matrices from the
Python `qrcode` package (8.2).

Usage (from the plugin directory):
    python test/qr-oracle.py test/qr-oracle.json

`qrcode` must be importable (pip install qrcode, or point PYTHONPATH at an
unpacked wheel such as ../../pylib in the original workspace).

The JS encoder is written to be byte-for-byte compatible with the reference
implementation for byte-mode, ECC level M: same version, same mask, same
matrix. Any divergence shows up as a matrix mismatch in test/qr.test.mjs.
"""
import json
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
for _candidate in (os.path.join(_here, "..", "..", "pylib"),):
    if os.path.isdir(_candidate):
        sys.path.insert(0, _candidate)

import qrcode  # noqa: E402
from qrcode import base, constants, util  # noqa: E402

VERSIONS = list(range(1, 21))
ECC = constants.ERROR_CORRECT_M


def new_qr(text):
    qr = qrcode.QRCode(error_correction=ECC, border=0)
    qr.add_data(util.QRData(text.encode("utf-8"), mode=util.MODE_8BIT_BYTE))
    return qr


tables = {}
for v in VERSIONS:
    blocks = base.rs_blocks(v, ECC)
    tables[str(v)] = [[b.total_count, b.data_count] for b in blocks]

samples = []
strings = [
    "a",
    "https://www.bilibili.com",
    "https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=0123456789abcdef",
    "https://account.bilibili.com/h5-app/passport/login/scan?navhide=1&from=" + "x" * 40,
    "https://account.bilibili.com/h5-app/passport/login/scan?navhide=1&from=" + "y" * 120,
    "z" * 300,
    "https://www.bilibili.com/video/BV1NGZtBwELa?p=1&vd_source=ae71e2a1b7c2",
]
for text in strings:
    probe = new_qr(text)
    probe.make(fit=True)
    version = probe.version

    masks = []
    for mask in range(8):
        qr = new_qr(text)
        qr.version = version
        qr.modules_count = version * 4 + 17
        qr.modules = [[None] * qr.modules_count for _ in range(qr.modules_count)]
        qr.makeImpl(False, mask)
        masks.append(
            ["".join("1" if c else "0" for c in row) for row in qr.modules]
        )

    samples.append(
        {
            "text": text,
            "version": version,
            "masks": masks,
        }
    )

payload = json.dumps({"tables": tables, "samples": samples}, ensure_ascii=False)
out_path = sys.argv[1] if len(sys.argv) > 1 else None
if out_path:
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(payload)
    print(f"qr-oracle: {len(samples)} samples -> {out_path}")
else:
    print(payload)
