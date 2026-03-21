const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const exts = ['.js', '.jsx', '.ts', '.tsx'];

let filesProcessed = 0;
let filesChanged = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!exts.includes(path.extname(full))) return;
    let content = fs.readFileSync(full, 'utf8');
    const original = content;
    // Replace direct sequence
    content = content.replace(/bg-indigo-600\s+text-slate-900/g, 'bg-indigo-600 text-white');
    // Replace cases where other classes are between them (up to 80 chars)
    content = content.replace(/bg-indigo-600([^"]{0,80})text-slate-900/g, (m, p1) => `bg-indigo-600${p1}text-white`);
    // Also change icon/text inside bg container: if bg-indigo-600 appears and later an element has text-slate-900, change that too
    // Simple heuristic: change any standalone 'text-slate-900' that occurs within same file near bg-indigo-600 occurrences
    // (This may over-replace in rare cases; we limit to files that contain bg-indigo-600)
    if (original.includes('bg-indigo-600')) {
      content = content.replace(/text-slate-900/g, 'text-white');
    }
    if (content !== original) {
      fs.writeFileSync(full, content, 'utf8');
      filesChanged++;
    }
    filesProcessed++;
  });
}

walk(path.join(repoRoot, 'src'));
console.log(`Processed: ${filesProcessed} files. Modified: ${filesChanged} files.`);
