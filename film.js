const Film = (() => {
  const MAX_SIDE = 2000;

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function decode(blob) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(blob); } catch (e) {}
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function buildLuts() {
    const black = [0.075, 0.06, 0.07];
    const white = [0.985, 0.95, 0.85];
    const gamma = [0.9, 0.97, 1.1];
    return [0, 1, 2].map((c) => {
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        let v = i / 255;
        v = v * 0.65 + v * v * (3 - 2 * v) * 0.35;
        v = Math.pow(v, gamma[c]);
        v = black[c] + v * (white[c] - black[c]);
        lut[i] = Math.round(v * 255);
      }
      return lut;
    });
  }
  const LUTS = buildLuts();

  function grade(ctx, w, h, rand) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const [lr, lg, lb] = LUTS;
    const cx = w / 2, cy = h / 2;
    const maxR2 = cx * cx + cy * cy;
    const vigStrength = 0.42 + rand() * 0.15;
    const grainAmt = 15 + rand() * 6;
    const sat = 0.86;
    let s = (rand() * 4294967295) >>> 0 || 7;
    for (let y = 0; y < h; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        let r = lr[d[p]], g = lg[d[p + 1]], b = lb[d[p + 2]];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
        const dx = x - cx;
        const t = (dx * dx + dy2) / maxR2;
        const vig = 1 - vigStrength * (t * 0.3 + t * t * 0.7);
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const n1 = (s >>> 0) / 4294967296;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const n2 = (s >>> 0) / 4294967296;
        const mid = 1 - Math.abs(l / 127.5 - 1) * 0.55;
        const grain = (n1 + n2 - 1) * grainAmt * mid;
        d[p] = r * vig + grain;
        d[p + 1] = g * vig + grain;
        d[p + 2] = b * vig + grain * 0.9;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function lightLeak(ctx, w, h, rand) {
    const side = Math.floor(rand() * 4);
    const big = Math.max(w, h);
    const colors = [
      ['rgba(255,90,20,0.85)', 'rgba(255,40,0,0.35)'],
      ['rgba(255,150,40,0.8)', 'rgba(255,70,20,0.3)'],
      ['rgba(255,60,60,0.75)', 'rgba(255,140,0,0.3)']
    ][Math.floor(rand() * 3)];
    let x, y;
    if (side === 0) { x = 0; y = rand() * h; }
    else if (side === 1) { x = w; y = rand() * h; }
    else if (side === 2) { x = rand() * w; y = 0; }
    else { x = rand() * w; y = h; }
    const radius = big * (0.35 + rand() * 0.45);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, colors[0]);
    g.addColorStop(0.45, colors[1]);
    g.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (rand() < 0.5) {
      const vertical = side < 2;
      const pos = (vertical ? w : h) * (side === 0 || side === 2 ? 0.02 + rand() * 0.12 : 0.86 + rand() * 0.12);
      const band = (vertical ? w : h) * (0.05 + rand() * 0.08);
      const lg = vertical
        ? ctx.createLinearGradient(pos - band, 0, pos + band, 0)
        : ctx.createLinearGradient(0, pos - band, 0, pos + band);
      lg.addColorStop(0, 'rgba(255,120,30,0)');
      lg.addColorStop(0.5, 'rgba(255,170,80,0.55)');
      lg.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  function dateStamp(ctx, w, h, takenAt) {
    const dt = new Date(takenAt);
    const yy = String(dt.getFullYear()).slice(-2);
    const mm = String(dt.getMonth() + 1);
    const dd = String(dt.getDate());
    const text = `'${yy} ${mm} ${dd}`;
    const size = Math.round(Math.min(w, h) * 0.05);
    ctx.save();
    ctx.font = `bold ${size}px "Courier New", ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const x = w - size * 1.4;
    const y = h - size * 1.2;
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = 'rgba(255,110,20,0.9)';
    ctx.shadowBlur = size * 0.5;
    ctx.fillStyle = 'rgba(255,128,32,0.95)';
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,160,80,0.3)';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function toBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/jpeg', quality);
    });
  }

  async function develop(rawBlob, opts) {
    const src = await decode(rawBlob);
    const sw = src.width, sh = src.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const rand = rng(opts.seed);

    const soft = document.createElement('canvas');
    soft.width = Math.round(w * 0.72);
    soft.height = Math.round(h * 0.72);
    const sctx = soft.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, soft.width, soft.height);
    if (src.close) src.close();

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(soft, 0, 0, w, h);
    soft.width = soft.height = 0;

    grade(ctx, w, h, rand);
    if (rand() < 0.3) lightLeak(ctx, w, h, rand);
    if (opts.dateStamp) dateStamp(ctx, w, h, opts.takenAt);

    const blob = await toBlob(canvas, 0.9);
    canvas.width = canvas.height = 0;
    return blob;
  }

  return { develop };
})();
