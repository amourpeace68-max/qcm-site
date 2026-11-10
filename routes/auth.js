const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();
const emailValide = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function ouvrirSession(req, res, userId) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ erreur: 'Erreur serveur.' });
    req.session.userId = userId;
    res.json({ ok: true });
  });
}

router.post('/register', async (req, res) => {
  const nom = String(req.body.nom || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const mdp = String(req.body.mot_de_passe || '');

  if (nom.length < 2) return res.status(400).json({ erreur: 'Nom trop court.' });
  if (!emailValide(email)) return res.status(400).json({ erreur: 'Email invalide.' });
  if (mdp.length < 8) return res.status(400).json({ erreur: 'Mot de passe : 8 caractères minimum.' });

  try {
    const hash = await bcrypt.hash(mdp, 10);
    const info = db
      .prepare('INSERT INTO users (nom, email, mot_de_passe) VALUES (?, ?, ?)')
      .run(nom, email, hash);
    ouvrirSession(req, res, info.lastInsertRowid);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ erreur: 'Cet email est déjà inscrit.' });
    }
    console.error(e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const mdp = String(req.body.mot_de_passe || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !(await bcrypt.compare(mdp, user.mot_de_passe))) {
    return res.status(401).json({ erreur: 'Email ou mot de passe incorrect.' });
  }
  ouvrirSession(req, res, user.id);
});

router.post('/logout', async (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ erreur: 'Non connecté.' });
  const user = db
    .prepare('SELECT id, nom, email, role FROM users WHERE id = ?')
    .get(req.session.userId);
  res.json(user);
});

module.exports = router;
