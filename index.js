process.stdout.write('[BOOT] index.js: Node ' + process.version + '\n');
process.stdout.write('[BOOT] PORT=' + (process.env.PORT || 'unset') + ' NODE_ENV=' + (process.env.NODE_ENV || 'unset') + '\n');

try {
  require('./src/server.js');
} catch (err) {
  process.stdout.write('[CRASH] ' + err.message + '\n');
  process.stdout.write('[STACK] ' + (err.stack || '') + '\n');
  setTimeout(function () { process.exit(1); }, 5000);
}
