// 一次性脚本:生成扩展图标到 stdout(纯 Node,无依赖)。
// 由外部写入 assets/icon{16,48,128}.png;也可运行后重定向。
// node tools/gen-icons.js > /dev/null 不适用 Windows,故本脚本仅作存档。
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22, lw = size * 0.09;
  const segs = [
    [[0.34,0.30],[0.22,0.5]], [[0.22,0.5],[0.34,0.70]],
    [[0.66,0.30],[0.78,0.5]], [[0.78,0.5],[0.66,0.70]],
  ];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let px;
      const rx = Math.min(x, size-1-x), ry = Math.min(y, size-1-y);
      if (rx < r && ry < r && (r-rx)*(r-rx)+(r-ry)*(r-ry) > r*r) px = [0,0,0,0];
      else {
        let on = false;
        for (const [[x1,y1],[x2,y2]] of segs) {
          const ax=x1*size, ay=y1*size, bx=x2*size, by=y2*size;
          const vx=bx-ax, vy=by-ay;
          const t=Math.max(0,Math.min(1,((x-ax)*vx+(y-ay)*vy)/(vx*vx+vy*vy)));
          if (Math.hypot(x-(ax+t*vx), y-(ay+t*vy)) <= lw/2) { on=true; break; }
        }
        px = on ? [255,255,255,255] : [37,99,235,255];
      }
      const o = row + 1 + x*4;
      raw[o]=px[0]; raw[o+1]=px[1]; raw[o+2]=px[2]; raw[o+3]=px[3];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

module.exports = { makePng };

if (require.main === module) {
  const fs = require("fs"), path = require("path");
  const out = path.join(__dirname, "..", "assets");
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  for (const s of [16,48,128]) {
    fs.writeFileSync(path.join(out, `icon${s}.png`), makePng(s));
    console.log(`assets/icon${s}.png`);
  }
}
