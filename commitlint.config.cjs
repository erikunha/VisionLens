/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The subject of a commit is read in a terminal and in a log: a
    // subject longer than 72 characters is cut in both. The cap is a rule
    // of the repository, so it is enforced by the gate and not only by the
    // habit of the author.
    'header-max-length': [2, 'always', 72],
  },
};
