import Image from "next/image";

type Metric = {
  label: string;
  value: string;
  tone: "mint" | "coral" | "leaf" | "sun";
};

type Row = Record<string, string>;

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

export function DataTable({
  title,
  columns,
  rows
}: {
  title: string;
  columns: string[];
  rows: Row[];
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white shadow-panel">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-lg font-bold">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              {columns.map((column) => (
                <th className="w-1/4 px-5 py-3 font-semibold" key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row, index) => (
              <tr key={`${row[columns[0]]}-${index}`}>
                {columns.map((column) => (
                  <td className="truncate px-5 py-4 text-zinc-700" key={column}>{row[column]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ActivityList({
  title,
  items
}: {
  title: string;
  items: string[];
}) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-bold">{title}</h2>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div className="rounded-lg border border-line px-4 py-3 text-sm text-zinc-700" key={item}>
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}
