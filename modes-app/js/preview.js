// Minimal top-down toolpath preview: parses G0/G1/G2/G3 with modal state,
// linearizes arcs, draws rapids dim and cuts bright, reports extents.

export function parseGcode(text) {
  const segs = [];   // {x0,y0,x1,y1,rapid}
  let x = 0, y = 0, z = 0, absolute = true, motion = null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;

  const track = (px, py) => {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };

  for (let raw of text.split('\n')) {
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!line) continue;
    const words = line.match(/[A-Z]-?\d*\.?\d+/g);
    if (!words) continue;
    let nx = null, ny = null, nz = null, i = 0, j = 0, hasIJ = false;
    for (const w of words) {
      const v = parseFloat(w.slice(1));
      switch (w[0]) {
        case 'G':
          if (v === 0 || v === 1 || v === 2 || v === 3) motion = v;
          else if (v === 90) absolute = true;
          else if (v === 91) absolute = false;
          break;
        case 'X': nx = v; break;
        case 'Y': ny = v; break;
        case 'Z': nz = v; break;
        case 'I': i = v; hasIJ = true; break;
        case 'J': j = v; hasIJ = true; break;
      }
    }
    if (motion === null || (nx === null && ny === null && nz === null)) continue;
    const tx = nx === null ? x : (absolute ? nx : x + nx);
    const ty = ny === null ? y : (absolute ? ny : y + ny);
    const tz = nz === null ? z : (absolute ? nz : z + nz);

    if ((motion === 2 || motion === 3) && hasIJ) {
      const cx = x + i, cy = y + j;
      const r = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx);
      let a1 = Math.atan2(ty - cy, tx - cx);
      if (motion === 2 && a1 >= a0) a1 -= 2 * Math.PI; // CW
      if (motion === 3 && a1 <= a0) a1 += 2 * Math.PI; // CCW
      const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * r / 0.5));
      let px = x, py = y;
      for (let s = 1; s <= steps; s++) {
        const a = a0 + (a1 - a0) * (s / steps);
        const qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a);
        segs.push({ x0: px, y0: py, x1: qx, y1: qy, rapid: false });
        track(qx, qy); px = qx; py = qy;
      }
    } else if (tx !== x || ty !== y) {
      segs.push({ x0: x, y0: y, x1: tx, y1: ty, rapid: motion === 0 });
      track(x, y); track(tx, ty);
    }
    if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
    x = tx; y = ty; z = tz;
  }
  return { segs, minX, minY, maxX, maxY, minZ, maxZ };
}

export function drawPreview(canvas, parsed, marker) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, PAD = 24;
  ctx.clearRect(0, 0, W, H);
  if (!parsed || !parsed.segs.length) {
    ctx.fillStyle = '#8696a5'; ctx.font = '14px monospace';
    ctx.fillText('no toolpath loaded', 20, 30);
    return;
  }
  const { minX, minY, maxX, maxY } = parsed;
  const sx = (W - 2 * PAD) / Math.max(1e-6, maxX - minX);
  const sy = (H - 2 * PAD) / Math.max(1e-6, maxY - minY);
  const s = Math.min(sx, sy);
  const tx = (px) => PAD + (px - minX) * s;
  const ty = (py) => H - PAD - (py - minY) * s; // Y up

  for (const g of parsed.segs) {
    ctx.strokeStyle = g.rapid ? '#2a3540' : '#4fb3ff';
    ctx.lineWidth = g.rapid ? 1 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tx(g.x0), ty(g.y0));
    ctx.lineTo(tx(g.x1), ty(g.y1));
    ctx.stroke();
  }
  // origin crosshair
  ctx.strokeStyle = '#e8b931'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx(0) - 8, ty(0)); ctx.lineTo(tx(0) + 8, ty(0));
  ctx.moveTo(tx(0), ty(0) - 8); ctx.lineTo(tx(0), ty(0) + 8);
  ctx.stroke();
  // live position marker (work coords)
  if (marker) {
    ctx.fillStyle = '#2fbf71';
    ctx.beginPath();
    ctx.arc(tx(marker.x), ty(marker.y), 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}
