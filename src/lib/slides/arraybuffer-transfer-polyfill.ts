/**
 * Polyfill for ArrayBuffer.prototype.transfer / transferToFixedLength
 * (ES2024) — missing from WKWebView on macOS 14 (Safari 17.0 engine).
 *
 * pdf.js v6 calls transferToFixedLength while building page operator
 * lists; without it the parse throws mid-stream, pdf.js "ignores" the
 * error by truncating the page's remaining drawing ops, and every run of
 * TEXT silently vanishes while backgrounds/images render. (Its "legacy"
 * build transpiles syntax, not this API.)
 *
 * Semantics note: the real API detaches the source buffer. This polyfill
 * returns a copy without detaching — indistinguishable for pdf.js's usage
 * (the source is discarded afterwards), and detaching is impossible to
 * emulate without the native API.
 */

type TransferFn = (this: ArrayBuffer, newByteLength?: number) => ArrayBuffer

function copyTo(source: ArrayBuffer, newByteLength?: number): ArrayBuffer {
  const length = newByteLength ?? source.byteLength
  const target = new ArrayBuffer(length)
  new Uint8Array(target).set(
    new Uint8Array(source, 0, Math.min(length, source.byteLength))
  )
  return target
}

const proto = ArrayBuffer.prototype as ArrayBuffer["constructor"]["prototype"] & {
  transfer?: TransferFn
  transferToFixedLength?: TransferFn
}

if (typeof proto.transferToFixedLength !== "function") {
  proto.transferToFixedLength = function (newByteLength?: number) {
    return copyTo(this, newByteLength)
  }
}

if (typeof proto.transfer !== "function") {
  proto.transfer = function (newByteLength?: number) {
    return copyTo(this, newByteLength)
  }
}
