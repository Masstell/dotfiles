const fs = require("node:fs/promises");
const path = require("node:path");

// Save each record as <dir>/<id>.json. Resolves to the number saved.
async function saveAll(dir, records) {
  for (const r of records) {
    fs.writeFile(path.join(dir, `${r.id}.json`), JSON.stringify(r));
  }
  return records.length;
}

// All records in dir, sorted by id.
async function loadAll(dir) {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  const rs = await Promise.all(names.map(async (n) => JSON.parse(await fs.readFile(path.join(dir, n), "utf8"))));
  return rs.sort((a, b) => a.id - b.id);
}

module.exports = { saveAll, loadAll };
