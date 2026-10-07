#!/usr/bin/env node
/**
 * The VeloTech kit drift guard.
 *
 * VeloExpense VENDORS the shared design system (HANDOFF §1: "shared libs are
 * vendored, not npm deps"): the token sheet, the Tailwind v4 glue and each shadcn
 * component are copies of lib-ui-kit's registry items. A copy can drift silently —
 * VeloLedger and VeloCRM each pasted the 2026 brand on the same day and were ~300
 * lines apart within hours. This compares every vendored file with the published
 * registry item it came from and fails on any difference.
 *
 *   npm run check:ui-kit
 *   UI_KIT_REGISTRY=/path/to/lib-ui-kit/public/r npm run check:ui-kit   (offline)
 *
 * To update: change lib-ui-kit, let it publish, then re-copy (or
 * `npx shadcn add <url>`) here. Never edit a vendored file in place.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = process.env.UI_KIT_REGISTRY ?? 'https://velotechsystems.github.io/lib-ui-kit/r';

/** registry item -> the file in this repo that vendors it. */
const VENDORED = {
  tokens: 'app/velotech-tokens.css',
  'tokens-tailwind-v4': 'app/tailwind-v4.css',
  button: 'components/ui/button.tsx',
  input: 'components/ui/input.tsx',
};

async function item(name) {
  if (!/^https?:/.test(REGISTRY)) return JSON.parse(readFileSync(join(REGISTRY, `${name}.json`), 'utf8'));
  const res = await fetch(`${REGISTRY}/${name}.json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${REGISTRY}/${name}.json answered ${res.status}`);
  return res.json();
}

let failed = 0;
for (const [name, local] of Object.entries(VENDORED)) {
  let kit;
  try {
    kit = await item(name);
  } catch (err) {
    console.error(`check:ui-kit: could not read the kit's "${name}": ${err.message}`);
    failed++;
    continue;
  }
  const content = kit.files?.[0]?.content;
  if (typeof content !== 'string') {
    console.error(`check:ui-kit: the kit's "${name}" has no file content`);
    failed++;
    continue;
  }
  const mine = readFileSync(local, 'utf8');
  if (mine === content) {
    console.log(`  ok    ${local}  (= kit ${name})`);
  } else {
    console.error(`  DRIFT ${local}  differs from the kit's "${name}" — re-copy it from lib-ui-kit; never edit it here`);
    failed++;
  }
}
if (failed > 0) process.exit(1);
console.log('check:ui-kit: every vendored kit file matches the published registry.');
