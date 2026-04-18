import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-8 items-center rounded-lg border px-2.5 py-1 text-xs font-semibold",
  {
    variants: {
      tone: {
        mint: "border-mint/30 bg-mint/10 text-mint",
        coral: "border-coral/30 bg-coral/10 text-coral",
        leaf: "border-leaf/30 bg-leaf/10 text-leaf",
        sun: "border-sun/30 bg-sun/10 text-zinc-700",
        neutral: "border-line bg-zinc-50 text-zinc-700",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
