const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret-de-developpement-a-changer',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 4 * 60 * 60 * 1000,
    },
  })
);

function exigerConnexion(req, res, next) {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
}

function estAdmin(req) {
  if (!req.session.userId) return false;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  return !!u && u.role === 'admin';
}
function exigerAdmin(req, res, next) {
  if (!estAdmin(req)) return res.status(403).json({ erreur: 'Accès réservé à l\'administrateur.' });
  next();
}
function exigerAdminPage(req, res, next) {
  if (!estAdmin(req)) return res.redirect('/login.html');
  next();
}

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', exigerAdmin, require('./routes/admin'));
app.use('/api/admin', exigerAdmin, require('./routes/generation'));

app.get('/', (req, res) => res.redirect(req.session.userId ? '/dashboard' : '/login.html'));
app.get('/dashboard', exigerConnexion, (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'dashboard.html'))
);
app.get('/admin', exigerAdminPage, (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'admin.html'))
);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur lancé : http://localhost:' + PORT));
