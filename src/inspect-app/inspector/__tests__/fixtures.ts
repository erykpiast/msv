import fs from 'node:fs';
import path from 'node:path';
import type { InvestigationView } from '../../../inspect/types';

export function loadFixture(
  name: 'ready-v5' | 'ready' | 'investigating' | 'degraded-discovery'
): InvestigationView {
  const root = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../../../test/fixtures/inspect',
    name
  );
  return JSON.parse(fs.readFileSync(path.join(root, 'inspect-view.json'), 'utf8')) as InvestigationView;
}
