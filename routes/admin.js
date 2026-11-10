const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const path = require('path');
const db = require('../db');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === '.xlsx' || ext === '.csv');
  },
});

const normaliser = (s) =>
  String(s || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

function texteCellule(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('').trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (v.text !== undefined) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}

async function lireFeuille(file) {
  const wb = new ExcelJS.Workbook();
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.xlsx') {
    await wb.xlsx.load(file.buffer);
    return wb.worksheets[0];
  }
  const premiereLigne = file.buffer.toString('utf8').split(/\r?\n/)[0];
  const delimiter = premiereLigne.includes(';') ? ';' : ',';
  return wb.csv.read(Readable.from(file.buffer), { parserOptions: { delimiter } });
}

const insQcm = db.prepare('INSERT INTO qcm (titre, matiere, duree_minutes) VALUES (?, ?, ?)');
const insQuestion = db.prepare(
  'INSERT INTO questions (qcm_id, enonce, option_a, option_b, option_c, option_d, bonne_reponse, points, explication) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const importer = db.transaction((titre, matiere, duree, questions) => {
  const id = insQcm.run(titre, matiere, duree).lastInsertRowid;
  for (const q of questions) {
    insQuestion.run(id, q.enonce, q.a, q.b, q.c || null, q.d || null, q.bonne, q.points, q.explication || null);
  }
  return id;
});

router.post('/import', (req, res) => {
  upload.single('fichier')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ erreur: err.message });
      if (!req.file) return res.status(400).json({ erreur: 'Fichier .xlsx ou .csv requis.' });

      const titre = String(req.body.titre || '').trim();
      const matiere = String(req.body.matiere || '').trim() || null;
      const duree = parseInt(req.body.duree_minutes, 10) || 30;
      if (!titre) return res.status(400).json({ erreur: 'Le titre est obligatoire.' });
      if (duree < 1 || duree > 600) return res.status(400).json({ erreur: 'Durée : entre 1 et 600 minutes.' });

      const ws = await lireFeuille(req.file);
      if (!ws) return res.status(400).json({ erreur: 'Fichier vide ou illisible.' });

      const entetes = {};
      ws.getRow(1).eachCell((cell, col) => {
        entetes[normaliser(texteCellule(cell.value))] = col;
      });
      const manquantes = ['question', 'option_a', 'option_b', 'bonne_reponse'].filter((n) => !entetes[n]);
      if (manquantes.length) {
        return res.status(400).json({ erreur: 'Colonnes manquantes : ' + manquantes.join(', ') });
      }

      const get = (row, nom) => (entetes[nom] ? texteCellule(row.getRow ? '' : row.getCell(entetes[nom]).value) : '');
      const questions = [];
      const erreurs = [];

      for (let i = 2; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const enonce = get(row, 'question');
        const a = get(row, 'option_a');
        const b = get(row, 'option_b');
        const c = get(row, 'option_c');
        const d = get(row, 'option_d');
        const bonne = get(row, 'bonne_reponse').toUpperCase();
        const ptsTexte = get(row, 'points').replace(',', '.');
        const explication = get(row, 'explication');

        if (!enonce && !a && !b && !bonne) continue; // ligne vide

        const points = ptsTexte === '' ? 1 : Number(ptsTexte);
        const options = { A: a, B: b, C: c, D: d };

        if (!enonce) erreurs.push('Ligne ' + i + ' : question vide.');
        else if (!a || !b) erreurs.push('Ligne ' + i + ' : option_a et option_b sont obligatoires.');
        else if (!/^[ABCD]$/.test(bonne)) erreurs.push('Ligne ' + i + ' : bonne_reponse doit être A, B, C ou D.');
        else if (!options[bonne]) erreurs.push('Ligne ' + i + ' : la bonne réponse ' + bonne + ' n\'a pas de texte.');
        else if (!Number.isFinite(points) || points <= 0) erreurs.push('Ligne ' + i + ' : points invalides.');
        else questions.push({ enonce, a, b, c, d, bonne, points, explication });
      }

      if (erreurs.length) return res.status(400).json({ erreur: erreurs.slice(0, 15).join('\n') });
      if (!questions.length) return res.status(400).json({ erreur: 'Aucune question trouvée dans le fichier.' });

      const id = importer(titre, matiere, duree, questions);
      res.json({ ok: true, qcm_id: id, nb_questions: questions.length });
    } catch (e) {
      console.error(e);
      res.status(400).json({ erreur: 'Impossible de lire ce fichier.' });
    }
  });
});

router.get('/qcm', (req, res) => {
  const liste = db
    .prepare(
      `SELECT q.id, q.titre, q.matiere, q.duree_minutes, q.publie, COUNT(s.id) AS nb_questions
       FROM qcm q LEFT JOIN questions s ON s.qcm_id = q.id
       GROUP BY q.id ORDER BY q.id DESC`
    )
    .all();
  res.json(liste);
});

router.post('/qcm/:id/publication', (req, res) => {
  const publie = req.body.publie ? 1 : 0;
  const r = db.prepare('UPDATE qcm SET publie = ? WHERE id = ?').run(publie, req.params.id);
  if (!r.changes) return res.status(404).json({ erreur: 'QCM introuvable.' });
  res.json({ ok: true });
});

module.exports = router;
