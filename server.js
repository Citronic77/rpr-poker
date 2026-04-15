const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ── Home Assistant Webhooks ──
const WEBHOOKS = {
  floorCall: {
    'Table 2 RED':    'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-6xJj0fF-pnIcfeOFPmHKZBdU',
    'Table 3 GREEN':  'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-4yfflO_MdRIZfPxyreGPsT4y',
    'Table 4 YELLOW': 'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-U-rWT5MKiWn8bjF5sVZDYs72',
    'Table 5 CYAN':   'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-8sJpf_gpyfU9Dw-QckGNyvnk',
    'Table 6 BLUE':   'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-VAuFEZfZ_9B2auXp_O_12LJ-',
    'Table 7':        'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-eOttVlpSiQvKYNPrN-PWQLqJ',
    'Table 7 PURPLE': 'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-eOttVlpSiQvKYNPrN-PWQLqJ',
  },
  floorDone: {
    'Table 2 RED':    'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-_2dGOzeJrIVlr_62pilkVegO',
    'Table 3 GREEN':  'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-wmPBtMOzISV5fPYi0LZQ1WSi',
    'Table 4 YELLOW': 'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-ltsISZ5MfdUmm7vz8mJMj_lx',
    'Table 5 CYAN':   'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-pEZDQtJ0IwhxlurCQ4PQvO_U',
    'Table 6 BLUE':   'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-Zn733ytfjEW23-UZ2h3SaAgp',
    'Table 7':        'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-JDc-xh3x3HMjonoobMNwcTEc',
    'Table 7 PURPLE': 'https://m27m0w68gru0ervrm8suzkbir5jjnt87.ui.nabu.casa/api/webhook/-JDc-xh3x3HMjonoobMNwcTEc',
  }
};

async function triggerWebhook(type, table) {
  // Try exact match first, then case-insensitive
  const map = WEBHOOKS[type] || {};
  const url = map[table] || Object.entries(map).find(([k]) => k.toUpperCase() === table.toUpperCase())?.[1];
  if (!url) return;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table, time: new Date().toISOString() }) });
    console.log(`Webhook ${type} [${table}]: ${res.status}`);
  } catch (e) {
    console.error(`Webhook ${type} [${table}] failed:`, e.message);
  }
}

// ── In-memory state ──
let state = {
  tourneyName: '',
  tables: [],
  players: [],      // parsed from .tdt
  eliminations: [], // manually set by dealers
  lastUpdate: null,
  lastRaw: '',
  currentLevel: null,
  currentBlind: null,
  currentBreak: null,
  blindLevelNumber: null,
  blinds: [],
  totalBuyins: 0,
  reentries: 0,
  uniquePlayers: 0,
  pot: 0,
  totalBuyins: 0,
  totalUniquePlayers: 0,
  totalReentries: 0
};

// ── Parse .tdt ──
function parseTDT(raw) {
  const tm = /Title: "([^"]+)"/.exec(raw);
  const name = tm ? tm[1] : 'Turnier';

  // ── 1. Build UUID → player map from GamePlayer entries ──
  const playersByUuid = {};
  const uuidRx = /\["([0-9a-f-]{36})", new GamePlayer/g;
  const nameRx = /Nickname: "([^"]+)", Firstname: "([^"]+)", Lastname: "([^"]+)"/g;
  let m;

  const uuidPositions = [];
  while ((m = uuidRx.exec(raw)) !== null) uuidPositions.push({ uuid: m[1], pos: m.index });

  const namePositions = [];
  while ((m = nameRx.exec(raw)) !== null)
    namePositions.push({ nick: m[1], first: m[2], last: m[3], pos: m.index });

  for (let i = 0; i < uuidPositions.length; i++) {
    const { uuid, pos } = uuidPositions[i];
    const nextPos = i + 1 < uuidPositions.length ? uuidPositions[i + 1].pos : raw.length;
    const block = raw.slice(pos, nextPos);
    // Skip players who have not bought in yet
    if (!block.includes('new GameBuyin({')) continue;
    const n = namePositions.find(x => x.pos > pos && x.pos < nextPos);
    if (n) {
      playersByUuid[uuid] = {
        id: uuid,
        name: n.first + ' ' + n.last,
        nick: n.nick
      };
    }
  }

  // ── 2. Read current seating from GameTables section ──
  // This is the authoritative source: Seats array contains UUIDs of seated players
  const players = [];
  const tables = [];

  const gameTablesIdx = raw.indexOf('new GameTables(');
  if (gameTablesIdx === -1) throw new Error('GameTables section not found in .tdt file');

  // Find end of GameTables block (before next top-level section)
  const gameTablesRaw = raw.slice(gameTablesIdx, gameTablesIdx + 20000);

  const tableRx = /new GameTable\(\{Name: "([^"]+)", NumberOfSeats: (\d+), Seats: \[([^\]]*)\]/g;
  while ((m = tableRx.exec(gameTablesRaw)) !== null) {
    const tableName = m[1];
    const seatsRaw = m[3];

    // Parse seat entries: null or "uuid" or negative numbers (template placeholders → skip)
    const seatEntries = seatsRaw.split(',').map(s => s.trim().replace(/"/g, ''));
    let hasSeatedPlayers = false;

    seatEntries.forEach((entry, idx) => {
      if (!entry || entry === 'null') return;
      // Negative numbers are locked placeholder seats, not real players
      if (/^-?\d+$/.test(entry)) return;
      const player = playersByUuid[entry];
      if (!player) return;
      players.push({ ...player, table: tableName, seat: idx + 1 });
      hasSeatedPlayers = true;
    });

    if (hasSeatedPlayers) tables.push(tableName);
  }

  // Sort: Final Table last
  const TABLE_ORDER = ['FINAL','RED','GREEN','YELLOW','CYAN','BLUE','PURPLE'];
  function tableRank(name) {
    const u = name.toUpperCase();
    const idx = TABLE_ORDER.findIndex(k => u.includes(k));
    return idx === -1 ? 99 : idx;
  }
  tables.sort((a, b) => tableRank(a) - tableRank(b));

  // ── 3. Parse blind levels (rounds + breaks) and current level ──
  // Schedule is in GameLevels section
  const gameLevelsIdx = raw.indexOf('GameLevels(');
  const schedRaw = gameLevelsIdx > -1 ? raw.slice(gameLevelsIdx) : raw;

  const roundRx = /new GameRound\(\{Minutes: (\d+), SmallBlind: (\d+), BigBlind: (\d+), Ante: (\d+)/g;
  const breakRx = /new GameBreak\(\{Minutes: (\d+)/g;
  const schedEntries = [];
  let rm;
  while ((rm = roundRx.exec(schedRaw)) !== null)
    schedEntries.push({ pos: rm.index, type: 'round', minutes: parseInt(rm[1]), sb: parseInt(rm[2]), bb: parseInt(rm[3]), ante: parseInt(rm[4]) });
  while ((rm = breakRx.exec(schedRaw)) !== null)
    schedEntries.push({ pos: rm.index, type: 'break', minutes: parseInt(rm[1]) });
  schedEntries.sort((a, b) => a.pos - b.pos);

  // blinds list = only real rounds (for reference)
  const blinds = schedEntries.filter(e => e.type === 'round');

  const clm = /CurrentLevel: (\d+)/.exec(raw);
  const currentLevelIndex = clm ? parseInt(clm[1]) : 0;

  // currentEntry = what is actually happening now (round or break)
  const currentEntry = schedEntries[currentLevelIndex] || null;
  const currentBlind = currentEntry && currentEntry.type === 'round' ? currentEntry : null;
  const currentBreak = currentEntry && currentEntry.type === 'break' ? currentEntry : null;

  // blindLevelNumber = count only non-break rounds up to currentLevel
  const blindLevelNumber = schedEntries.slice(0, currentLevelIndex + 1).filter(e => e.type === 'round').length;
  const currentLevel = currentLevelIndex + 1; // keep for compatibility

  // ── 4. Count buyins and reentries — only bought-in players ──
  const buyinRx2 = /new GameBuyin\(\{/g;
  let totalBuyins = 0;
  let totalUniquePlayers = 0;
  for (let i = 0; i < uuidPositions.length; i++) {
    const { pos } = uuidPositions[i];
    const nextPos = i + 1 < uuidPositions.length ? uuidPositions[i + 1].pos : raw.length;
    const block = raw.slice(pos, nextPos);
    const playerBuyins = (block.match(/new GameBuyin\(\{/g) || []).length;
    if (playerBuyins > 0) {
      totalBuyins += playerBuyins;
      totalUniquePlayers++;
    }
  }
  const totalReentries = totalBuyins - totalUniquePlayers;

  // ── 5. Calculate pot ──
  const potRx = /new GameBuyin\(\{Time: \d+, Round: \d+, Amount: ([\d.]+), PersonalBounty: \d+, Rake: new PerPlayerRake\(\[([\d., ]+)\]\)/g;
  let totalAmount = 0, totalRake = 0;
  let pm;
  while ((pm = potRx.exec(raw)) !== null) {
    totalAmount += parseFloat(pm[1]);
    pm[2].split(',').forEach(r => totalRake += parseFloat(r.trim()));
  }
  const pot = Math.round(totalAmount - totalRake);

  return { name, players, tables, blinds, currentLevel, currentBlind, currentBreak, blindLevelNumber, totalBuyins, totalUniquePlayers, totalReentries, pot };
}

// ── Broadcast to all clients ──
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function broadcastState() {
  // Don't send lastRaw to clients — it's server-only and large
  const { lastRaw, ...payload } = state;
  broadcast({ type: 'state', payload });
}

// ── File upload (multer, memory storage) ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Upload .tdt
app.post('/upload', upload.single('tdt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  try {
    const raw = req.file.buffer.toString('utf-8');

    // Skip broadcast if file content unchanged
    if (raw === state.lastRaw) {
      return res.json({ ok: true, changed: false, players: state.players.length, tables: state.tables.length });
    }
    state.lastRaw = raw;

    const parsed = parseTDT(raw);
    const newPlayerIds = new Set(parsed.players.map(p => p.id));

    // Keep manual eliminations only for players still present in the file.
    // If a player disappeared (e.g. removed from tournament), drop their elimination.
    state.eliminations = state.eliminations.filter(e => newPlayerIds.has(e.id));

    // Recalculate positions after any drops
    state.eliminations.forEach((e, i) => e.pos = parsed.players.length - i);

    // Always take fresh player data (seats/tables) from the file
    state.tourneyName = parsed.name;
    state.players = parsed.players;
    state.tables = parsed.tables;
    state.blinds = parsed.blinds;
    state.currentLevel = parsed.currentLevel;
    state.currentBlind = parsed.currentBlind;
    state.currentBreak = parsed.currentBreak;
    state.blindLevelNumber = parsed.blindLevelNumber;
    state.totalBuyins = parsed.totalBuyins;
    state.reentries = parsed.totalReentries;
    state.uniquePlayers = parsed.totalUniquePlayers;
    state.pot = parsed.pot;
    state.totalBuyins = parsed.totalBuyins;
    state.totalUniquePlayers = parsed.totalUniquePlayers;
    state.totalReentries = parsed.totalReentries;
    state.lastUpdate = new Date().toISOString();

    broadcastState();
    res.json({ ok: true, changed: true, players: parsed.players.length, tables: parsed.tables.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full state (for reconnecting clients)
app.get('/state', (req, res) => {
  const { lastRaw, ...payload } = state;
  res.json(payload);
});

// ── WebSocket ──
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'state', payload: state }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'eliminate') {
        const { playerId, playerName, table, time } = msg;
        if (!state.eliminations.find(e => e.id === playerId)) {
          // pos = number of players still active at moment of elimination = their finishing place
          const activePlayers = state.players.length - state.eliminations.length;
          const player = state.players.find(p => p.id === playerId);
          const seat = player ? player.seat : null;
          state.eliminations.push({ id: playerId, name: playerName, table, seat, time, pos: activePlayers });
          broadcastState();
        }
      } else if (msg.type === 'undo') {
        const { playerId } = msg;
        state.eliminations = state.eliminations.filter(e => e.id !== playerId);
        state.eliminations.forEach((e, i) => e.pos = state.players.length - i);
        broadcastState();
      } else if (msg.type === 'floorCall') {
        broadcast({ type: 'floorCall', table: msg.table, time: msg.time });
        triggerWebhook('floorCall', msg.table);
      } else if (msg.type === 'floorCallDone') {
        broadcast({ type: 'floorCallDone', table: msg.table });
        triggerWebhook('floorDone', msg.table);
      } else if (msg.type === 'getState') {
        // Client requesting fresh state (e.g. after reconnect)
        const { lastRaw, ...payload } = state;
        ws.send(JSON.stringify({ type: 'state', payload }));
      }
    } catch (e) { /* ignore */ }
  });
});

// ── Heartbeat: ping all clients every 30s ──
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else if (ws.readyState !== WebSocket.CONNECTING) {
      ws.terminate();
    }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Poker Tournament Manager läuft auf http://localhost:${PORT}`);
});
