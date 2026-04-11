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
  lastUpdate: null
};

// ── Parse .tdt ──
function parseTDT(raw) {
  const tm = /Title: "([^"]+)"/.exec(raw);
  const name = tm ? tm[1] : 'Turnier';

  const names = [];
  const nameRx = /Nickname: "([^"]+)", Firstname: "([^"]+)", Lastname: "([^"]+)"/g;
  let m;
  while ((m = nameRx.exec(raw)) !== null)
    names.push({ nick: m[1], first: m[2], last: m[3], pos: m.index });

  const seats = [];
  const seatRx = /Seat: new GameSeat\(\{TableName: "([^"]+)", SeatIndex: (\d+)/g;
  while ((m = seatRx.exec(raw)) !== null)
    seats.push({ table: m[1], seat: parseInt(m[2]), pos: m.index });

  const players = [];
  const tableSet = new Set();
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const np = i + 1 < names.length ? names[i + 1].pos : raw.length;
    const ps = seats.filter(s => s.pos > n.pos && s.pos < np);
    if (!ps.length) continue;
    const cur = ps[ps.length - 1];
    tableSet.add(cur.table);
    players.push({
      id: n.nick + '||' + n.first + '||' + n.last,
      name: n.first + ' ' + n.last,
      nick: n.nick,
      table: cur.table,
      seat: cur.seat
    });
  }

  const tables = [...tableSet].sort((a, b) => {
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
  broadcast({ type: 'state', payload: state });
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
    const parsed = parseTDT(raw);

    // Merge: keep existing eliminations for known players, clear for new ones
    const knownIds = new Set(state.players.map(p => p.id));
    const newPlayerIds = new Set(parsed.players.map(p => p.id));
    // Remove eliminations for players no longer in file
    state.eliminations = state.eliminations.filter(e => newPlayerIds.has(e.id));

    state.tourneyName = parsed.name;
    state.players = parsed.players;
    state.tables = parsed.tables;
    state.lastUpdate = new Date().toISOString();

    broadcastState();
    res.json({ ok: true, players: parsed.players.length, tables: parsed.tables.length });
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
          const pos = state.players.length - state.eliminations.length;
          state.eliminations.push({ id: playerId, name: playerName, table, time, pos });
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
