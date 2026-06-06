import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectSourceFiles } from './source-select.js';

describe('glob leak test', () => {
  it('should exclude wildcard-matched files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'glob-test-'));
    mkdirSync(path.join(root, 'certs'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), '*.pem\n.env*\ncerts/\n');
    writeFileSync(path.join(root, 'server.pem'), 'PRIVATE KEY');
    writeFileSync(path.join(root, '.env.production'), 'API_SECRET=xyz');
    writeFileSync(path.join(root, '.env'), 'LOCAL_SECRET=abc');
    writeFileSync(path.join(root, 'certs', 'cert.pem'), 'CERT');
    writeFileSync(path.join(root, 'src', 'main.tsx'), 'hello');
    writeFileSync(path.join(root, 'package.json'), '{}');

    const files = selectSourceFiles(root);
    console.log('Files selected:', files);
    
    // These SHOULD be excluded by glob patterns in .gitignore
    const serverPemLeaked = files.includes('server.pem');
    const envProdLeaked = files.includes('.env.production');
    
    rmSync(root, { recursive: true, force: true });
    
    expect(serverPemLeaked).toBe(false); // would fail if glob not handled
    expect(envProdLeaked).toBe(false);   // would fail if glob not handled
  });
});
