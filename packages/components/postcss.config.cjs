const tailwindOptions = { optimize: process.env.NODE_ENV === 'production' };

module.exports = {
  plugins: {
    '@tailwindcss/postcss': tailwindOptions,
  },
};
