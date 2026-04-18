"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OrderStatus } from "@/lib/api";
import { EmptyText, orderStatusLabels } from "@/components/operations-shared";

const STATUS_COLORS: Record<OrderStatus, string> = {
  new: "#0f8b8d",
  payment_pending: "#c68a19",
  processing: "#2f855a",
  paid: "#0f8b8d",
  shipped: "#2f855a",
  delivered: "#2f855a",
  cancelled: "#d95d39",
};

export function OrderStatusChart({ data }: { data: { status: OrderStatus; count: number }[] }) {
  const chartData = data
    .map((item) => ({
      name: orderStatusLabels[item.status] ?? item.status,
      count: Number(item.count || 0),
      color: STATUS_COLORS[item.status] ?? "#6b7280",
    }))
    .filter((item) => item.count > 0);

  if (chartData.length === 0) {
    return <EmptyText>Durum grafigi icin henuz siparis yok.</EmptyText>;
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer height="100%" width="100%">
        <BarChart barSize={32} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip cursor={{ fill: "rgba(15, 139, 141, 0.08)" }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {chartData.map((entry) => (
              <Cell fill={entry.color} key={entry.name} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
