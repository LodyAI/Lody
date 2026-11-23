import preset from '@lody/configs/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/components/src/**/*.{js,ts,jsx,tsx}',
  ],
};
