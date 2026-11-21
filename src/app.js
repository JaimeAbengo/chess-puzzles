import { Chessground } from 'chessground';
import { Chess } from 'chess.js';

const VERSION = '__VERSION__';
const DATA_URL = new URL('data/', location.href).href;
const CHUNK_CACHE = 'puzzle-data';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 864e5;

// ───────────────────────── storage (IndexedDB) ─────────────────────────
const db = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('chess-puzzles', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('attempts', { keyPath: 'n', autoIncrement: true });
      d.createObjectStore('missed', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    let out; const req = fn(s); if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  return {
    get: k => run('kv', 'readonly', s => s.get(k)),
    set: (k, v) => run('kv', 'readwrite', s => s.put(v, k)),
    all: store => run(store, 'readonly', s => s.getAll()),
    keys: store => run(store, 'readonly', s => s.getAllKeys()),
    put: (store, v) => run(store, 'readwrite', s => s.put(v)),
    del: (store, k) => run(store, 'readwrite', s => s.delete(k)),
    clear: store => run(store, 'readwrite', s => s.clear()),
  };
})();

// ───────────────────────── state ─────────────────────────
const DEFAULT_SETTINGS = { difficulty: 0, autoNext: false, sound: true, coords: true, board: 'green', offline: false, theme: null };
const DEFAULT_PLAYER = { r: 1500, rd: 300, vol: 0.06, streak: 0, best: 0 };
let settings, player, cursors, manifest;
let attempted = new Set();
let attempts = [];          // rated attempts, oldest first
let missed = new Map();     // id -> {id, p, level, due}

const save = {
  settings: () => db.set('settings', settings),
  player: () => db.set('player', player),
  cursors: () => db.set('cursors', cursors),
};

// ───────────────────────── rating (Glicko-2) ─────────────────────────
function glicko2(pl, oppR, oppRD, score) {
  const q = 173.7178, tau = 0.75;
  const mu = (pl.r - 1500) / q, phi = pl.rd / q, sigma = pl.vol;
  const muj = (oppR - 1500) / q, phij = oppRD / q;
  const g = 1 / Math.sqrt(1 + 3 * phij * phij / (Math.PI ** 2));
  const E = 1 / (1 + Math.exp(-g * (mu - muj)));
  const v = 1 / (g * g * E * (1 - E));
  const delta = v * g * (score - E);
  const a = Math.log(sigma * sigma);
  const f = x => { const ex = Math.exp(x); return ex * (delta * delta - phi * phi - v - ex) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau); };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * tau) < 0 && k < 100) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B), it = 0;
  while (Math.abs(B - A) > 1e-6 && it++ < 100) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const newSigma = Math.min(0.1, Math.exp(A / 2));
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * g * (score - E);
  return { r: Math.max(400, 1500 + q * newMu), rd: Math.max(50, Math.min(350, q * newPhi)), vol: newSigma };
}

// ───────────────────────── puzzle data ─────────────────────────
const mem = new Map();  // url -> parsed chunk (small LRU)

function chunkPath(b, c, theme) {
  const bb = String(b).padStart(2, '0');
  return theme ? `t/${theme}/${bb}/${c}.bin` : `b${bb}/${c}.bin`;
}
function allChunkPaths() {
  const out = [];
  manifest.chunks.forEach((n, b) => { for (let c = 0; c < n; c++) out.push(chunkPath(b, c)); });
  for (const [t, arr] of Object.entries(manifest.themeChunks || {})) arr.forEach((n, b) => { for (let c = 0; c < n; c++) out.push(chunkPath(b, c, t)); });
  return out;
}

async function loadManifest() {
  const cache = await caches.open(CHUNK_CACHE);
  const url = DATA_URL + 'manifest.json';
  let res = null;
  if (!settings.offline) {
    try { const r = await fetch(url, { cache: 'no-cache' }); if (r.ok) { res = r; await cache.put(url, r.clone()); } } catch { }
  }
  if (!res) res = await cache.match(url);
  if (!res) throw new Error('no-manifest');
  manifest = await res.json();
  const known = await db.get('dataVersion');
  if (known && known !== manifest.version) {
    // puzzle files were rebuilt: drop old cached chunks and reading positions
    for (const k of await cache.keys()) if (!k.url.endsWith('manifest.json')) await cache.delete(k);
    cursors = {}; save.cursors();
  }
  db.set('dataVersion', manifest.version);
}

async function getChunk(path, { network = !settings.offline } = {}) {
  const url = DATA_URL + path;
  if (mem.has(url)) { const v = mem.get(url); mem.delete(url); mem.set(url, v); return v; }
  const cache = await caches.open(CHUNK_CACHE);
  let res = await cache.match(url);
  if (!res) {
    if (!network) return null;
    try { res = await fetch(url); } catch { return null; }
    if (!res.ok) return null;
    await cache.put(url, res.clone());
  }
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const list = text.split('\n').map(line => {
    const [id, fen, mv, r, th] = line.split('\t');
    return { id, fen: fen + ' 0 1', moves: mv.split(' '), rating: +r, themes: th ? th.split('.').map(x => manifest.themes[parseInt(x, 36)]) : [] };
  });
  mem.set(url, list);
  if (mem.size > 8) mem.delete(mem.keys().next().value);
  return list;
}

function* spiral(b0, n) {
  yield b0;
  for (let d = 1; d < n; d++) { if (b0 + d < n) yield b0 + d; if (b0 - d >= 0) yield b0 - d; }
}

async function nextRatedPuzzle() {
  const theme = settings.theme;
  const rare = theme && manifest.themeChunks && manifest.themeChunks[theme];
  const counts = rare ? manifest.themeChunks[theme] : manifest.chunks;
  const base = rare ? manifest.tbase : manifest.base, width = rare ? manifest.twidth : manifest.width;
  const target = player.r + settings.difficulty + (Math.random() * 120 - 60);
  const b0 = Math.max(0, Math.min(counts.length - 1, Math.floor((target - base) / width)));
  for (const b of spiral(b0, counts.length)) {
    const n = counts[b]; if (!n) continue;
    const key = `${rare ? theme : '*'}|${b}`;
    const cur = cursors[key] || { c: 0, i: 0 };
    let c = cur.c, i = cur.i, scanned = 0;
    while (c < n && scanned < 8) {
      const chunk = await getChunk(chunkPath(b, c, rare ? theme : null));
      if (!chunk) { c++; i = 0; scanned++; continue; }   // not downloaded (offline) — try another
      for (; i < chunk.length; i++) {
        const p = chunk[i];
        if (attempted.has(p.id)) continue;
        if (theme && !rare && !p.themes.includes(theme)) continue;
        if (c === cur.c) { cursors[key] = { c, i: i + 1 }; save.cursors(); }
        if (!settings.offline && i > chunk.length * 0.8 && c + 1 < n) getChunk(chunkPath(b, c + 1, rare ? theme : null)); // prefetch
        return p;
      }
      if (c === cur.c) { cursors[key] = { c: c + 1, i: 0 }; save.cursors(); cur.c = c + 1; }
      c++; i = 0; scanned++;
    }
  }
  return null;
}

// ───────────────────────── sound ─────────────────────────
const sound = (() => {
  let ctx;
  const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
  function noise(dur, freq, gain) {
    const c = ac(), len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination); src.start();
  }
  function tone(freqs, dur, type = 'sine', gain = 0.12) {
    const c = ac(); let t = c.currentTime;
    for (const fr of freqs) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = fr;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02); t += dur * 0.55;
    }
  }
  const on = () => settings && settings.sound;
  return {
    unlock() { try { const c = ac(); if (c.state === 'suspended') c.resume(); } catch { } },
    move() { if (on()) try { noise(0.08, 1800, 1.6); } catch { } },
    capture() { if (on()) try { noise(0.12, 900, 2.6); } catch { } },
    good() { if (on()) try { tone([660, 880, 1320], 0.22); } catch { } },
    bad() { if (on()) try { tone([220, 185], 0.25, 'triangle', 0.15); } catch { } },
  };
})();

// ───────────────────────── board & puzzle flow ─────────────────────────
let cg;
const game = {
  p: null, chess: null, step: 0, color: 'white', mode: 'rated',
  failed: false, hinted: false, done: false, busy: false, recorded: false, token: 0,
};

function dests(chess) {
  const m = new Map();
  for (const mv of chess.moves({ verbose: true })) { if (!m.has(mv.from)) m.set(mv.from, []); m.get(mv.from).push(mv.to); }
  return m;
}
const turnColor = ch => ch.turn() === 'w' ? 'white' : 'black';

function sync(lastMove) {
  const ch = game.chess, mine = !game.done && !game.busy && turnColor(ch) === game.color;
  cg.set({
    fen: ch.fen(), turnColor: turnColor(ch), check: ch.inCheck(),
    lastMove: lastMove || cg.state.lastMove,
    movable: { color: mine ? game.color : undefined, dests: mine ? dests(ch) : new Map() },
  });
}

function applyUci(uci) {
  const mv = game.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (mv.captured) sound.capture(); else sound.move();
  return mv;
}

function setStatus(kind, title, sub = '') {
  const ic = $('statusIcon');
  ic.className = 'status-icon ' + kind;
  $('statusTitle').textContent = title; $('statusSub').textContent = sub;
  if (kind === 'ok' || kind === 'bad') {
    const s = $('status'); s.classList.remove('flash-ok', 'flash-bad'); void s.offsetWidth; s.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-bad');
  }
}

function setButtons() {
  const d = game.done;
  $('hintBtn').hidden = d; $('solBtn').hidden = d;
  $('nextBtn').hidden = !d && !game.failed;
  $('retryBtn').hidden = !d;
  $('hintBtn').disabled = game.busy || game.hinted;
  $('solBtn').disabled = game.busy;
}

function yourTurnStatus() {
  const side = game.color === 'white' ? 'White' : 'Black';
  if (game.failed) setStatus(game.color, 'Keep trying, or see the solution', `Find the best move for ${side}`);
  else setStatus(game.color, 'Your turn', `Find the best move for ${side}`);
}

function hideSplash() {
  const s = $('splash'); if (!s || s.classList.contains('out')) return;
  s.classList.add('out'); setTimeout(() => s.remove(), 450);
}

async function startPuzzle(p, { replay = false } = {}) {
  const token = ++game.token;
  Object.assign(game, { p, chess: new Chess(p.fen), step: 0, failed: false, hinted: false, done: false, busy: true, recorded: replay });
  game.color = turnColor(game.chess) === 'white' ? 'black' : 'white';
  $('boardMsg').hidden = true; $('promo').hidden = true; $('view-play').classList.remove('msg');
  cg.set({ orientation: game.color, fen: p.fen, lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() }, drawable: { shapes: [] } });
  cg.setAutoShapes([]);
  const ratingTxt = game.mode === 'review' ? 'review' : `rated ${p.rating}`;
  $('meta').innerHTML = `Puzzle <a href="https://lichess.org/training/${p.id}" target="_blank" rel="noopener">#${p.id}</a> · ${ratingTxt}`;
  setStatus(game.color, 'Get ready…', `You play ${game.color === 'white' ? 'White' : 'Black'}`);
  setButtons();
  hideSplash();
  await sleep(450);
  if (token !== game.token) return;
  const mv = applyUci(p.moves[0]);
  game.step = 1; game.busy = false;
  sync([mv.from, mv.to]);
  yourTurnStatus(); setButtons();
}

function needsPromotion(orig, dest) {
  const pc = game.chess.get(orig);
  return pc && pc.type === 'p' && (dest[1] === '8' || dest[1] === '1');
}

function askPromotion(dest) {
  return new Promise(resolve => {
    const box = $('promo'); box.innerHTML = '';
    for (const [r, name] of [['q', 'queen'], ['n', 'knight'], ['r', 'rook'], ['b', 'bishop']]) {
      const b = document.createElement('button');
      // pieces only get their images inside a .cg-wrap, so wrap each one
      b.innerHTML = `<span class="cg-wrap promo-piece"><piece class="${name} ${game.color}"></piece></span>`;
      b.setAttribute('aria-label', name[0].toUpperCase() + name.slice(1));
      b.onclick = e => { e.stopPropagation(); box.hidden = true; resolve(r); };
      box.appendChild(b);
    }
    box.onclick = () => { box.hidden = true; resolve(null); };
    box.hidden = false;
  });
}

async function onUserMove(orig, dest) {
  if (game.done || game.busy) return;
  sound.unlock();
  let promo = '';
  if (needsPromotion(orig, dest)) {
    const r = await askPromotion(dest);
    if (!r) { sync(); return; }
    promo = r;
  }
  const uci = orig + dest + promo;
  const expected = game.p.moves[game.step];
  const mv = applyUci(uci);
  const correct = uci === expected || game.chess.isCheckmate();
  if (!correct) {
    sync([mv.from, mv.to]);
    game.busy = true; setButtons();
    if (!game.failed) { game.failed = true; await recordResult(false); }
    sound.bad();
    setStatus('bad', "That's not the move", 'Try something else');
    await sleep(650);
    game.chess.undo(); game.busy = false;
    const prev = game.chess.history({ verbose: true }).pop();
    sync(prev ? [prev.from, prev.to] : undefined);
    setStatus('bad', "That's not the move", 'Keep trying, or tap Solution');
    setButtons();
    return;
  }
  game.step++;
  cg.setAutoShapes([]);
  if (game.step >= game.p.moves.length || game.chess.isCheckmate()) return finish(true, [mv.from, mv.to]);
  // opponent replies
  game.busy = true; sync([mv.from, mv.to]); setButtons();
  setStatus('ok', 'Best move!', 'Keep going…');
  await sleep(380);
  const token = game.token;
  const rep = applyUci(game.p.moves[game.step]);
  if (token !== game.token) return;
  game.step++; game.busy = false;
  sync([rep.from, rep.to]);
  setStatus('ok', 'Best move! Keep going', `Find the next move for ${game.color === 'white' ? 'White' : 'Black'}`);
  setButtons();
}

async function finish(solved, lastMove) {
  game.done = true; game.busy = false;
  sync(lastMove);
  if (solved && !game.failed) {
    sound.good();
    await recordResult(true);
    const sub = game.mode === 'review' ? reviewSubtitle() : (game.hinted ? 'Solved with a hint' : `Streak: ${player.streak}`);
    setStatus('ok', game.hinted ? 'Solved' : 'Success!', sub);
  } else if (solved) {
    setStatus('bad', 'Solved, but counted as a miss', 'It will come back in Review');
  }
  setButtons();
  if (solved && !game.failed && settings.autoNext) { const t = game.token; await sleep(900); if (t === game.token && game.done) next(); }
}

function reviewSubtitle() {
  const m = missed.get(game.p.id);
  return m ? `Next review in ${Math.round((m.due - Date.now()) / DAY)} days` : 'Learned! Removed from review';
}

async function recordResult(ok) {
  if (game.recorded) return;
  game.recorded = true;
  const p = game.p;
  const success = ok && !game.hinted;
  if (game.mode === 'review') {
    const m = missed.get(p.id);
    if (!m) return;
    if (success) {
      m.level++;
      if (m.level >= 4) { missed.delete(p.id); await db.del('missed', p.id); }
      else { m.due = Date.now() + [1, 3, 7, 21][m.level] * DAY; await db.put('missed', m); }
    } else { m.level = 0; m.due = Date.now() + DAY; await db.put('missed', m); }
    updateBadge();
    return;
  }
  const before = player.r;
  const nr = glicko2(player, p.rating, 80, success ? 1 : 0);
  Object.assign(player, nr);
  if (success) { player.streak++; player.best = Math.max(player.best, player.streak); } else player.streak = 0;
  const a = { id: p.id, t: Date.now(), ok: success, pr: p.rating, r: Math.round(player.r), th: p.themes };
  attempts.push(a); attempted.add(p.id);
  await db.put('attempts', a);
  await save.player();
  if (!success) {
    const m = { id: p.id, p, level: 0, due: Date.now() + DAY, added: Date.now() };
    missed.set(p.id, m); await db.put('missed', m); updateBadge();
  }
  showRating(Math.round(player.r) - Math.round(before));
}

function showRating(delta) {
  $('rating').textContent = Math.round(player.r);
  $('prov').hidden = player.rd < 110;
  $('streak').textContent = player.streak;
  const d = $('delta');
  if (delta) {
    d.textContent = (delta > 0 ? '+' : '') + delta;
    d.className = 'delta show ' + (delta > 0 ? 'up' : 'down');
    clearTimeout(showRating.t); showRating.t = setTimeout(() => d.classList.remove('show'), 2500);
  }
}

async function hint() {
  if (game.done || game.busy || game.hinted) return;
  game.hinted = true;
  if (!game.failed && game.mode === 'rated') { game.failed = true; await recordResult(false); }
  else if (game.mode === 'review') { game.failed = true; await recordResult(false); }
  const from = game.p.moves[game.step].slice(0, 2);
  cg.setAutoShapes([{ orig: from, brush: 'blue' }]);
  setStatus(game.color, 'Hint: move this piece', 'Hints count as a miss');
  setButtons();
}

async function showSolution() {
  if (game.done || game.busy) return;
  if (!game.failed) { game.failed = true; await recordResult(false); }
  game.busy = true; setButtons(); cg.setAutoShapes([]);
  const token = game.token;
  setStatus('bad', 'Solution', 'Watch the moves…');
  let last;
  while (game.step < game.p.moves.length) {
    const uci = game.p.moves[game.step];
    cg.setAutoShapes([{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }]);
    await sleep(500);
    if (token !== game.token) return;
    last = applyUci(uci); game.step++;
    sync([last.from, last.to]);
    cg.setAutoShapes([]);
    await sleep(450);
    if (token !== game.token) return;
  }
  game.done = true; game.busy = false; sync();
  setStatus('bad', 'Puzzle failed', game.mode === 'review' ? 'It will come back tomorrow' : 'Added to your Review pile');
  setButtons();
}

function retry() { if (game.p) startPuzzle(game.p, { replay: true }); }

async function next() {
  $('nextBtn').disabled = true;
  try {
    if (game.mode === 'review') {
      const due = dueList();
      updateBadge();
      if (!due.length) {
        const soon = [...missed.values()].sort((a, b) => a.due - b.due)[0];
        const when = soon ? (() => { const h = (soon.due - Date.now()) / 36e5; return h < 1 ? 'within the hour' : h < 24 ? `in ${Math.round(h)} hours` : `in ${Math.round(h / 24)} days`; })() : '';
        return boardMessage(soon
          ? `Nothing to review right now 🎉<br><small class="muted">${missed.size} missed puzzle${missed.size > 1 ? 's' : ''} waiting. The next one is due ${when}.</small>`
          : 'Nothing to review yet.<br><small class="muted">Puzzles you miss come back here a day later, then after 3, 7 and 21 days until you solve them.</small>', 'Back to puzzles', () => setMode('rated'));
      }
      $('reviewLeft').textContent = due.length;
      return startPuzzle(due[0].p);
    }
    setStatus('', 'Loading…');
    const p = await nextRatedPuzzle();
    if (!p) {
      return boardMessage(settings.offline
        ? 'No downloaded puzzles left for this level or theme.<br><br>Turn off Offline mode or download all puzzles in Settings.'
        : "Couldn't load puzzles. Check your internet connection.", 'Try again', next);
    }
    await startPuzzle(p);
  } finally { $('nextBtn').disabled = false; }
}

function boardMessage(html, btnText, fn) {
  const m = $('boardMsg');
  m.innerHTML = `<div>${html}</div>`;
  if (btnText) { const b = document.createElement('button'); b.className = 'btn primary small'; b.textContent = btnText; b.onclick = fn; m.appendChild(b); }
  m.hidden = false; $('view-play').classList.add('msg'); hideSplash();
  setStatus('', '', ''); $('statusTitle').textContent = ''; $('meta').textContent = '';
  game.done = true; $('hintBtn').hidden = $('solBtn').hidden = $('retryBtn').hidden = $('nextBtn').hidden = true;
}

// ───────────────────────── review mode ─────────────────────────
const dueList = () => [...missed.values()].filter(m => m.due <= Date.now()).sort((a, b) => a.due - b.due);
function updateBadge() {
  const n = dueList().length;
  $('dueBadge').hidden = !n; $('dueBadge').textContent = n;
  $('reviewLeft').textContent = n;
}
function setMode(mode) {
  game.mode = mode;
  $('reviewBanner').hidden = mode !== 'review';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'play' && t.dataset.mode === mode));
  showView('play');
  game.token++;
  next();
}

// ───────────────────────── themes ─────────────────────────
const THEME_NAMES = {
  advancedPawn: 'Advanced pawn', advantage: 'Advantage', anastasiaMate: "Anastasia's mate", arabianMate: 'Arabian mate', attackingF2F7: 'Attacking f2/f7',
  attraction: 'Attraction', backRankMate: 'Back rank mate', balestraMate: 'Balestra mate', bishopEndgame: 'Bishop endgame', blindSwineMate: 'Blind swine mate',
  bodenMate: "Boden's mate", capturingDefender: 'Capture the defender', castling: 'Castling', clearance: 'Clearance', collinearMove: 'Collinear move',
  cornerMate: 'Corner mate', crushing: 'Crushing', defensiveMove: 'Defensive move', deflection: 'Deflection', discoveredAttack: 'Discovered attack',
  discoveredCheck: 'Discovered check', doubleBishopMate: 'Double bishop mate', doubleCheck: 'Double check', dovetailMate: 'Dovetail mate', enPassant: 'En passant',
  endgame: 'Endgame', epauletteMate: 'Epaulette mate', equality: 'Equality', exposedKing: 'Exposed king', fork: 'Fork', hangingPiece: 'Hanging piece',
  hookMate: 'Hook mate', interference: 'Interference', intermezzo: 'Intermezzo', killBoxMate: 'Kill box mate', kingsideAttack: 'Kingside attack',
  knightEndgame: 'Knight endgame', long: 'Long (3 moves)', master: 'Master games', masterVsMaster: 'Master vs master', mate: 'Checkmate', mateIn1: 'Mate in 1',
  mateIn2: 'Mate in 2', mateIn3: 'Mate in 3', mateIn4: 'Mate in 4', mateIn5: 'Mate in 5+', middlegame: 'Middlegame', morphysMate: "Morphy's mate",
  oneMove: 'One move', opening: 'Opening', operaMate: 'Opera mate', pawnEndgame: 'Pawn endgame', pillsburysMate: "Pillsbury's mate", pin: 'Pin',
  promotion: 'Promotion', queenEndgame: 'Queen endgame', queenRookEndgame: 'Queen & rook', queensideAttack: 'Queenside attack', quietMove: 'Quiet move',
  rookEndgame: 'Rook endgame', sacrifice: 'Sacrifice', short: 'Short (2 moves)', skewer: 'Skewer', smotheredMate: 'Smothered mate', superGM: 'Super GM games',
  swallowstailMate: "Swallow's tail mate", trappedPiece: 'Trapped piece', triangleMate: 'Triangle mate', underPromotion: 'Underpromotion', veryLong: 'Very long (4+)',
  vukovicMate: 'Vukovic mate', xRayAttack: 'X-ray attack', zugzwang: 'Zugzwang',
};
const themeName = t => THEME_NAMES[t] || t.replace(/([A-Z0-9])/g, ' $1').replace(/^./, c => c.toUpperCase());
const HIDDEN_THEMES = new Set(['crushing', 'advantage', 'equality']);
function themeGroup(t) {
  if (/^mateIn/.test(t) || t === 'mate') return 'Checkmates';
  if (/Mate$/.test(t)) return 'Named mates';
  if (['opening', 'middlegame', 'endgame'].includes(t) || /Endgame$/.test(t)) return 'Game phase';
  if (['oneMove', 'short', 'long', 'veryLong'].includes(t)) return 'Length';
  if (['master', 'masterVsMaster', 'superGM'].includes(t)) return 'Origin';
  return 'Tactics';
}
const fmtCount = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);

function renderThemeSheet() {
  const groups = { Tactics: [], Checkmates: [], 'Named mates': [], 'Game phase': [], Length: [], Origin: [] };
  manifest.themes.forEach((t, i) => { if (!HIDDEN_THEMES.has(t)) groups[themeGroup(t)].push([t, manifest.themeCounts[i]]); });
  const list = $('themeList'); list.innerHTML = '';
  const mk = (t, label, count) => {
    const b = document.createElement('button');
    b.className = 'tbtn' + ((settings.theme || null) === t ? ' on' : '');
    b.innerHTML = `${label}${count ? `<small>${fmtCount(count)}</small>` : ''}`;
    b.onclick = () => { setTheme(t); closeSheet(); };
    return b;
  };
  const top = document.createElement('div'); top.className = 'tgrid';
  top.appendChild(mk(null, 'All puzzles', manifest.total));
  list.appendChild(top);
  for (const [g, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    arr.sort((a, b) => g === 'Checkmates' || g === 'Length' ? 0 : themeName(a[0]).localeCompare(themeName(b[0])));
    const h = document.createElement('h3'); h.textContent = g; list.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'tgrid';
    for (const [t, c] of arr) grid.appendChild(mk(t, themeName(t), c));
    list.appendChild(grid);
  }
}
function setTheme(t) {
  settings.theme = t; save.settings(); updateThemeChip();
  if (game.mode === 'rated') { game.token++; next(); } else setMode('rated');
}
function updateThemeChip() {
  $('themeLabel').textContent = settings.theme ? themeName(settings.theme) : 'All puzzles';
  $('themeBtn').classList.toggle('on', !!settings.theme);
}
function openSheet() { renderThemeSheet(); $('sheet').hidden = false; }
function closeSheet() { $('sheet').hidden = true; }

// ───────────────────────── stats ─────────────────────────
let chartRange = 100;
function renderStats() {
  const total = attempts.length, ok = attempts.filter(a => a.ok).length;
  const today = attempts.filter(a => a.t > new Date().setHours(0, 0, 0, 0));
  const peak = attempts.reduce((m, a) => Math.max(m, a.r), Math.round(player.r));
  $('statCards').innerHTML = [
    [Math.round(player.r) + (player.rd >= 110 ? '?' : ''), 'Rating'], [peak, 'Peak rating'],
    [total.toLocaleString(), 'Puzzles played'], [total ? Math.round(ok / total * 100) + '%' : '–', 'Solved first try'],
    [today.length, `Today (${today.filter(a => a.ok).length} solved)`], [player.best, 'Best streak'],
  ].map(([v, l]) => `<div class="card"><b>${v}</b><span>${l}</span></div>`).join('');

  $('chartRange').innerHTML = [[50, 'Last 50'], [100, '100'], [500, '500'], [0, 'All']]
    .map(([n, l]) => `<button data-n="${n}" class="${n === chartRange ? 'on' : ''}">${l}</button>`).join('');
  $('chartRange').querySelectorAll('button').forEach(b => b.onclick = () => { chartRange = +b.dataset.n; renderStats(); });
  const pts = [1500, ...attempts.map(a => a.r)].slice(chartRange ? -chartRange - 1 : 0);
  if (pts.length < 2) $('chart').innerHTML = '<div class="empty">Play some puzzles to see your rating graph.</div>';
  else {
    const W = 600, H = 170, P = 26;
    const lo = Math.floor((Math.min(...pts) - 20) / 50) * 50, hi = Math.ceil((Math.max(...pts) + 20) / 50) * 50;
    const x = i => P + (W - P - 6) * i / (pts.length - 1), y = v => 8 + (H - 22) * (1 - (v - lo) / (hi - lo));
    const step = Math.max(50, Math.ceil((hi - lo) / 4 / 50) * 50);
    let grid = '';
    for (let v = lo; v <= hi; v += step) grid += `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#3a3733" stroke-width="1"/><text x="0" y="${y(v) + 4}" fill="#9b968e" font-size="11">${v}</text>`;
    const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}<path d="${d} L${x(pts.length - 1)},${H - 14} L${P},${H - 14}Z" fill="rgba(127,166,80,.18)"/><path d="${d}" fill="none" stroke="#93c060" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  const by = new Map();
  for (const a of attempts) for (const t of a.th || []) {
    if (HIDDEN_THEMES.has(t)) continue;
    const s = by.get(t) || { n: 0, ok: 0 }; s.n++; if (a.ok) s.ok++; by.set(t, s);
  }
  const rows = [...by].filter(([, s]) => s.n >= 10).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n);
  $('themeStats').innerHTML = rows.length
    ? rows.map(([t, s]) => { const pc = Math.round(s.ok / s.n * 100); return `<div class="tstat"><span>${themeName(t)} <small class="muted">${s.n}</small></span><div class="tbar"><i style="width:${pc}%"></i></div><span class="pct">${pc}%</span></div>`; }).join('')
    : '<div class="empty">Your weakest and strongest themes will show here.</div>';

  $('recent').innerHTML = attempts.slice(-40).reverse()
    .map(a => `<a class="${a.ok ? 'ok' : 'bad'}" href="https://lichess.org/training/${a.id}" target="_blank" rel="noopener">${a.pr}</a>`).join('') || '<div class="empty">No puzzles yet.</div>';
}

// ───────────────────────── settings ─────────────────────────
const BOARDS = { green: ['#eeeed2', '#769656'], brown: ['#f0d9b5', '#b58863'], blue: ['#dee3e6', '#8ca2ad'], purple: ['#e8e1f2', '#9b85b8'], gray: ['#d9d9d9', '#8f8f8f'] };
function applySettings() {
  document.body.className = document.body.className.replace(/board-\w+/g, '').trim();
  document.body.classList.add('board-' + settings.board);
  document.body.classList.toggle('no-coords', !settings.coords);
}
function renderSettings() {
  $('setDifficulty').value = settings.difficulty;
  $('setAutoNext').checked = settings.autoNext;
  $('setSound').checked = settings.sound;
  $('setCoords').checked = settings.coords;
  $('setOffline').checked = settings.offline;
  $('swatches').innerHTML = Object.entries(BOARDS).map(([k, [l, d]]) => `<button class="swatch${k === settings.board ? ' on' : ''}" data-b="${k}" style="--l:${l};--d:${d}" aria-label="${k}"></button>`).join('');
  $('swatches').querySelectorAll('.swatch').forEach(b => b.onclick = () => { settings.board = b.dataset.b; save.settings(); applySettings(); renderSettings(); });
  $('ver').textContent = VERSION;
  updateDownloadInfo();
}

// download-all
let dl = null; // {stop: bool}
async function countCached() {
  const cache = await caches.open(CHUNK_CACHE);
  return (await cache.keys()).filter(k => k.url.endsWith('.bin')).length;
}
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB';
async function updateDownloadInfo() {
  if (!manifest) return;
  const total = allChunkPaths().length, have = await countCached();
  const pct = have / total;
  $('dlBar').style.width = (pct * 100).toFixed(1) + '%';
  $('dlCount').textContent = have >= total ? `All ${fmtCount(manifest.total)}` : `${Math.floor(pct * 100)}% of ${fmtCount(manifest.total)}`;
  let info = have >= total ? 'Every puzzle is saved on this phone. You can turn on Offline mode.' : `Full download: ${fmtMB(manifest.bytes)}. Use Wi-Fi. You can pause and continue later.`;
  try { const e = await navigator.storage.estimate(); if (e.usage) info += ` Using ${fmtMB(e.usage)}.`; } catch { }
  $('dlInfo').textContent = info;
  $('dlBtn').hidden = have >= total;
  $('dlBtn').textContent = dl ? 'Pause download' : pct > 0.03 ? 'Continue download' : 'Download all puzzles';
  $('dlBtn').disabled = settings.offline && !dl;
}
async function toggleDownload() {
  if (dl) { dl.stop = true; return; }
  if (settings.offline) return toast('Turn off Offline mode to download');
  try { await navigator.storage.persist?.(); } catch { }
  dl = { stop: false };
  updateDownloadInfo();
  const cache = await caches.open(CHUNK_CACHE);
  const have = new Set((await cache.keys()).map(k => k.url));
  const todo = allChunkPaths().map(p => DATA_URL + p).filter(u => !have.has(u));
  const total = allChunkPaths().length; let done = total - todo.length, errors = 0;
  const worker = async () => {
    while (todo.length && !dl.stop && errors < 20) {
      const u = todo.shift();
      try { const r = await fetch(u); if (!r.ok) throw 0; await cache.put(u, r); done++; } catch { errors++; todo.push(u); await sleep(1000); }
      if (done % 10 === 0) { $('dlBar').style.width = (done / total * 100).toFixed(1) + '%'; $('dlCount').textContent = `${Math.round(done / total * 100)}%`; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const stopped = dl.stop; dl = null;
  if (errors >= 20) toast('Download interrupted. Check your connection and tap Continue.');
  else if (!stopped) toast('All puzzles downloaded ✓');
  updateDownloadInfo();
}

// backup
async function exportBackup() {
  const data = { app: 'chess-puzzles', v: 1, exported: new Date().toISOString(), settings, player, cursors, attempts: await db.all('attempts'), missed: await db.all('missed'), dataVersion: await db.get('dataVersion') };
  const name = `chess-puzzles-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Chess puzzles backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'chess-puzzles') throw new Error();
    if (!confirm(`Replace your current progress with this backup (${data.attempts.length} puzzles, rating ${Math.round(data.player.r)})?`)) return;
    await db.clear('attempts'); await db.clear('missed');
    for (const a of data.attempts) await db.put('attempts', a);
    for (const m of data.missed) await db.put('missed', m);
    await db.set('settings', { ...DEFAULT_SETTINGS, ...data.settings });
    await db.set('player', data.player);
    await db.set('cursors', data.dataVersion === manifest?.version ? data.cursors : {});
    location.reload();
  } catch { toast("That file isn't a valid backup"); }
}
async function resetAll() {
  if (!confirm('Delete all your progress, rating and history? This cannot be undone.')) return;
  await db.clear('attempts'); await db.clear('missed');
  await db.set('player', { ...DEFAULT_PLAYER }); await db.set('cursors', {});
  location.reload();
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800);
}

// ───────────────────────── navigation ─────────────────────────
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  if (v !== 'play') document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'stats') renderStats();
  if (v === 'settings') renderSettings();
  if (v === 'play') requestAnimationFrame(() => cg && cg.redrawAll());
}

// ───────────────────────── service worker / updates ─────────────────────────
// tell the service worker about Offline mode (via Cache Storage, which it can read even after restarting)
async function syncOfflineFlag() {
  try { const c = await caches.open('flags'); if (settings.offline) await c.put('offline', new Response('1')); else await c.delete('offline'); } catch { }
}
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = swReg = await navigator.serviceWorker.register('sw.js');
    const prompt = w => { if (settings.offline) return; $('updateBar').hidden = false; $('updateBtn').onclick = () => w.postMessage('skipWaiting'); };
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w); });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
    setInterval(() => { if (!settings.offline) reg.update().catch(() => { }); }, 60 * 60e3);
  } catch { }
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  settings = { ...DEFAULT_SETTINGS, ...(await db.get('settings')) };
  syncOfflineFlag();
  player = { ...DEFAULT_PLAYER, ...(await db.get('player')) };
  cursors = (await db.get('cursors')) || {};
  attempts = (await db.all('attempts')).sort((a, b) => a.t - b.t);
  attempted = new Set(attempts.map(a => a.id));
  for (const m of await db.all('missed')) missed.set(m.id, m);
  applySettings();
  showRating(0); updateBadge();

  cg = Chessground($('board'), {
    coordinates: true, animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: onUserMove } },
    premovable: { enabled: false }, draggable: { showGhost: true },
    drawable: { enabled: true, visible: true },
  });
  window.addEventListener('resize', () => cg.redrawAll());

  $('hintBtn').onclick = hint; $('solBtn').onclick = showSolution; $('retryBtn').onclick = retry; $('nextBtn').onclick = () => { sound.unlock(); next(); };
  $('reviewExit').onclick = () => setMode('rated');
  $('themeBtn').onclick = () => manifest && openSheet();
  $('sheet').querySelectorAll('[data-close]').forEach(el => el.onclick = closeSheet);
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    sound.unlock();
    if (t.dataset.view === 'play') { if (game.mode !== t.dataset.mode || !game.p) setMode(t.dataset.mode); else { showView('play'); document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t)); } }
    else showView(t.dataset.view);
  });
  $('setDifficulty').onchange = e => { settings.difficulty = +e.target.value; save.settings(); };
  $('setAutoNext').onchange = e => { settings.autoNext = e.target.checked; save.settings(); };
  $('setSound').onchange = e => { settings.sound = e.target.checked; save.settings(); if (settings.sound) { sound.unlock(); sound.move(); } };
  $('setCoords').onchange = e => { settings.coords = e.target.checked; save.settings(); applySettings(); };
  $('setOffline').onchange = async e => {
    settings.offline = e.target.checked; save.settings();
    await syncOfflineFlag();
    if (settings.offline && dl) dl.stop = true;
    if (settings.offline) $('updateBar').hidden = true; else if (swReg) swReg.update().catch(() => { });
    toast(settings.offline ? 'Offline mode on: the app will not connect to the internet' : 'Offline mode off');
    updateDownloadInfo();
  };
  $('dlBtn').onclick = toggleDownload;
  $('exportBtn').onclick = exportBackup;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = e => e.target.files[0] && importBackup(e.target.files[0]);
  $('resetBtn').onclick = resetAll;

  registerSW();
  try { await loadManifest(); }
  catch { return boardMessage('The app needs internet the first time it opens, to get the puzzle list.', 'Try again', () => location.reload()); }
  updateThemeChip();
  next();
}

boot();
