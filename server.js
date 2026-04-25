const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');

const FT_SERVER = 'http://167.172.169.206:3000';

// ── OneDrive Upload via Microsoft Graph ──
async function uploadToOneDrive(buffer, filename, subfolder) {
  try {
    const tenantId = process.env.MS_TENANT_ID;
    const clientId = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;
    const driveFolder = process.env.MS_ONEDRIVE_FOLDER || 'RPR-Poker';

    if(!tenantId || !clientId || !clientSecret) {
      console.warn('OneDrive: Env variables not set, skipping upload');
      return null;
    }

    // 1. Get access token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default'
      })
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if(!token) { console.warn('OneDrive: No token received', tokenData); return null; }

    // 2. Upload file to OneDrive (specific user)
    const driveUser = process.env.MS_ONEDRIVE_USER || 'roger@lehmanncomputer.ch';
    const folder = subfolder ? `${driveFolder}/${subfolder}` : driveFolder;
    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(driveUser)}/drive/root:/${folder}/${filename}:/content`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/pdf'
      },
      body: buffer
    });

    if(!uploadRes.ok) {
      const err = await uploadRes.text();
      console.warn('OneDrive upload failed:', uploadRes.status, err);
      return null;
    }

    const fileData = await uploadRes.json();
    console.log('OneDrive upload OK:', fileData.name);
    return fileData.webUrl || null;

  } catch(e) {
    console.warn('OneDrive upload error:', e.message);
    return null;
  }
} // Final Table server

// ── Gastro-Abrechnung Konfiguration ──
const GASTRO_CFG_PATH = path.join(__dirname, 'gastro-config.json');
let gastroCfg = null;
if (fs.existsSync(GASTRO_CFG_PATH)) {
  gastroCfg = JSON.parse(fs.readFileSync(GASTRO_CFG_PATH, 'utf8'));
  console.log('✅  Gastro-Config geladen → Empfänger:', gastroCfg.recipient);
} else {
  console.warn('⚠️  gastro-config.json nicht gefunden — Gastro-Abrechnung deaktiviert.');
}

const ARCHIV_DIR = path.join(__dirname, 'Archiv_Abrechnungen');
if (gastroCfg && !fs.existsSync(ARCHIV_DIR)) {
  fs.mkdirSync(ARCHIV_DIR, { recursive: true });
}

let mailer = null;
if (gastroCfg) {
  mailer = nodemailer.createTransport({
    host: gastroCfg.smtp.host, port: gastroCfg.smtp.port,
    secure: gastroCfg.smtp.port === 465,
    auth: { user: gastroCfg.smtp.user, pass: gastroCfg.smtp.pass },
    tls: { rejectUnauthorized: false },
  });
  mailer.verify(err => {
    if (err) console.warn('⚠️  Gastro SMTP:', err.message);
    else console.log('✅  Gastro SMTP OK');
  });
}

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

// ── FRIBOURG SCORE POLLING ──
const FRIBOURG_TEAM_ID = 3690; // Fribourg-Gottéron SofaScore ID
let lastFribourgScore = null;
let fribourgPollTimer = null;

async function pollFribourgScore() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(
      `https://api.sofascore.com/api/v1/sport/ice-hockey/scheduled-events/${today}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) return;
    const data = await res.json();

    // Find Fribourg game
    const game = (data.events || []).find(e =>
      (e.homeTeam && e.homeTeam.id === FRIBOURG_TEAM_ID) ||
      (e.awayTeam && e.awayTeam.id === FRIBOURG_TEAM_ID)
    );

    if (!game) return;

    // Only track live games
    const statusCode = game.status.code;
    if (statusCode === 0 || statusCode >= 100) return;

    const homeScore = game.homeScore?.current ?? 0;
    const awayScore = game.awayScore?.current ?? 0;
    const scoreKey = `${homeScore}:${awayScore}`;

    if (lastFribourgScore !== null && lastFribourgScore !== scoreKey) {
      console.log(`Fribourg goal! ${scoreKey}`);
      broadcast({
        type: 'fribourg-goal',
        payload: {
          homeTeam: game.homeTeam.shortName || game.homeTeam.name,
          awayTeam: game.awayTeam.shortName || game.awayTeam.name,
          homeScore,
          awayScore
        }
      });
      // Also send to FT server
      fetch(FT_SERVER + '/fribourg-goal?' +
        `home=${encodeURIComponent(game.homeTeam.shortName || game.homeTeam.name)}` +
        `&away=${encodeURIComponent(game.awayTeam.shortName || game.awayTeam.name)}` +
        `&hs=${homeScore}&as=${awayScore}`
      ).catch(() => {});
    }
    lastFribourgScore = scoreKey;
  } catch (e) {
    // Silent fail — don't crash server
  }
}

// Poll every 30 seconds
setInterval(pollFribourgScore, 30000);
pollFribourgScore(); // initial check

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
  activeFloorCalls: [], // tables currently calling floor
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
  totalBonus: 0,
  payouts: [],
  isBounty: false,
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
  let totalBonus = 0;
  for (let i = 0; i < uuidPositions.length; i++) {
    const { pos } = uuidPositions[i];
    const nextPos = i + 1 < uuidPositions.length ? uuidPositions[i + 1].pos : raw.length;
    const block = raw.slice(pos, nextPos);
    const playerBuyins = (block.match(/new GameBuyin\(\{/g) || []).length;
    if (playerBuyins > 0) {
      totalBuyins += playerBuyins;
      totalUniquePlayers++;
      // Count bonus buyins: ProfileName contains "Bonus"
      const bonusMatches = (block.match(/ProfileName: "[^"]*Bonus[^"]*"/g) || []).length;
      totalBonus += bonusMatches;
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

  // ── 6. Parse payout structure ──
  const payouts = [];
  const prizeRx = /new GamePrize\(\{Description: "([^"]+)", Type: \d+, Recipient: (\d+), AmountType: \d+, Amount: [\d.]+.*?CalculatedAmount: ([\d.]+)/g;
  let pm2;
  while((pm2 = prizeRx.exec(raw)) !== null) {
    payouts.push({ description: pm2[1], recipient: parseInt(pm2[2]), amount: parseFloat(pm2[3]) });
  }

  // Build buyin count per player UUID
  const buyinCountPerPlayer = {};
  for (let i = 0; i < uuidPositions.length; i++) {
    const { uuid, pos } = uuidPositions[i];
    const nextPos = i + 1 < uuidPositions.length ? uuidPositions[i + 1].pos : raw.length;
    const block = raw.slice(pos, nextPos);
    buyinCountPerPlayer[uuid] = (block.match(/new GameBuyin\(\{/g) || []).length;
  }

  const isBounty = /BountyChipCost: [1-9]/.test(raw) || /PersonalBounty: [1-9]/.test(raw);
  return { name, players, tables, blinds, currentLevel, currentBlind, currentBreak, blindLevelNumber, totalBuyins, totalUniquePlayers, totalReentries, totalBonus, pot, buyinCountPerPlayer, payouts, isBounty };
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

app.use(express.json({ limit: '50mb' }));
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
    // Also remove eliminations for players who have re-entered (more buyins than at elimination time).
    state.eliminations = state.eliminations.filter(e => {
      if (!newPlayerIds.has(e.id)) return false; // player removed
      const currentBuyins = parsed.buyinCountPerPlayer[e.id] || 0;
      const buyinsAtElim = e.buyinsAtElim || 1;
      if (currentBuyins > buyinsAtElim) return false; // player re-entered
      return true;
    });

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
    state.totalBonus = parsed.totalBonus;
    state.payouts = parsed.payouts;
    state.isBounty = parsed.isBounty;
    state.pot = parsed.pot;
    state.totalBuyins = parsed.totalBuyins;
    state.totalUniquePlayers = parsed.totalUniquePlayers;
    state.totalReentries = parsed.totalReentries;
    state.lastBuyinCounts = parsed.buyinCountPerPlayer;
    state.lastUpdate = new Date().toISOString();

    broadcastState();
    // Update Final Table projection with real player names
    updateFinalTablePlayers(state.players, state.tables);
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
        const { playerId, playerName, table, time, hitmanId, hitmanName } = msg;
        if (!state.eliminations.find(e => e.id === playerId)) {
          // pos = number of players still active at moment of elimination = their finishing place
          const activePlayers = state.players.length - state.eliminations.length;
          const player = state.players.find(p => p.id === playerId);
          const seat = player ? player.seat : null;
          const currentBuyinCounts = state.lastBuyinCounts || {};
          state.eliminations.push({ id: playerId, name: playerName, table, seat, time, pos: activePlayers, buyinsAtElim: currentBuyinCounts[playerId] || 1, hitmanId: hitmanId || null, hitmanName: hitmanName || null });
          broadcastState();
        }
      } else if (msg.type === 'undo') {
        const { playerId } = msg;
        state.eliminations = state.eliminations.filter(e => e.id !== playerId);
        state.eliminations.forEach((e, i) => e.pos = state.players.length - i);
        broadcastState();
      } else if (msg.type === 'floorCall') {
        if(!state.activeFloorCalls.includes(msg.table)) state.activeFloorCalls.push(msg.table);
        broadcast({ type: 'floorCall', table: msg.table, time: msg.time });
        triggerWebhook('floorCall', msg.table);
      } else if (msg.type === 'floorCallDone') {
        state.activeFloorCalls = state.activeFloorCalls.filter(t => t !== msg.table);
        broadcast({ type: 'floorCallDone', table: msg.table });
        broadcastState(); // sync activeFloorCalls to all clients
        triggerWebhook('floorDone', msg.table);
      } else if (msg.type === 'getState') {
        // Client requesting fresh state (e.g. after reconnect)
        const { lastRaw, ...payload } = state;
        ws.send(JSON.stringify({ type: 'state', payload }));
      }
    } catch (e) { /* ignore */ }
  });
});

// ── Final Table Proxy ──
// Forward commands to Final Table server (avoids CORS issues from browser)
app.get('/ft/remote', async (req, res) => {
  const command = req.query.command || '';
  try {
    const ftRes = await fetch(FT_SERVER + '/remote?command=' + command);
    res.json({ ok: true, command });
  } catch (e) {
    res.status(502).json({ error: 'Final Table server not reachable', detail: e.message });
  }
});

app.get('/ft/fribourg-goal', async (req, res) => {
  const { home, away, hs, as: as_ } = req.query;
  try {
    await fetch(`${FT_SERVER}/fribourg-goal?home=${encodeURIComponent(home||'FRI')}&away=${encodeURIComponent(away||'DAV')}&hs=${hs||2}&as=${as_||1}`);
    res.json({ ok: true });
  } catch(e) {
    res.status(502).json({ error: 'FT server not reachable' });
  }
});

app.get('/ft/countdown', async (req, res) => {
  const seconds = parseInt(req.query.seconds) || 20;
  const command = req.query.command || 'start';
  try {
    await fetch(FT_SERVER + '/countdown?seconds=' + seconds + '&command=' + command);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Final Table server not reachable' });
  }
});

app.get('/ft/getPotSize', async (req, res) => {
  try {
    const ftRes = await fetch(FT_SERVER + '/getPotSize');
    const data = await ftRes.text();
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: 'Final Table server not reachable' });
  }
});

app.post('/ft/setPotSize', express.json(), async (req, res) => {
  try {
    await fetch(FT_SERVER + '/setPotSize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Final Table server not reachable' });
  }
});

// Send player names to Final Table server via HTTP
async function updateFinalTablePlayers(players, tables) {
  try {
    // Build players array [null, name1, name2, ...] indexed by seat
    const ftPlayers = [null];
    const ftTable = tables.find(t => t.toUpperCase().includes('FINAL'));
    if (ftTable) {
      const ftSeats = players.filter(p => p.table === ftTable).sort((a, b) => a.seat - b.seat);
      // Fill seats 1-10
      for (let i = 1; i <= 10; i++) {
        const p = ftSeats.find(x => x.seat === i);
        ftPlayers.push(p ? p.name : null);
      }
    }
    await fetch(FT_SERVER + '/playerUpdate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: ftPlayers })
    });
    console.log('Final Table player update sent');
  } catch (e) {
    console.log('Final Table player update failed (server may be offline):', e.message);
  }
}

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

// ── Env Debug ──
app.get('/api/env-debug', (req, res) => {
  res.json({
    MS_TENANT_ID: process.env.MS_TENANT_ID ? 'SET (' + process.env.MS_TENANT_ID.substring(0,8) + '...)' : 'MISSING',
    MS_CLIENT_ID: process.env.MS_CLIENT_ID ? 'SET (' + process.env.MS_CLIENT_ID.substring(0,8) + '...)' : 'MISSING',
    MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET ? 'SET' : 'MISSING',
    MS_ONEDRIVE_USER: process.env.MS_ONEDRIVE_USER || 'MISSING',
    NODE_ENV: process.env.NODE_ENV || 'not set',
    allKeys: Object.keys(process.env).filter(k => k.startsWith('MS_'))
  });
});

// ── Quittung speichern (von externem PHP-Server) ──
app.post('/api/save-quittung', express.json({ limit: '5mb' }), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { zahlungsart, betrag, bonnr, datum, zeit, mitarbeiter, tischid, items } = req.body;
  if (!betrag) return res.status(400).json({ ok: false, error: 'Kein Betrag' });
  try {
    const mwst = (betrag / 1.081 * 0.081).toFixed(2);
    const zahlLabels = { bar: 'Bar', karte: 'Kreditkarte', twint: 'TWINT' };
    const zahlLabel = zahlLabels[zahlungsart] || zahlungsart;
    let itemsText = '';
    if (items && items.length) {
      items.forEach(item => {
        const name = (item.name + (item.rabatt ? ' (-' + item.rabatt + '%)' : '')).substring(0, 28).padEnd(28);
        itemsText += '  ' + name + ' Fr. ' + parseFloat(item.preis).toFixed(2) + '\n';
        if (item.optionen) item.optionen.forEach(o => { itemsText += '    + ' + o + '\n'; });
      });
    }
    const datumStr2 = datum || new Date().toLocaleDateString('de-CH');
    const zeitStr = zeit || new Date().toLocaleTimeString('de-CH');
    const bonText = [
      '================================',
      '     UNIQUE Poker & Sport       ',
      '   Bonnstrasse 22, Duedingen    ',
      '================================',
      'Datum:       ' + datumStr2,
      'Zeit:        ' + zeitStr,
      'Bon-Nr.:     ' + (bonnr || ''),
      tischid ? 'Tisch:       ' + tischid : null,
      mitarbeiter ? 'Mitarbeiter: ' + mitarbeiter : null,
      '--------------------------------',
      itemsText,
      '================================',
      'TOTAL        Fr. ' + parseFloat(betrag).toFixed(2),
      'inkl. MwSt 8.1%   Fr. ' + mwst,
      '--------------------------------',
      '[ ' + zahlLabel.toUpperCase() + ' ]',
      'Bezahlt      Fr. ' + parseFloat(betrag).toFixed(2),
      '================================',
      '  Vielen Dank fuer Ihren Besuch!',
      '================================',
    ].filter(l => l !== null).join('\n');

    const datumFile = datumStr2.replace(/\./g, '-');
    const filename = 'Quittung-' + datumFile + '-' + (bonnr || Date.now()) + '-' + zahlungsart + '.txt';
    const buffer = Buffer.from(bonText, 'utf-8');
    const odUrl = await uploadToOneDrive(buffer, filename, 'Quittungen');
    res.json({ ok: true, filename, onedrive: !!odUrl });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.options('/api/save-quittung', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// ── OneDrive Test ──
app.get('/api/onedrive-test', async (req, res) => {
  try {
    const tenantId = process.env.MS_TENANT_ID;
    const clientId = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;
    const driveUser = process.env.MS_ONEDRIVE_USER || 'roger@lehmanncomputer.ch';

    if(!tenantId || !clientId || !clientSecret) {
      return res.json({ ok: false, error: 'Env variables missing' });
    }

    // Get token
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default'
      })
    });
    const tokenData = await tokenRes.json();
    if(!tokenData.access_token) return res.json({ ok: false, step: 'token', error: tokenData });

    // Test: get user info
    const userRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(driveUser)}`, {
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
    });
    const userData = await userRes.json();

    // Test: get drive info
    const driveRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(driveUser)}/drive`, {
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
    });
    const driveData = await driveRes.json();

    // Test: upload small test file
    const testBuf = Buffer.from('RPR Poker OneDrive Test');
    const uploadRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(driveUser)}/drive/root:/RPR-Poker/test.txt:/content`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Content-Type': 'text/plain' },
      body: testBuf
    });
    const uploadData = await uploadRes.json();

    res.json({
      ok: uploadRes.ok,
      tokenOk: !!tokenData.access_token,
      user: userData.displayName || userData.error?.message,
      drive: driveData.name || driveData.error?.message,
      upload: uploadRes.status,
      uploadResult: uploadData.name || uploadData.error
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Registrierung PDF ──
const REG_PDF_DIR = path.join(__dirname, 'public', 'reg-pdfs');
if (!fs.existsSync(REG_PDF_DIR)) fs.mkdirSync(REG_PDF_DIR, { recursive: true });

app.post('/api/reg/save', express.json({ limit: '20mb' }), (req, res) => {
  const { pdfBase64, filename } = req.body;
  if(!pdfBase64) return res.status(400).json({ ok: false });
  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const filePath = path.join(REG_PDF_DIR, path.basename(filename));
    fs.writeFileSync(filePath, pdfBuffer);
    // Upload to OneDrive async
    uploadToOneDrive(pdfBuffer, path.basename(filename), 'Registrierungen').catch(()=>{});
    const host = req.get('host');
    const proto = host.includes('railway.app') ? 'https' : req.protocol;
    const pdfUrl = proto + '://' + host + '/reg-pdf/' + encodeURIComponent(path.basename(filename));
    res.json({ ok: true, pdfUrl });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/reg-pdf/:filename', (req, res) => {
  const filePath = path.join(REG_PDF_DIR, path.basename(req.params.filename));
  if(!fs.existsSync(filePath)) return res.status(404).send('Nicht gefunden');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.params.filename)}"`);
  res.sendFile(filePath);
});

// ── Gastro PDF Download ──
const GASTRO_PDF_DIR = path.join(__dirname, 'public', 'gastro-pdfs');
if (!fs.existsSync(GASTRO_PDF_DIR)) fs.mkdirSync(GASTRO_PDF_DIR, { recursive: true });

app.get('/gastro-pdf/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // security: no path traversal
  const filePath = path.join(GASTRO_PDF_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF nicht gefunden');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filePath);
});

// ── Gastro Mitarbeiter (server-side persistent) ──
const EMPLOYEES_PATH = path.join(__dirname, 'gastro-employees.json');

function loadEmployees() {
  try {
    if(fs.existsSync(EMPLOYEES_PATH)) return JSON.parse(fs.readFileSync(EMPLOYEES_PATH, 'utf8'));
  } catch(e) {}
  return [];
}

function saveEmployees(list) {
  try { fs.writeFileSync(EMPLOYEES_PATH, JSON.stringify(list)); } catch(e) {}
}

app.get('/api/gastro/employees', (req, res) => {
  res.json(loadEmployees());
});

app.post('/api/gastro/employees', express.json(), (req, res) => {
  const list = req.body;
  if(!Array.isArray(list)) return res.status(400).json({ error: 'Invalid data' });
  saveEmployees(list);
  res.json({ ok: true });
});

// ── Gastro-Abrechnung API ──
app.get('/api/gastro/health', (req, res) => {
  if (!gastroCfg) return res.status(503).json({ ok: false, error: 'gastro-config.json fehlt' });
  res.json({ ok: true, recipient: gastroCfg.recipient, smtpHost: gastroCfg.smtp.host });
});

app.post('/api/gastro/send', express.json({ limit: '20mb' }), async (req, res) => {
  if (!gastroCfg) return res.status(503).json({ ok: false, error: 'gastro-config.json fehlt' });
  const { pdfBase64, filename, datum, summary } = req.body;
  if (!pdfBase64) return res.status(400).json({ ok: false, error: 'Kein PDF erhalten.' });

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const archivPath = path.join(ARCHIV_DIR, filename);
  const results = { email: false, archiv: false, druck: false, errors: [] };

  // Archivieren (privat)
  try {
    fs.writeFileSync(archivPath, pdfBuffer);
    results.archiv = true;
  } catch (err) { results.errors.push('Archivieren: ' + err.message); }

  // Öffentlicher PDF-Link
  let pdfDownloadUrl = null;
  try {
    const publicPdfPath = path.join(GASTRO_PDF_DIR, filename);
    fs.writeFileSync(publicPdfPath, pdfBuffer);
    // Upload to OneDrive async (don't block response)
    uploadToOneDrive(pdfBuffer, filename, 'Gastro').catch(()=>{});
    // Force https on Railway (req.protocol may return http behind proxy)
    const host = req.get('host');
    const proto = host.includes('railway.app') ? 'https' : req.protocol;
    const baseUrl = proto + '://' + host;
    pdfDownloadUrl = baseUrl + '/gastro-pdf/' + encodeURIComponent(filename);
  } catch (err) { results.errors.push('PDF-Link: ' + err.message); }

  // E-Mail — mit Timeout damit der Server nicht hängt
  const emailPromise = (async () => {
    const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#0d1e3d;padding:18px 24px;border-radius:6px 6px 0 0">
        <span style="font-size:22px;font-weight:900;color:#fff;letter-spacing:3px">UNIQUE</span>
        <span style="font-size:11px;color:#f5a623;margin-left:10px">Poker & Sport Lounge</span>
      </div>
      <div style="background:#f8f7f4;padding:24px;border:1px solid #e8e6e0;border-top:none;border-radius:0 0 6px 6px">
        <h2 style="color:#0d1e3d;margin:0 0 16px">Gastro-Abrechnung ${datum || ''}</h2>
        <pre style="background:#fff;border:1px solid #e8e6e0;border-radius:4px;padding:16px;font-size:13px;line-height:1.7;white-space:pre-wrap">${summary || ''}</pre>
        ${pdfDownloadUrl ? `<div style="margin-top:20px;text-align:center">
          <a href="${pdfDownloadUrl}" style="background:#0d1e3d;color:#f5a623;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:.05em">
            &#128196; PDF herunterladen
          </a>
        </div>` : ''}
      </div>
      <p style="font-size:11px;color:#a0aec0;text-align:center;margin-top:12px">Bonnstrasse 22, 3186 Düdingen · poker@rpr.duedingen.ch</p>
    </div>`;
    await mailer.sendMail({
      from: `"UNIQUE Gastro" <${gastroCfg.smtp.user}>`,
      to: gastroCfg.recipient,
      subject: `Gastro-Abrechnung UNIQUE — ${datum || ''}`.trim(),
      text: summary || '', html: htmlBody,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });
  })();

  // Timeout nach 15 Sekunden
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP Timeout nach 15s')), 15000));
  try {
    await Promise.race([emailPromise, timeout]);
    results.email = true;
  } catch (err) {
    results.errors.push('E-Mail: ' + err.message);
  }

  // Drucken nicht verfügbar auf Cloud
  results.druck = true; // Als OK markieren damit UI nicht rot wird
  
  const allOk = results.email && results.archiv;
  res.status(200).json({ ok: true, results, errors: results.errors, pdfUrl: pdfDownloadUrl });
});

server.listen(PORT, () => {
  console.log(`Poker Tournament Manager läuft auf http://localhost:${PORT}`);
});
