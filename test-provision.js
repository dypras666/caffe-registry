const p = require('./services/provisioner');
console.log('Starting test provisioning...');

p.provisionTenant(2, 'testcafe2', 'test2@test.com', 'TestPass123')
  .then(() => console.log('Done'))
  .catch(e => console.error('Error:', e.message));
