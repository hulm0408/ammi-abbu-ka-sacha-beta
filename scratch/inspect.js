import fs from 'fs';
const content = fs.readFileSync('index.js', 'utf8');
const lines = content.split('\n');
const search = process.argv[2] || 'boss_text_user';
lines.forEach((line, index) => {
  if (line.includes(search)) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
