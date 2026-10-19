/** @type {import(tailwindcss).Config} */
export default {
  content: ["./index.html","./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0D0B0A", 900: "#141110", 800: "#1A1512", 700: "#241D19", 600: "#2A211C", 500: "#3A2E27" },
        rust: { DEFAULT: "#C1440E", bright: "#E8613C", muted: "#A8563F" },
        bone: { DEFAULT: "#F5EDE6", dim: "#A89688", faint: "#6B5D54" },
        signal: { pass: "#34C759", slow: "#FFD60A", forbid: "#FF3B30", marker: "#00E5FF", band: "#8D7B6B" }
      },
      fontFamily: {
        sans: ["PingFang SC","Microsoft YaHei","system-ui","sans-serif"],
        mono: ["Consolas","SF Mono","Menlo","monospace"]
      },
      fontSize: { xs: ["11px","16px"], sm: ["12px","18px"], base: ["13px","20px"], lg: ["15px","24px"] }
    }
  },
  plugins: [],
}