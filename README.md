# Schach Game Review

Gib deinen chess.com-Namen ein, und jede deiner Partien wird mit Stockfish analysiert – mit Zugklassen wie im chess.com Game Review (Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Miss, Blunder), Erklärungen zu jedem Fehler und jedem Brilliant-Zug, einem Brett zum Nachspielen und einer Karriere-Statistik.

Alles läuft im Browser: Die Partien kommen von der öffentlichen chess.com-API, Stockfish 17.1 läuft als WebAssembly lokal, und die Ergebnisse werden im Browser gespeichert. Es gibt keinen Server.

Die Einstufung ist eine Annäherung – der Algorithmus von chess.com ist nicht öffentlich.

## Lokal starten

```
python -m http.server 8000
```
und dann http://localhost:8000 öffnen (direkt als Datei geöffnet funktioniert es nicht, weil der Browser dann keine Module lädt).

## Verwendete Software

- [Stockfish](https://stockfishchess.org/) 17.1 als WebAssembly ([stockfish.js](https://github.com/nmrugg/stockfish.js)), GPLv3
- [chess.js](https://github.com/jhlywa/chess.js) 1.4, BSD-2-Clause
- Figuren „cburnett“ von Colin M.L. Burnett (aus [Lichess](https://github.com/lichess-org/lila)), GPLv2+
