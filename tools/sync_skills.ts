import fs from 'fs/promises';
import path from 'path';

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFileSafe(src: string, dest: string): Promise<void> {
  const destDir = path.dirname(dest);
  await ensureDir(destDir);
  await fs.copyFile(src, dest);
}

async function copyDirRecursive(srcDir: string, destDir: string, options: { includeHidden?: boolean } = {}): Promise<void> {
  const includeHidden = options.includeHidden ?? false;
  await ensureDir(destDir);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (!includeHidden && e.name.startsWith('.')) continue;
    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);
    if (e.isDirectory()) {
      await copyDirRecursive(src, dest, options);
    } else if (e.isFile()) {
      await copyFileSafe(src, dest);
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const skillsRoot = path.join(repoRoot, 'skills');
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) throw new Error('HOME directory not resolved');
  const claudeSkillsRoot = path.join(homeDir, '.claude', 'skills');

  // list subdirectories under skills/
  let entries: Array<{ name: string; fullPath: string }>;
  try {
    const dirents = await fs.readdir(skillsRoot, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, fullPath: path.join(skillsRoot, d.name) }));
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      console.error('No skills/ directory found. Nothing to sync.');
      return;
    }
    throw e;
  }

  let syncedCount = 0;
  for (const entry of entries) {
    const srcSkillMd = path.join(entry.fullPath, 'SKILL.md');
    try {
      const stat = await fs.stat(srcSkillMd);
      if (!stat.isFile()) continue;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') continue; // skip if no SKILL.md
      throw e;
    }

    // read name from frontmatter if present; fallback to directory name
    let skillName = entry.name;
    try {
      const content = await fs.readFile(srcSkillMd, 'utf8');
      const m = content.match(/^---[\s\S]*?\bname:\s*([^\n\r]+)[\s\S]*?---/);
      if (m && m[1]) {
        skillName = m[1].trim();
      }
    } catch {
      /* ignore, fallback to dir name */
    }

    const destDir = path.join(claudeSkillsRoot, skillName);
    // Sync entire directory (progressive disclosure assets, scripts, docs)
    await copyDirRecursive(entry.fullPath, destDir);
    const destPath = path.join(destDir, 'SKILL.md');
    console.log(`Synced ${path.relative(repoRoot, entry.fullPath)}/ -> ${destDir} (includes SKILL.md at ${destPath})`);
    syncedCount += 1;
  }

  if (syncedCount === 0) {
    console.log('No SKILL.md files found under skills/.');
  } else {
    console.log(`Done. Synced ${syncedCount} skill(s).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });


