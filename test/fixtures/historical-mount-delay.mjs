// Used only by worker child processes: the mounted directory cache has not
// exposed any of the server's freshly archived originals yet.
import fs from 'node:fs/promises';
import path from 'node:path';
const stat = fs.stat;
const archive = path.join(process.env.HISTORICAL_TEST_STORE, 'historical-recordings-archive') + path.sep;
fs.stat = async function (file, ...args) {
  if (String(file).startsWith(archive)) throw Object.assign(new Error('Mount cache has not refreshed'), { code: 'ENOENT', path: file });
  return stat.call(this, file, ...args);
};

// The same mount can briefly deny a staging write before accepting a retry.
const copyFile = fs.copyFile;
const staging = path.join(process.env.HISTORICAL_TEST_STORE, 'historical-import-staging') + path.sep;
let denied = false;
fs.copyFile = async function (source, destination, ...args) {
  if (!denied && String(destination).startsWith(staging)) {
    denied = true;
    throw Object.assign(new Error('Transient mount permission failure'), {
      code: 'EACCES', syscall: 'copyfile', path: source, dest: destination,
    });
  }
  return copyFile.call(this, source, destination, ...args);
};
