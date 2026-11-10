const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

const router = express.Router();

// --- CLÉS API ET MODÈLES ---
const CLE_GROQ = process.env.GROQ_API_KEY || '';
const CLE_GEMINI = process.env.GEMINI_API_KEY || ''; // Optionnel (secours)
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'; // Optionnel (secours local)
const MODELE_OLLAMA = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// Modèle Groq ultra-rapide
const MODELE_GROQ = 'llama-3.1-8b-instant'; 

// Limite de texte pour éviter que l'IA ne mette trop de temps à lire
const MAX_CARACTERES = 15000; 
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- EXTRACTION DU TEXTE (PDF / TXT) ---
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

// --- CONSTRUCTION DU PROMPT ---
function construirePrompt(texte, nb, difficulte) {
  return `Tu es un enseignant. À partir du DOCUMENT ci-dessous, rédige exactement ${nb} questions à choix multiples en français, de difficulté ${difficulte}.
Règles strictes :
- Les questions portent uniquement sur les notions présentes dans le document.
- Chaque question a 4 options (A, B, C, D) dont une seule est correcte.
- ATTENTION : Ne génère JAMAIS deux options qui sont des synonymes ou des versions d'un même nom.
- Varie la position de la bonne réponse.
- Les mauvaises réponses sont plausibles mais clairement fausses.
- Ajoute une explication très courte (une phrase) qui justifie la bonne réponse.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, de la forme :
{"questions":[{"question":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","bonne_reponse":"A","explication":"..."}]}

DOCUMENT :
"""
${texte}
"""`;
}

// --- APPELS AUX API ---

async function appelerGroq(prompt) {
  console.log("📡 Appel de l'API Groq en cours...");
  const reponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${CLE_GROQ}`,
    },
    body: JSON.stringify({
      model: MODELE_GROQ,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000), // 60 secondes max
  });

  if (!reponse.ok) {
    const errTxt = await reponse.text();
    console.error('❌ Erreur Groq', reponse.status, errTxt);
    if (reponse.status === 429) throw new Error('Quota Groq dépassé. Attends 1 minute.');
    throw new Error(`L'API Groq a répondu par une erreur (${reponse.status}).`);
  }

  const data = await reponse.json();
  console.log("✅ Réponse de Groq reçue !");
  return data.choices[0].message.content;
}

async function appelerGemini(prompt) {
  console.log("📡 Appel de l'API Gemini en cours...");
  const reponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CLE_GEMINI}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!reponse.ok) throw new Error(`Erreur Gemini (${reponse.status})`);
  const data = await reponse.json();
  console.log("✅ Réponse de Gemini reçue !");
  return data.candidates[0].content.parts[0].text;
}

async function appelerOllama(prompt) {
  console.log("📡 Appel d'Ollama en local (patientez...)");
  const reponse = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELE_OLLAMA,
      stream: false,
      format: 'json',
      options: { num_ctx: 4096, temperature: 0.2 },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!reponse.ok) throw new Error('Erreur Ollama');
  const data = await reponse.json();
  console.log("✅ Réponse d'Ollama reçue !");
  return data.message.content;
}

// --- PARSING ET NETTOYAGE ---
function lireJson(texte) {
  const d = texte.indexOf('{');
  const f = texte.lastIndexOf('}');
  if (d !== -1 && f > d) {
    try {
      const o = JSON.parse(texte.slice(d, f + 1));
      if (Array.isArray(o.questions)) return o.questions;
    } catch (e) {
      console.error("⚠️ Erreur de syntaxe JSON.");
    }
  }
  throw new Error('Le modèle n\'a pas renvoyé un JSON valide.');
}

function nettoyer(liste, nb) {
  const t = (v) => String(v == null ? '' : v).trim().slice(0, 600);
  const valides = [];
  for (const q of liste) {
    if (!q || typeof q !== 'object') continue;
    const item = {
      enonce: t(q.question), a: t(q.option_a), b: t(q.option_b), c: t(q.option_c), d: t(q.option_d),
      bonne: t(q.bonne_reponse).toUpperCase(), explication: t(q.explication),
    };
    if (!item.enonce || !item.a || !item.b || !item.c || !item.d) continue;
    if (new Set([item.a, item.b, item.c, item.d].map((x) => x.toLowerCase())).size < 4) continue;
    if (!/^[ABCD]$/.test(item.bonne)) continue;
    valides.push(item);
    if (valides.length >= nb) break;
  }
  return valides;
}

// --- MOTEUR PRINCIPAL ---
async function genererQuestions(texte, nb, difficulte) {
  const texteCoupe = texte.slice(0, MAX_CARACTERES);
  const prompt = construirePrompt(texteCoupe, nb, difficulte);
  let brut = '';

  try {
    if (CLE_GROQ) {
      brut = await appelerGroq(prompt);
    } else if (CLE_GEMINI) {
      brut = await appelerGemini(prompt);
    } else {
      brut = await appelerOllama(prompt);
    }
    
    const questions = nettoyer(lireJson(brut), nb);
    if (questions.length === 0) throw new Error("0 questions valides générées.");
    return { questions, derniereErreur: '' };
  } catch (e) {
    console.error('❌ Erreur de génération :', e.message);
    return { questions: [], derniereErreur: e.message };
  }
}

// --- ROUTES EXPRESS ---
const insQcm = db.prepare('INSERT INTO qcm (titre, matiere, duree_minutes) VALUES (?, ?, ?)');
const insQ = db.prepare(
  'INSERT INTO questions (qcm_id, enonce, option_a, option_b, option_c, option_d, bonne_reponse, points, explication) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
);
const enregistrer = db.transaction((titre, matiere, duree, questions) => {
  const id = insQcm.run(titre, matiere, duree).lastInsertRowid;
  for (const q of questions) insQ.run(id, q.enonce, q.a, q.b, q.c, q.d, q.bonne, q.explication || null);
  return id;
});

router.get('/generer-page', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'private', 'generer.html'))
);

router.post('/generer', (req, res) => {
  upload.single('fichier')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ erreur: err.message });
      if (!req.file) return res.status(400).json({ erreur: 'Fichier PDF ou TXT requis.' });

      const titre = String(req.body.titre || '').trim();
      if (!titre) return res.status(400).json({ erreur: 'Le titre est obligatoire.' });
      
      const matiere = String(req.body.matiere || '').trim() || null;
      const duree = Math.min(Math.max(parseInt(req.body.duree_minutes, 10) || 30, 1), 600);
      const nb = Math.min(Math.max(parseInt(req.body.nb_questions, 10) || 10, 3), 30);
      const difficulte = ['facile', 'moyenne', 'difficile'].includes(req.body.difficulte) ? req.body.difficulte : 'moyenne';

      console.log(`\n--- Nouvelle génération (${nb} questions) ---`);
      
      const texte = (await extraireTexte(req.file)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (texte.length < 200) return res.status(400).json({ erreur: 'Texte insuffisant dans ce fichier.' });

      const { questions, derniereErreur } = await genererQuestions(texte, nb, difficulte);
      if (!questions.length) return res.status(502).json({ erreur: derniereErreur || 'Aucune question générée.' });

      console.log(`💾 Enregistrement de ${questions.length} questions...`);
      const id = enregistrer(titre, matiere, duree, questions);
      const lignes = db.prepare('SELECT id, enonce, option_a, option_b, option_c, option_d, bonne_reponse, explication FROM questions WHERE qcm_id = ? ORDER BY id').all(id);
      
      console.log("🎉 Terminé avec succès !\n");
      res.json({ ok: true, qcm_id: id, questions: lignes });
    } catch (e) {
      console.error("💥 Erreur fatale :", e);
      res.status(500).json({ erreur: e.message || 'Erreur pendant la génération.' });
    }
  });
});

router.delete('/questions/:id', (req, res) => {
  try {
    const r = db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
    res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
  } catch (e) {
    res.status(409).json({ erreur: 'Question déjà utilisée dans un examen.' });
  }
});

module.exports = router;