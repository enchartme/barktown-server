import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openReadonlyDb, listSettings, updateFilterSettings } from '../lib/db.mjs';

test('filter defaults migrate idempotently and saved bounds persist for readonly readers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barktown-settings-'));
  const file = path.join(dir, 'db.sqlite');
  let db;
  let reader;
  try {
    db = openDb(file);
    assert.equal(listSettings(db).length, 18);
    updateFilterSettings(db, { filter_wind_min: .2, filter_wind_max: .8 });
    db.close();
    db = openDb(file);
    reader = openReadonlyDb(file);
    assert.equal(listSettings(reader).find(row => row.key === 'filter_wind_min').value, .2);
    assert.throws(() => updateFilterSettings(db, { filter_wind_min: .9 }), /minimum/);
    assert.equal(listSettings(reader).find(row => row.key === 'filter_wind_min').value, .2);
    db.exec('DROP TABLE settings');
    assert.equal(listSettings(reader).find(row => row.key === 'filter_wind_min').value, 0);
    db.close();
    db = openDb(file);
    assert.equal(listSettings(db).find(row => row.key === 'filter_wind_max').value, 1);
  } finally {
    reader?.close();
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
