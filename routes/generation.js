const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

const router = express.Router();

// --- CONFIGURATION ---
const CLE_GROQ = process.env.GROQ_API_KEY || '';
const MODELE_GROQ = 'llama-3.1-8b-instant'; 
const MAX_CARACTERES = 15000; 

// Configuration de Multer (stockage en mémoire pour traiter le fichier)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- FONCTIONS UTILITAIRES ---

// 1. Extraire le texte du PDF ou TXT
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

// 2. Construire le prompt pour l'IA
function construirePrompt(texte, nb, difficulte) {
  return `Tu es un enseignant. À partir du DOCUMENT ci-dessous, rédige exactement ${nb} questions à choix multiples en français, de difficulté ${difficulte}.
Règles strictes :
- Les questions portent uniquement sur les notions présentes dans le document.
- Chaque question a 4 options (A, B, C, D) dont une seule est correcte.
- ATTENTION : Ne génère JAMAIS deux options qui sont des synonymes ou des versions d'un même nom.
- Varie la position de la bonne réponse.
- Ajoute une explication très courte (une phrase) qui justifie la bonne réponse.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de la forme :
{"questions":[{"question":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","bonne_reponse":"A","explication":"..."}]}

DOCUMENT :
"""
${texte}
"""`;
}

// 3. Appeler l'API Groq
async function appelerGroq(prompt) {
  console.log("📡 Appel de l'API Groq...");
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
    signal: AbortSignal.timeout(60000),
  });

  if (!reponse.ok) {
    const errTxt = await reponse.text();
    console.error('❌ Erreur Groq', reponse.status, errTxt);
    throw new Error(`L'API Groq a répondu par une erreur (${reponse.status}).`);
  }

  const data = await reponse.json();
  console.log("✅ Réponse Groq reçue !");
  return data.choices[0].message.content;
}

// 4. Parser et nettoyer le JSON reçu
function lireJson(texte) {
  const d = texte.indexOf('{');
  const f = texte.lastIndexOf('}');
  if (d !== -1 && f > d) {
    try {
      const o = JSON.parse(texte.slice(d, f + 1));
      if (Array.isArray(o.questions)) return o.questions;
    } catch (e) { }
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
    // Vérifie que les 4 options sont différentes
    if (new Set([item.a, item.b, item.c, item.d].map((x) => x.toLowerCase())).size < 4) continue;
    if (!/^[ABCD]$/.test(item.bonne)) continue;
    valides.push(item);
    if (valides.length >= nb) break;
  }
  return valides;
}

// 5. Fonction principale de génération
async function genererQuestions(texte, nb, difficulte) {
  const texteCoupe = texte.slice(0, MAX_CARACTERES);
  const prompt = construirePrompt(texteCoupe, nb, difficulte);
  
  try {
    const brut = await appelerGroq(prompt);
    const questions = nettoyer(lireJson(brut), nb);
    if (questions.length === 0) throw new Error("0 questions valides générées.");
    return { questions, derniereErreur: '' };
  } catch (e) {
    console.error('❌ Erreur de génération :', e.message);
    return { questions: [], derniereErreur: e.message };
  }
}

// --- ROUTES EXPRESS ---

// Route 1 : Pour l'administration (sauvegarde en DB)
router.post('/api/generer-admin', upload.single('fichier'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erreur: 'Fichier requis.' });
        const nb = Math.min(Math.max(parseInt(req.body.nb_questions) || 10, 3), 30);
        
        const texte = (await extraireTexte(req.file)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        const { questions, derniereErreur } = await genererQuestions(texte, nb, req.body.difficulte || 'moyenne');
        
        if (!questions.length) return res.status(502).json({ erreur: derniereErreur || 'Aucune question générée.' });

        res.json({ ok: true, questions });
    } catch (e) {
        console.error(e);
        res.status(500).json({ erreur: e.message || 'Erreur pendant la génération.' });
    }
});

// Route 2 : Pour les étudiants (renvoie juste le JSON sans sauvegarder)
router.post('/api/generer-etudiant', upload.single('fichier'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erreur: 'Fichier requis.' });
        
        const nb = Math.min(Math.max(parseInt(req.body.nb_questions) || 10, 3), 20);
        const difficulte = req.body.difficulte || 'moyenne';

        console.log(`\n--- Nouvelle génération Étudiant (${nb} questions) ---`);
        
        const texte = (await extraireTexte(req.file)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (texte.length < 200) return res.status(400).json({ erreur: 'Texte insuffisant dans le fichier.' });

        const { questions, derniereErreur } = await genererQuestions(texte, nb, difficulte);
        
        if (!questions.length) return res.status(502).json({ erreur: derniereErreur || 'Aucune question générée.' });

        console.log(`🎉 ${questions.length} questions générées pour l'étudiant !`);
        res.json({ ok: true, questions });
        
    } catch (e) {
        console.error("💥 Erreur fatale étudiant :", e);
        res.status(500).json({ erreur: 'Erreur lors de la génération.' });
    }
});

module.exports = router;