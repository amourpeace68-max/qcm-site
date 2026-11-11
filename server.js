const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'cle_secrete_pour_le_site_qcm',
    resave: false,
    saveUninitialized: true
}));

// --- FICHIERS STATIQUES ---
// Permet d'accéder aux fichiers du dossier public (login.html, style.css)
app.use(express.static(path.join(__dirname, 'public')));

// Permet d'accéder aux fichiers du dossier private (admin.html, dashboard.html)
app.use('/private', express.static(path.join(__dirname, 'private')));

// --- IMPORTATION DES ROUTES ---
const authRoutes = require('./routes/auth');
const generationRoutes = require('./routes/generation');

// Branchement des routes
app.use('/api/auth', authRoutes);
app.use(generationRoutes); 

// --- ROUTES DE NAVIGATION ---

// Route pour afficher le dashboard (C'EST CE QUI MANQUAIT !)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

// Route par défaut : redirige vers la page de connexion
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});