import type { Config } from "tailwindcss";

// Material 3 (dark) token mapping. Surface hexes mirror the CSS custom
// properties in globals.css but are kept as literal values here so Tailwind
// opacity modifiers (e.g. bg-bg-card/80) keep working.
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
          DEFAULT: "#0c1117", // surface
          card: "#161c25", // surface-container
          elev: "#1f2631", // surface-container-high
          highest: "#29313d", // surface-container-highest
        },
        border: {
          DEFAULT: "rgba(255,255,255,0.09)", // outline-variant
          strong: "rgba(255,255,255,0.16)", // outline
        },
        accent: {
          protein: "#f04444",
          carbs: "#f5a623",
          fat: "#4a90e2",
          cal: "#13c08a",
          brand: "#0ea5e9", // vibrant primary (filled buttons)
          primary: "#6ecff5", // light primary (text/icons/active)
          "sec-container": "#22424f", // secondary-container (tonal)
          "on-sec-container": "#cbe7f5",
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        // M3 dark leans on tonal elevation; shadows stay light.
        card: "0 1px 2px rgba(0,0,0,0.28)",
        elev: "0 2px 6px rgba(0,0,0,0.32)",
        nav: "0 -1px 0 rgba(255,255,255,0.06)",
        brand: "0 8px 28px -10px rgba(14,165,233,0.5)",
      },
      borderRadius: {
        // M3 corner scale
        lg: "12px",
        xl: "16px",
        "2xl": "20px",
        "3xl": "28px",
      },
    },
  },
  plugins: [],
};
export default config;
