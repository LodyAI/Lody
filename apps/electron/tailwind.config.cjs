const preset = require('@lody/configs/tailwind-preset')

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  darkMode: ['class'],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/components/src/**/*.{js,ts,jsx,tsx}'
  ]
}
