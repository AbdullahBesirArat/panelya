import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#202124",
        paper: "#f5f7f8",
        line: "#d9dee2",
        // A31: measured against white, the previous values were 4.12:1 (mint) and 3.77:1
        // (coral) — both under the 4.5:1 WCAG AA threshold, as text and as a filled
        // background carrying white text. The hues are unchanged; only luminance drops far
        // enough to clear AA in both directions (mint 6.03:1, coral 5.39:1).
        mint: "#0d6e70",
        coral: "#b8442a",
        // Badges render this tone on a 10% tint of itself, where the old value measured
        // 4.02:1 — under AA. Same green, enough luminance drop to reach 5.00:1 on that
        // tint (5.73:1 on white).
        leaf: "#2a7350",
        sun: "#c68a19"
      },
      boxShadow: {
        panel: "0 18px 45px rgba(32, 33, 36, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
