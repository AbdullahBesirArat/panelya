const { randomBytes } = require('crypto');

function secret(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function main() {
  const jwtSecret = secret(48);
  const callbackSecret = secret(32);
  const adminBootstrapPassword = secret(18);

  console.log('Maveran secret seti hazir.');
  console.log('');
  console.log(`JWT_SECRET=${jwtSecret}`);
  console.log(`PAYMENT_CALLBACK_SECRET=${callbackSecret}`);
  console.log(`ADMIN_BOOTSTRAP_PASSWORD=${adminBootstrapPassword}`);
  console.log('');
  console.log('Sonraki adimlar:');
  console.log('1. Yeni degerleri .env veya secret manager icine yaz.');
  console.log('2. Eski secretleri gecersiz kil.');
  console.log('3. Deploy sonrasi npm run check:production ve smoke testleri calistir.');
}

main();
