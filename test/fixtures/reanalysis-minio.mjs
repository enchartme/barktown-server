// Loaded only in the re-analysis API test's child processes.
import { Client } from 'minio';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
const keys = ['uncompressed-uploads-archive/a.wav', 'uncompressed-uploads-archive/b.wav'];
Client.prototype.listObjectsV2 = function (_bucket, prefix) {
  return Readable.from(keys.filter(name => name.startsWith(prefix)).map(name => ({ name })));
};
Client.prototype.statObject = async function (_bucket, key) {
  if (!keys.includes(key)) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' });
  return { size: 16 };
};
Client.prototype.fGetObject = async function (_bucket, key, destination) {
  await writeFile(destination, key.endsWith('a.wav') ? 'a' : 'b');
};
