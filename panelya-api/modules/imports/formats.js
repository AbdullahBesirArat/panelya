const ExcelJS = require('exceljs');
const crypto = require('crypto');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 40;
const MAX_CELL_LENGTH = 4_096;
const MAX_XLSX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 1_000;
const MAX_XLSX_RATIO = 100;

const JOB_COLUMNS = Object.freeze({
  product_upsert: ['sku', 'name', 'description', 'category', 'collections', 'price', 'sale_price', 'status', 'color', 'size', 'stock', 'image_url', 'image_file'],
  stock_update: ['sku', 'stock', 'reason', 'expected_version'],
  price_update: ['sku', 'price', 'sale_price'],
});

const REQUIRED_COLUMNS = Object.freeze({
  product_upsert: ['sku', 'name', 'price'],
  stock_update: ['sku', 'stock', 'reason'],
  price_update: ['sku', 'price'],
});

const HEADER_ALIASES = new Map(Object.entries({
  stok_kodu: 'sku', urun_kodu: 'sku', ürün_kodu: 'sku',
  ad: 'name', urun_adi: 'name', ürün_adı: 'name', aciklama: 'description', açıklama: 'description',
  kategori: 'category', koleksiyonlar: 'collections', fiyat: 'price', satis_fiyati: 'sale_price', satış_fiyatı: 'sale_price',
  durum: 'status', renk: 'color', beden: 'size', stok: 'stock', gorsel_url: 'image_url', görsel_url: 'image_url',
  gorsel_dosyasi: 'image_file', görsel_dosyası: 'image_file',
  neden: 'reason', beklenen_versiyon: 'expected_version',
}));

function importError(message, code = 'INVALID_IMPORT_FILE', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function configHash(config) {
  return sha256(stableJson(config || {}));
}

function normalizeHeader(value) {
  const normalized = String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/[\s-]+/g, '_');
  return HEADER_ALIASES.get(normalized) || normalized;
}

function inspectXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES || buffer.length < 4) {
    throw importError('XLSX dosya boyutu desteklenmiyor', 'FILE_SIZE_LIMIT');
  }
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw importError('XLSX ZIP imzasi gecersiz', 'INVALID_XLSX');
  let cursor = 0;
  let entries = 0;
  let compressed = 0;
  let uncompressed = 0;
  while ((cursor = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor)) !== -1) {
    if (cursor + 46 > buffer.length) throw importError('XLSX arsiv basligi bozuk', 'INVALID_XLSX');
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > buffer.length) throw importError('XLSX arsiv girdisi bozuk', 'INVALID_XLSX');
    const name = buffer.toString('utf8', cursor + 46, nameEnd);
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw importError('XLSX arsiv yolu guvenli degil', 'XLSX_PATH_TRAVERSAL');
    }
    entries += 1;
    compressed += compressedSize;
    uncompressed += uncompressedSize;
    if (entries > MAX_XLSX_ENTRIES || uncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw importError('XLSX acilmis boyut veya girdi limitini asiyor', 'XLSX_ZIP_BOMB');
    }
    if (compressed > 0 && uncompressed / compressed > MAX_XLSX_RATIO) {
      throw importError('XLSX sikistirma orani guvenli limiti asiyor', 'XLSX_ZIP_BOMB');
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  if (!entries) throw importError('XLSX merkezi dizini bulunamadi', 'INVALID_XLSX');
  return { entries, compressed, uncompressed };
}

function detectCsvDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let index = 0; index < firstLine.length; index += 1) {
    if (firstLine[index] === '"') quoted = !quoted;
    if (!quoted && firstLine[index] === ',') commas += 1;
    if (!quoted && firstLine[index] === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

function decodeCsv(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_BYTES) {
    throw importError('CSV dosya boyutu desteklenmiyor', 'FILE_SIZE_LIMIT');
  }
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    throw importError('CSV UTF-8 olarak kaydedilmelidir', 'UNSUPPORTED_ENCODING');
  }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD') || text.includes('\u0000')) {
    throw importError('CSV UTF-8 kodlamasi gecersiz', 'UNSUPPORTED_ENCODING');
  }
  return text;
}

function parseCsv(buffer) {
  const text = decodeCsv(buffer);
  const delimiter = detectCsvDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const character = index === text.length ? '\n' : text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === '') { quoted = true; continue; }
    if (character === delimiter) { row.push(field); field = ''; continue; }
    if (character === '\r' && text[index + 1] === '\n') continue;
    if (character === '\n') {
      row.push(field); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) throw importError(`En fazla ${MAX_ROWS} veri satiri desteklenir`, 'ROW_LIMIT');
      continue;
    }
    field += character;
    if (field.length > MAX_CELL_LENGTH) throw importError('Hucre uzunluk limiti asildi', 'CELL_SIZE_LIMIT');
  }
  if (quoted) throw importError('CSV tirnaklari dengeli degil', 'INVALID_CSV');
  return rows;
}

function xlsxCellValue(cell) {
  const value = cell.value;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'formula') || Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) {
      return { formula: true, value: String(value.formula || value.sharedFormula || '') };
    }
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

async function parseXlsx(buffer) {
  inspectXlsxArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw importError('XLSX dosyasi okunamadi', 'INVALID_XLSX');
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw importError('XLSX ilk calisma sayfasi bos', 'EMPTY_FILE');
  if (worksheet.actualRowCount > MAX_ROWS + 1) throw importError(`En fazla ${MAX_ROWS} veri satiri desteklenir`, 'ROW_LIMIT');
  if (worksheet.actualColumnCount > MAX_COLUMNS) throw importError(`En fazla ${MAX_COLUMNS} sutun desteklenir`, 'COLUMN_LIMIT');
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (sheetRow) => {
    const values = [];
    for (let column = 1; column <= worksheet.actualColumnCount; column += 1) {
      const value = xlsxCellValue(sheetRow.getCell(column));
      if (String(value?.value ?? value).length > MAX_CELL_LENGTH) throw importError('Hucre uzunluk limiti asildi', 'CELL_SIZE_LIMIT');
      values.push(value);
    }
    if (values.some((value) => value !== '')) rows.push(values);
  });
  return rows;
}

function validateJobType(jobType) {
  if (!JOB_COLUMNS[jobType]) throw importError('Import tipi gecersiz', 'INVALID_JOB_TYPE');
  return jobType;
}

function resolveHeaders(rawHeaders, jobType, config = {}) {
  const allowed = new Set(JOB_COLUMNS[jobType]);
  const mapping = config.columnMapping && typeof config.columnMapping === 'object' ? config.columnMapping : {};
  const headers = rawHeaders.map((header) => {
    const raw = String(header?.value ?? header).trim();
    const mapped = mapping[raw] ?? mapping[normalizeHeader(raw)] ?? raw;
    return { raw, canonical: normalizeHeader(mapped) };
  });
  if (headers.length > MAX_COLUMNS) throw importError(`En fazla ${MAX_COLUMNS} sutun desteklenir`, 'COLUMN_LIMIT');
  const warnings = headers.filter((header) => header.canonical && !allowed.has(header.canonical)).map((header) => ({
    code: 'UNKNOWN_COLUMN', column: header.raw, message: `Bilinmeyen sutun yok sayilacak: ${header.raw}`,
  }));
  const canonical = headers.filter((header) => allowed.has(header.canonical)).map((header) => header.canonical);
  const duplicate = canonical.find((header, index) => canonical.indexOf(header) !== index);
  if (duplicate) throw importError(`Ayni hedef sutuna birden fazla esleme yapildi: ${duplicate}`, 'DUPLICATE_MAPPING');
  for (const required of REQUIRED_COLUMNS[jobType]) {
    if (!canonical.includes(required)) throw importError(`Zorunlu sutun eksik: ${required}`, 'MISSING_COLUMN');
  }
  return { headers, warnings };
}

function rowError(code, message, column = null) { return { code, message, column }; }

function textValue(value, column, errors, { required = false, max = 500 } = {}) {
  if (value && typeof value === 'object' && value.formula) {
    errors.push(rowError('FORMULA_CELL', `${column} formulu kabul edilmez`, column));
    return '';
  }
  const result = String(value == null ? '' : value).trim();
  if (required && !result) errors.push(rowError('REQUIRED', `${column} zorunlu`, column));
  if (result.length > max) errors.push(rowError('TOO_LONG', `${column} en fazla ${max} karakter olabilir`, column));
  return result.slice(0, max);
}

function moneyValue(value, column, errors, { required = false } = {}) {
  const raw = textValue(value, column, errors, { required, max: 40 });
  if (!raw) return null;
  const canonical = /^\d+(,\d{1,2})$/.test(raw) ? raw.replace(',', '.') : raw;
  if (!/^\d+(?:\.\d{1,2})?$/.test(canonical)) {
    errors.push(rowError('INVALID_DECIMAL', `${column} negatif olmayan ve en fazla iki ondalikli sayi olmali`, column));
    return null;
  }
  const number = Number(canonical);
  if (!Number.isFinite(number) || number > 99_999_999.99) {
    errors.push(rowError('INVALID_DECIMAL', `${column} desteklenen aralikta degil`, column));
    return null;
  }
  return Number(number.toFixed(2));
}

function integerValue(value, column, errors, { required = false } = {}) {
  const raw = textValue(value, column, errors, { required, max: 20 });
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) > 2_147_483_647) {
    errors.push(rowError('INVALID_INTEGER', `${column} negatif olmayan tam sayi olmali`, column));
    return null;
  }
  return Number(raw);
}

function normalizeRow(rawRow, headers, jobType, imageFiles = new Set()) {
  const source = {};
  headers.forEach((header, index) => {
    if (JOB_COLUMNS[jobType].includes(header.canonical)) source[header.canonical] = rawRow[index] ?? '';
  });
  const errors = [];
  const sku = textValue(source.sku, 'sku', errors, { required: true, max: 120 });
  const payload = { sku };
  if (jobType === 'product_upsert') {
    Object.assign(payload, {
      name: textValue(source.name, 'name', errors, { required: true, max: 200 }),
      description: textValue(source.description, 'description', errors, { max: 4_000 }),
      category: textValue(source.category, 'category', errors, { max: 160 }),
      collections: textValue(source.collections, 'collections', errors, { max: 1_000 }).split('|').map((value) => value.trim()).filter(Boolean),
      price: moneyValue(source.price, 'price', errors, { required: true }),
      sale_price: moneyValue(source.sale_price, 'sale_price', errors),
      status: textValue(source.status, 'status', errors, { max: 20 }) || 'draft',
      color: textValue(source.color, 'color', errors, { max: 80 }),
      size: textValue(source.size, 'size', errors, { max: 80 }),
      stock: integerValue(source.stock, 'stock', errors) ?? 0,
      image_url: textValue(source.image_url, 'image_url', errors, { max: 2_000 }),
      image_file: textValue(source.image_file, 'image_file', errors, { max: 180 }),
    });
    if (!['active', 'draft', 'out'].includes(payload.status)) errors.push(rowError('INVALID_STATUS', 'status active, draft veya out olmali', 'status'));
    if (payload.sale_price != null && payload.price != null && payload.sale_price > payload.price) errors.push(rowError('INVALID_SALE_PRICE', 'sale_price fiyattan buyuk olamaz', 'sale_price'));
    if (payload.image_url) {
      try { if (new URL(payload.image_url).protocol !== 'https:') throw new Error(); }
      catch (_) { errors.push(rowError('INVALID_IMAGE_URL', 'image_url gecerli bir HTTPS URL olmali', 'image_url')); }
    }
    if (payload.image_url && payload.image_file) errors.push(rowError('IMAGE_SOURCE_CONFLICT', 'image_url ve image_file birlikte kullanilamaz', 'image_file'));
    if (payload.image_file && !imageFiles.has(payload.image_file.toLocaleLowerCase('tr-TR'))) {
      errors.push(rowError('IMAGE_FILE_NOT_FOUND', `ZIP icinde gorsel bulunamadi: ${payload.image_file}`, 'image_file'));
    }
  } else if (jobType === 'stock_update') {
    Object.assign(payload, {
      stock: integerValue(source.stock, 'stock', errors, { required: true }),
      reason: textValue(source.reason, 'reason', errors, { required: true, max: 500 }),
      expected_version: integerValue(source.expected_version, 'expected_version', errors),
    });
  } else {
    Object.assign(payload, {
      price: moneyValue(source.price, 'price', errors, { required: true }),
      sale_price: moneyValue(source.sale_price, 'sale_price', errors),
    });
    if (payload.sale_price != null && payload.price != null && payload.sale_price > payload.price) errors.push(rowError('INVALID_SALE_PRICE', 'sale_price fiyattan buyuk olamaz', 'sale_price'));
  }
  return { payload, errors };
}

async function parseImportFile(buffer, { filename, jobType, config = {}, imageFiles = new Set() }) {
  validateJobType(jobType);
  const extension = String(filename || '').toLowerCase().split('.').pop();
  const rawRows = extension === 'csv' ? parseCsv(buffer) : extension === 'xlsx' ? await parseXlsx(buffer) : null;
  if (!rawRows) throw importError('Yalniz CSV veya XLSX desteklenir', 'UNSUPPORTED_FILE_TYPE');
  if (rawRows.length < 2) throw importError('Dosyada baslik ve en az bir veri satiri olmali', 'EMPTY_FILE');
  const { headers, warnings } = resolveHeaders(rawRows[0], jobType, config);
  const normalizedRows = rawRows.slice(1).map((rawRow, index) => ({ rowNumber: index + 2, ...normalizeRow(rawRow, headers, jobType, imageFiles) }));
  const skuRows = new Map();
  for (const row of normalizedRows) {
    const key = row.payload.sku.toLocaleLowerCase('tr-TR');
    if (!key) continue;
    const first = skuRows.get(key);
    if (first) {
      const error = rowError('DUPLICATE_SKU', `Dosyada yinelenen SKU: ${row.payload.sku}`, 'sku');
      row.errors.push(error);
      first.errors.push(error);
    } else skuRows.set(key, row);
  }
  for (const row of normalizedRows) row.rowKey = sha256(`${jobType}:${row.rowNumber}:${stableJson(row.payload)}`);
  return { rows: normalizedRows, warnings, headers: headers.map((header) => header.canonical) };
}

function neutralizeSpreadsheetValue(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const safe = neutralizeSpreadsheetValue(Array.isArray(value) ? value.join('|') : value);
  return `"${safe.replace(/"/g, '""')}"`;
}

function rowsToCsv(columns, rows) {
  return [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n');
}

async function rowsToXlsx(columns, rows, sheetName = 'Panelya') {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Panelya';
  workbook.created = new Date(0);
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = columns.map((column) => ({ header: column, key: column, width: Math.min(Math.max(column.length + 2, 14), 40) }));
  for (const row of rows) {
    const safe = {};
    for (const column of columns) safe[column] = neutralizeSpreadsheetValue(Array.isArray(row[column]) ? row[column].join('|') : row[column]);
    sheet.addRow(safe);
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  JOB_COLUMNS, MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS, configHash, importError,
  inspectXlsxArchive, neutralizeSpreadsheetValue, parseImportFile, rowsToCsv,
  rowsToXlsx, sha256, stableJson, validateJobType,
};
