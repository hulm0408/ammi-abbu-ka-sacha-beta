// builds a review contact-sheet from rendered PNGs: node montage.js out1.png out2.png ... -> /home/user/mockups/out/_review.png
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const OUT = process.env.OUT_DIR || path.join(__dirname, '..', 'images');

(async () => {
  const files = process.argv.slice(2);
  const cols = Math.min(4, files.length);
  const cw = 270, ch = 585, pad = 14, labelH = 26;
  const rows = Math.ceil(files.length / cols);
  const W = cols * (cw + pad) + pad;
  const Hh = rows * (ch + labelH + pad) + pad;
  const c = createCanvas(W * 2, Hh * 2);
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.fillStyle = '#0b1017';
  g.fillRect(0, 0, W, Hh);
  g.font = '700 13px TG-B';
  for (let i = 0; i < files.length; i++) {
    const x = pad + (i % cols) * (cw + pad);
    const y = pad + Math.floor(i / cols) * (ch + labelH + pad);
    const img = await loadImage(fs.readFileSync(path.join(OUT, files[i])));
    g.drawImage(img, x, y, cw, ch);
    g.fillStyle = '#8fa2b5';
    g.font = '400 11px TG';
    g.fillText(files[i].replace('.png', ''), x, y + ch + 15);
  }
  fs.writeFileSync(process.env.OUT || path.join(OUT, '_review.png'), c.toBuffer('image/png'));
  console.log('review sheet written', files.length);
})();
