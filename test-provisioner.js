const p = require('./services/provisioner');
console.log('Testing provisioner module...');

p.checkAvailability('test123')
  .then(r => console.log('checkAvailability result:', r))
  .catch(e => console.error('Error:', e.message));
