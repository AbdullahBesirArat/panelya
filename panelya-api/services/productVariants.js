// Urun varyantlarini SILIP YENIDEN OLUSTURMADAN, mantiksal kimlik uzerinden
// birlestirir (merge/upsert). Boylece order_items.variant_id (on delete set
// null) bagi kopmaz ve stok iadesi dogru varyanta yazilir.
//
// Mantiksal varyant anahtari: (product_id, color, size). Bu, product_variants
// tablosundaki `unique (product_id, color, size)` kisitiyla birebir ortusur ve
// urun formundaki normalizeVariants dedupe anahtariyla aynidir. SKU serbest
// metindir ve benzersiz degildir; bu yuzden eslestirme anahtari degildir.
//
// Tum sorgular cagiranin verdigi client (transaction) uzerinden gider ve
// organization_id ile scope edilir (tenant izolasyonu). Mevcut varyantlar
// `for update` ile kilitlenir; ayni urun icin escyzamanli guncelleme/siparis
// yarislari onlenir.

function variantKey(color, size) {
  return `${String(color || '').trim().toLowerCase()}::${String(size || '').trim().toLowerCase()}`;
}

async function syncProductVariants(client, organizationId, productId, variants) {
  // Mevcut varyantlari kilitle (aktif + pasif dahil hepsi).
  const existingResult = await client.query(
    `select id, color, size
       from product_variants
      where organization_id = $1 and product_id = $2
      for update`,
    [organizationId, productId]
  );

  const existingByKey = new Map();
  for (const row of existingResult.rows) {
    existingByKey.set(variantKey(row.color, row.size), row);
  }

  const incomingKeys = new Set();

  for (const variant of variants) {
    const key = variantKey(variant.color, variant.size);
    incomingKeys.add(key);
    const existing = existingByKey.get(key);

    if (existing) {
      // Ayni mantiksal varyant: mevcut id KORUNUR; guncellenebilir alanlar
      // update edilir. Daha once pasiflenmisse (yeniden eklendiginden) tekrar
      // aktive edilir.
      await client.query(
        `update product_variants
            set sku = $1,
                stock = $2,
                status = $3,
                is_active = true,
                updated_at = now()
          where id = $4 and organization_id = $5`,
        [variant.sku, variant.stock, variant.status, existing.id, organizationId]
      );
    } else {
      // Eslesme yok: yeni kayit olustur (yeni id).
      await client.query(
        `insert into product_variants
           (organization_id, product_id, color, size, sku, stock, status, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, true)`,
        [organizationId, productId, variant.color, variant.size, variant.sku, variant.stock, variant.status]
      );
    }
  }

  // Formdan kaldirilan varyantlar: mevcutta olup gelen sette olmayanlar.
  for (const [key, existing] of existingByKey) {
    if (incomingKeys.has(key)) continue;

    // Gecmis siparis kalemi bu varyanta bagli mi? (tenant-scope'lu kontrol)
    const referenced = await client.query(
      `select 1
         from order_items oi
         join orders o on o.id = oi.order_id and o.organization_id = $2
        where oi.variant_id = $1
        limit 1`,
      [existing.id, organizationId]
    );

    if (referenced.rows[0]) {
      // Gecmis siparise bagli: FIZIKSEL SILME YOK. Pasiflenir (gorunmez olur)
      // ama satir korunur; boylece order_items.variant_id bagi ve stok iadesi
      // calismaya devam eder.
      await client.query(
        `update product_variants
            set is_active = false, updated_at = now()
          where id = $1 and organization_id = $2`,
        [existing.id, organizationId]
      );
    } else {
      // Gecmis kaydi yok: mevcut is kuralindaki gibi fiziksel silinir.
      await client.query(
        'delete from product_variants where id = $1 and organization_id = $2',
        [existing.id, organizationId]
      );
    }
  }
}

module.exports = {
  variantKey,
  syncProductVariants,
};
