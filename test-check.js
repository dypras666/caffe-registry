const { checkAvailability } = require('./services/provisioner');

async function test() {
  console.log('Testing checkAvailability...');
  
  const result1 = await checkAvailability('test-new-slug');
  console.log('test-new-slug:', JSON.stringify(result1));
  
  const result2 = await checkAvailability('asasa');
  console.log('asasa:', JSON.stringify(result2));
}

test().catch(console.error);
