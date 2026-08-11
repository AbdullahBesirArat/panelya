"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  answerQuestion, fetchModerationQuestions, fetchModerationReviews, moderateQuestion, moderateReview,
  type ModerationQuestion, type ModerationReview, type ModerationStatus, type ReviewAction,
} from "@/lib/api/reviews";
import { queryKeys } from "@/lib/query-keys";

const statusLabels: Record<ModerationStatus, string> = {
  pending: "Beklemede", published: "Yayında", rejected: "Reddedildi", hidden: "Gizli",
};

function statusTone(status: ModerationStatus) {
  if (status === "published") return "mint" as const;
  if (status === "pending") return "sun" as const;
  if (status === "rejected") return "coral" as const;
  return "leaf" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function ReviewsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [status, setStatus] = useState("pending");
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const reviewsQuery = useQuery({
    queryKey: queryKeys.reviews.all(organizationSlug, status),
    queryFn: () => fetchModerationReviews(status),
  });
  const questionsQuery = useQuery({
    queryKey: queryKeys.reviews.questions(organizationSlug, status),
    queryFn: () => fetchModerationQuestions(status),
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all(organizationSlug, status) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.reviews.questions(organizationSlug, status) }),
    ]);
  };

  const reviewMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: ReviewAction }) => moderateReview(id, action),
    onSuccess: invalidate,
  });
  const questionMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: ReviewAction }) => moderateQuestion(id, action),
    onSuccess: invalidate,
  });
  const answerMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => answerQuestion(id, body),
    onSuccess: async (_data, variables) => {
      setAnswers((prev) => ({ ...prev, [variables.id]: "" }));
      await invalidate();
    },
  });

  if (reviewsQuery.isLoading || questionsQuery.isLoading) return <SectionLoading />;
  if (reviewsQuery.isError) return <SectionError message={errorMessage(reviewsQuery.error)} onRetry={() => reviewsQuery.refetch()} />;

  const statusFilter = (
    <select
      aria-label="Durum filtresi"
      className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
      onChange={(event) => setStatus(event.target.value)}
      value={status}
    >
      <option value="pending">Beklemede</option>
      <option value="published">Yayında</option>
      <option value="rejected">Reddedildi</option>
      <option value="hidden">Gizli</option>
      <option value="all">Tümü</option>
    </select>
  );

  const reviews = reviewsQuery.data?.items ?? [];
  const questions = questionsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      {reviewMutation.isError ? <InlineError message={errorMessage(reviewMutation.error)} /> : null}
      {questionMutation.isError ? <InlineError message={errorMessage(questionMutation.error)} /> : null}
      {answerMutation.isError ? <InlineError message={errorMessage(answerMutation.error)} /> : null}

      <Panel title="Değerlendirme moderasyonu" description="Yorumları yayınla, reddet veya gizle. Yalnız yayınlanan yorumlar mağazada görünür." actions={statusFilter}>
        <DataGrid<ModerationReview>
          caption="Değerlendirme moderasyonu"
          columns={["Ürün / Yazar", "Puan", "Yorum", "Durum", "İşlem"]}
          rows={reviews}
          emptyMessage="Bu durumda değerlendirme yok."
          renderRow={(review) => (
            <tr key={review.id}>
              <DataCell>
                <div className="font-semibold">{review.product_name}</div>
                <div className="text-xs text-zinc-600">{review.author_name || "Müşteri"} · {formatDateTime(review.created_at)}</div>
                {review.verified_purchase ? <div className="text-xs text-mint">Doğrulanmış alışveriş</div> : null}
                {review.flagged_reason ? <div className="text-xs text-coral">İşaret: {review.flagged_reason}</div> : null}
              </DataCell>
              <DataCell>{"★".repeat(review.rating)}</DataCell>
              <DataCell>
                {review.title ? <div className="font-semibold">{review.title}</div> : null}
                <div className="whitespace-pre-wrap text-zinc-700">{review.body}</div>
              </DataCell>
              <DataCell><StatusPill tone={statusTone(review.status)}>{statusLabels[review.status]}</StatusPill></DataCell>
              <DataCell>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {review.status !== "published" ? (
                      <Button size="sm" onClick={() => reviewMutation.mutate({ id: review.id, action: "publish" })}>Yayınla</Button>
                    ) : null}
                    {review.status !== "rejected" ? (
                      <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: review.id, action: "reject" })}>Reddet</Button>
                    ) : null}
                    {review.status === "published" ? (
                      <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: review.id, action: "hide" })}>Gizle</Button>
                    ) : null}
                  </div>
                ) : <span className="text-xs text-zinc-600">Yetki yok</span>}
              </DataCell>
            </tr>
          )}
        />
      </Panel>

      <Panel title="Soru & Cevap moderasyonu" description="Soruları yayınla/reddet ve mağaza yanıtı ekle. Mağaza yanıtı soruyu yayınlar.">
        <DataGrid<ModerationQuestion>
          caption="Soru & Cevap moderasyonu"
          columns={["Ürün / Soru", "Yanıtlar", "Durum", "İşlem"]}
          rows={questions}
          emptyMessage="Bu durumda soru yok."
          renderRow={(question) => (
            <tr key={question.id}>
              <DataCell>
                <div className="font-semibold">{question.product_name}</div>
                <div className="whitespace-pre-wrap text-zinc-700">{question.body}</div>
                {question.flagged_reason ? <div className="text-xs text-coral">İşaret: {question.flagged_reason}</div> : null}
              </DataCell>
              <DataCell>
                {question.answers.length === 0 ? <span className="text-xs text-zinc-600">Yanıt yok</span> : null}
                {question.answers.map((answer) => (
                  <div className="mb-1 text-zinc-700" key={answer.id}>
                    <span className="text-xs uppercase text-zinc-600">{answer.author_type === "store" ? "Mağaza" : "Müşteri"} · {statusLabels[answer.status]}</span>
                    <div className="whitespace-pre-wrap">{answer.body}</div>
                  </div>
                ))}
                {canManage ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      aria-label="Mağaza yanıtı"
                      className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
                      onChange={(event) => setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))}
                      placeholder="Mağaza yanıtı yaz"
                      value={answers[question.id] ?? ""}
                    />
                    <Button
                      size="sm"
                      disabled={!(answers[question.id] ?? "").trim()}
                      onClick={() => answerMutation.mutate({ id: question.id, body: (answers[question.id] ?? "").trim() })}
                    >
                      Yanıtla
                    </Button>
                  </div>
                ) : null}
              </DataCell>
              <DataCell><StatusPill tone={statusTone(question.status)}>{statusLabels[question.status]}</StatusPill></DataCell>
              <DataCell>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {question.status !== "published" ? (
                      <Button size="sm" onClick={() => questionMutation.mutate({ id: question.id, action: "publish" })}>Yayınla</Button>
                    ) : null}
                    {question.status !== "rejected" ? (
                      <Button size="sm" variant="outline" onClick={() => questionMutation.mutate({ id: question.id, action: "reject" })}>Reddet</Button>
                    ) : null}
                  </div>
                ) : <span className="text-xs text-zinc-600">Yetki yok</span>}
              </DataCell>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}
