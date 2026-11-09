const cds = require('@sap/cds');
const { registerRoutes } = require('./srv/document-ai');

cds.on('bootstrap', (app) => {
  registerRoutes(app);
});

module.exports = cds.server;
