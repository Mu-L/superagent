const path = require('node:path');

const remarkIgnoredFiles = new Set(['CONTRIBUTING.md', 'HISTORY.md']);
const shouldLintMarkdown = (filename) =>
  !filename.includes(`${path.sep}docs${path.sep}`) &&
  !remarkIgnoredFiles.has(path.basename(filename));

module.exports = {
  '*.md': (filenames) =>
    filenames
      .filter(shouldLintMarkdown)
      .map((filename) => `remark ${filename} -qfo`),
  '{src,test}/**/*.js': 'eslint -c .eslintrc --fix'
};
