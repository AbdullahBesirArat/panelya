const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['node_modules', 'uploads']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

const files = walk(root);
let failed = false;

for (const file of files) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    new vm.Script(source, { filename: file });
  } catch (err) {
    failed = true;
    process.stderr.write(`${file}: ${err.message}\n`);
  }
}

if (failed) process.exit(1);
console.log(`Syntax check basarili: ${files.length} JS dosyasi kontrol edildi.`);
