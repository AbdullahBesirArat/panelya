import { authenticatedRequest } from "./core";

export type ModerationStatus = "pending" | "published" | "rejected" | "hidden";
export type ReviewAction = "publish" | "reject" | "hide" | "unpublish";

export type ModerationReview = {
  id: number;
  product_id: number;
  product_name: string;
  author_name: string;
  rating: number;
  title: string;
  body: string;
  status: ModerationStatus;
  verified_purchase: boolean;
  helpful_count: number;
  not_helpful_count: number;
  flagged_reason: string;
  rejection_reason: string;
  created_at: string;
};

export type ModerationAnswer = {
  id: number;
  body: string;
  author_type: "store" | "customer";
  is_official: boolean;
  status: ModerationStatus;
  created_at: string;
};

export type ModerationQuestion = {
  id: number;
  product_id: number;
  product_name: string;
  body: string;
  status: ModerationStatus;
  answer_count: number;
  flagged_reason: string;
  created_at: string;
  answers: ModerationAnswer[];
};

export function fetchModerationReviews(status = "pending") {
  return authenticatedRequest<{ items: ModerationReview[] }>(
    `/operations/reviews?status=${encodeURIComponent(status)}`
  );
}

export function moderateReview(id: number, action: ReviewAction, rejectionReason = "") {
  return authenticatedRequest<{ review: ModerationReview }>(`/operations/reviews/${id}/moderate`, {
    method: "POST",
    body: JSON.stringify({ action, rejection_reason: rejectionReason }),
  });
}

export function fetchModerationQuestions(status = "pending") {
  return authenticatedRequest<{ items: ModerationQuestion[] }>(
    `/operations/reviews/questions?status=${encodeURIComponent(status)}`
  );
}

export function moderateQuestion(id: number, action: ReviewAction, rejectionReason = "") {
  return authenticatedRequest<{ question: ModerationQuestion }>(
    `/operations/reviews/questions/${id}/moderate`,
    { method: "POST", body: JSON.stringify({ action, rejection_reason: rejectionReason }) }
  );
}

export function answerQuestion(id: number, body: string) {
  return authenticatedRequest<{ answer: ModerationAnswer }>(
    `/operations/reviews/questions/${id}/answer`,
    { method: "POST", body: JSON.stringify({ body }) }
  );
}
