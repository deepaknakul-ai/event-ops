const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const exts = ['.js', '.jsx', '.ts', '.tsx', '.css', '.html'];

const replacements = [
  { from: /dark:/g, to: '' },
  { from: /bg-slate-(700|800|900)/g, to: 'bg-slate-50' },
  { from: /text-white/g, to: 'text-slate-900' },
  { from: /dark:text-white/g, to: 'text-slate-900' },
  { from: /dark:text-slate-200/g, to: 'text-slate-700' },
  { from: /border-slate-(600|700)/g, to: 'border-slate-200' },
  { from: /placeholder-slate-5\d{1}/g, to: 'placeholder-slate-400' },
  { from: /divide-slate-700/g, to: 'divide-slate-100' },
  { from: /hover:bg-slate-600/g, to: 'hover:bg-slate-50' },
  { from: /dark:hover:bg-slate-600/g, to: 'hover:bg-slate-50' },
  { from: /dark:bg-slate-700/g, to: 'bg-slate-50' },
  { from: /dark:bg-slate-800/g, to: 'bg-slate-50' },
  { from: /dark:border-slate-600/g, to: 'border-slate-200' },
  { from: /dark:placeholder-slate-5\d{1}/g, to: 'placeholder-slate-400' }
];

let filesProcessed = 0;
let filesChanged = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      if (exts.includes(path.extname(full))) {
        try {
          let content = fs.readFileSync(full, 'utf8');
          const original = content;
          replacements.forEach(r => {
            content = content.replace(r.from, r.to);
          });
          if (content !== original) {
            fs.writeFileSync(full, content, 'utf8');
            filesChanged++;
          }
          filesProcessed++;
        } catch (err) {
          console.error('ERR', full, err.message);
        }
      }
    }
  });
}

walk(path.join(repoRoot, 'src'));

console.log(`Processed: ${filesProcessed} files. Modified: ${filesChanged} files.`);
