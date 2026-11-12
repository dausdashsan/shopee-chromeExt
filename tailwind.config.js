/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./popup.html",
    "./dashboard.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        shopee: {
          primary: '#ee4d2d',
          dark: '#d73211',
          light: '#ff6433',
          orange: '#f53d2d'
        }
      }
    },
  },
  plugins: [],
}
