#!/bin/sh
# Fake bark-sidecar for the rhema-stt integration test.
#
# Speaks the sidecar protocol without loading a model: prints "ready", then
# one canned "result" per audio frame read from stdin, and exits on the
# zero-length shutdown frame or EOF. Logs go to stderr like the real sidecar.
# CLI arguments (--model-dir and friends) are accepted and ignored.
exec python3 -I -c '
import json
import struct
import sys

out = sys.stdout
err = sys.stderr


def emit(obj):
    out.write(json.dumps(obj) + "\n")
    out.flush()


err.write("fake sidecar: args %s\n" % " ".join(sys.argv[1:]))
err.flush()
emit({"type": "ready", "load_ms": 1})
# An unknown line type; the provider must ignore it.
emit({"type": "progress", "percent": 100})

stdin = sys.stdin.buffer
while True:
    header = stdin.read(8)
    if len(header) < 8:
        break
    seg_id, n = struct.unpack("<II", header)
    if n == 0:
        break
    payload = stdin.read(n * 4)
    if len(payload) < n * 4:
        emit({"type": "error", "id": seg_id, "message": "truncated frame"})
        break
    samples = struct.unpack("<%df" % n, payload)
    peak = max(abs(s) for s in samples)
    if peak > 1.0 or peak == 0.0:
        emit({"type": "error", "id": seg_id, "message": "bad audio (peak %f)" % peak})
        continue
    emit({
        "type": "result",
        "id": seg_id,
        "text": "John three sixteen",
        "confidence": 0.95,
        "elapsed_ms": 7,
        "tokens": [
            {"text": "John", "start": 0.1, "end": 0.3, "confidence": 0.97},
            {"text": "three", "start": 0.35, "end": 0.5, "confidence": 0.94},
            {"text": "sixteen", "start": 0.55, "end": 0.9, "confidence": 0.94},
        ],
    })

err.write("fake sidecar: shutting down\n")
err.flush()
' -- "$@"
