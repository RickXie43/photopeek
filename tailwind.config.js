/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        mac: {
          bg: '#ececec',
          sidebar: '#f5f5f5',
          text: '#1d1d1f',
          blue: '#007AFF',
          orange: '#FF9500',
          red: '#FF3B30',
          green: '#34C759',
          border: '#d1d1d6',
        }
      }
    },
  },
  plugins: [],
}