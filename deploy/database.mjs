import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../lib/db.mjs";

process.umask(0o077);

function check(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`SQLite integrity check failed: ${result}`);
    // A valid but unrelated SQLite file is not a Barktown backup.
    const count = db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('samples', 'diary_entries')").pluck().get();
    if (count !== 2) throw new Error("Missing Barktown tables");
  } finally {
    db.close();
  }
}

const [operation, destination, source] = process.argv.slice(2);
if (operation === "check" && destination && !source) {
  check(destination);
  console.log("Barktown database integrity: OK");
} else {
  if (!["init", "snapshot", "restore"].includes(operation) || !destination ||
      (operation === "init" ? source : !source)) {
    throw new Error("Usage: database.mjs check DB | init TARGET | snapshot TARGET SOURCE | restore TARGET BACKUP");
  }
  for (const filename of [destination, destination + "-wal", destination + "-shm", destination + "-journal"]) {
    if (fs.lstatSync(filename, { throwIfNoEntry: false })) {
      throw new Error(`Refusing to overwrite ${filename}`);
    }
  }

  const work = fs.mkdtempSync(path.join(path.dirname(destination), ".barktown-db-"));
  const candidate = path.join(work, "barktown.db");
  try {
    if (operation === "init") {
      openDb(candidate).close();
    } else if (operation === "snapshot") {
      const db = new Database(source, { readonly: true, fileMustExist: true });
      try {
        db.pragma("busy_timeout = 5000");
        db.prepare("VACUUM INTO ?").run(candidate);
      } finally {
        db.close();
      }
    } else {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (fs.lstatSync(source + suffix, { throwIfNoEntry: false })) {
          throw new Error("Restore requires a standalone SQLite backup; use snapshot for a working DB");
        }
      }
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
    }

    fs.chmodSync(candidate, 0o600);
    check(candidate);
    const fd = fs.openSync(candidate, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // A hard link publishes the verified copy atomically without replacing a file.
    fs.linkSync(candidate, destination);
    const dir = fs.openSync(path.dirname(destination), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    console.log(`SQLite ${operation}: verified and saved ${destination}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
