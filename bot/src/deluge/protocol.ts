import zlib from "node:zlib";

const CHR_LIST = "l";
const CHR_DICT = "d";
const CHR_INT = "i";
const CHR_INT1 = Buffer.from([0x39]);
const CHR_INT2 = Buffer.from([0x3a]);
const CHR_INT4 = Buffer.from([0x3b]);
const CHR_INT8 = Buffer.from([0x3c]);
const CHR_FLOAT32 = Buffer.from([0x42]);
const CHR_FLOAT64 = Buffer.from([0x43]);
const CHR_TRUE = Buffer.from([0x03]);
const CHR_FALSE = Buffer.from([0x02]);
const CHR_NONE = Buffer.from([0x01]);
const CHR_TERM = "e";

const INT_POS_FIXED_START = 0;
const INT_POS_FIXED_COUNT = 44;
const INT_NEG_FIXED_START = 70;
const INT_NEG_FIXED_COUNT = 32;
const STR_FIXED_START = 128;
const STR_FIXED_COUNT = 64;
const LIST_FIXED_START = 192;
const LIST_FIXED_COUNT = 64;

class DecodeError extends Error {}

class Decoder {
  private data: Buffer;
  private pos: number;

  constructor(data: Buffer) {
    this.data = data;
    this.pos = 0;
  }

  decode(): any {
    if (this.pos >= this.data.length) {
      throw new DecodeError("Unexpected end of data");
    }

    const typeByte = this.data[this.pos];

    if (typeByte === CHR_NONE[0]) {
      this.pos++;
      return null;
    }
    if (typeByte === CHR_TRUE[0]) {
      this.pos++;
      return true;
    }
    if (typeByte === CHR_FALSE[0]) {
      this.pos++;
      return false;
    }

    if (typeByte >= INT_POS_FIXED_START && typeByte < INT_POS_FIXED_START + INT_POS_FIXED_COUNT) {
      this.pos++;
      return typeByte - INT_POS_FIXED_START;
    }

    if (typeByte >= INT_NEG_FIXED_START && typeByte < INT_NEG_FIXED_START + INT_NEG_FIXED_COUNT) {
      this.pos++;
      return -(typeByte - INT_NEG_FIXED_START + 1);
    }

    if (typeByte === CHR_INT1[0]) {
      this.pos++;
      const val = this.data.readInt8(this.pos);
      this.pos += 1;
      return val;
    }
    if (typeByte === CHR_INT2[0]) {
      this.pos++;
      const val = this.data.readInt16BE(this.pos);
      this.pos += 2;
      return val;
    }
    if (typeByte === CHR_INT4[0]) {
      this.pos++;
      const val = this.data.readInt32BE(this.pos);
      this.pos += 4;
      return val;
    }
    if (typeByte === CHR_INT8[0]) {
      this.pos++;
      const val = Number(this.data.readBigInt64BE(this.pos));
      this.pos += 8;
      return val;
    }

    if (typeByte === CHR_FLOAT32[0]) {
      this.pos++;
      const val = this.data.readFloatBE(this.pos);
      this.pos += 4;
      return val;
    }
    if (typeByte === CHR_FLOAT64[0]) {
      this.pos++;
      const val = this.data.readDoubleBE(this.pos);
      this.pos += 8;
      return val;
    }

    if (typeByte === CHR_INT.charCodeAt(0)) {
      this.pos++;
      const end = this.data.indexOf(CHR_TERM.charCodeAt(0), this.pos);
      if (end === -1) throw new DecodeError("Unterminated integer");
      const val = parseInt(this.data.subarray(this.pos, end).toString(), 10);
      this.pos = end + 1;
      return val;
    }

    if (typeByte >= STR_FIXED_START && typeByte < STR_FIXED_START + STR_FIXED_COUNT) {
      const len = typeByte - STR_FIXED_START;
      this.pos++;
      const str = this.data.subarray(this.pos, this.pos + len);
      this.pos += len;
      return str.toString("utf-8");
    }

    if (typeByte >= 0x30 && typeByte <= 0x39) {
      const colon = this.data.indexOf(0x3a, this.pos);
      if (colon === -1) throw new DecodeError("Unterminated string length");
      const len = parseInt(this.data.subarray(this.pos, colon).toString(), 10);
      this.pos = colon + 1;
      const str = this.data.subarray(this.pos, this.pos + len);
      this.pos += len;
      try {
        return str.toString("utf-8");
      } catch {
        return str;
      }
    }

    if (typeByte === CHR_LIST.charCodeAt(0)) {
      this.pos++;
      const list: any[] = [];
      while (this.data[this.pos] !== CHR_TERM.charCodeAt(0)) {
        list.push(this.decode());
      }
      this.pos++;
      return list;
    }

    if (typeByte >= LIST_FIXED_START && typeByte < LIST_FIXED_START + LIST_FIXED_COUNT) {
      const count = typeByte - LIST_FIXED_START;
      this.pos++;
      const list: any[] = [];
      for (let i = 0; i < count; i++) {
        list.push(this.decode());
      }
      return list;
    }

    if (typeByte === CHR_DICT.charCodeAt(0)) {
      this.pos++;
      const dict: Record<string, any> = {};
      while (this.data[this.pos] !== CHR_TERM.charCodeAt(0)) {
        const key = this.decode();
        const val = this.decode();
        dict[String(key)] = val;
      }
      this.pos++;
      return dict;
    }

    throw new DecodeError(`Unknown type byte: 0x${typeByte.toString(16)} at pos ${this.pos}`);
  }
}

function encodeValue(value: any): Buffer {
  if (value === null || value === undefined) {
    return CHR_NONE;
  }
  if (value === true) return CHR_TRUE;
  if (value === false) return CHR_FALSE;

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      if (value >= 0 && value < INT_POS_FIXED_COUNT) {
        return Buffer.from([INT_POS_FIXED_START + value]);
      }
      if (value < 0 && value >= -INT_NEG_FIXED_COUNT) {
        return Buffer.from([INT_NEG_FIXED_START - value - 1]);
      }
      if (value >= -128 && value < 128) {
        const buf = Buffer.alloc(2);
        buf[0] = CHR_INT1[0];
        buf.writeInt8(value, 1);
        return buf;
      }
      if (value >= -32768 && value < 32768) {
        const buf = Buffer.alloc(3);
        buf[0] = CHR_INT2[0];
        buf.writeInt16BE(value, 1);
        return buf;
      }
      if (value >= -2147483648 && value < 2147483648) {
        const buf = Buffer.alloc(5);
        buf[0] = CHR_INT4[0];
        buf.writeInt32BE(value, 1);
        return buf;
      }
      const buf = Buffer.alloc(9);
      buf[0] = CHR_INT8[0];
      buf.writeBigInt64BE(BigInt(value), 1);
      return buf;
    }
    const buf = Buffer.alloc(9);
    buf[0] = CHR_FLOAT64[0];
    buf.writeDoubleBE(value, 1);
    return buf;
  }

  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const strBuf = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
    if (strBuf.length < STR_FIXED_COUNT) {
      return Buffer.concat([Buffer.from([STR_FIXED_START + strBuf.length]), strBuf]);
    }
    const lenStr = Buffer.from(`${strBuf.length}:`);
    return Buffer.concat([lenStr, strBuf]);
  }

  if (Array.isArray(value)) {
    const parts = value.map(encodeValue);
    if (value.length < LIST_FIXED_COUNT) {
      return Buffer.concat([Buffer.from([LIST_FIXED_START + value.length]), ...parts]);
    }
    return Buffer.concat([
      Buffer.from(CHR_LIST),
      ...parts,
      Buffer.from(CHR_TERM),
    ]);
  }

  if (typeof value === "object") {
    const parts: Buffer[] = [Buffer.from(CHR_DICT)];
    for (const [k, v] of Object.entries(value)) {
      parts.push(encodeValue(k));
      parts.push(encodeValue(v));
    }
    parts.push(Buffer.from(CHR_TERM));
    return Buffer.concat(parts);
  }

  throw new Error(`Cannot encode type: ${typeof value}`);
}

export function rencodeEncode(data: any): Buffer {
  return encodeValue(data);
}

export function rencodeDecode(data: Buffer): any {
  const decoder = new Decoder(data);
  return decoder.decode();
}

export function compressFrame(data: Buffer): Buffer {
  return zlib.deflateSync(data);
}

export function decompressFrame(data: Buffer): Buffer {
  return zlib.inflateSync(data);
}
