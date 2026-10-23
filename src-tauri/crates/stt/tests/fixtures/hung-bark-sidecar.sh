#!/bin/sh
# Fake bark-sidecar that reports ready and then hangs: it never answers a
# segment and never reads stdin, like a Core ML call that is stuck. The
# provider must still honor stop() promptly and kill it.
# CLI arguments (--model-dir and friends) are accepted and ignored.
printf '%s\n' '{"type":"ready","load_ms":1}'
exec sleep 600
