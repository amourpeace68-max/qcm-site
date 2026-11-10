const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'qcm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  mot_de_passe TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'etudiant',
  cree_le TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS qcm (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  matiere TEXT,
  duree_minutes INTEGER NOT NULL DEFAULT 30,
  publie INTEGER NOT NULL DEFAULT 0,
  correction_visible INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qcm_id INTEGER NOT NULL REFERENCES qcm(id) ON DELETE CASCADE,
  enonce TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT,
  option_d TEXT,
  bonne_reponse TEXT NOT NULL,
  points REAL NOT NULL DEFAULT 1,
  explication TEXT
);

CREATE TABLE IF NOT EXISTS resultats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  qcm_id INTEGER NOT NULL REFERENCES qcm(id),
  debut TEXT NOT NULL,
  fin TEXT,
  points_obtenus REAL,
  points_total REAL,
  note REAL,
  UNIQUE(user_id, qcm_id)
);

CREATE TABLE IF NOT EXISTS reponses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resultat_id INTEGER NOT NULL REFERENCES resultats(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  choix TEXT,
  correct INTEGER NOT NULL DEFAULT 0
);
`);

module.exports = db;
