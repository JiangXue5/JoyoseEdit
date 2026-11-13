import { readFileSync, readdirSync } from 'node:fs';
import initSqlJs from 'sql.js';
const SQL = await initSqlJs({});
for (const d of readdirSync('tests', { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const p = `tests/${d.name}/SmartP.db`;
  let db;
  try { db = new SQL.Database(new Uint8Array(readFileSync(p))); } catch { continue; }
  const rows = db.exec("SELECT params FROM cloud_config WHERE config_name='booster_config'");
  if (!rows[0]) { db.close(); continue; }
  const params = JSON.parse(rows[0].values[0][0]);
  const cfg = params?.game_booster?.fisr_config;
  const groups = cfg?.enhance_config ?? [];
  const shared = groups.filter((g) => (g.game_list ?? []).length > 1).length;
  console.log(d.name, 'groups', groups.length, 'shared', shared, groups.slice(0,3).map(g=>g.game_list.join('+')));
  db.close();
}
