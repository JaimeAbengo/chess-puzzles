# Chess Puzzles

A home-screen web app with all 6.2 million Lichess puzzles, rating-matched, with review of missed puzzles, stats and full offline mode.

- `docs/` – the published app (served by GitHub Pages)
- `src/` – app source (`app.js`, `sw.js`)
- `tools/build-data.mjs` – converts `lichess_db_puzzle.csv` into `docs/data/`
- `build.mjs` – `npm install && node build.mjs` rebuilds the app

Puzzles: [Lichess open database](https://database.lichess.org/#puzzles) (CC0). Board: [Chessground](https://github.com/lichess-org/chessground) (GPL-3.0).
