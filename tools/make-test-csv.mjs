// Fake puzzles (random legal lines) in Lichess CSV format, only for testing the app mechanics.
import { Chess } from 'chess.js';
const N = +process.argv[2] || 5000;
const themes = ['fork', 'pin', 'mateIn1', 'mateIn2', 'endgame', 'middlegame', 'short', 'long', 'sacrifice', 'skewer', 'crushing', 'smotheredMate'];
console.log('PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags');
let id = 0;
while (id < N) {
  const c = new Chess();
  const plies = 10 + Math.floor(Math.random() * 40);
  let ok = true;
  for (let i = 0; i < plies && ok; i++) { const m = c.moves(); if (!m.length) ok = false; else c.move(m[Math.floor(Math.random() * m.length)]); }
  if (!ok) continue;
  const fen = c.fen();
  const line = [];
  for (let i = 0; i < 4; i++) {
    const m = c.moves({ verbose: true });
    if (!m.length) break;
    const mv = m[Math.floor(Math.random() * m.length)];
    c.move(mv);
    line.push(mv.from + mv.to + (mv.promotion || ''));
  }
  if (line.length < 2 || line.length % 2) continue;
  const t = themes.filter(() => Math.random() < 0.25).join(' ');
  const pid = (id++).toString(36).padStart(5, '0');
  console.log(`${pid},${fen},${line.join(' ')},${400 + Math.floor(Math.random() * 2600)},75,90,1000,${t},https://lichess.org/x,`);
}
