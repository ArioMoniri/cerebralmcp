/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        cerebral: {
          bg: '#0f1117',
          surface: '#1a1d27',
          card: '#222533',
          border: '#2d3148',
          accent: '#6c5ce7',
          'accent-light': '#a29bfe',
          teal: '#00cec9',
          green: '#00b894',
          orange: '#fdcb6e',
          red: '#ff6b6b',
          text: '#e2e8f0',
          muted: '#8892b0',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
