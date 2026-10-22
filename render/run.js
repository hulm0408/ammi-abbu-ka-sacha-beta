// Renders all scenario specs to PNGs in ../out
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const OUT = process.env.OUT_DIR || path.join(__dirname, '..', 'images');

(async () => {
  await L.preloadWallpaper();
  const groups = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(__dirname).filter((f) => /^scn_.*\.js$/.test(f)).map((f) => f.replace('.js', ''));
  let all = [];
  for (const g of groups) {
    const mod = require(path.join(__dirname, g.endsWith('.js') ? g : g + '.js'));
    all = all.concat(mod);
  }
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const jobs = all.filter((sc) => !only || only.includes(sc.file) || only.includes(sc.file.replace(/\.png$/, '')));
  let n = 0;
  const runOne = async (sc) => {
    try {
      await L.preloadAssets(sc.spec);
      const buf = await L.renderChat(sc.spec);
      fs.writeFileSync(path.join(OUT, sc.file), buf);
      n++;
      process.stdout.write('·');
    } catch (e) {
      console.error('\nFAIL', sc.file, e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n'));
    }
  };
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    })
  );
  console.log('\nrendered', n, '/', jobs.length);
})();
