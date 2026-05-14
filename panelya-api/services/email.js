const EMAIL_PROVIDER = String(process.env.EMAIL_PROVIDER || 'none').trim().toLowerCase();

async function sendWithResend({ to, subject, html, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || '').trim();
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY ve EMAIL_FROM zorunlu');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend email gonderimi basarisiz: ${response.status} ${body}`.trim());
  }
}

function brevoCredentials(account) {
  if (account === 'panelya') {
    return {
      apiKey: String(process.env.BREVO_API_KEY_PANELYA || '').trim(),
      senderEmail: String(process.env.BREVO_SENDER_PANELYA || '').trim(),
      senderName: String(process.env.BREVO_SENDER_PANELYA_NAME || 'Panelya').trim(),
    };
  }
  return {
    apiKey: String(process.env.BREVO_API_KEY_SUVERA || '').trim(),
    senderEmail: String(process.env.BREVO_SENDER_SUVERA || '').trim(),
    senderName: String(process.env.BREVO_SENDER_SUVERA_NAME || 'Suvera').trim(),
  };
}

async function sendWithBrevo({ to, subject, html, text, account }) {
  const { apiKey, senderEmail, senderName } = brevoCredentials(account);
  if (!apiKey || !senderEmail) {
    throw new Error(`Brevo creds eksik (account=${account || 'suvera'})`);
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((email) => ({ email: String(email) }));

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: recipients,
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo email gonderimi basarisiz: ${response.status} ${body}`.trim());
  }
}

async function sendEmail(message) {
  if (EMAIL_PROVIDER === 'none' || !message?.to) {
    return { skipped: true };
  }

  if (EMAIL_PROVIDER === 'resend') {
    await sendWithResend(message);
    return { skipped: false };
  }

  if (EMAIL_PROVIDER === 'brevo') {
    await sendWithBrevo({ ...message, account: message.account || 'suvera' });
    return { skipped: false };
  }

  throw new Error(`Desteklenmeyen EMAIL_PROVIDER: ${EMAIL_PROVIDER}`);
}

async function sendWelcomeEmail(user, organization) {
  if (!user?.email) return { skipped: true };
  return sendEmail({
    account: 'suvera',
    to: user.email,
    subject: `${organization?.name || 'Panelya'} hos geldiniz`,
    text: `Merhaba ${user.name || ''}, ${organization?.name || 'Panelya'} workspace'iniz hazir.`,
    html: `<p>Merhaba ${user.name || ''},</p><p><strong>${organization?.name || 'Panelya'}</strong> workspace'iniz hazir.</p>`,
  });
}

async function sendInviteEmail(invite, organization, token) {
  if (!invite?.email) return { skipped: true };
  const appUrl = String(process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const inviteUrl = appUrl && token
    ? `${appUrl}/login?invite=${encodeURIComponent(token)}`
    : '';

  return sendEmail({
    account: 'panelya',
    to: invite.email,
    subject: `${organization?.name || 'Panelya'} ekip daveti`,
    text: [
      `${organization?.name || 'Panelya'} workspace'ine ${invite.role || 'member'} roluyle davet edildiniz.`,
      inviteUrl ? `Daveti kabul etmek icin: ${inviteUrl}` : '',
    ].filter(Boolean).join('\n'),
    html: [
      `<p><strong>${organization?.name || 'Panelya'}</strong> workspace'ine ${invite.role || 'member'} roluyle davet edildiniz.</p>`,
      inviteUrl ? `<p><a href="${inviteUrl}">Daveti kabul et</a></p>` : '',
    ].filter(Boolean).join(''),
  });
}

async function sendCustomerPasswordResetEmail(account, organization, token) {
  if (!account?.email) return { skipped: true };
  const siteUrl = String(process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const resetUrl = siteUrl && token
    ? `${siteUrl}/sifre-sifirla?token=${encodeURIComponent(token)}`
    : '';

  return sendEmail({
    account: 'suvera',
    to: account.email,
    subject: `${organization?.name || 'Suvera'} sifre sifirlama`,
    text: [
      `Merhaba ${account.name || ''}`.trim(),
      'Sifrenizi yenilemek icin sifirlama baglantisini kullanin.',
      resetUrl ? `Baglanti: ${resetUrl}` : '',
      'Bu talebi siz olusturmadiysaniz bu e-postayi dikkate almayin.',
    ].filter(Boolean).join('\n'),
    html: [
      `<p>Merhaba ${escapeHtml(account.name || '')},</p>`,
      '<p>Sifrenizi yenilemek icin sifirlama baglantisini kullanin.</p>',
      resetUrl ? `<p><a href="${escapeHtml(resetUrl)}">Sifremi yenile</a></p>` : '',
      '<p>Bu talebi siz olusturmadiysaniz bu e-postayi dikkate almayin.</p>',
    ].filter(Boolean).join(''),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildVerificationUrl({ target, token, purpose }) {
  const isPanelya = target === 'panelya';
  const baseRaw = isPanelya
    ? (process.env.PUBLIC_APP_URL || '')
    : (process.env.PUBLIC_SITE_URL || '');
  const base = String(baseRaw || '').replace(/\/$/, '');
  if (!base || !token) return '';
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  const path = isPanelya ? '/verify' : '/dogrula.html';
  const qs = new URLSearchParams({ token: String(token) });
  if (purpose) qs.set('purpose', purpose);
  return `${base}${path}?${qs.toString()}`;
}

async function sendEmailVerificationMagicLink({ to, name, token, target, organization }) {
  if (!to) return { skipped: true };
  const url = buildVerificationUrl({ target, token });
  if (!url) return { skipped: true };
  const account = target === 'panelya' ? 'panelya' : 'suvera';
  const brand = organization?.name || (target === 'panelya' ? 'Panelya' : 'Suvera');

  return sendEmail({
    account,
    to,
    subject: `${brand} - E-posta dogrulama`,
    text: [
      `Merhaba ${name || ''}`.trim(),
      'E-posta adresinizi dogrulamak icin asagidaki linke tiklayin:',
      url,
      'Link 24 saat boyunca gecerlidir. Bu talebi siz olusturmadiysaniz dikkate almayin.',
    ].filter(Boolean).join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      `<p>Merhaba ${escapeHtml(name || '')},</p>`,
      `<p><strong>${escapeHtml(brand)}</strong> hesabiniza ait e-posta adresini dogrulamak icin asagidaki butona tiklayin.</p>`,
      `<p style="margin:20px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;">E-postami dogrula</a></p>`,
      '<p style="color:#64748b;">Link 24 saat boyunca gecerlidir. Bu talebi siz olusturmadiysaniz bu e-postayi dikkate almayin.</p>',
      '</div>',
    ].join(''),
  });
}

async function sendEmailChangeConfirmation({ to, name, token, target, organization }) {
  if (!to) return { skipped: true };
  const url = buildVerificationUrl({ target, token, purpose: 'email_change' });
  if (!url) return { skipped: true };
  const account = target === 'panelya' ? 'panelya' : 'suvera';
  const brand = organization?.name || (target === 'panelya' ? 'Panelya' : 'Suvera');

  return sendEmail({
    account,
    to,
    subject: `${brand} - E-posta degisikligini onaylayin`,
    text: [
      `Merhaba ${name || ''}`.trim(),
      'Hesabinizin e-posta adresini degistirme talebini onaylamak icin asagidaki linke tiklayin:',
      url,
      'Link 24 saat boyunca gecerlidir. Bu talebi siz olusturmadiysaniz dikkate almayin.',
    ].filter(Boolean).join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      `<p>Merhaba ${escapeHtml(name || '')},</p>`,
      `<p><strong>${escapeHtml(brand)}</strong> hesabinizin e-posta adresini degistirme talebini onaylamak icin asagidaki butona tiklayin.</p>`,
      `<p style="margin:20px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;">Yeni e-postami onayla</a></p>`,
      '<p style="color:#64748b;">Link 24 saat boyunca gecerlidir. Bu talebi siz olusturmadiysaniz bu e-postayi dikkate almayin.</p>',
      '</div>',
    ].join(''),
  });
}

function statusLabel(status) {
  const labels = {
    payment_pending: 'Odeme bekleniyor',
    payment_review: 'Odeme inceleniyor',
    payment_failed: 'Odeme basarisiz',
    pending: 'Hazirlaniyor',
    paid: 'Odendi',
    processing: 'Hazirlaniyor',
    shipped: 'Kargoya verildi',
    delivered: 'Teslim edildi',
    cancelled: 'Iptal edildi',
    refunded: 'Iade edildi',
  };

  return labels[status] || status || 'Guncellendi';
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return `${amount.toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} TL`;
}

function compactLine(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `${label}: ${value}`;
}

async function sendOrderStatusEmail(order, customer) {
  if (!customer?.email) return { skipped: true };
  const status = order?.status || 'payment_pending';
  const readableStatus = statusLabel(status);
  const orderCode = order?.order_code || '-';
  const total = formatMoney(order?.total_amount);
  const trackingNumber = order?.tracking_number || '';
  const trackingUrl = order?.tracking_url || '';
  const shippingCompany = order?.shipping_company || '';
  const shippedAt = order?.shipped_at
    ? new Date(order.shipped_at).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const subjectPrefix = trackingNumber || trackingUrl || status === 'shipped'
    ? 'Kargo bilgisi'
    : 'Siparis durumu';
  const textLines = [
    `Merhaba ${customer.name || ''}`.trim(),
    `Siparisinizin son durumu: ${readableStatus}.`,
    compactLine('Siparis kodu', orderCode),
    compactLine('Toplam', total),
    compactLine('Odeme yontemi', order?.payment_method),
    compactLine('Kargo firmasi', shippingCompany),
    compactLine('Takip numarasi', trackingNumber),
    compactLine('Takip linki', trackingUrl),
    compactLine('Kargoya verilme zamani', shippedAt),
  ].filter(Boolean);

  const details = [
    ['Siparis kodu', orderCode],
    ['Durum', readableStatus],
    ['Toplam', total],
    ['Odeme yontemi', order?.payment_method],
    ['Kargo firmasi', shippingCompany],
    ['Takip numarasi', trackingNumber],
    ['Kargoya verilme zamani', shippedAt],
  ].filter(([, value]) => value);

  const detailRows = details.map(([label, value]) => (
    `<tr><td style="padding:8px 12px;color:#64748b;">${escapeHtml(label)}</td><td style="padding:8px 12px;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td></tr>`
  )).join('');

  const trackingButton = trackingUrl
    ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;">Kargoyu takip et</a></p>`
    : '';

  return sendEmail({
    account: 'suvera',
    to: customer.email,
    subject: `${subjectPrefix}: ${orderCode}`.trim(),
    text: textLines.join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      `<p>Merhaba ${escapeHtml(customer.name || '')},</p>`,
      `<p>Siparisinizin son durumu: <strong>${escapeHtml(readableStatus)}</strong>.</p>`,
      `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">${detailRows}</table>`,
      trackingButton,
      '<p style="margin-top:20px;color:#64748b;">Bu e-posta siparisinizle ilgili otomatik bilgilendirme amaciyla gonderilmistir.</p>',
      '</div>',
    ].join(''),
  });
}

async function sendNewOrderSellerNotification({ order, organization, sellerEmail, items }) {
  if (!sellerEmail || !order) return { skipped: true };
  const appUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  let panelUrl = '';
  if (appUrl && order.id) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        panelUrl = `${appUrl}/orders/${encodeURIComponent(order.id)}`;
      }
    } catch {
      panelUrl = '';
    }
  }
  const orderCode = order.order_code || '-';
  const total = formatMoney(order.total ?? order.total_amount);
  const customerName = order.customer_name || order.customer?.name || '';

  const itemList = Array.isArray(items) ? items : [];
  const itemRows = itemList.map((it) => (
    `<tr><td style="padding:6px 12px;color:#0f172a;">${escapeHtml(it.product_name || it.name || '')}</td>`
    + `<td style="padding:6px 12px;color:#64748b;">${escapeHtml(String(it.quantity || 0))}</td>`
    + `<td style="padding:6px 12px;text-align:right;color:#0f172a;">${escapeHtml(formatMoney(it.unit_price))}</td></tr>`
  )).join('');
  const itemTable = itemRows
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;width:100%;margin-top:12px;"><thead><tr><th style="padding:6px 12px;text-align:left;color:#64748b;font-weight:600;">Urun</th><th style="padding:6px 12px;text-align:left;color:#64748b;font-weight:600;">Adet</th><th style="padding:6px 12px;text-align:right;color:#64748b;font-weight:600;">Birim</th></tr></thead><tbody>${itemRows}</tbody></table>`
    : '';

  const panelButton = panelUrl
    ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(panelUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;">Panele git</a></p>`
    : '';

  return sendEmail({
    account: 'panelya',
    to: sellerEmail,
    subject: `Yeni siparis: ${orderCode}${total ? ` - ${total}` : ''}`,
    text: [
      `${organization?.name || 'Panelya'} workspace'inde yeni bir siparis olustu.`,
      compactLine('Siparis kodu', orderCode),
      compactLine('Toplam', total),
      compactLine('Musteri', customerName),
      panelUrl ? `Detay: ${panelUrl}` : '',
    ].filter(Boolean).join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      `<p><strong>${escapeHtml(organization?.name || 'Panelya')}</strong> workspace'inde yeni bir siparis olustu.</p>`,
      '<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">',
      `<tr><td style="padding:8px 12px;color:#64748b;">Siparis kodu</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(orderCode)}</td></tr>`,
      total ? `<tr><td style="padding:8px 12px;color:#64748b;">Toplam</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(total)}</td></tr>` : '',
      customerName ? `<tr><td style="padding:8px 12px;color:#64748b;">Musteri</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(customerName)}</td></tr>` : '',
      '</table>',
      itemTable,
      panelButton,
      '</div>',
    ].filter(Boolean).join(''),
  });
}

module.exports = {
  sendEmail,
  sendCustomerPasswordResetEmail,
  sendInviteEmail,
  sendOrderStatusEmail,
  sendWelcomeEmail,
  sendEmailVerificationMagicLink,
  sendEmailChangeConfirmation,
  sendNewOrderSellerNotification,
};
