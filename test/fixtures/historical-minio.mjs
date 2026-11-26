// Filesystem-backed MinIO double used only by historical API child processes.
import { Client } from 'minio';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
const root = process.env.HISTORICAL_TEST_STORE;
const location = key => path.join(root, key);
Client.prototype.listObjectsV2 = function (_bucket, prefix) {
  return Readable.from(fs.readdirSync(root, { recursive: true }).filter(key =>
    key.startsWith(prefix) && fs.statSync(location(key)).isFile()).map(name => ({ name })));
};
Client.prototype.statObject = async function (_bucket, key) {
  if (!fs.existsSync(location(key))) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' });
  const data = fs.readFileSync(location(key));
  return { size: data.length, etag: createHash('sha256').update(data).digest('hex') };
};
Client.prototype.copyObject = async function (_bucket, key, from) {
  if (typeof _bucket !== 'string') {
    const source = _bucket, destination = key;
    key = destination.Object;
    from = `/${source.Bucket}/${source.Object}`;
    const current = await this.statObject(source.Bucket, source.Object);
    if (source.MatchETag && source.MatchETag !== current.etag) throw new Error('Source ETag changed');
    if (fs.existsSync(path.join(root, 'fail-copy')) && fs.readFileSync(path.join(root, 'fail-copy'), 'utf8') === key) {
      throw new Error('Simulated publication failure');
    }
    fs.mkdirSync(path.dirname(path.join(root, '.metadata', key)), { recursive: true });
    fs.writeFileSync(path.join(root, '.metadata', key), JSON.stringify(destination.Headers));
  }
  fs.mkdirSync(path.dirname(location(key)), { recursive: true });
  fs.copyFileSync(location(from.replace(/^\/[^/]+\//, '')), location(key));
  if (key.endsWith('.json') && fs.existsSync(path.join(root, 'delete-after-copy'))) {
    fs.rmSync(location(fs.readFileSync(path.join(root, 'delete-after-copy'), 'utf8')), { force: true });
  }
};
Client.prototype.fGetObject = async function (_bucket, key, destination) {
  fs.copyFileSync(location(key), destination);
};
Client.prototype.fPutObject = async function (_bucket, key, source) {
  if (fs.existsSync(path.join(root, 'fail-upload')) && key.endsWith('.mp3')) {
    const target = fs.readFileSync(path.join(root, 'fail-upload'), 'utf8').trim();
    if (target === '1' || target === key) throw new Error('Simulated upload failure');
  }
  fs.mkdirSync(path.dirname(location(key)), { recursive: true });
  fs.copyFileSync(source, location(key));
};
Client.prototype.removeObject = async function (_bucket, key) { fs.rmSync(location(key), { force: true }); };
Client.prototype.getObject = async function (_bucket, key) {
  if (!fs.existsSync(location(key))) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' });
  return fs.createReadStream(location(key));
};
Client.prototype.putObject = async function (_bucket, key, stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  fs.writeFileSync(location(key), Buffer.concat(chunks));
};
