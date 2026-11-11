const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();

const CLE_GROQ = process.env.GROQ_API_KEY || '';
const MODELE_GROQ = 'llama-3.1-8b-instant'; 
const MAX_CARACTERES = 15000; 

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function extraireTexte(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.txt') return Promise.resolve(file.buffer.toString('utf8'));
  if (ext !== '.pdf') return Promise.reject(new Error('Format accepté : PDF ou TXT.'));
  return new Promise((resolve, reject) => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'qcm-'));
    const chemin = path.join(dossier, 'doc.pdf');
    fs.writeFileSync(chemin, file.buffer);
    execFile('pdftotext', [chemin, '-'], { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      fs.rmSync(dossier, { recursive: true, force: true });
      if (err) return reject(new Error('Lecture du PDF impossible.'));
      resolve(stdout);
    });
  });
}

function construirePrompt(texte, nb, difficulte) {
  return `Tu es un enseignant. À partir du DOCUMENT ci-dessous, rédige exactement ${nb} questions à choix multiples en français, de difficulté ${difficulte}.
Règles strictes :
- Les questions portent uniquement sur le document.
- 4 options (A, B, C, D), une seule correcte.
- Ne génère JAMAIS deux options synonymes.
- Ajoute une explication courte.
Réponds UNIQUEMENT en JSON valide :
{"questions":[{"question":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","bonne_reponse":"A","explication":"..."}]}
DOCUMENT :
"""
${texte}
"""`;
}

async function appelerGroq(prompt) {
  const reponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${CLE_GROQ}` },
    body: JSON.stringify({
      model: MODELE_GROQ,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!reponse.ok) throw new Error(`Erreur Groq (${reponse.status})`);
  const data = await reponse.json();
  return data.choices[0].message.content;
}

function lireJson(texte) {
  const d = texte.indexOf('{');
  const f = texte.lastIndexOf('}');
  if (d !== -1 && f > d) {
    try {
      const o = JSON.parse(texte.slice(d, f + 1));
      if (Array.isArray(o.questions)) return o.questions;
    } catch (e) { }
  }
  throw new Error('JSON invalide');
}

function nettoyer(liste, nb) {
  const t = (v) => String(v == null ? '' : v).trim();
  const valides = [];
  for (const q of liste) {
    if (!q || !q.question || !q.option_a || !q.option_b || !q.option_c || !q.option_d) continue;
    valides.push({
      enonce: t(q.question), a: t(q.option_a), b: t(q.option_b), c: t(q.option_c), d: t(q.option_d),
      bonne: t(q.bonne_reponse).toUpperCase(), explication: t(q.explication)
    });
    if (valides.length >= nb) break;
  }
  return valides;
}

async function genererQuestions(texte, nb, difficulte) {
  const prompt = construirePrompt(texte.slice(0, MAX_CARACTERES), nb, difficulte);
  const brut = await appelerGroq(prompt);
  return nettoyer(lireJson(brut), nb);
}

// LA ROUTE POUR L'ÉTUDIANT
router.post('/api/generer-etudiant', upload.single('fichier'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erreur: 'Fichier requis.' });
        const nb = Math.min(Math.max(parseInt(req.body.nb_questions) || 10, 3), 20);
        const texte = (await extraireTexte(req.file)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (texte.length < 200) return res.status(400).json({ erreur: 'Texte insuffisant.' });

        const questions = await genererQuestions(texte, nb, req.body.difficulte || 'moyenne');
        if (!questions.length) return res.status(502).json({ erreur: 'Aucune question générée.' });

        res.json({ ok: true, questions });
    } catch (e) {
        console.error(e);
        res.status(500).json({ erreur: e.message || 'Erreur lors de la génération.' });
    }
});

module.exports = router;