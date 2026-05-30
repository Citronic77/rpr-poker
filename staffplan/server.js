const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'rpr-staffplan-secret-2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── DB Init ──
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      jobs TEXT[] NOT NULL DEFAULT '{dealer}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      datum TEXT NOT NULL,
      uhrzeit TEXT NOT NULL,
      floorman_needed INT DEFAULT 1,
      dealer_needed INT DEFAULT 4,
      gastro_needed INT DEFAULT 2,
      kueche_needed INT DEFAULT 1,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(event_id, user_id)
    );
  `);

  const admins = await query("SELECT id FROM users WHERE role='admin'");
  if (!admins.length) {
    const hash = bcrypt.hashSync('admin123', 10);
    await query("INSERT INTO users (name,email,password,role,jobs) VALUES ($1,$2,$3,$4,$5)",
      ['Administrator','admin@rpr.poker',hash,'admin',['admin']]);
    console.log('Admin erstellt: admin@rpr.poker / admin123');
  }
}

// ── Auth ──
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({error:'Kein Token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Ungültiger Token'}); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({error:'Nur Admin'});
  next();
}

// ── Auth Route ──
app.post('/api/auth/login', async (req, res) => {
  const {email, password} = req.body;
  const rows = await query('SELECT * FROM users WHERE email=$1', [email]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({error:'Falsche E-Mail oder Passwort'});
  const token = jwt.sign({id:user.id,name:user.name,role:user.role,jobs:user.jobs}, JWT_SECRET, {expiresIn:'7d'});
  res.json({token, user:{id:user.id,name:user.name,role:user.role,jobs:user.jobs}});
});

// ── Users ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const rows = await query('SELECT id,name,email,role,job FROM users ORDER BY name');
  res.json(rows);
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  const {name,email,password,role,jobs} = req.body;
  if (!name||!email||!password) return res.status(400).json({error:'Fehlende Felder'});
  try {
    const hash = bcrypt.hashSync(password, 10);
    const jobsArr = Array.isArray(jobs) && jobs.length ? jobs : ['dealer'];
    const rows = await query(
      'INSERT INTO users (name,email,password,role,jobs) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, email, hash, role||'staff', jobsArr]);
    res.json({id:rows[0].id, name, email, role:role||'staff', jobs:jobsArr});
  } catch(e) { 
    console.error('User insert error:', e.message);
    const msg = e.message.includes('unique') || e.message.includes('duplicate') ? 'E-Mail bereits vorhanden' : 'Fehler: '+e.message;
    res.status(400).json({error: msg}); 
  }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  await query("DELETE FROM users WHERE id=$1 AND role!='admin'", [req.params.id]);
  res.json({ok:true});
});

// ── Events ──
app.get('/api/events', auth, async (req, res) => {
  const rows = await query('SELECT * FROM events ORDER BY datum DESC, uhrzeit DESC');
  res.json(rows);
});

app.post('/api/events', auth, adminOnly, async (req, res) => {
  const {name,datum,uhrzeit,floorman_needed,dealer_needed,gastro_needed,kueche_needed} = req.body;
  if (!name||!datum||!uhrzeit) return res.status(400).json({error:'Fehlende Felder'});
  const rows = await query(
    'INSERT INTO events (name,datum,uhrzeit,floorman_needed,dealer_needed,gastro_needed,kueche_needed) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [name,datum,uhrzeit,floorman_needed||1,dealer_needed||4,gastro_needed||2,kueche_needed||1]);
  res.json({id:rows[0].id});
});

app.patch('/api/events/:id', auth, adminOnly, async (req, res) => {
  const {name,datum,uhrzeit,floorman_needed,dealer_needed,gastro_needed,kueche_needed,status} = req.body;
  await query(
    'UPDATE events SET name=$1,datum=$2,uhrzeit=$3,floorman_needed=$4,dealer_needed=$5,gastro_needed=$6,kueche_needed=$7,status=$8 WHERE id=$9',
    [name,datum,uhrzeit,floorman_needed,dealer_needed,gastro_needed,kueche_needed,status,req.params.id]);
  res.json({ok:true});
});

app.delete('/api/events/:id', auth, adminOnly, async (req, res) => {
  await query('DELETE FROM events WHERE id=$1', [req.params.id]);
  res.json({ok:true});
});

// ── Shifts ──
app.get('/api/events/:id/shifts', auth, async (req, res) => {
  const rows = await query(
    'SELECT s.id,s.job,s.user_id,u.name FROM shifts s JOIN users u ON s.user_id=u.id WHERE s.event_id=$1 ORDER BY s.job,u.name',
    [req.params.id]);
  res.json(rows);
});

app.post('/api/events/:id/shifts', auth, async (req, res) => {
  const {job} = req.body;
  const eventId = req.params.id;
  const evRows = await query('SELECT * FROM events WHERE id=$1', [eventId]);
  const ev = evRows[0];
  if (!ev) return res.status(404).json({error:'Nicht gefunden'});
  if (ev.status !== 'open') return res.status(400).json({error:'Anlass nicht offen'});
  const cnt = await query('SELECT COUNT(*) as c FROM shifts WHERE event_id=$1 AND job=$2', [eventId, job]);
  if (parseInt(cnt[0].c) >= ev[`${job}_needed`]) return res.status(400).json({error:'Schicht voll'});
  const userRow = await query('SELECT jobs,role FROM users WHERE id=$1',[req.user.id]);
  const userJobs = userRow[0]?.jobs || [];
  if (userRow[0]?.role !== 'admin' && !userJobs.includes(job)) return res.status(403).json({error:'Keine Berechtigung fuer diese Funktion'});
  try {
    const rows = await query('INSERT INTO shifts (event_id,user_id,job) VALUES ($1,$2,$3) RETURNING id',
      [eventId, req.user.id, job]);
    res.json({id:rows[0].id});
  } catch(e) { res.status(400).json({error:'Bereits eingetragen'}); }
});

app.delete('/api/events/:eid/shifts/:sid', auth, async (req, res) => {
  const rows = await query('SELECT * FROM shifts WHERE id=$1', [req.params.sid]);
  const shift = rows[0];
  if (!shift) return res.status(404).json({error:'Nicht gefunden'});
  if (shift.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({error:'Kein Zugriff'});
  await query('DELETE FROM shifts WHERE id=$1', [req.params.sid]);
  res.json({ok:true});
});

// ── Start ──
console.log('DATABASE_URL gesetzt:', !!process.env.DATABASE_URL);
if (!process.env.DATABASE_URL) {
  console.error('FEHLER: DATABASE_URL nicht gesetzt!');
  process.exit(1);
}

initDb().then(() => {
  app.listen(PORT, () => console.log(`StaffPlan auf Port ${PORT}`));
}).catch(e => {
  console.error('DB Init Fehler:', e.message, e.stack);
  process.exit(1);
});
