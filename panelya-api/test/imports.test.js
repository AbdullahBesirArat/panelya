const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const {
  configHash, inspectXlsxArchive, neutralizeSpreadsheetValue, parseImportFile, rowsToCsv, rowsToXlsx,
} = require('../modules/imports/formats');
const { blockedIp, downloadExternalImage, resolvePublicAddress } = require('../modules/imports/externalImage');
const { centralEntries, extractImageZip, safeEntryName } = require('../modules/imports/imageZip');

// --- Local test adapters (no real network, no real archive extraction to disk) ---

function fakeHttp(steps) {
  let index = 0;
  return function request(_url, _options, callback) {
    const spec = steps[Math.min(index, steps.length - 1)];
    index += 1;
    const req = new EventEmitter();
    req.destroy = (error) => { if (error) req.emit('error', error); };
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = spec.statusCode || 200;
        res.headers = spec.headers || {};
        res.resume = () => {};
        res.destroy = () => {};
        callback(res);
        if (res.statusCode === 200 && !(res.statusCode >= 300 && res.statusCode < 400)) {
          queueMicrotask(() => {
            const body = spec.body ? (Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body)) : Buffer.alloc(0);
            if (body.length) res.emit('data', body);
            res.emit('end');
          });
        }
      });
    };
    return req;
  };
}

const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];

function centralRecord({ name, flags = 0, method = 8, compressedSize = 12, uncompressedSize = 12, localOffset = 0 }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const record = Buffer.alloc(46 + nameBuf.length);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(flags, 8);
  record.writeUInt16LE(method, 10);
  record.writeUInt32LE(compressedSize, 20);
  record.writeUInt32LE(uncompressedSize, 24);
  record.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(record, 46);
  return record;
}

function buildCentralZip(entries) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(0x04034b50, 0);
  return Buffer.concat([head, ...entries.map(centralRecord)]);
}

test('valid BOM CSV preserves Turkish text and normalizes decimal commas', async () => {
  const csv = Buffer.from('\uFEFFstok_kodu;urun_adi;fiyat;kategori;stok\r\nSUV-1;Åžile Elbise;1299,90;Elbise;3', 'utf8');
  const parsed = await parseImportFile(csv, { filename: 'urunler.csv', jobType: 'product_upsert' });
  assert.equal(parsed.rows[0].payload.name, 'Åžile Elbise');
  assert.equal(parsed.rows[0].payload.price, 1299.9);
  assert.equal(parsed.rows[0].payload.stock, 3);
  assert.deepEqual(parsed.rows[0].errors, []);
});

test('CSV and XLSX exports roundtrip through the import parser', async () => {
  const columns = ['sku', 'name', 'price', 'sale_price', 'status'];
  const rows = [{ sku: 'SKU-1', name: 'Ä°stanbul', price: 120, sale_price: 100, status: 'active' }];
  const csv = Buffer.from(rowsToCsv(columns, rows), 'utf8');
  const csvParsed = await parseImportFile(csv, { filename: 'products.csv', jobType: 'product_upsert' });
  assert.equal(csvParsed.rows[0].payload.name, 'Ä°stanbul');
  const xlsx = await rowsToXlsx(columns, rows);
  const xlsxParsed = await parseImportFile(xlsx, { filename: 'products.xlsx', jobType: 'product_upsert' });
  assert.equal(xlsxParsed.rows[0].payload.sku, 'SKU-1');
  assert.equal(xlsxParsed.rows[0].payload.sale_price, 100);
});

test('spreadsheet formulas are neutralized on export and rejected on import', async () => {
  assert.equal(neutralizeSpreadsheetValue('=CMD()'), "'=CMD()");
  assert.match(rowsToCsv(['sku'], [{ sku: '+SUM(1,1)' }]), /'\+SUM/);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Import');
  sheet.addRow(['sku', 'name', 'price']);
  sheet.addRow([{ formula: '1+1', result: 'SKU-2' }, 'Urun', 10]);
  const parsed = await parseImportFile(Buffer.from(await workbook.xlsx.writeBuffer()), {
    filename: 'formula.xlsx', jobType: 'product_upsert',
  });
  assert.ok(parsed.rows[0].errors.some((error) => error.code === 'FORMULA_CELL'));
});

test('XLSX zip-bomb ratio is rejected before workbook parsing', () => {
  const archive = Buffer.alloc(64);
  archive.writeUInt32LE(0x04034b50, 0);
  archive.writeUInt32LE(0x02014b50, 4);
  archive.writeUInt32LE(1, 24);
  archive.writeUInt32LE(1000, 28);
  archive.writeUInt16LE(8, 32);
  archive.write('test.xml', 50, 'utf8');
  assert.throws(() => inspectXlsxArchive(archive), (error) => error.code === 'XLSX_ZIP_BOMB');
});

test('row limit and duplicate SKU validation return understandable codes', async () => {
  const duplicate = Buffer.from('sku,name,price\nSKU-1,A,10\nsku-1,B,20', 'utf8');
  const parsed = await parseImportFile(duplicate, { filename: 'duplicate.csv', jobType: 'product_upsert' });
  assert.ok(parsed.rows.every((row) => row.errors.some((error) => error.code === 'DUPLICATE_SKU')));
  const tooMany = Buffer.from(`sku,stock,reason\n${Array.from({ length: 10001 }, (_, index) => `S-${index},1,Sayim`).join('\n')}`, 'utf8');
  await assert.rejects(() => parseImportFile(tooMany, { filename: 'large.csv', jobType: 'stock_update' }), (error) => error.code === 'ROW_LIMIT');
});

test('external image URL validation blocks localhost, private and DNS-rebinding answers', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1']) {
    assert.equal(blockedIp(address), true);
  }
  assert.equal(blockedIp('1.1.1.1'), false);
  await assert.rejects(
    () => resolvePublicAddress('image.example', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]),
    (error) => error.code === 'IMAGE_SSRF_BLOCKED'
  );
});

test('image ZIP validates archive entries and image magic bytes before mapping', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const zip = new JSZip();
  zip.file('images/SKU-1.png', png);
  const images = extractImageZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal(images.length, 1);
  assert.equal(images[0].normalizedFilename, 'sku-1.png');
  const csv = Buffer.from('sku,name,price,image_file\nSKU-1,Urun,10,missing.png');
  const parsed = await parseImportFile(csv, { filename: 'products.csv', jobType: 'product_upsert', imageFiles: new Set(['sku-1.png']) });
  assert.ok(parsed.rows[0].errors.some((error) => error.code === 'IMAGE_FILE_NOT_FOUND'));
});

test('048 migration bounds payloads, enables RLS and worker uses SKIP LOCKED', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/048_catalog_import_export.sql'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '../modules/imports/worker.js'), 'utf8');
  assert.match(migration, /octet_length\(normalized_payload::text\) <= 65536/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /inventory_version/i);
  assert.match(migration, /import_job_images/i);
  assert.match(worker, /for update skip locked/i);
  assert.match(worker, /idempotencyKey: `import:/i);
});

test('unknown headers warn, required columns and mapping are enforced', async () => {
  const csv = Buffer.from('Ürün Kodu;name;price;renksiz_sutun\nSKU-9;Bluz;120;xx', 'utf8');
  const parsed = await parseImportFile(csv, {
    filename: 'map.csv', jobType: 'product_upsert', config: { columnMapping: { 'Ürün Kodu': 'sku' } },
  });
  assert.equal(parsed.rows[0].payload.sku, 'SKU-9');
  assert.ok(parsed.warnings.some((warning) => warning.code === 'UNKNOWN_COLUMN' && /renksiz_sutun/i.test(warning.column)));
  await assert.rejects(
    () => parseImportFile(Buffer.from('sku,name\nSKU-1,Bluz', 'utf8'), { filename: 'x.csv', jobType: 'product_upsert' }),
    (error) => error.code === 'MISSING_COLUMN'
  );
});

test('invalid decimal, status and sale-price rules produce machine codes', async () => {
  const csv = Buffer.from('sku,name,price,sale_price,status\nSKU-1,Bluz,12.abc,999,glow', 'utf8');
  const parsed = await parseImportFile(csv, { filename: 'bad.csv', jobType: 'product_upsert' });
  const codes = parsed.rows[0].errors.map((error) => error.code);
  assert.ok(codes.includes('INVALID_DECIMAL'));
  assert.ok(codes.includes('INVALID_STATUS'));
});

test('config hash is stable under key reordering', () => {
  assert.equal(
    configHash({ columnMapping: { a: '1' }, categoryMapping: { b: '2' } }),
    configHash({ categoryMapping: { b: '2' }, columnMapping: { a: '1' } })
  );
  assert.notEqual(configHash({ columnMapping: { a: '1' } }), configHash({ columnMapping: { a: '2' } }));
});

test('external image download pins DNS and rejects redirects to metadata IPs', async () => {
  await assert.rejects(
    () => downloadExternalImage('https://cdn.example/a.png', {
      lookup: publicLookup,
      request: fakeHttp([{ statusCode: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }]),
    }),
    (error) => error.code === 'IMAGE_SSRF_BLOCKED'
  );
});

test('external image download enforces the redirect limit', async () => {
  await assert.rejects(
    () => downloadExternalImage('https://cdn.example/a.png', {
      lookup: publicLookup,
      request: fakeHttp([{ statusCode: 302, headers: { location: 'https://cdn.example/next.png' } }]),
    }),
    (error) => error.code === 'IMAGE_REDIRECT_LIMIT'
  );
});

test('external image download rejects oversized bodies via content-length', async () => {
  await assert.rejects(
    () => downloadExternalImage('https://cdn.example/big.png', {
      lookup: publicLookup, maxBytes: 2048,
      request: fakeHttp([{ statusCode: 200, headers: { 'content-length': '5000', 'content-type': 'image/png' } }]),
    }),
    (error) => error.code === 'IMAGE_SIZE_LIMIT'
  );
});

test('external image download rejects wrong MIME and wrong magic bytes', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  await assert.rejects(
    () => downloadExternalImage('https://cdn.example/a.png', {
      lookup: publicLookup,
      request: fakeHttp([{ statusCode: 200, headers: { 'content-type': 'text/html' }, body: png }]),
    }),
    (error) => error.code === 'IMAGE_CONTENT_MISMATCH'
  );
  await assert.rejects(
    () => downloadExternalImage('https://cdn.example/a.png', {
      lookup: publicLookup,
      request: fakeHttp([{ statusCode: 200, headers: { 'content-type': 'image/png' }, body: jpeg }]),
    }),
    (error) => error.code === 'IMAGE_CONTENT_MISMATCH'
  );
});

test('external image download accepts a magic-consistent HTTPS image', async () => {
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
  const result = await downloadExternalImage('https://cdn.example/ok.png', {
    lookup: publicLookup,
    request: fakeHttp([{ statusCode: 200, headers: { 'content-type': 'image/png' }, body: png }]),
  });
  assert.equal(result.format, 'png');
  assert.equal(result.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(result.buffer));
});

test('safe entry names reject traversal and reduce backslash/drive paths to a basename', () => {
  assert.throws(() => safeEntryName('/etc/passwd'), (error) => error.code === 'ZIP_PATH_TRAVERSAL');
  assert.throws(() => safeEntryName('../secret.png'), (error) => error.code === 'ZIP_PATH_TRAVERSAL');
  assert.throws(() => safeEntryName('bad\u0000.png'), (error) => error.code === 'ZIP_PATH_TRAVERSAL');
  assert.equal(safeEntryName('deep\\win\\logo.png'), 'logo.png');
  assert.equal(safeEntryName('C:\\Windows\\evil.png'), 'evil.png');
});

test('image ZIP central directory rejects traversal, encryption, bombs and entry floods', () => {
  assert.throws(
    () => centralEntries(buildCentralZip([{ name: '../evil.png' }])),
    (error) => error.code === 'ZIP_PATH_TRAVERSAL'
  );
  assert.throws(
    () => centralEntries(buildCentralZip([{ name: 'a.png', flags: 0x1 }])),
    (error) => error.code === 'ENCRYPTED_ZIP'
  );
  assert.throws(
    () => centralEntries(buildCentralZip([{ name: 'a.png', compressedSize: 100, uncompressedSize: 100 * 101 }])),
    (error) => error.code === 'ZIP_BOMB'
  );
  assert.throws(
    () => centralEntries(buildCentralZip([{ name: 'a.png', compressedSize: 6 * 1024 * 1024, uncompressedSize: 6 * 1024 * 1024 }])),
    (error) => error.code === 'ZIP_BOMB'
  );
  assert.throws(
    () => centralEntries(buildCentralZip(Array.from({ length: 201 }, () => ({ name: 'a.png' })))),
    (error) => error.code === 'ZIP_ENTRY_LIMIT'
  );
});

test('image ZIP rejects duplicate normalized filenames and skips unsupported entries', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const duplicate = new JSZip();
  duplicate.file('a/logo.png', png);
  duplicate.file('b/LOGO.png', png);
  await assert.rejects(
    async () => extractImageZip(await duplicate.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
    (error) => error.code === 'DUPLICATE_IMAGE_FILE'
  );

  const mixed = new JSZip();
  mixed.file('readme.txt', 'ignored');
  mixed.file('nested.zip', Buffer.from('PK\u0003\u0004ignored'));
  mixed.file('gallery/kirmizi.png', png);
  const images = extractImageZip(await mixed.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal(images.length, 1);
  assert.equal(images[0].normalizedFilename, 'kirmizi.png');
});
