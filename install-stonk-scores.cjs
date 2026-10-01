const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, 'app', 'server.js');
let server = fs.readFileSync(target,'utf8');
if (!server.includes("from './stonk-scores.mjs'")) {
  const matches = [...server.matchAll(/const\s+app\s*=\s*express\(\);/g)];
  if (matches.length !== 1) throw new Error('Could not locate the Game Pup Express app; original server was not changed.');
  server = "import pg from 'pg';\nimport mountStonkScores from './stonk-scores.mjs';\n" + server.replace(matches[0][0], matches[0][0] + `
mountStonkScores(app, express, new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000}), {
  token:process.env.TELEGRAM_BOT_TOKEN,
  databaseConfigured:!!process.env.DATABASE_URL,
  origin:process.env.GAME_ORIGIN || 'https://stonk-city-v2-game-pup.onrender.com'
});
`);
  fs.writeFileSync(target, server);
}
fs.copyFileSync(path.join(__dirname,'stonk-scores.mjs'),path.join(__dirname,'app','stonk-scores.mjs'));
console.log('Stonk City score routes installed alongside Game Pup.');
