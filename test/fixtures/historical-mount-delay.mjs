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
