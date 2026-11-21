/** @type {import('tailwindcss').Config} */
import preset from '@lody/configs/tailwind-preset';

const streamdownContent = [
  '../../packages/components/node_modules/streamdown/dist/**/*.js',
  '../../packages/components/node_modules/@streamdown/*/dist/**/*.js',
  '../../node_modules/.pnpm/streamdown*/node_modules/streamdown/dist/**/*.js',
  '../../node_modules/.pnpm/@streamdown+*/node_modules/@streamdown/*/dist/**/*.js',
];

export default {
  presets: [preset],
  darkMode: ['class'],
  content: [
    './src/index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/components/src/**/*.{js,ts,jsx,tsx}',
    ...streamdownContent,
  ],
};
