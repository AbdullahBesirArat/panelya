const test = require('node:test');
const assert = require('node:assert/strict');

const uploadRoute = require('../routes/upload');

test('detectImageFormat magic byte disinda mimetype/uzantiya guvenmez', () => {
  assert.equal(uploadRoute.detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), 'jpeg');
  assert.equal(uploadRoute.detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])), 'png');
  assert.equal(uploadRoute.detectImageFormat(Buffer.from('RIFFxxxxWEBP', 'ascii')), 'webp');
  assert.equal(uploadRoute.detectImageFormat(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(uploadRoute.detectImageFormat(Buffer.from('not an image')), null);
});
