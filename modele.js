const ExcelJS = require('exceljs');

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('QCM');
  ws.addRow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'bonne_reponse', 'points', 'explication']);
  ws.addRow(['Quelle est la capitale du Bénin ?', 'Cotonou', 'Porto-Novo', 'Parakou', 'Abomey', 'B', 1, 'Porto-Novo est la capitale officielle.']);
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile('modele-qcm.xlsx');
  console.log('Fichier créé : modele-qcm.xlsx');
})();
