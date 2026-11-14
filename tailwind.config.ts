import type { Config } from "tailwindcss";

// Every color is a theme token: an "R G B" channel triple defined per theme
// in globals.css (light = Fresh, dark = Sunset), wrapped here so Tailwind
// opacity modifiers (e.g. bg-bg-card/80, text-ink/60) keep working.
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: token("bg"), // page surface
          card: token("card"), // surface-container
          elev: token("elev"), // surface-container-high (inputs, chips)
          highest: token("highest"),
        },
        // Hairlines are ink at low alpha, so they read on either surface.
        border: {
          DEFAULT: "rgb(var(--c-ink) / 0.09)",
          strong: "rgb(var(--c-ink) / 0.16)",
        },
        ink: token("ink"), // body text and on-surface tints
        "on-brand": token("on-brand"), // text/icons on brand fills and gradients
        ok: token("ok"),
        warn: token("warn"),
        bad: token("bad"),
        accent: {
          protein: token("protein"),
          carbs: token("carbs"),
          fat: token("fat"),
          cal: token("cal"),
          brand: token("brand"), // filled buttons
          primary: token("primary"), // accent text/icons/active
          "sec-container": token("sec"), // tonal buttons, chips
          "on-sec-container": token("on-sec"),
        },
      },
      fontFamily: {
        sans: ["var(--font-app)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Arial", "sans-serif"],
      },
      boxShadow: {
        card: "var(--shadow-card)",
        elev: "var(--shadow-elev)",
        nav: "0 -1px 0 rgb(var(--c-ink) / 0.06)",
        brand: "var(--glow-brand)",
      },
      borderRadius: {
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
