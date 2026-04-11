const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ── In-memory state ──
let state = {
  tourneyName: '',
  tables: [],
  players: [],      // parsed from .tdt
  eliminations: [], // manually set by dealers
  lastUpdate: null,
  lastRaw: ''
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
  tables.sort((a, b) => {
    if (a.toUpperCase().includes('FINAL')) return 1;
    if (b.toUpperCase().includes('FINAL')) return -1;
    return a.localeCompare(b);
  });

  return { name, players, tables };
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
    state.lastUpdate = new Date().toISOString();

    broadcastState();
    res.json({ ok: true, changed: true, players: parsed.players.length, tables: parsed.tables.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full state (for reconnecting clients)
app.get('/state', (req, res) => res.json(state));

// ── WebSocket ──
wss.on('connection', ws => {
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
      }
    } catch (e) { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`Poker Tournament Manager läuft auf http://localhost:${PORT}`);
});
