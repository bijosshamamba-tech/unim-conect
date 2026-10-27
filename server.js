const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'changez-ce-secret-en-production';
const db = new Database(process.env.DB_FILE || 'unim.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  matricule TEXT DEFAULT '',
  faculte TEXT DEFAULT '',
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Migrations (ignorées si la colonne existe déjà)
for (const sql of [
  "ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''",
  "ALTER TABLE posts ADD COLUMN image TEXT DEFAULT ''",
  "ALTER TABLE posts ADD COLUMN groupe TEXT DEFAULT ''",
]) { try { db.exec(sql); } catch {} }

// Premier démarrage : création du compte administrateur
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@unim.cd';
  const pass = process.env.ADMIN_PASSWORD || 'Admin@12345';
  db.prepare("INSERT INTO users (nom,email,password,role,status) VALUES (?,?,?,'admin','approved')")
    .run('Administrateur UNIM', email, bcrypt.hashSync(pass, 10));
  console.log(`Compte admin créé : ${email} / ${pass}  (changez ce mot de passe !)`);
}

const app = express();
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });
const UPLOAD_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/;

// Emails (optionnels) : actifs seulement si SMTP_HOST est défini
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = require('nodemailer').createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
const mail = (to, subject, text) => mailer &&
  mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text })
    .catch((e) => console.error('Email non envoyé :', e.message));

app.use('/api/upload', express.json({ limit: '3mb' }));
app.use(express.json({ limit: '50kb' }));
app.use('/uploads', express.static(UP, { setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(__dirname, 'public')));

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const auth = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { id } = jwt.verify(token, SECRET);
    const u = db.prepare('SELECT id,nom,email,faculte,avatar,role,status FROM users WHERE id=?').get(id);
    if (!u || u.status !== 'approved') return res.status(403).json({ error: "Compte non validé" });
    req.user = u;
    next();
  } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous' }); }
};
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Réservé aux administrateurs' });

// ---------- Authentification ----------
app.post('/api/register', (req, res) => {
  const nom = str(req.body.nom, 80), email = str(req.body.email, 120).toLowerCase();
  const matricule = str(req.body.matricule, 40), faculte = str(req.body.faculte, 80);
  const pw = String(req.body.password || '');
  if (!nom || !/^\S+@\S+\.\S+$/.test(email) || pw.length < 8)
    return res.status(400).json({ error: 'Nom, email valide et mot de passe (8 caractères minimum) requis' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  db.prepare('INSERT INTO users (nom,email,matricule,faculte,password) VALUES (?,?,?,?,?)')
    .run(nom, email, matricule, faculte, bcrypt.hashSync(pw, 10));
  db.prepare("SELECT email FROM users WHERE role='admin'").all().forEach((a) =>
    mail(a.email, 'Nouvelle demande d\u2019inscription - UNIM Network', `${nom} (${email}) demande l'accès au réseau. Validez la demande : ${APP_URL}`));
  res.status(201).json({ message: "Demande envoyée. Un administrateur doit valider votre compte avant votre première connexion." });
});

app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(str(req.body.email, 120).toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password))
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  if (u.status === 'pending') return res.status(403).json({ error: "Votre compte est en attente de validation par un administrateur" });
  if (u.status === 'rejected') return res.status(403).json({ error: "Votre demande d'inscription a été refusée" });
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' }) });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---------- Publications ----------
app.get('/api/posts', auth, (req, res) => {
  const g = req.query.groupe && req.query.groupe !== 'all' ? String(req.query.groupe) : '';
  res.json(db.prepare(`
    SELECT p.id, p.content, p.created_at, p.user_id, p.image, p.groupe, u.nom, u.faculte, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
      (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments,
      EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=?) AS liked
    FROM posts p JOIN users u ON u.id=p.user_id ${g ? 'WHERE p.groupe=?' : ''} ORDER BY p.id DESC LIMIT 100`)
    .all(...[req.user.id, ...(g ? [g === 'general' ? '' : g] : [])]));
});

app.post('/api/posts', auth, (req, res) => {
  const content = str(req.body.content, 1000);
  if (!content) return res.status(400).json({ error: 'Écrivez quelque chose avant de publier' });
  const image = str(req.body.image, 80), g = str(req.body.groupe, 80);
  if (image && !UPLOAD_RE.test(image)) return res.status(400).json({ error: 'Image invalide' });
  if (g && g !== 'general' && g !== req.user.faculte) return res.status(400).json({ error: 'Groupe invalide' });
  db.prepare('INSERT INTO posts (user_id,content,image,groupe) VALUES (?,?,?,?)')
    .run(req.user.id, content, image, g === 'general' ? '' : g);
  res.status(201).json({ ok: true });
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const p = db.prepare('SELECT user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Publication introuvable' });
  if (p.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Action non autorisée' });
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Publication introuvable' });
  const r = db.prepare('DELETE FROM likes WHERE post_id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!r.changes) db.prepare('INSERT INTO likes (post_id,user_id) VALUES (?,?)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/posts/:id/comments', auth, (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.content, c.created_at, u.nom FROM comments c
    JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id`).all(req.params.id));
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const content = str(req.body.content, 500);
  if (!content) return res.status(400).json({ error: 'Commentaire vide' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Publication introuvable' });
  db.prepare('INSERT INTO comments (post_id,user_id,content) VALUES (?,?,?)').run(req.params.id, req.user.id, content);
  res.status(201).json({ ok: true });
});

// ---------- Images, profil, groupes ----------
app.post('/api/upload', auth, (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!m) return res.status(400).json({ error: 'Image invalide (PNG, JPEG ou WebP)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Image trop lourde (2 Mo maximum)' });
  const name = crypto.randomBytes(16).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, name), buf);
  res.json({ url: '/uploads/' + name });
});

app.put('/api/me/avatar', auth, (req, res) => {
  const url = str(req.body.url, 80);
  if (!UPLOAD_RE.test(url)) return res.status(400).json({ error: 'Image invalide' });
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(url, req.user.id);
  res.json({ ok: true });
});

app.get('/api/groupes', auth, (req, res) => {
  res.json(db.prepare("SELECT DISTINCT faculte FROM users WHERE status='approved' AND faculte!='' ORDER BY faculte")
    .all().map((r) => r.faculte));
});

app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare("SELECT id,nom,faculte,avatar FROM users WHERE status='approved' AND id!=? ORDER BY nom").all(req.user.id));
});

// ---------- Messagerie privée ----------
app.get('/api/messages/unread', auth, (req, res) => {
  res.json({ n: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE to_id=? AND is_read=0').get(req.user.id).n });
});

app.get('/api/messages/conversations', auth, (req, res) => {
  const me = req.user.id;
  res.json(db.prepare(`
    SELECT u.id, u.nom, u.avatar, m.content AS last, m.created_at,
      (SELECT COUNT(*) FROM messages WHERE from_id=u.id AND to_id=? AND is_read=0) AS unread
    FROM users u JOIN messages m ON m.id=(
      SELECT MAX(id) FROM messages WHERE (from_id=? AND to_id=u.id) OR (from_id=u.id AND to_id=?))
    ORDER BY m.id DESC`).all(me, me, me));
});

app.get('/api/messages/:userId', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.userId);
  db.prepare('UPDATE messages SET is_read=1 WHERE from_id=? AND to_id=?').run(other, me);
  res.json(db.prepare(`SELECT id, from_id, content, created_at FROM messages
    WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 200`).all(me, other, other, me).reverse());
});

app.post('/api/messages/:userId', auth, (req, res) => {
  const other = Number(req.params.userId), content = str(req.body.content, 1000);
  if (!content) return res.status(400).json({ error: 'Message vide' });
  if (other === req.user.id || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='approved'").get(other))
    return res.status(404).json({ error: 'Destinataire introuvable' });
  db.prepare('INSERT INTO messages (from_id,to_id,content) VALUES (?,?,?)').run(req.user.id, other, content);
  res.status(201).json({ ok: true });
});

// ---------- Administration ----------
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const s = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json(db.prepare(`SELECT id,nom,email,matricule,faculte,status,created_at FROM users
    WHERE status=? AND role!='admin' ORDER BY id DESC`).all(s));
});

app.post('/api/admin/users/:id/:action', auth, adminOnly, (req, res) => {
  const status = { approve: 'approved', reject: 'rejected' }[req.params.action];
  if (!status) return res.status(400).json({ error: 'Action invalide' });
  const u = db.prepare("SELECT nom,email FROM users WHERE id=? AND role!='admin'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.params.id);
  mail(u.email,
    status === 'approved' ? 'Votre compte UNIM Network est validé' : 'Votre demande UNIM Network',
    status === 'approved'
      ? `Bonjour ${u.nom}, votre compte est validé. Connectez-vous : ${APP_URL}`
      : `Bonjour ${u.nom}, votre demande d'inscription n'a pas été retenue.`);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`UNIM Network : http://localhost:${PORT}`));
