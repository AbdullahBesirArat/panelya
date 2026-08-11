const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const reviews = require('../modules/reviews/service');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

// The moderator is the acting app user; resolveOrganization has already activated
// the request tenant transaction, so passing `db` runs everything on it atomically.
function moderatorId(req) {
  return req.auth?.userId || null;
}

router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const items = await reviews.listModerationReviews(db, {
      organizationId: organization.id, status: req.query.status || 'pending',
      page: req.query.page, pageSize: req.query.page_size,
    });
    res.json({ items });
  } catch (error) { next(error); }
});

router.post('/:id/moderate', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await reviews.moderateReview(db, {
      organizationId: organization.id, reviewId: req.params.id, action: req.body.action,
      moderatorUserId: moderatorId(req), rejectionReason: req.body.rejection_reason || req.body.reason || '',
    });
    await auditLog(req, {
      action: `review.${req.body.action}`, resourceType: 'product_review', resourceId: String(req.params.id),
      oldValue: { status: result.previousStatus }, newValue: { status: result.review.status },
      organizationId: organization.id,
    });
    res.json({ review: result.review });
  } catch (error) { next(error); }
});

router.get('/questions', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const items = await reviews.listModerationQuestions(db, {
      organizationId: organization.id, status: req.query.status || 'pending',
      page: req.query.page, pageSize: req.query.page_size,
    });
    res.json({ items });
  } catch (error) { next(error); }
});

router.post('/questions/:id/moderate', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await reviews.moderateQuestion(db, {
      organizationId: organization.id, questionId: req.params.id, action: req.body.action,
      moderatorUserId: moderatorId(req), rejectionReason: req.body.rejection_reason || '',
    });
    await auditLog(req, {
      action: `question.${req.body.action}`, resourceType: 'product_question', resourceId: String(req.params.id),
      oldValue: { status: result.previousStatus }, newValue: { status: result.question.status },
      organizationId: organization.id,
    });
    res.json({ question: result.question });
  } catch (error) { next(error); }
});

router.post('/questions/:id/answer', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const answer = await reviews.answerQuestion(db, {
      organizationId: organization.id, questionId: req.params.id, body: req.body.body,
      authorType: 'store', authorUserId: moderatorId(req), isOfficial: req.body.official !== false,
    });
    await auditLog(req, {
      action: 'question.answer', resourceType: 'product_answer', resourceId: String(answer.id),
      newValue: { question_id: String(req.params.id) }, organizationId: organization.id,
    });
    res.status(201).json({ answer });
  } catch (error) { next(error); }
});

router.post('/answers/:id/moderate', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await reviews.moderateAnswer(db, {
      organizationId: organization.id, answerId: req.params.id, action: req.body.action, moderatorUserId: moderatorId(req),
    });
    await auditLog(req, {
      action: `answer.${req.body.action}`, resourceType: 'product_answer', resourceId: String(req.params.id),
      oldValue: { status: result.previousStatus }, newValue: { status: result.answer.status },
      organizationId: organization.id,
    });
    res.json({ answer: result.answer });
  } catch (error) { next(error); }
});

module.exports = router;
