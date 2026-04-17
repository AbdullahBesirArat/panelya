import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OperationsContent } from "@/components/operations-content";
import { SectionHeader } from "@/components/page-kit";
import { sectionKeys, sectionMeta } from "@/lib/demo-data";

type PageProps = {
  params: Promise<{
    section: string;
  }>;
};

export function generateStaticParams() {
  return sectionKeys.map((section) => ({ section }));
}

export default async function OperationsPage({ params }: PageProps) {
  const { section: sectionKey } = await params;
  const section = sectionMeta[sectionKey];
  if (!section) notFound();

  return (
    <AppShell activeSection={sectionKey}>
      <SectionHeader
        kicker={section.kicker}
        title={section.title}
        description={section.description}
        image={section.image}
      />
      <OperationsContent sectionKey={sectionKey} />
    </AppShell>
  );
}
