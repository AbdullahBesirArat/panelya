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

async function sendEmail(message) {
  if (EMAIL_PROVIDER === 'none' || !message?.to) {
    return { skipped: true };
  }

  if (EMAIL_PROVIDER === 'resend') {
    await sendWithResend(message);
    return { skipped: false };
  }

  throw new Error(`Desteklenmeyen EMAIL_PROVIDER: ${EMAIL_PROVIDER}`);
}

async function sendWelcomeEmail(user, organization) {
  if (!user?.email) return { skipped: true };
  return sendEmail({
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
    ? `${siteUrl}/sifre-sifirla.html?token=${encodeURIComponent(token)}`
    : '';

  return sendEmail({
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

module.exports = {
  sendEmail,
  sendCustomerPasswordResetEmail,
  sendInviteEmail,
  sendOrderStatusEmail,
  sendWelcomeEmail,
};
