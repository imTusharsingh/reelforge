const format = "oxfmt --no-error-on-unmatched-pattern --write";

export default {
  "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": ["oxlint --fix --deny-warnings", format],
  "!(*.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.mts|*.cts)": format,
};
