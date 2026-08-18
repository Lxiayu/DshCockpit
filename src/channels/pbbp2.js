// src/channels/pbbp2.js — Feishu long-connection frame codec (C6).
//
// Feishu's WebSocket long-connection mode multiplexes events over a private
// protobuf framing ("pbbp2") instead of plain JSON. The wire schema is public
// through the official @larksuiteoapi/node-sdk (MIT) ws-client; this module
// re-implements encode/decode for the two messages we need with zero
// dependencies (plain protobuf wire format: varints + length-delimited
// fields — no packed/repeated-scalar trickery in this schema):
//
//   message Header { string key = 1; string value = 2; }
//   message Frame {
//     uint64 SeqID = 1;          // varint
//     uint64 LogID = 2;          // varint
//     int32  service = 3;        // varint (service_id from the endpoint URL)
//     int32  method = 4;         // varint (0 = control, 1 = data)
//     repeated Header headers = 5;
//     string payloadEncoding = 6;
//     string payloadType = 7;
//     bytes  payload = 8;
//     string LogIDNew = 9;
//   }
//
// Unknown fields are skipped per protobuf rules, so server-side additions
// degrade instead of breaking the connection.
'use strict';

// --------------------------------------------------------------- varint I/O

function writeVarint(out, value) {
  let v = Number(value) || 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

function writeBytes(out, bytes) {
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b & 0xff);
}

function writeString(out, s) {
  writeBytes(out, Array.from(Buffer.from(String(s), 'utf8')));
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= buf.length) throw new Error('pbbp2: truncated varint');
    const b = buf[pos.i++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return { value: result };
    shift += 7;
    if (shift > 63) throw new Error('pbbp2: varint too long');
  }
}

// ----------------------------------------------------------------- encoding

/**
 * @param {{SeqID?:number, LogID?:number, service?:number, method?:number,
 *          headers?:{key:string,value:string}[], payloadEncoding?:string,
 *          payloadType?:string, payload?:Uint8Array, LogIDNew?:string}} frame
 * @returns {Buffer}
 */
function encodeFrame(frame) {
  const out = [];
  const f = frame || {};
  if (f.SeqID) { out.push(0x08); writeVarint(out, f.SeqID); }          // 1 varint
  if (f.LogID) { out.push(0x10); writeVarint(out, f.LogID); }          // 2 varint
  if (f.service) { out.push(0x18); writeVarint(out, f.service); }      // 3 varint
  if (f.method) { out.push(0x20); writeVarint(out, f.method); }        // 4 varint
  if (Array.isArray(f.headers)) {
    for (const h of f.headers) {
      if (!h) continue;
      const inner = [];
      if (h.key !== undefined) { inner.push(0x0a); writeString(inner, h.key); }
      if (h.value !== undefined) { inner.push(0x12); writeString(inner, h.value); }
      out.push(0x2a); // 5, wireType 2
      writeBytes(out, inner);
    }
  }
  if (f.payloadEncoding) { out.push(0x32); writeString(out, f.payloadEncoding); } // 6
  if (f.payloadType) { out.push(0x3a); writeString(out, f.payloadType); }         // 7
  if (f.payload && f.payload.length) { out.push(0x42); writeBytes(out, Array.from(f.payload)); } // 8
  if (f.LogIDNew) { out.push(0x4a); writeString(out, f.LogIDNew); }               // 9
  return Buffer.from(out);
}

// ----------------------------------------------------------------- decoding

function decodeFrame(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: new Uint8Array(0) };
  const pos = { i: 0 };
  while (pos.i < bytes.length) {
    const tag = readVarint(bytes, pos).value;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === 0) {
      const value = readVarint(bytes, pos).value;
      if (fieldNo === 1) frame.SeqID = value;
      else if (fieldNo === 2) frame.LogID = value;
      else if (fieldNo === 3) frame.service = value;
      else if (fieldNo === 4) frame.method = value;
      // other varint fields (none today): skipped by reading the value above
    } else if (wireType === 2) {
      const len = readVarint(bytes, pos).value;
      if (pos.i + len > bytes.length) throw new Error('pbbp2: truncated length-delimited field');
      const slice = bytes.subarray(pos.i, pos.i + len);
      pos.i += len;
      if (fieldNo === 5) {
        frame.headers.push(decodeHeader(slice));
      } else if (fieldNo === 6) frame.payloadEncoding = slice.toString('utf8');
      else if (fieldNo === 7) frame.payloadType = slice.toString('utf8');
      else if (fieldNo === 8) frame.payload = new Uint8Array(slice);
      else if (fieldNo === 9) frame.LogIDNew = slice.toString('utf8');
      // unknown length-delimited fields: skipped
    } else {
      throw new Error(`pbbp2: unsupported wire type ${wireType}`);
    }
  }
  return frame;
}

function decodeHeader(buf) {
  const header = { key: '', value: '' };
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos).value;
    const fieldNo = Math.floor(tag / 8);
    if (tag % 8 !== 2) { readVarint(buf, pos); continue; }
    const len = readVarint(buf, pos).value;
    const slice = buf.subarray(pos.i, pos.i + len);
    pos.i += len;
    if (fieldNo === 1) header.key = slice.toString('utf8');
    else if (fieldNo === 2) header.value = slice.toString('utf8');
  }
  return header;
}

/** headers[] → {key: value} map (last write wins, mirroring the SDK). */
function headerMap(frame) {
  const map = {};
  for (const h of (frame && frame.headers) || []) map[h.key] = h.value;
  return map;
}

module.exports = { encodeFrame, decodeFrame, headerMap };
