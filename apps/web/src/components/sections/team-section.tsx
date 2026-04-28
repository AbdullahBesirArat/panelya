"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { MetricGrid } from "@/components/page-kit";
import {
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatDateTime,
} from "@/components/operations-shared";
import {
  createOrganizationInvite,
  fetchOrganizationInvites,
  fetchTeamMembers,
  removeTeamMember,
  updateTeamMemberRole,
  type ApiOrganizationInvite,
  type ApiTeamMember,
} from "@/lib/api";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";

type EditableRole = "admin" | "member" | "viewer";

const inviteRoleOptions: EditableRole[] = ["member", "admin", "viewer"];

export function TeamSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const currentUser = useSessionStore((state) => state.user);
  const [inviteToken, setInviteToken] = useState("");
  const [now] = useState(() => Date.now());
  const canManageTeam = currentRole === "owner" || currentRole === "admin";

  const membersQuery = useQuery({
    queryKey: ["team-members", organizationSlug],
    queryFn: fetchTeamMembers,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const invitesQuery = useQuery({
    queryKey: ["organization-invites", organizationSlug],
    queryFn: fetchOrganizationInvites,
    enabled: canManageTeam,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const inviteMutation = useMutation({
    mutationFn: createOrganizationInvite,
    onSuccess: async (invite) => {
      setInviteToken(invite.inviteToken || "");
      pushToast({
        title: "Davet oluşturuldu",
        description: `${invite.email} adresine ekip daveti hazırlandı.`,
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organization-invites", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: EditableRole }) => updateTeamMemberRole(id, role),
    onSuccess: async () => {
      pushToast({
        title: "Rol güncellendi",
        description: "Ekip üyesinin yetkisi kaydedildi.",
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: ["team-members", organizationSlug] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeTeamMember,
    onSuccess: async () => {
      pushToast({
        title: "Üyelik kaldırıldı",
        description: "Ekip listesi güncellendi.",
        tone: "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["team-members", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  function handleInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageTeam) return;
    const form = new FormData(event.currentTarget);
    inviteMutation.mutate({
      email: String(form.get("email") || "").trim(),
      role: normalizeEditableRole(form.get("role")),
    });
    event.currentTarget.reset();
  }

  if (membersQuery.isLoading && !membersQuery.data) return <SectionLoading />;
  if (membersQuery.isError || !membersQuery.data) {
    return <SectionError message="Ekip bilgisi yüklenemedi." onRetry={() => void membersQuery.refetch()} />;
  }

  const members = membersQuery.data;
  const invites = invitesQuery.data || [];
  const activeInvites = invites.filter((invite) => !invite.accepted_at && new Date(invite.expires_at).getTime() > now);
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const adminCount = members.filter((member) => member.role === "admin").length;

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aktif üye", value: String(members.length), tone: "mint" },
          { label: "Yönetici", value: String(ownerCount + adminCount), tone: "leaf" },
          { label: "Bekleyen davet", value: String(activeInvites.length), tone: "sun" },
          { label: "Rolünüz", value: roleLabel(currentRole), tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Panel
          title="Ekip üyeleri"
          description="Aktif kullanıcılar ve mağaza yetkileri"
          actions={membersQuery.isFetching ? (
            <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
              Güncelleniyor
            </span>
          ) : null}
        >
          <DataGrid
            columns={["Üye", "Rol", "Son giriş", "Eklenme", "Aksiyon"]}
            emptyMessage="Henüz ekip üyesi yok."
            rows={members}
            renderRow={(member) => (
              <MemberRow
                canManageTeam={canManageTeam}
                currentUserId={currentUser?.id || ""}
                isRemoving={removeMutation.isPending && removeMutation.variables === member.id}
                isSavingRole={roleMutation.isPending && roleMutation.variables?.id === member.id}
                key={member.id}
                member={member}
                onRemove={(id) => removeMutation.mutate(id)}
                onRoleChange={(id, role) => roleMutation.mutate({ id, role })}
              />
            )}
          />
          {roleMutation.isError ? <InlineError message={roleMutation.error.message} /> : null}
          {removeMutation.isError ? <InlineError message={removeMutation.error.message} /> : null}
        </Panel>

        <Panel title="Davet gönder" description="Yeni ekip üyesi ekleyin">
          <form className="space-y-4" onSubmit={handleInviteSubmit}>
            <div className="grid gap-2">
              <FieldLabel htmlFor="inviteEmail">E-posta</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                disabled={!canManageTeam || inviteMutation.isPending}
                id="inviteEmail"
                name="email"
                placeholder="ekip@marka.com"
                required
                type="email"
              />
            </div>
            <div className="grid gap-2">
              <FieldLabel htmlFor="inviteRole">Rol</FieldLabel>
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                defaultValue="member"
                disabled={!canManageTeam || inviteMutation.isPending}
                id="inviteRole"
                name="role"
              >
                {inviteRoleOptions.map((role) => (
                  <option key={role} value={role}>{roleLabel(role)}</option>
                ))}
              </select>
            </div>
            <Button disabled={!canManageTeam || inviteMutation.isPending} type="submit" variant="mint">
              {inviteMutation.isPending ? "Gönderiliyor" : "Davet oluştur"}
            </Button>
            {!canManageTeam ? <InlineHint>Ekip daveti için sahip veya yönetici rolü gerekir.</InlineHint> : null}
            {inviteMutation.isError ? <InlineError message={inviteMutation.error.message} /> : null}
            {inviteToken ? (
              <div className="rounded-lg border border-line bg-zinc-50 p-3">
                <p className="text-xs font-semibold uppercase text-zinc-500">Davet token</p>
                <p className="mt-2 break-all font-mono text-xs text-zinc-700">{inviteToken}</p>
              </div>
            ) : null}
          </form>
        </Panel>
      </div>

      <Panel title="Bekleyen davetler" description="Son oluşturulan ekip davetleri">
        {canManageTeam && invitesQuery.isError ? <InlineError message={invitesQuery.error.message} /> : null}
        <DataGrid
          columns={["E-posta", "Rol", "Durum", "Oluşturma", "Geçerlilik"]}
          emptyMessage={canManageTeam ? "Bekleyen davet yok." : "Davetleri görüntülemek için sahip veya yönetici rolü gerekir."}
          rows={canManageTeam ? invites : []}
          renderRow={(invite) => <InviteRow invite={invite} key={invite.id} now={now} />}
        />
      </Panel>
    </>
  );
}

function MemberRow({
  member,
  currentUserId,
  canManageTeam,
  isSavingRole,
  isRemoving,
  onRoleChange,
  onRemove,
}: {
  member: ApiTeamMember;
  currentUserId: string;
  canManageTeam: boolean;
  isSavingRole: boolean;
  isRemoving: boolean;
  onRoleChange: (id: string, role: EditableRole) => void;
  onRemove: (id: string) => void;
}) {
  const protectedMember = member.role === "owner" || member.user_id === currentUserId;

  return (
    <tr>
      <DataCell>
        <p className="font-semibold text-ink">{member.name || member.email}</p>
        <p className="text-xs text-zinc-500">{member.email}</p>
      </DataCell>
      <DataCell>
        {member.role === "owner" ? (
          <StatusPill tone="mint">{roleLabel(member.role)}</StatusPill>
        ) : (
          <select
            className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-sm"
            disabled={!canManageTeam || isSavingRole}
            onChange={(event) => onRoleChange(member.id, normalizeEditableRole(event.target.value))}
            value={member.role}
          >
            {inviteRoleOptions.map((role) => (
              <option key={role} value={role}>{roleLabel(role)}</option>
            ))}
          </select>
        )}
      </DataCell>
      <DataCell>{formatDateTime(member.last_login_at)}</DataCell>
      <DataCell>{formatDateTime(member.created_at)}</DataCell>
      <DataCell>
        <Button
          disabled={!canManageTeam || protectedMember || isRemoving}
          onClick={() => onRemove(member.id)}
          type="button"
          variant="outline"
        >
          {isRemoving ? "Kaldırılıyor" : "Kaldır"}
        </Button>
      </DataCell>
    </tr>
  );
}

function InviteRow({ invite, now }: { invite: ApiOrganizationInvite; now: number }) {
  const expired = new Date(invite.expires_at).getTime() <= now;
  const accepted = Boolean(invite.accepted_at);

  return (
    <tr>
      <DataCell>{invite.email}</DataCell>
      <DataCell>{roleLabel(invite.role)}</DataCell>
      <DataCell>
        <StatusPill tone={accepted ? "leaf" : expired ? "coral" : "sun"}>
          {accepted ? "Kabul edildi" : expired ? "Süresi doldu" : "Bekliyor"}
        </StatusPill>
      </DataCell>
      <DataCell>{formatDateTime(invite.created_at)}</DataCell>
      <DataCell>{formatDateTime(invite.expires_at)}</DataCell>
    </tr>
  );
}

function normalizeEditableRole(value: FormDataEntryValue | string | null): EditableRole {
  const role = String(value || "");
  return inviteRoleOptions.includes(role as EditableRole) ? role as EditableRole : "member";
}

function roleLabel(role: string) {
  switch (role) {
    case "owner":
      return "Sahip";
    case "admin":
      return "Yönetici";
    case "member":
      return "Ekip Üyesi";
    case "viewer":
      return "Salt Okur";
    default:
      return role;
  }
}
