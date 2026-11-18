'use strict';
/** Ask for a password without echoing it (works in Windows PowerShell and Unix terminals). Never logged. */
module.exports = function hiddenPrompt(question) {
  return new Promise(function (resolve) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) { if (s.indexOf(question) === 0) rl.output.write(question); };
    rl.question(question, function (a) { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
};
