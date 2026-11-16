#!/usr/bin/env node
/*
 * Refit the texting ETA from the ETA log the texting server keeps (predicted vs. real wait for each ride).
 *   node tools/eta-fit.mjs [eta.json | eta.csv]      (default: ~/.local/state/surewalk-texts/eta.json)
 * Model (Texts.gs etaMinutes_): wait ≈ A + B · ahead / √max(rate, 0.1), clamped 5–90 min.
 * Prints the current model's error, a refit A and B (least squares on rides that arrived), and the refit checked on
 * nights it wasn't fitted on (leave one night out), so a new A / B only goes into Texts.gs when it really is better.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'surewalk-texts', 'eta.json');
function load(f) {
  const text = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.json')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map(l => { // simple CSV (quoted cells)
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out;
  });
}
if (!fs.existsSync(file)) { console.error(`No ETA log at ${file} yet (the texting server starts it with the first ride after a restart).`); process.exit(1); }
const rows = load(file);
const head = rows[0] || [], col = name => head.indexOf(name);
const C = { night: col('Night'), ahead: col('Ahead'), rate: col('Arrivals/min (30 min)'), pred: col('Predicted min'), wait: col('Wait min'), out: col('Outcome') };
if (Object.values(C).some(i => i < 0)) { console.error(`${file} doesn't look like the ETA log (header: ${head.join(', ')})`); process.exit(1); }
const data = rows.slice(1).filter(r => r[C.out] === 'arrived' && r[C.wait] !== '' && !isNaN(+r[C.wait]))
  .map(r => ({ night: r[C.night], x: +r[C.ahead] / Math.sqrt(Math.max(+r[C.rate] || 0, 0.1)), y: +r[C.wait], pred: r[C.pred] === '' ? null : +r[C.pred] }));
const nights = [...new Set(data.map(d => d.night))];
console.log(`${file}: ${rows.length - 1} rides logged, ${data.length} with a real wait, ${nights.length} night(s)`);
if (data.length < 20) { console.log('Not enough finished rides yet to refit (need 20+).'); process.exit(0); }

const clamp = m => Math.max(5, Math.min(90, m));
const mae = (ds, f) => ds.reduce((s, d) => s + Math.abs(f(d) - d.y), 0) / ds.length;
function fit(ds) {
  const n = ds.length, mx = ds.reduce((s, d) => s + d.x, 0) / n, my = ds.reduce((s, d) => s + d.y, 0) / n;
  const sxx = ds.reduce((s, d) => s + (d.x - mx) ** 2, 0), sxy = ds.reduce((s, d) => s + (d.x - mx) * (d.y - my), 0);
  const B = sxx ? sxy / sxx : 0;
  return { A: my - B * mx, B };
}
const withPred = data.filter(d => d.pred != null);
if (withPred.length) console.log(`Current model: average error ${mae(withPred, d => d.pred).toFixed(1)} min (${withPred.length} rides)`);
const all = fit(data);
console.log(`Refit on everything: A = ${all.A.toFixed(2)}, B = ${all.B.toFixed(3)} · average error ${mae(data, d => clamp(all.A + all.B * d.x)).toFixed(1)} min (in-sample)`);
if (nights.length >= 2) {
  let err = 0, errOld = 0, n = 0;
  nights.forEach(nt => {
    const test = data.filter(d => d.night === nt), m = fit(data.filter(d => d.night !== nt));
    test.forEach(d => { err += Math.abs(clamp(m.A + m.B * d.x) - d.y); errOld += d.pred == null ? 0 : Math.abs(d.pred - d.y); n++; });
  });
  console.log(`Leave one night out: refit ${(err / n).toFixed(1)} min vs current ${(errOld / n).toFixed(1)} min`);
  console.log(err < errOld ? `→ Better. Put ETA_A = ${all.A.toFixed(1)}, ETA_B = ${all.B.toFixed(3)} in Texts.gs and restart the texting server.` : '→ Keep the current A / B.');
} else console.log('Only one night so far: collect more nights before changing A / B.');
