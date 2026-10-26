// Game Review im Browser: lädt chess.com-Partien, analysiert sie mit Stockfish (WASM)
// und stuft jeden Zug wie im chess.com Game Review ein. Portierung von analyse.py.
import { Chess, SQUARES } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

const SF_JS = 'https://unpkg.com/stockfish@17.1.0/src/stockfish-17.1-lite-single-03e3232.js';
const SF_WASM = SF_JS.replace(/\.js$/, '.wasm');
const CACHE_VERSION = 'v1';

const REMIS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
// Zugklassen wie im chess.com Game Review: Schlüssel -> [Name, Farbe, Symbol]
const KL = {
  brilliant: ['Brilliant', '#26c2a3', '!!'],
  great: ['Great', '#749bbf', '!'],
  best: ['Best', '#81b64c', '★'],
  excellent: ['Excellent', '#81b64c', '✓'],
  good: ['Good', '#95af8a', '✓'],
  inaccuracy: ['Inaccuracy', '#f7c631', '?!'],
  mistake: ['Mistake', '#ffa459', '?'],
  miss: ['Miss', '#ff7769', '✕'],
  blunder: ['Blunder', '#fa412d', '??'],
};
const SCHLECHT = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
// Verlust an Gewinnchance (Prozentpunkte), ab dem ein Zug in die Klasse fällt
const EXCELLENT = 2, GOOD = 5, INACCURACY = 10, MISTAKE = 20;
const GREAT_ABSTAND = 15;            // Great: der zweitbeste Zug wäre mindestens so viel schlechter
const BRILLIANT_OPFER = 1;           // Brilliant: Figur geopfert, nach Abtauschen mind. so viel Material weniger
const BRILLIANT_MAX_ALTERNATIVE = 90; // ... und ohne das Opfer stünde man nicht schon klar auf Gewinn

const WERT = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const FIGUR = { p: 'Bauer', n: 'Springer', b: 'Läufer', r: 'Turm', q: 'Dame', k: 'König' };
const MENGE = { 1: ['ein Bauer', 'einen Bauern'], 2: ['zwei Bauern', 'zwei Bauern'], 3: ['eine Figur', 'eine Figur'],
  4: ['eine Figur und ein Bauer', 'eine Figur und einen Bauern'], 5: ['ein Turm', 'einen Turm'],
  6: ['ein Turm und ein Bauer', 'einen Turm und einen Bauern'], 8: ['die Dame', 'die Dame'], 9: ['die Dame', 'die Dame'] };
const FIG = Object.fromEntries(['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'].map(c => [c, `figuren/${c}.svg`]));

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mittel = w => { w = w.filter(x => x != null); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null; };
const prozent = x => x == null ? '–' : x.toFixed(1).replace('.', ',') + ' %';
const datum = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const sym = k => `<span class="sym" style="background:${KL[k][1]}" title="${KL[k][0]}">${KL[k][2]}</span>`;
const pid = p => p.uuid || p.url.replace(/\/$/, '').split('/').pop();
const speicher = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

// ---------------------------------------------------------------- Speicher (IndexedDB)

const DB = {
  db: null,
  async oeffnen() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('chess-analyse', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('analysen'); r.result.createObjectStore('archive'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch { this.db = null; }
  },
  get(store, key) {
    return new Promise(res => {
      if (!this.db) return res(undefined);
      try {
        const r = this.db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      } catch { res(undefined); }
    });
  },
  put(store, key, wert) {
    return new Promise(res => {
      if (!this.db) return res();
      try {
        const t = this.db.transaction(store, 'readwrite');
        t.objectStore(store).put(wert, key);
        t.oncomplete = t.onerror = () => res();
      } catch { res(); }
    });
  },
};

// ---------------------------------------------------------------- Download

async function holeJson(url) {
  for (let versuch = 0; versuch < 5; versuch++) {
    const r = await fetch(url);
    if (r.status === 429) { await new Promise(s => setTimeout(s, 3000 * (versuch + 1))); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`chess.com antwortet mit Fehler ${r.status}`);
    return r.json();
  }
  throw new Error('chess.com ist gerade überlastet, bitte gleich nochmal versuchen.');
}

async function ladePartien(user, fortschritt) {
  const index = await holeJson(`https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`);
  if (!index) throw new Error(`Spieler „${user}“ wurde auf chess.com nicht gefunden.`);
  const jetzt = new Date(), aktuell = `${jetzt.getUTCFullYear()}/${String(jetzt.getUTCMonth() + 1).padStart(2, '0')}`;
  const partien = [];
  for (const [i, url] of index.archives.entries()) {
    fortschritt(i, index.archives.length);
    const monat = url.split('/').slice(-2).join('/');
    // Abgeschlossene Monate ändern sich nicht mehr -> aus dem Speicher lesen
    let daten = monat !== aktuell ? await DB.get('archive', url) : undefined;
    if (!daten) {
      daten = await holeJson(url) || { games: [] };
      await DB.put('archive', url, daten);
    }
    partien.push(...(daten.games || []));
  }
  // Nur normales Schach (keine Varianten wie Chess960 oder Bughouse)
  return partien.filter(p => p.rules === 'chess' && p.pgn).sort((a, b) => b.end_time - a.end_time);
}

// ---------------------------------------------------------------- Stockfish (mehrere Worker parallel)

class Engine {
  constructor(url) {
    this.w = new Worker(url + '#' + encodeURIComponent(SF_WASM));
    this.zeilen = {};
    this.warte = null;
    this.bereit = new Promise(res => { this.beiBereit = res; });
    this.w.onmessage = e => this.nachricht(String(e.data));
    this.w.postMessage('uci');
  }
  nachricht(l) {
    if (l === 'uciok') {
      this.w.postMessage('setoption name MultiPV value 2');
      this.w.postMessage('setoption name Hash value 32');
      this.w.postMessage('isready');
    } else if (l === 'readyok') this.beiBereit();
    else if (l.startsWith('info') && l.includes(' pv ')) {
      const m = l.match(/ multipv (\d+)/);
      this.zeilen[m ? +m[1] : 1] = l;
    } else if (l.startsWith('bestmove') && this.warte) {
      const r = this.warte;
      this.warte = null;
      r(this.zeilen);
    }
  }
  async analysiere(fen, ms) {
    await this.bereit;
    this.zeilen = {};
    return new Promise(res => {
      this.warte = res;
      this.w.postMessage('position fen ' + fen);
      this.w.postMessage('go movetime ' + ms);
    });
  }
}

/** UCI-Ausgabe -> Bewertung in Centipawns aus Sicht von Weiß + die zwei besten Züge als [uci, cp, variante]. */
function auswerten(fen, zeilen) {
  const weiss = fen.split(' ')[1] === 'w';
  const linien = Object.keys(zeilen).sort((a, b) => a - b).map(k => {
    const l = zeilen[k], s = l.match(/ score (cp|mate) (-?\d+)/);
    let cp = +s[2];
    if (s[1] === 'mate') cp = cp > 0 ? 10000 - cp : -10000 - cp;
    if (!weiss) cp = -cp;
    const pv = l.split(' pv ')[1].trim().split(/\s+/).slice(0, 10);
    return [pv[0], cp, pv];
  });
  return { cp: linien.length ? linien[0][1] : 0, linien };
}

const Pool = {
  engines: [], frei: [], schlange: [],
  async starten() {
    if (this.start) return this.start;
    this.start = (async () => {
      const r = await fetch(SF_JS);
      if (!r.ok) throw new Error('Stockfish konnte nicht geladen werden.');
      const url = URL.createObjectURL(new Blob([await r.text()], { type: 'application/javascript' }));
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const e = new Engine(url);
        this.engines.push(e);
        this.frei.push(e);
      }
    })();
    return this.start;
  },
  bewerte(fen, ms) {
    return new Promise((res, rej) => { this.schlange.push({ fen, ms, res, rej }); this.weiter(); });
  },
  weiter() {
    while (this.frei.length && this.schlange.length) {
      const e = this.frei.pop(), job = this.schlange.shift();
      e.analysiere(job.fen, job.ms).then(z => {
        this.frei.push(e);
        job.res(auswerten(job.fen, z));
        this.weiter();
      });
    }
  },
  abbrechen() {
    const s = this.schlange;
    this.schlange = [];
    s.forEach(j => j.rej(new Error('abgebrochen')));
  },
};

async function bewerte(fen, ms) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: c.turn() === 'w' ? -10000 : 10000, linien: [] };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, linien: [] };
  return Pool.bewerte(fen, ms);
}

function ziehe(c, uci) {
  try { return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { return null; }
}

function phase(fen) {
  if (+fen.split(' ')[5] <= 12) return 'Eröffnung';
  return (fen.split(' ')[0].match(/[nbrqNBRQ]/g) || []).length <= 6 ? 'Endspiel' : 'Mittelspiel';
}

async function analysierePartie(pgn, ms, fortschritt) {
  await Pool.starten();
  const c = new Chess();
  c.loadPgn(pgn);
  const verlauf = c.history({ verbose: true });
  const uhren = [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(m => +m[1] * 3600 + +m[2] * 60 + +m[3]);
  const fens = [verlauf.length ? verlauf[0].before : c.fen(), ...verlauf.map(m => m.after)];
  let fertig = 0;
  const bew = await Promise.all(fens.map(f => bewerte(f, ms).then(r => { fortschritt?.(++fertig, fens.length); return r; })));
  const zuege = [];
  let letzterSchlag = null;  // Feld, auf dem der Gegner zuletzt geschlagen hat
  verlauf.forEach((m, i) => {
    const linien = bew[i].linien;
    const best = linien.length ? ziehe(new Chess(m.before), linien[0][0]) : null;
    const schlag = !!m.captured;
    zuege.push({
      san: m.san, uci: m.from + m.to + (m.promotion || ''), farbe: m.color, zugnr: +m.before.split(' ')[5],
      phase: phase(m.before), fen_vorher: m.before, vorher: bew[i].cp, linien, best: best ? best.san : null,
      uhr: uhren.length === verlauf.length ? uhren[i] : null, legal: new Chess(m.before).moves().length,
      rueck: schlag && m.to === letzterSchlag, nachher: bew[i + 1].cp, fen: m.after,
      antwort: bew[i + 1].linien.length ? bew[i + 1].linien[0][2] : [],
    });
    letzterSchlag = schlag ? m.to : null;
  });
  return zuege;
}

// ---------------------------------------------------------------- Material und Opfer

const andere = f => f === 'w' ? 'b' : 'w';
function mitZug(fen, farbe) { const t = fen.split(' '); t[1] = farbe; t[3] = '-'; return t.join(' '); }
function anzahl(fen, typ, farbe) {
  const z = farbe === 'w' ? typ.toUpperCase() : typ;
  let n = 0;
  for (const c of fen.split(' ')[0]) if (c === z) n++;
  return n;
}
/** Materialvorsprung von 'farbe' in Bauerneinheiten. */
function bilanz(fen, farbe) {
  return ['p', 'n', 'b', 'r', 'q'].reduce((s, t) => s + WERT[t] * (anzahl(fen, t, farbe) - anzahl(fen, t, andere(farbe))), 0);
}
function istSchlag(c, uci) {
  const von = c.get(uci.slice(0, 2)), nach = uci.slice(2, 4);
  return !!c.get(nach) || (von && von.type === 'p' && uci[0] !== uci[2]);
}

/** Was die Seite am Zug netto gewinnt, wenn sie auf 'feld' schlägt und beide Seiten abwechselnd
 *  mit der billigsten Figur zurückschlagen (0 = Schlagen lohnt sich nicht). */
function abtausch(c, feld) {
  const ziel = c.get(feld);
  if (!ziel || !c.attackers(feld, c.turn()).length) return 0;
  const zuege = c.moves({ verbose: true }).filter(m => m.to === feld && (!m.promotion || m.promotion === 'q'));
  if (!zuege.length) return 0;
  const m = zuege.reduce((a, b) => WERT[b.piece] < WERT[a.piece] ? b : a);
  const nach = new Chess(c.fen(), { skipValidation: true });
  nach.move({ from: m.from, to: m.to, promotion: m.promotion });
  return Math.max(0, WERT[ziel.type] - abtausch(nach, feld));
}

/** Wie viel Material der Zug dem Gegner anbietet (0 = kein Opfer) und auf welchem Feld. */
function opfer(fen, uci) {
  const c = new Chess(fen), farbe = c.turn();
  const gefaehrdet = f => {
    const g = new Chess(mitZug(f, andere(farbe)), { skipValidation: true });
    const r = new Map();
    for (const sq of SQUARES) {
      const p = g.get(sq);
      if (p && p.color === farbe && p.type !== 'p' && p.type !== 'k') {
        const gewinn = abtausch(g, sq);
        if (gewinn > 0) r.set(sq, gewinn);
      }
    }
    return r;
  };
  const vorher = gefaehrdet(fen);
  const m = ziehe(c, uci);
  if (!m || c.isCheckmate()) return [0, null];
  const geschlagen = m.captured ? WERT[m.captured] : 0;
  // Nur Figuren, die erst durch diesen Zug in Gefahr geraten. Eine frisch umgewandelte Figur zählt nicht.
  let best = [0, null];
  for (const [sq, gewinn] of gefaehrdet(c.fen())) {
    if (vorher.has(sq) || (sq === m.to && (vorher.has(m.from) || m.promotion))) continue;
    if (gewinn > best[0]) best = [gewinn, sq];
  }
  return best[1] ? [Math.max(0, best[0] - geschlagen), best[1]] : [0, null];
}

// ---------------------------------------------------------------- Einstufung

function gewinnchance(cp) {
  cp = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
const chanceFuer = (farbe, cp) => farbe === 'w' ? gewinnchance(cp) : 100 - gewinnchance(cp);
const zugGenauigkeit = v => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * v) - 3.1669));

/** Stuft jeden Zug beider Seiten nach dem Vorbild des chess.com Game Review ein. */
function klassifiziere(zuege) {
  zuege.forEach((z, i) => {
    const f = z.farbe;
    const vorher = chanceFuer(f, z.vorher), nachher = chanceFuer(f, z.nachher);
    const istBest = z.linien.length > 0 && z.uci === z.linien[0][0];
    const verlust = istBest ? 0 : Math.max(0, vorher - nachher);
    const andereLinien = z.linien.filter(l => l[0] !== z.uci).map(l => chanceFuer(f, l[1]));
    const alternative = andereLinien.length ? Math.max(...andereLinien) : null;

    let k = istBest ? 'best' : verlust < EXCELLENT ? 'excellent' : verlust < GOOD ? 'good'
      : verlust < INACCURACY ? 'inaccuracy' : verlust < MISTAKE ? 'mistake' : 'blunder';
    const gegner = i > 0 ? zuege[i - 1] : null;
    z.opfer = 0; z.opfer_feld = null;
    if ((k === 'mistake' || k === 'blunder') && gegner && gegner.verlust >= INACCURACY
        && nachher >= chanceFuer(f, gegner.vorher) - 3) {
      // Der Gegner hat sich vergriffen, man hat es nicht ausgenutzt, steht aber nicht schlechter als vorher
      k = 'miss';
    } else if ((k === 'best' || k === 'excellent') && nachher >= 50
        && (alternative == null || alternative < BRILLIANT_MAX_ALTERNATIVE)
        && ([z.opfer, z.opfer_feld] = opfer(z.fen_vorher, z.uci))[0] >= BRILLIANT_OPFER) {
      k = 'brilliant';
    } else if (istBest && z.legal > 1 && !z.rueck && alternative != null && vorher - alternative >= GREAT_ABSTAND) {
      k = 'great';
    }
    Object.assign(z, { verlust, klasse: k, chance_vorher: vorher, chance_nachher: nachher });
  });
  zuege.forEach((z, i) => {
    z.warum = SCHLECHT.has(z.klasse) ? erklaere(z, i > 0 ? zuege[i - 1] : null)
      : z.klasse === 'brilliant' ? erklaereBrilliant(z) : '';
  });
}

// ---------------------------------------------------------------- Erklärungen

const den = t => ({ q: 'die Dame', p: 'den Bauern', k: 'den König' }[t] || 'den ' + FIGUR[t]);

/** Spielt die Variante, bis kein Schlagzug mehr folgt (sonst zählt ein halber Abtausch). */
function bisRuhig(fen, variante, max = 10) {
  const c = new Chess(fen);
  let ruhig = fen, gespielt = [];
  const zuege = variante.slice(0, max);
  for (let i = 0; i < zuege.length; i++) {
    if (!ziehe(c, zuege[i])) break;
    const naechster = zuege[i + 1];
    if (!naechster || !istSchlag(c, naechster)) { ruhig = c.fen(); gespielt = zuege.slice(0, i + 1); }
  }
  return [ruhig, gespielt];
}

/** Text für n Bauerneinheiten Materialunterschied ('die Qualität' wird erkannt). */
function menge(n, start, ende, farbe, akkusativ = false) {
  const turm = anzahl(start, 'r', farbe) - anzahl(ende, 'r', farbe);
  const leicht = ['n', 'b'].reduce((s, t) => s + anzahl(ende, t, andere(farbe)) - anzahl(start, t, andere(farbe)), 0);
  if (n === 2 && Math.abs(turm) === 1 && Math.abs(leicht) === 1) return 'die Qualität';
  if (MENGE[n]) return MENGE[n][akkusativ ? 1 : 0];
  return `Material im Wert von ${n} Bauern`;
}

function varianteText(fen, ucis, n = 4) {
  const c = new Chess(fen), teile = [];
  for (const [i, u] of ucis.slice(0, n).entries()) {
    const nr = c.moveNumber(), weiss = c.turn() === 'w';
    const m = ziehe(c, u);
    if (!m) break;
    teile.push(weiss ? `${nr}. ${m.san}` : i === 0 ? `${nr}... ${m.san}` : m.san);
  }
  return teile.join(' ');
}

/** Felder der Figuren, die die gezogene Figur nach 'uci' gleichzeitig angreift (Gabel), sonst []. */
function gabel(fen, uci) {
  const c = new Chess(fen);
  const m = ziehe(c, uci);
  if (!m) return [];
  const angreifer = c.get(m.to), ziele = [];
  for (const f of SQUARES) {
    const p = c.get(f);
    if (!p || p.color === angreifer.color || !c.attackers(f, angreifer.color).includes(m.to)) continue;
    if (p.type === 'k' || (p.type !== 'p' && (WERT[p.type] > WERT[angreifer.type] || !c.attackers(f, p.color).length)))
      ziele.push([f, p.type]);
  }
  return ziele.length >= 2 ? ziele : [];
}

/** [Feld, Typ, Index] der Figur, die in der Variante tatsächlich verloren geht (nicht nur abgetauscht). */
function verloreneFigur(fen, variante, ende, farbe) {
  const netto = new Set(['p', 'n', 'b', 'r', 'q'].filter(t =>
    anzahl(fen, t, farbe) - anzahl(ende, t, farbe) > anzahl(fen, t, andere(farbe)) - anzahl(ende, t, andere(farbe))));
  const c = new Chess(fen);
  for (const [i, u] of variante.entries()) {
    const ziel = c.get(u.slice(2, 4));
    if (c.turn() !== farbe && ziel && netto.has(ziel.type)) return [u.slice(2, 4), ziel.type, i];
    if (!ziehe(c, u)) break;
  }
  return null;
}

/** Ein bis drei Sätze, warum ein Zug schlecht ist. */
function erklaere(z, gegnerzug) {
  const farbe = z.farbe, sicht = cp => farbe === 'w' ? cp : -cp;
  const vorher = z.fen_vorher, nachher = z.fen;
  const beste = z.linien.length ? z.linien[0][2] : [];
  const antwort = z.antwort || [];
  const saetze = [];
  if (z.klasse === 'miss' && gegnerzug)
    saetze.push(`Der Gegner hat mit ${gegnerzug.san} einen Fehler gemacht, das wird nicht ausgenutzt.`);

  const cpVorher = sicht(z.vorher), cpNachher = sicht(z.nachher);
  const start = bilanz(vorher, farbe);
  const [endeGegner, gespieltGegner] = bisRuhig(nachher, antwort);
  const verlust = start - bilanz(endeGegner, farbe);
  const [endeBest] = bisRuhig(vorher, beste);
  const gewinn = bilanz(endeBest, farbe) - start;

  if (cpNachher <= -9000) {
    saetze.push(`Erlaubt ein Matt in ${10000 + cpNachher}: ${varianteText(nachher, antwort, 6)}.`);
  } else if (cpVorher >= 9000) {
    saetze.push(`Verpasst ein Matt in ${10000 - cpVorher}: ${varianteText(vorher, beste, 6)}.`);
  } else if (verlust >= 1 && antwort.length) {
    const r = antwort[0], c = new Chess(nachher);
    const geschlagen = c.get(r.slice(2, 4)), zieher = c.get(r.slice(0, 2));
    let ziele = gabel(nachher, r);
    if (geschlagen && zieher && WERT[geschlagen.type] >= WERT[zieher.type]) ziele = [];  // Abtausch, keine Gabel
    const rSan = varianteText(nachher, [r], 1).replace(/^\d+\.+ /, '');
    if (ziele.length) {
      saetze.push(`Erlaubt eine Gabel: ${rSan} greift ${ziele.slice(0, 2).map(([f, t]) => `${den(t)} auf ${f}`).join(' und ')} gleichzeitig an.`);
    } else {
      const d = new Chess(nachher);
      ziehe(d, r);
      if (d.inCheck()) saetze.push(`Erlaubt ${rSan} mit Schach.`);
    }
    const variante = gespieltGegner.length ? gespieltGegner : antwort;
    const verloren = verloreneFigur(nachher, variante, endeGegner, farbe);
    if (verloren && !ziele.length) {
      const [feld, typ, i] = verloren;
      // "gezogen" nur, wenn vorher in der Variante niemand auf dieses Feld gezogen ist
      const gezogen = feld === z.uci.slice(2, 4) && variante.slice(0, i).every(u => u.slice(2, 4) !== feld);
      saetze.push(`${typ === 'q' ? 'Die' : 'Der'} ${gezogen ? 'gezogene ' : ''}${FIGUR[typ]} auf ${feld} geht verloren: `
        + `${varianteText(nachher, variante, Math.max(4, i + 1))}.`);
    } else {
      const was = menge(verlust, vorher, endeGegner, farbe);
      const verb = was.startsWith('zwei') || was.includes(' und ') ? 'gehen' : 'geht';
      saetze.push(`Nach ${varianteText(nachher, variante, 6)} ${verb} ${was} verloren.`);
    }
  } else if (gewinn >= 1) {
    saetze.push(`Verpasst, ${menge(gewinn, vorher, endeBest, andere(farbe), true)} zu gewinnen.`);
  } else {
    saetze.push(`Kein direkter Materialverlust, aber die Stellung wird schlechter `
      + `(Gewinnchance ${z.chance_vorher.toFixed(0)} % → ${z.chance_nachher.toFixed(0)} %).`);
    if (antwort.length) saetze.push(`Der Gegner antwortet am besten mit ${varianteText(nachher, antwort, 3)}.`);
  }
  if (beste.length && z.uci !== beste[0]) saetze.push(`Besser war ${varianteText(vorher, beste)}.`);
  return saetze.join(' ');
}

/** Warum ein Opfer brillant ist: was geopfert wird und was nach der Annahme passiert. */
function erklaereBrilliant(z) {
  const farbe = z.farbe, sicht = cp => farbe === 'w' ? cp : -cp;
  const vorher = z.fen_vorher, nachher = z.fen, feld = z.opfer_feld;
  const typ = new Chess(nachher).get(feld).type;
  const geschlagen = new Chess(vorher).get(z.uci.slice(2, 4));
  const ein = { p: 'ein Bauer', n: 'ein Springer', b: 'ein Läufer', r: 'ein Turm', q: 'die Dame' };
  const saetze = [`Opfert ${den(typ)} auf ${feld}${geschlagen ? ` – geschlagen wurde nur ${ein[geschlagen.type]}` : ''}. `
    + 'Der Gegner kann die Figur schlagen, aber das hilft ihm nicht.'];
  const antwort = z.antwort || [], cp = sicht(z.nachher);
  if (antwort.length && antwort[0].slice(2, 4) === feld && istSchlag(new Chess(nachher), antwort[0])) {
    const [ende, gespielt] = bisRuhig(nachher, antwort);
    const linie = varianteText(nachher, antwort, Math.max(4, gespielt.length));
    if (cp >= 9000) saetze.push(`Nimmt er an, folgt Matt in ${10000 - cp}: ${linie}.`);
    else {
      const diff = bilanz(ende, farbe) - bilanz(vorher, farbe);
      const folge = diff >= 1 ? `am Ende hat man sogar ${menge(diff, vorher, ende, andere(farbe), true)} mehr`
        : diff >= 0 ? 'das Material kommt zurück'
          : `trotz Materialnachteil steht man gut (Gewinnchance ${z.chance_nachher.toFixed(0)} %)`;
      saetze.push(`Nimmt er an, folgt ${linie} – ${folge}.`);
    }
  } else if (antwort.length) {
    if (cp >= 9000) saetze.push(`Das Opfer führt zu Matt in ${10000 - cp}.`);
    saetze.push(`Annehmen wäre für den Gegner noch schlechter, seine beste Antwort ist ${varianteText(nachher, antwort, 4)}.`);
  }
  const alt = z.linien.filter(l => l[0] !== z.uci).map(l => [chanceFuer(farbe, l[1]), l[0]]).sort((a, b) => b[0] - a[0])[0];
  if (alt) {
    const san = varianteText(vorher, [alt[1]], 1).replace(/^\d+\.+ /, '');
    saetze.push(z.chance_nachher - alt[0] >= 3
      ? `Ohne das Opfer (z. B. ${san}) läge die Gewinnchance nur bei ${alt[0].toFixed(0)} % statt ${z.chance_nachher.toFixed(0)} %.`
      : `${san} wäre ähnlich gut gewesen, aber das Opfer muss man erst einmal sehen.`);
  }
  return saetze.join(' ');
}

// ---------------------------------------------------------------- Auswertung einer Partie

function eroeffnung(p) {
  const slug = (p.eco || '').replace(/\/$/, '').split('/').pop();
  if (!slug) return ['Unbekannt', 'Unbekannt'];
  const name = slug.split(/-\d+\./)[0].replace(/-/g, ' ').trim() || 'Unbekannt';
  const woerter = name.split(' ');
  let familie = woerter.slice(0, 3).join(' ');
  const i = woerter.findIndex(w => ['Defense', 'Opening', 'Game', 'Gambit', 'Attack', 'System'].includes(w));
  if (i >= 0) familie = woerter.slice(0, i + 1).join(' ');
  return [name, familie];
}

function startzeit(p) {
  const tc = p.time_control || '';
  if (!tc || tc.includes('/')) return null;  // Daily-Partien
  const s = parseInt(tc.split('+')[0], 10);
  return Number.isFinite(s) ? s : null;
}

function werteAus(user, p, zuege) {
  klassifiziere(zuege);
  const farbe = p.white.username.toLowerCase() === user.toLowerCase() ? 'w' : 'b';
  const ich = farbe === 'w' ? p.white : p.black, gegner = farbe === 'w' ? p.black : p.white;
  const punkte = ich.result === 'win' ? 1 : REMIS.has(ich.result) ? 0.5 : 0;
  const basis = startzeit(p);
  const [name, familie] = eroeffnung(p);
  const eigene = [];
  zuege.forEach((z, i) => {
    if (z.farbe !== farbe) return;
    const zeitnot = basis != null && z.uhr != null && z.uhr < Math.max(10, basis * 0.1);
    eigene.push({ ...z, ply: i + 1, zeitnot });
  });
  const gen = f => mittel(zuege.filter(z => z.farbe === f).map(z => zugGenauigkeit(z.verlust)));
  return {
    id: pid(p), p, url: p.url, datum: new Date(p.end_time * 1000), zeitklasse: p.time_class || '?', farbe,
    gegner: gegner.username, gegnerRating: gegner.rating, punkte, genauigkeit: gen(farbe), genWB: [gen('w'), gen('b')],
    eroeffnung: name, familie, zuege: eigene, alle: zuege,
  };
}

function viewerDaten(g) {
  const { p } = g, w = p.white, b = p.black;
  const erg = w.result === 'win' ? '1-0' : b.result === 'win' ? '0-1' : '½-½';
  const fenMatch = p.pgn.match(/\[FEN "([^"]+)"\]/);
  return {
    url: g.url, datum: datum(g.datum), zeit: g.zeitklasse, w: [w.username, w.rating], b: [b.username, b.rating], erg,
    ich: g.farbe, er: g.eroeffnung, start: fenMatch ? fenMatch[1] : new Chess().fen(),
    cp0: g.alle.length ? g.alle[0].vorher : 0, gen: g.genWB,
    z: g.alle.map(z => [z.san, z.uci, z.fen, z.klasse, z.nachher, z.best || '', z.linien.length ? z.linien[0][0] : '', z.warum]),
  };
}

// ---------------------------------------------------------------- Zustand

const S = {
  user: null, partien: [], byId: new Map(), analysen: new Map(), auswertung: new Map(),
  laeuft: false, abbruch: false, ms: +(speicher.get('rechenzeit') || 200), zeigeAnzahl: 100, fortschritt: '',
};

function auswertungVon(id) {
  if (!S.auswertung.has(id) && S.analysen.has(id))
    S.auswertung.set(id, werteAus(S.user, S.byId.get(id), structuredClone(S.analysen.get(id))));
  return S.auswertung.get(id);
}

async function analyseFuer(id, fortschritt) {
  if (S.analysen.has(id)) return;
  const zuege = await analysierePartie(S.byId.get(id).pgn, S.ms, fortschritt);
  S.analysen.set(id, zuege);
  await DB.put('analysen', `${CACHE_VERSION}:${id}`, zuege);
}

// ---------------------------------------------------------------- Übersicht

function tabelle(kopf, zeilen, rechtsAb = 1) {
  const k = kopf.map((h, i) => `<th class="${i >= rechtsAb ? 'r' : ''}">${esc(h)}</th>`).join('');
  const z = zeilen.map(zeile => '<tr>' + zeile.map((c, i) => `<td class="${i >= rechtsAb ? 'r' : ''}">${c}</td>`).join('') + '</tr>').join('');
  return `<div class="scroll"><table><thead><tr>${k}</tr></thead><tbody>${z}</tbody></table></div>`;
}
const zaehle = (zz, k) => zz.filter(z => z.klasse === k).length;
const zugtext = z => `${z.zugnr}${z.farbe === 'w' ? '.' : '...'} ${z.san}`;
const link = (id, ply = 0) => `#u=${encodeURIComponent(S.user)}&p=${encodeURIComponent(id)}&z=${ply}`;
const ansehen = (g, ply = 0, text = 'Ansehen') => `<a href="${link(g.id, ply)}">${text}</a>`;
function gruppenZeile(name, gruppe) {
  const n = gruppe.length, blunder = gruppe.reduce((s, g) => s + zaehle(g.zuege, 'blunder'), 0);
  return [esc(name), n, prozent(100 * gruppe.reduce((s, g) => s + g.punkte, 0) / n),
    prozent(mittel(gruppe.map(g => g.genauigkeit))), (blunder / n).toFixed(2).replace('.', ',')];
}
function gruppiere(liste, schluessel) {
  const m = new Map();
  for (const x of liste) { const k = schluessel(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function karriereHTML(auswertung) {
  const n = auswertung.length;
  const siege = auswertung.filter(g => g.punkte === 1).length, remis = auswertung.filter(g => g.punkte === 0.5).length;
  const alle = auswertung.flatMap(g => g.zuege);
  const teile = [];
  const karten = [['Analysierte Partien', n], ['Siege / Remis / Niederlagen', `${siege} / ${remis} / ${n - siege - remis}`],
    ['Ø Genauigkeit', prozent(mittel(auswertung.map(g => g.genauigkeit)))],
    ['Blunder pro Partie', (zaehle(alle, 'blunder') / Math.max(n, 1)).toFixed(2).replace('.', ',')],
    ['Brilliant-Züge', zaehle(alle, 'brilliant')]];
  teile.push('<div class="karten">' + karten.map(([l, w]) =>
    `<div class="karte"><div class="wert">${esc(w)}</div><div class="label">${esc(l)}</div></div>`).join('') + '</div>');

  teile.push('<h2>Deine Züge nach Klasse</h2>' + tabelle(['Klasse', 'Züge', 'Pro 100 Züge'],
    Object.keys(KL).map(k => [`${sym(k)} ${KL[k][0]}`, zaehle(alle, k), (100 * zaehle(alle, k) / Math.max(alle.length, 1)).toFixed(1).replace('.', ',')])));

  // Brilliant-Züge der ganzen Karriere
  const brillant = auswertung.flatMap(g => g.zuege.filter(z => z.klasse === 'brilliant').map(z => [g, z]));
  teile.push(`<h2>Deine Brilliant-Züge (${brillant.length})</h2>` + (brillant.length
    ? '<p class="hinweis">Neueste zuerst. Klick öffnet die Partie an dieser Stelle.</p><div class="galerie">'
      + brillant.map(([g, z]) => galerieKarte(g, z)).join('') + '</div>'
    : '<p class="hinweis">Noch keine Brilliant-Züge gefunden.</p>'));

  const kopf = ['', 'Partien', 'Punkte', 'Ø Genauigkeit', 'Blunder/Partie'];
  teile.push('<h2>Nach Zeitkontrolle</h2>' + tabelle(kopf,
    [...gruppiere(auswertung, g => g.zeitklasse)].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => gruppenZeile(k, v))));

  const schlecht = [...SCHLECHT];
  const phasen = ['Eröffnung', 'Mittelspiel', 'Endspiel'].map(ph => [ph, alle.filter(z => z.phase === ph)]).filter(([, zz]) => zz.length);
  teile.push('<h2>Fehler nach Spielphase</h2><p class="hinweis">Anzahl pro 100 eigene Züge.</p>' + tabelle(
    ['Phase', 'Züge', 'Ø Genauigkeit', ...schlecht.map(k => KL[k][0])],
    phasen.map(([ph, zz]) => [ph, zz.length, prozent(mittel(zz.map(z => zugGenauigkeit(z.verlust)))),
      ...schlecht.map(k => (100 * zaehle(zz, k) / zz.length).toFixed(1).replace('.', ','))])));

  const zeitnot = [['Genug Zeit', alle.filter(z => !z.zeitnot)], ['Zeitnot (< 10 % der Startzeit)', alle.filter(z => z.zeitnot)]]
    .filter(([, zz]) => zz.length);
  teile.push('<h2>Zeitnot</h2>' + tabelle(['', 'Züge', 'Ø Genauigkeit', 'Blunder pro 100 Züge'],
    zeitnot.map(([name, zz]) => [name, zz.length, prozent(mittel(zz.map(z => zugGenauigkeit(z.verlust)))),
      (100 * zaehle(zz, 'blunder') / zz.length).toFixed(1).replace('.', ',')])));

  for (const [farbe, titel] of [['w', 'Weiß'], ['b', 'Schwarz']]) {
    const liste = [...gruppiere(auswertung.filter(g => g.farbe === farbe), g => g.familie)]
      .filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
    if (liste.length) teile.push(`<h2>Eröffnungen mit ${titel}</h2><p class="hinweis">Mindestens 3 Partien.</p>`
      + tabelle(['Eröffnung', ...kopf.slice(1)], liste.map(([k, v]) => gruppenZeile(k, v))));
  }

  const monate = [...gruppiere(auswertung, g => `${g.datum.getFullYear()}-${String(g.datum.getMonth() + 1).padStart(2, '0')}`)]
    .sort((a, b) => b[0].localeCompare(a[0]));
  teile.push('<h2>Verlauf pro Monat</h2>' + tabelle(['Monat', ...kopf.slice(1)], monate.map(([k, v]) => gruppenZeile(k, v))));

  const blunder = auswertung.flatMap(g => g.zuege.filter(z => z.klasse === 'blunder').map(z => [g, z]))
    .sort((a, b) => b[1].verlust - a[1].verlust).slice(0, 30);
  teile.push('<h2>Die 30 schlimmsten Blunder</h2><p class="hinweis">Gewinnchance vor → nach dem Zug.</p>' + tabelle(
    ['Datum', 'Gegner', 'Gespielt', 'Besser', 'Gewinnchance', 'Warum', ''],
    blunder.map(([g, z]) => [datum(g.datum), esc(g.gegner), esc(zugtext(z)), esc(z.best || '–'),
      `${z.chance_vorher.toFixed(0)} % → ${z.chance_nachher.toFixed(0)} %`, `<div class="warum">${esc(z.warum)}</div>`,
      ansehen(g, z.ply)]), 6));
  return teile.join('');
}

function partienHTML() {
  const ergebnis = { 1: 'Sieg', 0.5: 'Remis', 0: 'Niederlage' };
  const zeilen = S.partien.slice(0, S.zeigeAnzahl).map(p => {
    const id = pid(p), g = auswertungVon(id);
    const farbe = p.white.username.toLowerCase() === S.user.toLowerCase() ? 'w' : 'b';
    const ich = farbe === 'w' ? p.white : p.black, gegner = farbe === 'w' ? p.black : p.white;
    const punkte = ich.result === 'win' ? 1 : REMIS.has(ich.result) ? 0.5 : 0;
    return [datum(new Date(p.end_time * 1000)), esc(p.time_class), farbe === 'w' ? 'Weiß' : 'Schwarz',
      `${esc(gegner.username)} (${esc(gegner.rating)})`, ergebnis[punkte], g ? prozent(g.genauigkeit) : '–',
      g ? ['brilliant', 'mistake', 'miss', 'blunder'].map(k => `${sym(k)}${zaehle(g.zuege, k)}`).join(' ') : '',
      `<a href="${link(id)}">${g ? 'Ansehen' : 'Analysieren'}</a> · <a href="${esc(p.url)}" target="_blank" rel="noopener">chess.com</a>`];
  });
  return '<h2>Partien</h2><p class="hinweis">„Analysieren“ öffnet das Game Review – die Analyse dauert ein paar Sekunden.</p>'
    + tabelle(['Datum', 'Zeit', 'Farbe', 'Gegner', 'Ergebnis', 'Genauigkeit', 'Brilliant · Mistake · Miss · Blunder', ''], zeilen, 5)
    + (S.partien.length > S.zeigeAnzahl
      ? `<button class="knopf mehr" id="mehr">Weitere Partien anzeigen (${S.partien.length - S.zeigeAnzahl} übrig)</button>` : '');
}

function zeigeUebersicht() {
  stopp();
  const analysiert = S.partien.filter(p => S.analysen.has(pid(p))).length;
  const auswertung = S.partien.map(p => auswertungVon(pid(p))).filter(Boolean);
  const offen = S.partien.length - analysiert;
  const zeiten = [[100, 'schnell'], [200, 'normal'], [500, 'genau']];
  $('uebersicht').innerHTML = `
    <h1>${esc(S.user)}</h1>
    <p class="unter">${S.partien.length} Partien auf chess.com · ${analysiert} davon analysiert</p>
    <div class="leiste">
      <button class="knopf haupt" id="alle" ${offen || S.laeuft ? '' : 'disabled'}>${S.laeuft ? 'Analyse stoppen'
        : offen ? `Alle ${offen} Partien analysieren` : 'Alle Partien analysiert'}</button>
      <select id="rechenzeit" title="Rechenzeit pro Stellung">${zeiten.map(([ms, n]) =>
        `<option value="${ms}" ${ms === S.ms ? 'selected' : ''}>${n} (${ms / 1000} s pro Stellung)</option>`).join('')}</select>
      <div class="fortschritt" id="fortschritt" ${S.laeuft ? '' : 'hidden'}>
        <div class="balken"><div id="balken"></div></div><div class="text" id="fortschritt-text">${S.fortschritt}</div></div>
    </div>
    ${auswertung.length ? (analysiert < S.partien.length
      ? `<p class="hinweis" style="margin-top:14px">Statistik aus ${analysiert} von ${S.partien.length} Partien. Analysiere alle für deine ganze Karriere.</p>` : '')
      + karriereHTML(auswertung)
      : '<p class="hinweis" style="margin-top:14px">Noch nichts analysiert. Klick auf „Alle Partien analysieren“ für deine Karriere-Statistik und Brilliant-Galerie – oder öffne einzelne Partien unten.</p>'}
    ${partienHTML()}`;
  $('alle').onclick = alleAnalysieren;
  $('rechenzeit').onchange = e => { S.ms = +e.target.value; speicher.set('rechenzeit', S.ms); };
  if ($('mehr')) $('mehr').onclick = () => { S.zeigeAnzahl += 200; zeigeUebersicht(); };
  zeige('uebersicht');
}

async function alleAnalysieren() {
  if (S.laeuft) { S.abbruch = true; Pool.abbrechen(); return; }
  S.laeuft = true; S.abbruch = false;
  const offen = S.partien.filter(p => !S.analysen.has(pid(p)));
  const start = Date.now();
  let fertig = 0;
  const melde = text => {
    S.fortschritt = text;
    if ($('fortschritt-text')) $('fortschritt-text').textContent = text;
    if ($('balken')) $('balken').style.width = (100 * fertig / offen.length) + '%';
  };
  zeigeUebersicht();
  melde('Stockfish wird geladen …');
  for (const p of offen) {
    if (S.abbruch) break;
    try {
      await analyseFuer(pid(p));
    } catch (e) {
      if (S.abbruch) break;
      console.warn('Analyse fehlgeschlagen', p.url, e);
    }
    fertig++;
    const rest = (Date.now() - start) / fertig * (offen.length - fertig) / 60000;
    melde(`${fertig} von ${offen.length} Partien analysiert · noch ca. ${Math.ceil(rest)} min`);
    // Statistik zwischendurch auffrischen, solange die Übersicht offen ist
    if (!$('uebersicht').hidden && (fertig % 10 === 0)) zeigeUebersicht();
  }
  S.laeuft = false;
  S.fortschritt = '';
  if (!$('uebersicht').hidden) zeigeUebersicht();
}

function galerieKarte(g, z) {
  const sp = viewerDaten(g), gegner = sp.ich === 'w' ? sp.b : sp.w;
  const v = sp.z[z.ply - 1];
  return `<a class="galerie-karte" href="${link(g.id, z.ply)}">
    <div class="brett mini">${brettHTML(v[2], v, sp.ich, false)}</div>
    <div class="galerie-text"><b>${sym('brilliant')} ${esc(zugtext(z))}</b><br>
    <span>gegen ${esc(gegner[0])} (${gegner[1] ?? '?'}) · ${sp.erg} · ${sp.datum} · ${esc(sp.zeit)}</span>
    <p>${esc(z.warum)}</p></div></a>`;
}

// ---------------------------------------------------------------- Brett

const R = { spiel: null, id: null, ply: 0, orient: 'w', timer: null };
const feld = n => [n.charCodeAt(0) - 97, +n[1] - 1];
const anzeige = (f, r) => R.orient === 'w' ? [f, 7 - r] : [7 - f, r];
const cpBei = ply => ply === 0 ? R.spiel.cp0 : R.spiel.z[ply - 1][4];
const fenBei = ply => ply === 0 ? R.spiel.start : R.spiel.z[ply - 1][2];
function evalText(cp) {
  if (Math.abs(cp) >= 9000) { const m = 10000 - Math.abs(cp); return m === 0 ? '#' : 'M' + m; }
  return (cp > 0 ? '+' : '') + (cp / 100).toFixed(1);
}
function zugInfo(i) {  // Farbe und Zugnummer des i-ten Halbzugs (0-basiert)
  const t = R.spiel.start.split(' '), off = i + (t[1] === 'b' ? 1 : 0);
  return { farbe: off % 2 ? 'b' : 'w', nr: +t[5] + Math.floor(off / 2) };
}

function pfeil(uci, farbe, pos) {
  const [x1, y1] = pos(...feld(uci.slice(0, 2))).map(v => v + .5);
  const [x2, y2] = pos(...feld(uci.slice(2, 4))).map(v => v + .5);
  const l = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / l, uy = (y2 - y1) / l;
  const ex = x2 - ux * .45, ey = y2 - uy * .45;
  return `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${farbe}" stroke-width=".2" stroke-linecap="round"/>`
    + `<polygon points="${x2},${y2} ${ex - uy * .28},${ey + ux * .28} ${ex + uy * .28},${ey - ux * .28}" fill="${farbe}"/>`;
}

function brettHTML(fen, z, orient, koordinaten = true) {
  const pos = (f, r) => orient === 'w' ? [f, 7 - r] : [7 - f, r];
  const von = z && z[1].slice(0, 2), nach = z && z[1].slice(2, 4);
  let h = '';
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const [x, y] = pos(f, r), name = String.fromCharCode(97 + f) + (r + 1);
    let inhalt = '';
    if (koordinaten && x === 0) inhalt += `<span class="rang">${r + 1}</span>`;
    if (koordinaten && y === 7) inhalt += `<span class="linie">${name[0]}</span>`;
    h += `<div class="feld ${(f + r) % 2 ? 'hell' : 'dunkel'}" style="left:${x * 12.5}%;top:${y * 12.5}%">${inhalt}</div>`;
    if (name === von || name === nach)
      h += `<div class="mark" style="left:${x * 12.5}%;top:${y * 12.5}%;background:${KL[z[3]][1]}"></div>`;
  }
  fen.split(' ')[0].split('/').forEach((zeile, i) => {
    let f = 0;
    for (const c of zeile) {
      if (/\d/.test(c)) { f += +c; continue; }
      const r = 7 - i, [x, y] = pos(f, r), name = String.fromCharCode(97 + f) + (r + 1);
      const code = (c === c.toUpperCase() ? 'w' : 'b') + c.toUpperCase();
      h += `<div class="figur" data-feld="${name}" style="left:${x * 12.5}%;top:${y * 12.5}%;background-image:url(${FIG[code]})"></div>`;
      f++;
    }
  });
  if (z) {
    const [x, y] = pos(...feld(nach));
    h += `<div class="badge" style="left:${(x + 1) * 12.5}%;top:${y * 12.5}%;background:${KL[z[3]][1]}">${KL[z[3]][2]}</div>`;
  }
  h += '<svg class="pfeile" viewBox="0 0 8 8">';
  if (z && SCHLECHT.has(z[3]) && z[6]) h += pfeil(z[6], 'rgba(129,182,76,.85)', pos);
  return h + '</svg>';
}

function figurCode(name) {  // 'wK' usw. der Figur auf einem Feld der aktuellen Stellung
  const [f, r] = feld(name), zeile = fenBei(R.ply).split(' ')[0].split('/')[7 - r];
  let i = 0;
  for (const c of zeile) {
    if (/\d/.test(c)) { i += +c; continue; }
    if (i === f) return (c === c.toUpperCase() ? 'w' : 'b') + c.toUpperCase();
    i++;
  }
  return '';
}
function gleite(von, nach) {
  const el = $('brett').querySelector(`.figur[data-feld="${nach}"]`);
  if (!el) return;
  const [xv, yv] = anzeige(...feld(von)), [xn, yn] = anzeige(...feld(nach));
  el.style.transform = `translate(${(xv - xn) * 100}%, ${(yv - yn) * 100}%)`;
  el.getBoundingClientRect();
  el.style.transition = 'transform .2s ease';
  el.style.transform = '';
}
function zeichneBrett(animiert) {
  const z = R.ply > 0 ? R.spiel.z[R.ply - 1] : null;
  $('brett').innerHTML = brettHTML(fenBei(R.ply), z, R.orient);
  if (animiert && z) {
    const von = z[1].slice(0, 2), nach = z[1].slice(2, 4);
    gleite(von, nach);
    const [fv] = feld(von), [fn, rn] = feld(nach);
    if (figurCode(nach)[1] === 'K' && Math.abs(fn - fv) === 2) {  // Rochade: Turm mitbewegen
      gleite((fn > fv ? 'h' : 'a') + (rn + 1), (fn > fv ? 'f' : 'd') + (rn + 1));
    }
  }
}

function spielerZeile(farbe) {
  const [name, rating] = R.spiel[farbe], gen = R.spiel.gen[farbe === 'w' ? 0 : 1];
  return `<span>${farbe === 'w' ? '⚪' : '⚫'} ${esc(name)} <span class="gen">(${rating ?? '?'})${farbe === R.spiel.ich ? ' (du)' : ''}</span></span>`
    + `<span class="gen">Genauigkeit ${gen == null ? '–' : gen.toFixed(1)}</span>`;
}
function zeichneSpieler() {
  const oben = R.orient === 'w' ? 'b' : 'w';
  $('sp-oben').innerHTML = spielerZeile(oben);
  $('sp-unten').innerHTML = spielerZeile(andere(oben));
}
function baueZugliste() {
  let h = '', offen = '';
  R.spiel.z.forEach((z, i) => {
    const { farbe, nr } = zugInfo(i);
    const zelle = `<div class="zug" data-ply="${i + 1}">${sym(z[3])}${esc(z[0])}</div>`;
    if (farbe === 'w') offen = `<div class="zugzeile"><div class="nr">${nr}.</div>${zelle}`;
    else { h += (offen || `<div class="zugzeile"><div class="nr">${nr}.</div><div></div>`) + zelle + '</div>'; offen = ''; }
  });
  if (offen) h += offen + '<div></div></div>';
  $('zugliste').innerHTML = h;
}
function baueZusammenfassung() {
  const zahl = { w: {}, b: {} };
  R.spiel.z.forEach((z, i) => { const f = zugInfo(i).farbe; zahl[f][z[3]] = (zahl[f][z[3]] || 0) + 1; });
  const g = R.spiel.gen.map(x => x == null ? '–' : x.toFixed(1));
  let h = `<thead><tr><th>${esc(R.spiel.w[0])}</th><th></th><th>${esc(R.spiel.b[0])}</th></tr></thead><tbody>`
    + `<tr><td>${g[0]}</td><td>Genauigkeit</td><td>${g[1]}</td></tr>`;
  for (const k in KL)
    h += `<tr><td style="color:${KL[k][1]}">${zahl.w[k] || 0}</td><td>${sym(k)} ${KL[k][0]}</td><td style="color:${KL[k][1]}">${zahl.b[k] || 0}</td></tr>`;
  $('zusammen').innerHTML = h + '</tbody>';
}
function baueGraph() {
  const n = R.spiel.z.length, flip = R.orient === 'b', pkt = [];
  for (let p = 0; p <= n; p++) pkt.push([n ? p / n * 1000 : 0, 100 - gewinnchance(cpBei(p))]);
  const y = v => flip ? 100 - v : v;
  let h = `<svg viewBox="0 0 1000 100" preserveAspectRatio="none"><path d="M0,${flip ? 0 : 100} L${pkt.map(([x, v]) => `${x},${y(v)}`).join(' L')} L1000,${flip ? 0 : 100} Z" fill="#f2f2f2"/>`
    + '<line x1="0" y1="50" x2="1000" y2="50" stroke="#888" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';
  R.spiel.z.forEach((z, i) => {
    if (!['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(z[3])) return;
    const [x, v] = pkt[i + 1];
    h += `<div class="punkt" style="left:${x / 10}%;top:${y(v)}%;background:${KL[z[3]][1]}"></div>`;
  });
  $('graph').innerHTML = h + '<div class="jetzt" id="jetzt"></div>';
}
const SATZ = {
  brilliant: 'ist brillant!', great: 'ist ein großartiger Zug', best: 'ist der beste Zug', excellent: 'ist exzellent',
  good: 'ist gut', inaccuracy: 'ist eine Ungenauigkeit', mistake: 'ist ein Fehler', miss: 'verpasst eine Chance',
  blunder: 'ist ein grober Patzer',
};
function zeichneKommentar() {
  const sp = R.spiel, k = $('kommentar');
  if (R.ply === 0) {
    k.innerHTML = `<div class="titel">Startstellung</div><div class="text">${esc(sp.er)} · Bewertung ${evalText(sp.cp0)}</div>`;
    return;
  }
  const z = sp.z[R.ply - 1], { farbe, nr } = zugInfo(R.ply - 1);
  let text = `Bewertung ${evalText(z[4])}`;
  if (z[7]) text = `<div class="warum-text">${esc(z[7])}</div>` + text;
  else if (!['best', 'brilliant', 'great'].includes(z[3]) && z[5]) text = `Bester Zug war <b>${esc(z[5])}</b> · ` + text;
  k.innerHTML = `<div class="titel">${sym(z[3])}<span style="color:${KL[z[3]][1]}">${nr}${farbe === 'w' ? '.' : '...'} ${esc(z[0])} ${SATZ[z[3]]}</span></div>`
    + `<div class="text">${text}</div>`;
}
function zeichneEval() {
  const cp = cpBei(R.ply), weiss = $('evalweiss'), t = $('evaltext');
  weiss.style.height = gewinnchance(cp) + '%';
  weiss.style.top = R.orient === 'w' ? '' : '0';
  weiss.style.bottom = R.orient === 'w' ? '0' : '';
  t.textContent = evalText(cp).replace(/^[+-]/, '');
  const unten = (R.orient === 'w') === (cp >= 0);
  t.style.color = cp >= 0 ? '#403d39' : '#f2f2f2';
  t.style.top = unten ? '' : '4px';
  t.style.bottom = unten ? '4px' : '';
}
function gehe(ply, animiert) {
  if (!R.spiel) return;
  const n = R.spiel.z.length;
  ply = Math.max(0, Math.min(n, ply));
  animiert = animiert && ply === R.ply + 1;
  R.ply = ply;
  zeichneBrett(animiert);
  zeichneEval();
  zeichneKommentar();
  document.querySelectorAll('.zug.an').forEach(e => e.classList.remove('an'));
  const akt = document.querySelector(`.zug[data-ply="${ply}"]`), liste = $('zugliste');
  if (akt) {
    akt.classList.add('an');
    const oben = akt.offsetTop - liste.offsetTop;
    if (oben < liste.scrollTop || oben > liste.scrollTop + liste.clientHeight - 30) liste.scrollTop = oben - liste.clientHeight / 2;
  } else liste.scrollTop = 0;
  $('jetzt').style.left = (n ? ply / n * 100 : 0) + '%';
  history.replaceState(null, '', link(R.id, ply));
}
function stopp() { clearInterval(R.timer); R.timer = null; $('k-play').textContent = '▶︎ Play'; }
function play() {
  if (R.timer) return stopp();
  if (R.ply >= R.spiel.z.length) gehe(0);
  $('k-play').textContent = '⏸ Pause';
  R.timer = setInterval(() => { if (R.ply >= R.spiel.z.length) stopp(); else gehe(R.ply + 1, true); }, 1000);
}
function drehen() { R.orient = andere(R.orient); zeichneSpieler(); baueGraph(); gehe(R.ply); }

async function zeigePartie(id, ply) {
  stopp();
  zeige('partie');
  window.scrollTo(0, 0);
  $('zurueck').href = `#u=${encodeURIComponent(S.user)}`;
  if (!S.analysen.has(id)) {
    R.spiel = null; R.id = id;
    const p = S.byId.get(id);
    const laden = $('laden');
    laden.hidden = false;
    laden.innerHTML = `<div>Analysiere Partie gegen ${esc(p.white.username.toLowerCase() === S.user.toLowerCase() ? p.black.username : p.white.username)} …</div>`
      + '<div class="balken"><div id="laden-balken"></div></div><div id="laden-text">Stockfish wird geladen …</div>';
    ['brett', 'zugliste', 'graph', 'kommentar', 'zusammen', 'sp-oben', 'sp-unten'].forEach(e => { $(e).innerHTML = ''; });
    $('partie-titel').textContent = '';
    try {
      await analyseFuer(id, (fertig, gesamt) => {
        if (R.id !== id) return;
        $('laden-balken').style.width = (100 * fertig / gesamt) + '%';
        $('laden-text').textContent = `${fertig} von ${gesamt} Stellungen`;
      });
    } catch (e) {
      if (R.id === id) laden.innerHTML = `<div>Analyse fehlgeschlagen: ${esc(e.message)}</div>`;
      return;
    }
    if (R.id !== id) return;  // inzwischen woanders hin navigiert
    laden.hidden = true;
  }
  const g = auswertungVon(id);
  R.spiel = viewerDaten(g); R.id = id; R.orient = R.spiel.ich; R.ply = 0;
  $('partie-titel').textContent = `${R.spiel.w[0]} – ${R.spiel.b[0]}  ${R.spiel.erg}  ·  ${R.spiel.datum} · ${R.spiel.zeit}`;
  zeichneSpieler(); baueZugliste(); baueZusammenfassung(); baueGraph();
  gehe(ply);
}

// ---------------------------------------------------------------- Navigation

function zeige(bereich) {
  for (const b of ['start', 'uebersicht', 'partie']) $(b).hidden = b !== bereich;
  $('kopf').hidden = bereich === 'start';
}

async function ladeSpieler(name) {
  S.user = name; S.partien = []; S.byId = new Map(); S.analysen = new Map(); S.auswertung = new Map(); S.zeigeAnzahl = 100;
  zeige('uebersicht');
  $('uebersicht').innerHTML = `<h1>${esc(name)}</h1><p class="unter" id="lade-text">Lade Partien von chess.com …</p>`;
  const partien = await ladePartien(name, (i, n) => { const t = $('lade-text'); if (t) t.textContent = `Lade Partien von chess.com … Monat ${i + 1} von ${n}`; });
  // Schreibweise des Namens von chess.com übernehmen
  const p0 = partien[0];
  if (p0) S.user = [p0.white.username, p0.black.username].find(u => u.toLowerCase() === name.toLowerCase()) || name;
  S.partien = partien;
  S.byId = new Map(partien.map(p => [pid(p), p]));
  const gespeichert = await Promise.all(partien.map(p => DB.get('analysen', `${CACHE_VERSION}:${pid(p)}`)));
  partien.forEach((p, i) => { if (gespeichert[i]) S.analysen.set(pid(p), gespeichert[i]); });
  speicher.set('letzterName', S.user);
}

async function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  const name = h.get('u'), id = h.get('p');
  if (!name) { stopp(); zeige('start'); return; }
  try {
    if (!S.user || S.user.toLowerCase() !== name.toLowerCase()) await ladeSpieler(name);
  } catch (e) {
    S.user = null;
    zeige('start');
    $('start-fehler').textContent = e.message;
    return;
  }
  if (id && S.byId.has(id)) {
    if (R.id === id && R.spiel && !$('partie').hidden) gehe(+(h.get('z') || 0));
    else zeigePartie(id, +(h.get('z') || 0));
  } else { R.id = null; zeigeUebersicht(); }
}

// ---------------------------------------------------------------- Ereignisse

document.querySelectorAll('[data-suche]').forEach(f => f.addEventListener('submit', e => {
  e.preventDefault();
  const name = new FormData(f).get('name').trim();
  if (!name) return;
  $('start-fehler').textContent = '';
  const ziel = `#u=${encodeURIComponent(name)}`;
  if (location.hash === ziel) route(); else location.hash = ziel;
}));
$('k-anfang').onclick = () => { stopp(); gehe(0); };
$('k-zurueck').onclick = () => { stopp(); gehe(R.ply - 1); };
$('k-vor').onclick = () => { stopp(); gehe(R.ply + 1, true); };
$('k-ende').onclick = () => { stopp(); gehe(R.spiel.z.length); };
$('k-play').onclick = () => R.spiel && play();
$('k-drehen').onclick = () => R.spiel && drehen();
$('zugliste').onclick = e => { const z = e.target.closest('.zug'); if (z) { stopp(); gehe(+z.dataset.ply); } };
$('graph').onclick = e => {
  if (!R.spiel) return;
  const r = $('graph').getBoundingClientRect();
  stopp(); gehe(Math.round((e.clientX - r.left) / r.width * R.spiel.z.length));
};
document.addEventListener('keydown', e => {
  if ($('partie').hidden || !R.spiel || e.ctrlKey || e.altKey || e.metaKey || e.target.matches('input, select')) return;
  const aktion = { ArrowLeft: () => gehe(R.ply - 1), ArrowRight: () => gehe(R.ply + 1, true), Home: () => gehe(0),
    End: () => gehe(R.spiel.z.length), ' ': play, f: drehen, F: drehen }[e.key];
  if (!aktion) return;
  e.preventDefault();
  if (e.key !== ' ') stopp();
  aktion();
});
new ResizeObserver(([e]) => $('brett').style.setProperty('--f', e.contentRect.width / 8 + 'px')).observe($('brett'));
window.addEventListener('hashchange', route);

$('start-klassen').innerHTML = Object.keys(KL).map(k => `<span>${sym(k)} ${KL[k][0]}</span>`).join('');
const letzter = speicher.get('letzterName');
if (letzter) document.querySelectorAll('[data-suche] input').forEach(i => { i.value = letzter; });
await DB.oeffnen();
route();
