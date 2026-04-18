import Image from "next/image";

type Metric = {
  label: string;
  value: string;
  tone: "mint" | "coral" | "leaf" | "sun";
};

const toneClass: Record<Metric["tone"], string> = {
  mint: "border-mint text-mint",
  coral: "border-coral text-coral",
  leaf: "border-leaf text-leaf",
  sun: "border-sun text-sun"
};

export function SectionHeader({
  kicker,
  title,
  description,
  image
}: {
  kicker: string;
  title: string;
  description: string;
  image: string;
}) {
  return (
    <section className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="rounded-lg border border-line bg-white p-5 shadow-panel">
        <p className="text-sm font-semibold uppercase text-mint">{kicker}</p>
        <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-zinc-600">{description}</p>
      </div>
      <Image
        alt=""
        className="h-56 w-full rounded-lg object-cover shadow-panel lg:h-full"
        height={720}
        sizes="(min-width: 1024px) 340px, 100vw"
        src={image}
        width={960}
      />
    </section>
  );
}

export function MetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <article className={`rounded-lg border-l-4 bg-white p-5 shadow-panel ${toneClass[metric.tone]}`} key={metric.label}>
          <p className="text-sm font-semibold text-zinc-500">{metric.label}</p>
          <p className="mt-3 text-3xl font-bold text-ink">{metric.value}</p>
        </article>
      ))}
    </section>
  );
}
