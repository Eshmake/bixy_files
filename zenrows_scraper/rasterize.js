// rasterize.js
// Usage: node rasterize.js input_path output.png
// Requires: npm i sharp

const fs = require('fs');
const sharp = require('sharp');

(async () => {
  const inPath = process.argv[2];
  const outPath = process.argv[3];

  if (!inPath || !outPath) {
    console.error('Usage: node rasterize.js input_path output.png');
    process.exit(2);
  }
  if (!fs.existsSync(inPath)) {
    console.error(`Input not found: ${inPath}`);
    process.exit(2);
  }

  try {
    // sharp can rasterize many formats; SVG support depends on build.
    await sharp(inPath).png().toFile(outPath);
    process.stdout.write(outPath);
  } catch (e) {
    console.error(String(e && e.stack ? e.stack : e));
    process.exit(1);
  }
})();
