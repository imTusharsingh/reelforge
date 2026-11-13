export default {
  "*.{js,jsx,ts,tsx,mjs,cjs}": [
    "eslint --fix --max-warnings=0",
    "prettier --write --ignore-unknown",
  ],
  "!(*.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs)": "prettier --write --ignore-unknown",
};
