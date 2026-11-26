// Substitute only MinIO reads inside the projection API test's child processes.
import { Client } from 'minio';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

Client.prototype.getObject = async function (bucket, key) {
  if (bucket !== 'projection-fixture' || key !== 'training-set-projection.csv') {
    throw new Error(`Unexpected MinIO read: ${bucket}/${key}`);
  }
  const file = process.env.PROJECTION_TEST_FILE;
  if (existsSync(`${file}.error`)) {
    const code = readFileSync(`${file}.error`, 'utf8');
    throw Object.assign(new Error('Fixture storage error'), { code });
  }
  try {
    await stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Missing CSV'), { code: 'NoSuchKey' });
    throw error;
  }
  return createReadStream(file, { highWaterMark: 1024 });
};
