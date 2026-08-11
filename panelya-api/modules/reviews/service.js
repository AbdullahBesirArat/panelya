'use strict';

const crypto = require('crypto');

const MAX_TITLE = 160;
const MAX_BODY = 4000;
const MAX_QUESTION = 2000;
const MAX_ANSWER = 4000;
const PURCHASED_STATUSES = ['paid', 'processing', 'shipped', 'delivered'];

function reviewError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Store plain text only: strip control characters, collapse excessive blank runs,
// trim and cap length. Rendering is always textContent/escaped, never innerHTML.
function cleanText(value, maxLen) {
  const text = String(value == null ? '' : value)
    // strip control characters but keep newline and tab
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return text.slice(0, maxLen);
}

// Detect content that must not appear in public bodies (contact PII) or that looks
// like spam. We never silently censor: we surface a reason so a human moderates.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\s().-]?){10,}/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

function detectFlag(...parts) {
  const text = parts.filter(Boolean).join('\n');
  if (EMAIL_RE.test(text)) return 'pii_email';
  if (PHONE_RE.test(text)) return 'pii_phone';
  if (URL_RE.test(text)) return 'link';
  const letters = text.replace(/[^a-zçğıöşü]/gi, '');
  if (letters.length >= 12 && /(.)\1{7,}/i.test(text)) return 'spam_repeat';
  return '';
}

function normalizeRating(value) {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw reviewError('Puan 1 ile 5 arasinda olmalidir', 'INVALID_RATING', 400);
  }
  return rating;
}

function voterHash(organizationId, { customerAccountId = null, guestToken = '' } = {}) {
  const seed = customerAccountId
    ? `account:${customerAccountId}`
    : (guestToken ? `guest:${crypto.createHash('sha256').update(String(guestToken)).digest('hex')}` : '');
  if (!seed) return null;
  return crypto.createHash('sha256').update(String(organizationId)).update('\0').update(seed).digest('hex');
}

function emailHash(organizationId, email) {
  const normalized = String(email || '').trim().toLocaleLowerCase('tr-TR');
  if (!EMAIL_RE.test(normalized)) return null;
  return crypto.createHash('sha256').update(String(organizationId)).update('\0').update(normalized).digest('hex');
}

// Server-derived verified purchase: the signed-in account must have bought this
// product in a paid-or-later order. Never trusts a client flag.
async function findPurchasedOrderItem(client, { organizationId, productId, customerAccountId }) {
  if (!customerAccountId) return null;
  const result = await client.query(
    `select oi.id
       from order_items oi
       join orders o on o.organization_id = oi.organization_id and o.id = oi.order_id
       join customer_accounts ca
         on ca.organization_id = o.organization_id and ca.customer_id = o.customer_id
      where oi.organization_id = $1 and oi.product_id = $2 and ca.id = $3
        and o.status = any($4::text[])
      order by oi.id desc
      limit 1`,
    [organizationId, productId, customerAccountId, PURCHASED_STATUSES]
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

async function assertProductSellable(client, organizationId, productId) {
  const result = await client.query(
    'select id from products where organization_id = $1 and id = $2 and status <> $3',
    [organizationId, productId, 'draft']
  );
  if (!result.rows[0]) throw reviewError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);
}

// Recompute the published aggregate on the product. Called inside the same
// transaction as any status change so the stored aggregate never drifts and only
// ever reflects published reviews.
async function recomputeProductRating(client, organizationId, productId) {
  await client.query(
    `update products p
        set review_count = agg.cnt,
            review_rating_avg = agg.avg,
            updated_at = now()
       from (
         select count(*)::int as cnt,
                coalesce(round(avg(rating)::numeric, 2), 0) as avg
           from product_reviews
          where organization_id = $1 and product_id = $2 and status = 'published'
       ) agg
      where p.organization_id = $1 and p.id = $2`,
    [organizationId, productId]
  );
}

async function createReview(client, { organizationId, customerAccountId, productId, rating, title, body }) {
  if (!customerAccountId) throw reviewError('Musteri oturumu zorunlu', 'CUSTOMER_SESSION_REQUIRED', 401);
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw reviewError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);
  await assertProductSellable(client, organizationId, pid);
  const safeRating = normalizeRating(rating);
  const safeTitle = cleanText(title, MAX_TITLE);
  const safeBody = cleanText(body, MAX_BODY);
  if (!safeBody) throw reviewError('Yorum metni zorunlu', 'REVIEW_BODY_REQUIRED', 400);

  const orderItemId = await findPurchasedOrderItem(client, { organizationId, productId: pid, customerAccountId });
  const flag = detectFlag(safeTitle, safeBody);

  const inserted = await client.query(
    `insert into product_reviews
       (organization_id, product_id, customer_account_id, order_item_id, rating, title, body,
        status, verified_purchase, flagged_reason)
     values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
     on conflict (organization_id, product_id, customer_account_id) do nothing
     returning *`,
    [organizationId, pid, customerAccountId, orderItemId, safeRating, safeTitle, safeBody,
      Boolean(orderItemId), flag]
  );
  if (!inserted.rows[0]) {
    throw reviewError('Bu urun icin zaten bir yorumunuz var', 'REVIEW_DUPLICATE', 409);
  }
  return inserted.rows[0];
}

function reviewSort(sort) {
  switch (String(sort || '')) {
    case 'oldest': return 'created_at asc';
    case 'highest': return 'rating desc, created_at desc';
    case 'lowest': return 'rating asc, created_at desc';
    case 'helpful': return 'helpful_count desc, created_at desc';
    default: return 'created_at desc';
  }
}

// Public review list: published only, paginated + sorted, with the rating
// distribution and aggregate computed from the published set.
async function listReviews(client, { organizationId, productId, page = 1, pageSize = 10, sort = 'newest', includeAll = false }) {
  const pid = Number(productId);
  const limit = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const statusClause = includeAll ? '' : "and status = 'published'";

  const rows = await client.query(
    `select r.id, r.rating, r.title, r.body, r.status, r.verified_purchase,
            r.helpful_count, r.not_helpful_count, r.created_at,
            coalesce(ca.name, '') as author_name
       from product_reviews r
       left join customer_accounts ca
         on ca.organization_id = r.organization_id and ca.id = r.customer_account_id
      where r.organization_id = $1 and r.product_id = $2 ${statusClause}
      order by ${reviewSort(sort)}
      limit $3 offset $4`,
    [organizationId, pid, limit, offset]
  );
  const distribution = await client.query(
    `select rating, count(*)::int as count
       from product_reviews
      where organization_id = $1 and product_id = $2 and status = 'published'
      group by rating`,
    [organizationId, pid]
  );
  const summary = await client.query(
    `select coalesce(count(*),0)::int as count,
            coalesce(round(avg(rating)::numeric, 2), 0) as average
       from product_reviews
      where organization_id = $1 and product_id = $2 and status = 'published'`,
    [organizationId, pid]
  );
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distribution.rows) dist[row.rating] = row.count;

  return {
    items: rows.rows.map((row) => ({
      id: Number(row.id),
      rating: row.rating,
      title: row.title,
      body: row.body,
      status: row.status,
      verified_purchase: row.verified_purchase,
      helpful_count: row.helpful_count,
      not_helpful_count: row.not_helpful_count,
      created_at: row.created_at,
      author_name: row.author_name,
    })),
    summary: {
      count: summary.rows[0].count,
      average: Number(summary.rows[0].average),
      distribution: dist,
    },
    page: Math.max(Number(page) || 1, 1),
    page_size: limit,
  };
}

// Idempotent per-voter vote. Changing helpful<->not_helpful moves the counters;
// re-voting the same way is a no-op. Only published reviews accept votes.
async function voteReview(client, { organizationId, reviewId, voterHash: hash, customerAccountId = null, voteType }) {
  if (!hash) throw reviewError('Oy icin kimlik gerekli', 'VOTE_IDENTITY_REQUIRED', 400);
  if (!['helpful', 'not_helpful'].includes(voteType)) throw reviewError('Gecersiz oy', 'VOTE_INVALID', 400);
  const review = await client.query(
    "select id, status from product_reviews where organization_id = $1 and id = $2 for update",
    [organizationId, Number(reviewId)]
  );
  if (!review.rows[0]) throw reviewError('Yorum bulunamadi', 'REVIEW_NOT_FOUND', 404);
  if (review.rows[0].status !== 'published') throw reviewError('Yorum oylanamaz', 'REVIEW_NOT_VOTABLE', 409);

  const existing = await client.query(
    'select id, vote_type from review_votes where organization_id = $1 and review_id = $2 and voter_hash = $3 for update',
    [organizationId, Number(reviewId), hash]
  );
  if (existing.rows[0] && existing.rows[0].vote_type === voteType) {
    return updatedCounts(client, organizationId, reviewId);
  }
  if (existing.rows[0]) {
    await client.query(
      'update review_votes set vote_type = $3, updated_at = now() where organization_id = $1 and id = $2',
      [organizationId, existing.rows[0].id, voteType]
    );
  } else {
    await client.query(
      `insert into review_votes (organization_id, review_id, voter_hash, customer_account_id, vote_type)
       values ($1,$2,$3,$4,$5)`,
      [organizationId, Number(reviewId), hash, customerAccountId, voteType]
    );
  }
  await client.query(
    `update product_reviews r
        set helpful_count = agg.helpful, not_helpful_count = agg.not_helpful, updated_at = now()
       from (
         select
           count(*) filter (where vote_type = 'helpful')::int as helpful,
           count(*) filter (where vote_type = 'not_helpful')::int as not_helpful
         from review_votes where organization_id = $1 and review_id = $2
       ) agg
      where r.organization_id = $1 and r.id = $2`,
    [organizationId, Number(reviewId)]
  );
  return updatedCounts(client, organizationId, reviewId);
}

async function updatedCounts(client, organizationId, reviewId) {
  const result = await client.query(
    'select helpful_count, not_helpful_count from product_reviews where organization_id = $1 and id = $2',
    [organizationId, Number(reviewId)]
  );
  return {
    helpful_count: result.rows[0]?.helpful_count ?? 0,
    not_helpful_count: result.rows[0]?.not_helpful_count ?? 0,
  };
}

const REVIEW_ACTIONS = {
  publish: 'published',
  reject: 'rejected',
  hide: 'hidden',
  unpublish: 'pending',
};

// Admin moderation: transition status, stamp moderator, recompute the aggregate
// whenever the published set can change. Returns the previous + new status for audit.
async function moderateReview(client, { organizationId, reviewId, action, moderatorUserId = null, rejectionReason = '' }) {
  const nextStatus = REVIEW_ACTIONS[action];
  if (!nextStatus) throw reviewError('Gecersiz moderasyon islemi', 'MODERATION_ACTION_INVALID', 400);
  const current = await client.query(
    'select * from product_reviews where organization_id = $1 and id = $2 for update',
    [organizationId, Number(reviewId)]
  );
  if (!current.rows[0]) throw reviewError('Yorum bulunamadi', 'REVIEW_NOT_FOUND', 404);
  const previous = current.rows[0];
  const updated = await client.query(
    `update product_reviews
        set status = $3, moderated_by = $4, moderated_at = now(),
            rejection_reason = case when $3 = 'rejected' then $5 else '' end,
            updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(reviewId), nextStatus, moderatorUserId, cleanText(rejectionReason, 500)]
  );
  await recomputeProductRating(client, organizationId, previous.product_id);
  return { previousStatus: previous.status, review: updated.rows[0] };
}

async function listModerationReviews(client, { organizationId, status = 'pending', page = 1, pageSize = 20 }) {
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const clause = status === 'all' ? '' : 'and r.status = $4';
  const params = [organizationId, limit, offset];
  if (status !== 'all') params.push(status);
  const rows = await client.query(
    `select r.*, coalesce(ca.name, '') as author_name, p.name as product_name
       from product_reviews r
       join products p on p.organization_id = r.organization_id and p.id = r.product_id
       left join customer_accounts ca
         on ca.organization_id = r.organization_id and ca.id = r.customer_account_id
      where r.organization_id = $1 ${clause}
      order by r.created_at desc
      limit $2 offset $3`,
    params
  );
  return rows.rows;
}

async function listModerationQuestions(client, { organizationId, status = 'pending', page = 1, pageSize = 20 }) {
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const clause = status === 'all' ? '' : 'and q.status = $4';
  const params = [organizationId, limit, offset];
  if (status !== 'all') params.push(status);
  const questions = await client.query(
    `select q.*, p.name as product_name
       from product_questions q
       join products p on p.organization_id = q.organization_id and p.id = q.product_id
      where q.organization_id = $1 ${clause}
      order by q.created_at desc
      limit $2 offset $3`,
    params
  );
  const ids = questions.rows.map((row) => Number(row.id));
  let answers = [];
  if (ids.length) {
    answers = (await client.query(
      `select id, question_id, body, author_type, is_official, status, created_at
         from product_answers
        where organization_id = $1 and question_id = any($2::bigint[])
        order by created_at asc`,
      [organizationId, ids]
    )).rows;
  }
  return questions.rows.map((question) => ({
    ...question,
    answers: answers.filter((answer) => Number(answer.question_id) === Number(question.id)),
  }));
}

// ── Q&A ───────────────────────────────────────────────────────────────────────

async function askQuestion(client, { organizationId, productId, customerAccountId = null, askerName = '', contactEmail = '', body }) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw reviewError('Urun bulunamadi', 'PRODUCT_NOT_FOUND', 404);
  await assertProductSellable(client, organizationId, pid);
  const safeBody = cleanText(body, MAX_QUESTION);
  if (!safeBody) throw reviewError('Soru metni zorunlu', 'QUESTION_BODY_REQUIRED', 400);
  const safeName = cleanText(askerName, 120);
  const flag = detectFlag(safeBody);
  const inserted = await client.query(
    `insert into product_questions
       (organization_id, product_id, customer_account_id, asker_name, contact_email_hash, body, status, flagged_reason)
     values ($1,$2,$3,$4,$5,$6,'pending',$7) returning *`,
    [organizationId, pid, customerAccountId, safeName, emailHash(organizationId, contactEmail), safeBody, flag]
  );
  return inserted.rows[0];
}

async function listQuestions(client, { organizationId, productId, page = 1, pageSize = 10, includeAll = false }) {
  const pid = Number(productId);
  const limit = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const statusClause = includeAll ? '' : "and q.status = 'published'";
  const questions = await client.query(
    `select q.id, q.body, q.status, q.asker_name, q.answer_count, q.created_at
       from product_questions q
      where q.organization_id = $1 and q.product_id = $2 ${statusClause}
      order by q.created_at desc
      limit $3 offset $4`,
    [organizationId, pid, limit, offset]
  );
  const ids = questions.rows.map((row) => Number(row.id));
  let answersByQuestion = new Map();
  if (ids.length) {
    const answerClause = includeAll ? '' : "and status = 'published'";
    const answers = await client.query(
      `select id, question_id, body, author_type, is_official, status, created_at
         from product_answers
        where organization_id = $1 and question_id = any($2::bigint[]) ${answerClause}
        order by is_official desc, created_at asc`,
      [organizationId, ids]
    );
    answersByQuestion = answers.rows.reduce((map, row) => {
      const key = Number(row.question_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        id: Number(row.id), body: row.body, author_type: row.author_type,
        is_official: row.is_official, status: row.status, created_at: row.created_at,
      });
      return map;
    }, new Map());
  }
  return {
    items: questions.rows.map((row) => ({
      id: Number(row.id), body: row.body, status: row.status, asker_name: row.asker_name,
      answer_count: row.answer_count, created_at: row.created_at,
      answers: answersByQuestion.get(Number(row.id)) || [],
    })),
    page: Math.max(Number(page) || 1, 1),
    page_size: limit,
  };
}

// Store answers are trusted (official, published on write); customer answers are
// queued for moderation like any other public content.
async function answerQuestion(client, { organizationId, questionId, body, authorType, authorUserId = null, authorAccountId = null, isOfficial = false }) {
  if (!['store', 'customer'].includes(authorType)) throw reviewError('Gecersiz yanit turu', 'ANSWER_TYPE_INVALID', 400);
  const qid = Number(questionId);
  const question = await client.query(
    'select id, status from product_questions where organization_id = $1 and id = $2 for update',
    [organizationId, qid]
  );
  if (!question.rows[0]) throw reviewError('Soru bulunamadi', 'QUESTION_NOT_FOUND', 404);
  const safeBody = cleanText(body, MAX_ANSWER);
  if (!safeBody) throw reviewError('Yanit metni zorunlu', 'ANSWER_BODY_REQUIRED', 400);
  const status = authorType === 'store' ? 'published' : 'pending';
  const official = authorType === 'store' ? Boolean(isOfficial) : false;
  const inserted = await client.query(
    `insert into product_answers
       (organization_id, question_id, body, author_type, author_user_id, author_account_id, is_official, status,
        moderated_by, moderated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $8 = 'published' then now() else null end) returning *`,
    [organizationId, qid, safeBody, authorType, authorUserId, authorAccountId, official, status,
      authorType === 'store' ? authorUserId : null]
  );
  await refreshAnswerCount(client, organizationId, qid);
  // A store answer publishes its question too, so a Q with an official answer is public.
  if (authorType === 'store' && question.rows[0].status === 'pending') {
    await client.query(
      "update product_questions set status = 'published', moderated_by = $3, moderated_at = now(), updated_at = now() where organization_id = $1 and id = $2",
      [organizationId, qid, authorUserId]
    );
  }
  return inserted.rows[0];
}

async function refreshAnswerCount(client, organizationId, questionId) {
  await client.query(
    `update product_questions q
        set answer_count = agg.cnt, updated_at = now()
       from (select count(*)::int as cnt from product_answers
              where organization_id = $1 and question_id = $2 and status = 'published') agg
      where q.organization_id = $1 and q.id = $2`,
    [organizationId, Number(questionId)]
  );
}

const QA_ACTIONS = { publish: 'published', reject: 'rejected', hide: 'hidden', unpublish: 'pending' };

async function moderateQuestion(client, { organizationId, questionId, action, moderatorUserId = null, rejectionReason = '' }) {
  const nextStatus = QA_ACTIONS[action];
  if (!nextStatus) throw reviewError('Gecersiz moderasyon islemi', 'MODERATION_ACTION_INVALID', 400);
  const current = await client.query(
    'select status from product_questions where organization_id = $1 and id = $2 for update',
    [organizationId, Number(questionId)]
  );
  if (!current.rows[0]) throw reviewError('Soru bulunamadi', 'QUESTION_NOT_FOUND', 404);
  const updated = await client.query(
    `update product_questions
        set status = $3, moderated_by = $4, moderated_at = now(),
            rejection_reason = case when $3 = 'rejected' then $5 else '' end, updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(questionId), nextStatus, moderatorUserId, cleanText(rejectionReason, 500)]
  );
  return { previousStatus: current.rows[0].status, question: updated.rows[0] };
}

async function moderateAnswer(client, { organizationId, answerId, action, moderatorUserId = null }) {
  const nextStatus = QA_ACTIONS[action];
  if (!nextStatus) throw reviewError('Gecersiz moderasyon islemi', 'MODERATION_ACTION_INVALID', 400);
  const current = await client.query(
    'select status, question_id from product_answers where organization_id = $1 and id = $2 for update',
    [organizationId, Number(answerId)]
  );
  if (!current.rows[0]) throw reviewError('Yanit bulunamadi', 'ANSWER_NOT_FOUND', 404);
  const updated = await client.query(
    `update product_answers set status = $3, moderated_by = $4, moderated_at = now(), updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, Number(answerId), nextStatus, moderatorUserId]
  );
  await refreshAnswerCount(client, organizationId, current.rows[0].question_id);
  return { previousStatus: current.rows[0].status, answer: updated.rows[0] };
}

module.exports = {
  cleanText,
  detectFlag,
  normalizeRating,
  voterHash,
  emailHash,
  findPurchasedOrderItem,
  recomputeProductRating,
  createReview,
  listReviews,
  voteReview,
  moderateReview,
  listModerationReviews,
  listModerationQuestions,
  askQuestion,
  listQuestions,
  answerQuestion,
  moderateQuestion,
  moderateAnswer,
  reviewError,
};
