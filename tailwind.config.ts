import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0a0c",
          card: "#15151a",
          elev: "#20202a",
        },
        border: {
          // Hairline white keeps dividers crisp without heavy lines.
          DEFAULT: "rgba(255,255,255,0.08)",
          strong: "rgba(255,255,255,0.12)",
        },
        accent: {
          protein: "#f04444",
          carbs: "#f5a623",
          fat: "#4a90e2",
          cal: "#13c08a",
          brand: "#a855f7",
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: "inset 0 1px 0 rgba(255,255,255,0.035), 0 1px 2px rgba(0,0,0,0.35), 0 8px 24px -12px rgba(0,0,0,0.5)",
        elev: "inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.4)",
        brand: "0 6px 24px -8px rgba(168,85,247,0.55)",
      },
      borderRadius: {
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
export default config;
