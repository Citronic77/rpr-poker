const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'rpr-staffplan-secret-2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database Setup ──
const db = new Database(process.env.DB_PATH || 'staffplan.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    job TEXT NOT NULL DEFAULT 'dealer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    datum TEXT NOT NULL,
    uhrzeit TEXT NOT NULL,
    floorman_needed INTEGER DEFAULT 1,
    dealer_needed INTEGER DEFAULT 4,
    gastro_needed INTEGER DEFAULT 2,
    kueche_needed INTEGER DEFAULT 1,
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    job TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(event_id, user_id, job)
  );
`);

// Create default admin if not exists
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (name, email, password, role, job) VALUES (?, ?, ?, ?, ?)')
    .run('Administrator', 'admin@rpr.poker', hash, 'admin', 'admin');
  console.log('Default admin created: admin@rpr.poker / admin123');
}

// ── Auth Middleware ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Kein Token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Ungültiger Token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admin' });
  next();
}

// ── Auth Routes ──
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Falsche E-Mail oder Passwort' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, job: user.job }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, job: user.job } });
});

// ── User Routes ──
app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, job, created_at FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', authMiddleware, adminOnly, (req, res) => {
  const { name, email, password, role, job } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Fehlende Felder' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password, role, job) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hash, role || 'staff', job || 'dealer');
    res.json({ id: result.lastInsertRowid, name, email, role: role || 'staff', job: job || 'dealer' });
  } catch (e) {
    res.status(400).json({ error: 'E-Mail bereits vorhanden' });
  }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM shifts WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'admin');
  res.json({ ok: true });
});

app.patch('/api/users/:id/password', authMiddleware, (req, res) => {
  const { password } = req.body;
  if (req.user.id !== parseInt(req.params.id) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ ok: true });
});

// ── Event Routes ──
app.get('/api/events', authMiddleware, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY datum DESC, uhrzeit DESC').all();
  res.json(events);
});

app.post('/api/events', authMiddleware, adminOnly, (req, res) => {
  const { name, datum, uhrzeit, floorman_needed, dealer_needed, gastro_needed, kueche_needed } = req.body;
  if (!name || !datum || !uhrzeit) return res.status(400).json({ error: 'Fehlende Felder' });
  const result = db.prepare(
    'INSERT INTO events (name, datum, uhrzeit, floorman_needed, dealer_needed, gastro_needed, kueche_needed) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, datum, uhrzeit, floorman_needed || 1, dealer_needed || 4, gastro_needed || 2, kueche_needed || 1);
  res.json({ id: result.lastInsertRowid });
});

app.patch('/api/events/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, datum, uhrzeit, floorman_needed, dealer_needed, gastro_needed, kueche_needed, status } = req.body;
  db.prepare('UPDATE events SET name=?, datum=?, uhrzeit=?, floorman_needed=?, dealer_needed=?, gastro_needed=?, kueche_needed=?, status=? WHERE id=?')
    .run(name, datum, uhrzeit, floorman_needed, dealer_needed, gastro_needed, kueche_needed, status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/events/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM shifts WHERE event_id = ?').run(req.params.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Shift Routes ──
app.get('/api/events/:id/shifts', authMiddleware, (req, res) => {
  const shifts = db.prepare(`
    SELECT s.id, s.job, s.created_at, u.name, u.id as user_id
    FROM shifts s JOIN users u ON s.user_id = u.id
    WHERE s.event_id = ? ORDER BY s.job, u.name
  `).all(req.params.id);
  res.json(shifts);
});

app.post('/api/events/:id/shifts', authMiddleware, (req, res) => {
  const { job } = req.body;
  const eventId = parseInt(req.params.id);
  const userId = req.user.id;

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Anlass nicht gefunden' });
  if (event.status !== 'open') return res.status(400).json({ error: 'Anlass nicht offen' });

  // Check capacity
  const current = db.prepare('SELECT COUNT(*) as cnt FROM shifts WHERE event_id = ? AND job = ?').get(eventId, job);
  const needed = event[`${job}_needed`];
  if (current.cnt >= needed) return res.status(400).json({ error: 'Schicht bereits voll' });

  // Check if user already signed up for this event
  const existing = db.prepare('SELECT id FROM shifts WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  if (existing) return res.status(400).json({ error: 'Bereits eingetragen' });

  try {
    const result = db.prepare('INSERT INTO shifts (event_id, user_id, job) VALUES (?, ?, ?)').run(eventId, userId, job);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Bereits eingetragen' });
  }
});

app.delete('/api/events/:eventId/shifts/:shiftId', authMiddleware, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.shiftId);
  if (!shift) return res.status(404).json({ error: 'Nicht gefunden' });
  if (shift.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Kein Zugriff' });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.shiftId);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`StaffPlan running on port ${PORT}`));
