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

// Fichiers accessibles publiquement
app.use(express.static(path.join(__dirname, 'public')));
app.use('/private', express.static(path.join(__dirname, 'private')));

// Importation des routes
const authRoutes = require('./routes/auth');
const generationRoutes = require('./routes/generation');

// Branchement des routes (attention à ne pas doubler le /api)
app.use('/api/auth', authRoutes);
app.use(generationRoutes); 

// Page d'accueil par défaut
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});