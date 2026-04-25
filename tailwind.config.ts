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
          DEFAULT: "#0a0a0b",
          card: "#141416",
          elev: "#1c1c20",
        },
        border: {
          DEFAULT: "#26262b",
        },
        accent: {
          protein: "#ef4444",
          carbs: "#f59e0b",
          fat: "#3b82f6",
          cal: "#10b981",
          brand: "#a855f7",
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
