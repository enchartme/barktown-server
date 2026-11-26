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
    assert.equal(listSettings(db).length, 30);
    updateFilterSettings(db, { filter_wind_min: .2, filter_wind_max: .8 });
    db.prepare("DELETE FROM settings WHERE key LIKE 'filter_delta_%' OR key LIKE 'filter_positive_%' OR key LIKE 'filter_negative_%'").run();
    db.close();
    db = openDb(file);
    reader = openReadonlyDb(file);
    assert.equal(listSettings(reader).length, 30);
    assert.equal(listSettings(reader).find(row => row.key === 'filter_delta_min').value, -1);
    updateFilterSettings(db, { filter_delta_min: -.75, filter_delta_max: .5, filter_positive_min: .6, filter_negative_max: .8 });
    for (const invalid of [{ filter_delta_min: 1.1 }, { filter_delta_min: -1.1 }, { filter_delta_max: -1.1 }, { filter_delta_max: 1.1 }, { filter_positive_max: .5 }, { filter_negative_max: -.1 }]) {
      assert.throws(() => updateFilterSettings(db, invalid));
    }
    assert.equal(listSettings(reader).find(row => row.key === 'filter_delta_min').value, -.75);
    assert.equal(listSettings(reader).find(row => row.key === 'filter_wind_min').value, .2);
    assert.throws(() => updateFilterSettings(db, { filter_wind_min: .9 }), /minimum/);
    assert.equal(listSettings(reader).find(row => row.key === 'filter_wind_min').value, .2);
    updateFilterSettings(db, { filter_delta_min: .25, filter_delta_max: .75 });
    assert.equal(listSettings(reader).find(row => row.key === 'filter_delta_min').value, .25);
    updateFilterSettings(db, { filter_delta_min: -.75, filter_delta_max: -.25 });
    assert.equal(listSettings(reader).find(row => row.key === 'filter_delta_max').value, -.25);
    assert.throws(() => updateFilterSettings(db, { filter_delta_min: 0 }), /minimum/);
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
