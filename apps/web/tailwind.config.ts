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
        mint: "#0f8b8d",
        coral: "#d95d39",
        leaf: "#2f855a",
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
