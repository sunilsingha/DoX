const cds = require('@sap/cds');
const { publicStatus, buildSampleResult, loadSchemaSync } = require('./document-ai');

module.exports = cds.service.impl(function () {
  this.on('token', () => (publicStatus().configured ? 'configured' : 'not-configured'));

  this.on('extractDataFromImage', () => {
    return JSON.stringify(buildSampleResult(loadSchemaSync(), { originalname: 'sample-gst-invoice' }));
  });
});
