const db = require('./db');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.log('Usage : node promouvoir.js email@exemple.com');
  process.exit(1);
}
const r = db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
console.log(r.changes ? 'OK : ' + email + ' est administrateur.' : 'Aucun compte avec cet email.');
