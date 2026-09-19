// after-pack-unified.cjs

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置常量
// ============================================================

const SKIP_ON_BUSY = process.env.DSH_SKIP_BUSY !== '0';

const SKIP_DIRS = new Set([
  '.git',
  '.github',
  '.agents',
  '.artifacts',
  '.cache',
  '.sessions',
  '.storages',
  '.turbo',
  '.vite',
  '.vite-temp',
  '.worktrees',
  '__pycache__',
  'coverage',
  'docs',
  'examples',
  'python',
  'website',
  'worktrees',
]);

const DEV_ONLY_NAMES = new Set([
  'typescript',
  'tsx',
  'ts-node',
  'vite',
  'vitest',
  '@vitest',
  'eslint',
  '@eslint',
  '@typescript-eslint',
  'turbo',
  'rollup',
  'webpack',
  'jest',
  '@jest',
  'playwright',
  '@playwright',
  'storybook',
  '@storybook',
  'prettier',
  'knip',
  'oxlint',
  'typedoc',
  'eslint-plugin',
  'babel',
  '@babel',
  'swc',
  '@swc',
  'nx',
  'husky',
  'lint-staged',
]);

// ============================================================
// 公共工具函数
// ============================================================

function longPath(target) {
  const abs = path.resolve(target);
  if (process.platform !== 'win32' || abs.length < 240) {
    return abs;
  }
  if (abs.startsWith('\\\\?\\')) {
    return abs;
  }
  if (abs.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${abs.slice(2)}`;
  }
  return `\\\\?\\${abs}`;
}

function isDevOnlyPnpmEntry(name) {
  const parts = name.split('+');
  const scope = parts.length > 1 ? parts[0] : null;
  const base = parts[parts.length - 1].split('@')[0];
  if (scope && scope.startsWith('@types')) {
    return true;
  }
  if (DEV_ONLY_NAMES.has(base) || (scope && DEV_ONLY_NAMES.has(scope))) {
    return true;
  }
  return false;
}

function shouldSkip(src, root, expandNested = false, skipStore = false) {
  const rel = path.relative(root, src);
  if (!rel || rel.startsWith('..')) {
    return false;
  }
  const parts = rel.split(path.sep);
  let nodeModulesSeen = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (SKIP_DIRS.has(part)) {
      return true;
    }
    if (skipStore && part === '.pnpm') {
      return true;
    }
    if (part === 'node_modules') {
      nodeModulesSeen += 1;
      if (nodeModulesSeen >= 3 && !expandNested) {
        return true;
      }
      if (i + 1 < parts.length && isDevOnlyPnpmEntry(parts[i + 1])) {
        return true;
      }
    }
    if ((part === 'src' || part === 'tests' || part === '__tests__') && /^(packages|apps)(\\|\/)/.test(parts.slice(0, i).join(path.sep))) {
      return true;
    }
  }
  return false;
}

function realOf(target) {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

// ============================================================
// v1 收集器：全局 visited 去重（激进）
// ============================================================

function collectFilesV1(root, destRoot, expandNested = false, flat = false) {
  console.log(`  正在扫描: ${path.basename(root)} (v1 模式: 全局去重)...`);
  const startTime = Date.now();
  const files = [];
  const pathStack = new Set();                    // 调用栈（用 src 路径）
  const processedSymlinkTargets = new Set();      // ✅ 只对符号链接的目标去重
  const topNodeModules = path.join(path.resolve(destRoot), 'node_modules');
  let fileCount = 0;
  let skippedByStack = 0;
  let skippedBySymlink = 0;
  let skippedByDepth = 0;

  function getInodeKey(filepath) {
    try {
      const stat = fs.statSync(filepath);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  function walk(src, dest, depth = 0) {
    const MAX_DEPTH = 100;
    if (depth > MAX_DEPTH) {
      skippedByDepth++;
      return;
    }

    if (shouldSkip(src, root, expandNested)) {
      return;
    }
    if (flat && src.endsWith(`${path.sep}node_modules`) && dest !== topNodeModules) {
      dest = topNodeModules;
    }

    let lstat;
    try {
      lstat = fs.lstatSync(src);
    } catch {
      return;
    }

    // ✅ 符号链接：复制内容，但用全局去重防止循环
    if (lstat.isSymbolicLink()) {
      const real = realOf(src);
      const inodeKey = getInodeKey(real);

      // ✅ 只对符号链接做全局去重（防止 A→B→A 循环）
      if (processedSymlinkTargets.has(inodeKey)) {
        skippedBySymlink++;
        return;
      }
      processedSymlinkTargets.add(inodeKey);

      let realStat;
      try {
        realStat = fs.statSync(real);
      } catch {
        return;
      }

      // 符号链接指向文件：复制文件
      if (realStat.isFile()) {
        files.push({ src: real, dest });
        fileCount++;
        if (fileCount % 5000 === 0) {
          process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
        }
        return;
      }

      // 符号链接指向目录：复制目录内容
      if (realStat.isDirectory()) {
        // 标记为已处理，然后遍历真实目录
        pathStack.add(real);
        const names = fs.readdirSync(real);
        for (const name of names) {
          const childSrc = path.join(real, name);
          const childDest = path.join(dest, name);
          // ✅ 递归调用，但此时 childSrc 是真实路径
          // 需要重新检查是否为符号链接
          walk(childSrc, childDest, depth + 1);
        }
        pathStack.delete(real);
        return;
      }
      return;
    }

    // 普通目录
    if (lstat.isDirectory()) {
      if (pathStack.has(src)) {
        skippedByStack++;
        return;
      }
      pathStack.add(src);

      let names;
      try {
        names = fs.readdirSync(src);
      } catch {
        pathStack.delete(src);
        return;
      }

      for (const name of names) {
        walk(path.join(src, name), path.join(dest, name), depth + 1);
      }

      pathStack.delete(src);
      return;
    }

    // 普通文件
    if (lstat.isFile()) {
      const base = path.basename(src);
      if (/\.(map|tsbuildinfo|md|d\.ts)$/i.test(base)) {
        return;
      }
      if (/^(license|licence|changelog|changes|authors|contributing)(\.|$)/i.test(base)) {
        return;
      }
      // ✅ 文件不做任何去重！每个硬链接都保留
      files.push({ src, dest });
      fileCount++;
      if (fileCount % 5000 === 0) {
        process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
      }
    }
  }

  walk(path.resolve(root), path.resolve(destRoot));
  console.log(`\r  收集完成: ${files.length} 个文件，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  if (skippedByStack || skippedBySymlink || skippedByDepth) {
    console.log(`  ℹ️ 调用栈跳过: ${skippedByStack}, 符号链接去重: ${skippedBySymlink}, 深度限制: ${skippedByDepth}`);
  }
  return files;
}

// ============================================================
// v2 收集器：调用栈检测（真实路径），最安全
// ============================================================

function collectFilesV2(root, destRoot, expandNested = false, flat = false) {
  console.log(`  正在扫描: ${path.basename(root)} (v2 模式: 调用栈-真实路径,可能耗时较长，请耐心等待)...`);
  const startTime = Date.now();
  const files = [];
  const pathStack = new Set();  // 改用路径栈，而不是全局 visited
  const topNodeModules = path.join(path.resolve(destRoot), 'node_modules');
  let fileCount = 0;
  let lastLogTime = Date.now();

  function walk(src, dest) {
    if (shouldSkip(src, root, expandNested)) {
      return;
    }
    if (flat && src.endsWith(`${path.sep}node_modules`) && dest !== topNodeModules) {
      dest = topNodeModules;
    }
    
    let lstat;
    try {
      lstat = fs.lstatSync(src);
    } catch {
      return;
    }

    if (lstat.isSymbolicLink() || lstat.isDirectory()) {
      const real = realOf(src);
      
      // ✅ 使用路径检测循环（仅在当前调用栈中）
      if (pathStack.has(real)) {
        return;  // 检测到循环
      }
      
      let realStat;
      try {
        realStat = fs.statSync(real);
      } catch {
        return;
      }
      
      if (realStat.isFile()) {
        files.push({ src: real, dest });
        fileCount++;
        if (fileCount % 5000 === 0) {
          process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
        }
        return;
      }
      
      // ✅ 添加到路径栈
      pathStack.add(real);
      
      let names;
      try {
        names = fs.readdirSync(src);
      } catch {
        pathStack.delete(real);
        return;
      }
      
      for (const name of names) {
        walk(path.join(src, name), path.join(dest, name));
      }
      
      // ✅ 离开当前目录时从栈中移除
      pathStack.delete(real);
      return;
    }

    if (lstat.isFile()) {
      const base = path.basename(src);
      if (/\.(map|tsbuildinfo|md|d\.ts)$/i.test(base)) {
        return;
      }
      if (/^(license|licence|changelog|changes|authors|contributing)(\.|$)/i.test(base)) {
        return;
      }
      files.push({ src, dest });
      fileCount++;
      if (fileCount % 5000 === 0) {
        process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
      }
    }
  }

  walk(path.resolve(root), path.resolve(destRoot));
  console.log(`\r  收集完成: ${files.length} 个文件，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return files;
}

// ============================================================
// v3 收集器：调用栈检测（src 路径）+ 符号链接目录去重
// ============================================================

function collectFilesV3(root, destRoot, expandNested = false, flat = false) {
  console.log(`  正在扫描: ${path.basename(root)} (v3 模式: 调用栈+符号链接去重)...`);
  const startTime = Date.now();
  const files = [];
  const pathStack = new Set();
  const processedSymlinkDirs = new Set();
  const topNodeModules = path.join(path.resolve(destRoot), 'node_modules');
  let fileCount = 0;
  let skippedByStack = 0;
  let skippedBySymlink = 0;
  let skippedByDepth = 0;

  function getInodeKey(filepath) {
    try {
      const stat = fs.statSync(filepath);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  function walk(src, dest, depth = 0) {
    const MAX_DEPTH = 100;
    if (depth > MAX_DEPTH) {
      skippedByDepth++;
      return;
    }

    if (shouldSkip(src, root, expandNested)) {
      return;
    }
    if (flat && src.endsWith(`${path.sep}node_modules`) && dest !== topNodeModules) {
      dest = topNodeModules;
    }

    let lstat;
    try {
      lstat = fs.lstatSync(src);
    } catch {
      return;
    }

    if (lstat.isSymbolicLink() || lstat.isDirectory()) {
      const real = realOf(src);
      const inodeKey = getInodeKey(real);

      // 调用栈检测
      if (pathStack.has(src)) {
        skippedByStack++;
        return;
      }

      let realStat;
      try {
        realStat = fs.statSync(real);
      } catch {
        return;
      }

      // ✅ 先检查文件：符号链接指向的文件直接复制
      if (realStat.isFile()) {
        files.push({ src: real, dest });
        fileCount++;
        if (fileCount % 5000 === 0) {
          process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
        }
        return;
      }

      // ✅ 只有目录才做符号链接去重
      if (lstat.isSymbolicLink()) {
        if (processedSymlinkDirs.has(inodeKey)) {
          skippedBySymlink++;
          return;
        }
        processedSymlinkDirs.add(inodeKey);
      }

      pathStack.add(src);

      let names;
      try {
        names = fs.readdirSync(src);
      } catch {
        pathStack.delete(src);
        return;
      }

      for (const name of names) {
        walk(path.join(src, name), path.join(dest, name), depth + 1);
      }

      pathStack.delete(src);
      return;
    }

    if (lstat.isFile()) {
      const base = path.basename(src);
      if (/\.(map|tsbuildinfo|md|d\.ts)$/i.test(base)) {
        return;
      }
      if (/^(license|licence|changelog|changes|authors|contributing)(\.|$)/i.test(base)) {
        return;
      }
      files.push({ src, dest });
      fileCount++;
      if (fileCount % 5000 === 0) {
        process.stdout.write(`\r  已收集 ${fileCount} 个文件...`);
      }
    }
  }

  walk(path.resolve(root), path.resolve(destRoot));
  console.log(`\r  收集完成: ${files.length} 个文件，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  if (skippedByStack || skippedBySymlink || skippedByDepth) {
    console.log(`  ℹ️ 调用栈跳过: ${skippedByStack}, 符号链接目录去重: ${skippedBySymlink}, 深度限制: ${skippedByDepth}`);
  }
  return files;
}

// ============================================================
// 统一调用函数（新增）
// ============================================================

/**
 * 统一文件收集入口
 * @param {string} root - 源目录
 * @param {string} destRoot - 目标目录
 * @param {Object} opts
 * @param {string} opts.mode - 'v1' | 'v2' | 'v3' | 'safe'
 * @param {boolean} opts.expandNested - 是否展开嵌套 node_modules
 * @param {boolean} opts.flat - 是否拍平 node_modules 到顶层
 * @returns {Array} 文件列表
 */
function collectFiles(root, destRoot, opts = {}) {
  const {
    mode = 'v3',
    expandNested = false,
    flat = false,
  } = opts;

  switch (mode) {
    case 'v1':
      return collectFilesV1(root, destRoot, expandNested, flat);
    case 'v2':
      return collectFilesV2(root, destRoot, expandNested, flat);
    case 'v3':
      return collectFilesV3(root, destRoot, expandNested, flat);
    case 'safe':
      // safe 模式：使用 v2 逻辑，但只检测循环不去重（v2 已经是这样）
      return collectFilesV2(root, destRoot, expandNested, flat);
    default:
      throw new Error(`未知模式: ${mode}，可选: v1, v2, v3, safe`);
  }
}

// ============================================================
// 复制函数
// ============================================================

async function copyFiles(files, limit = 16, skipOnBusy = true) {
  const total = files.length;
  let completed = 0;
  let retried = 0;
  let skipped = 0;
  const failedFiles = [];

  const progressInterval = setInterval(() => {
    if (completed > 0 && completed < total) {
      const pct = total > 0 ? (completed / total * 100).toFixed(1) : 0;
      process.stdout.write(`\r复制进度: ${completed}/${total} (${pct}%)`);
    }
  }, 1000);

  let idx = 0;
  const getNext = () => {
    if (idx >= files.length) return null;
    return files[idx++];
  };

  const worker = async () => {
    while (true) {
      const item = getNext();
      if (!item) break;
      const destDir = path.dirname(item.dest);
      fs.mkdirSync(longPath(destDir), { recursive: true });

      let success = false;
      let lastError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await fs.promises.copyFile(longPath(item.src), longPath(item.dest));
          success = true;
          completed++;
          if (completed % 100 === 0 || completed === total) {
            const pct = total > 0 ? (completed / total * 100).toFixed(1) : 0;
            process.stdout.write(`\r复制进度: ${completed}/${total} (${pct}%)`);
          }
          break;
        } catch (error) {
          lastError = error;
          if (error.code === 'EBUSY' && attempt < 5) {
            retried++;
            const delay = 2000 * (attempt + 1);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          if (skipOnBusy && error.code === 'EBUSY') {
            process.stdout.write(`\n  ⏭️ 跳过被占用文件: ${path.basename(item.src)}`);
            skipped++;
            failedFiles.push({ ...item, error });
            success = true;
            break;
          }
          failedFiles.push({ ...item, error });
          success = false;
          break;
        }
      }
      if (!success && lastError) {
        process.stdout.write(`\n  ❌ 复制失败: ${path.basename(item.src)} - ${lastError.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));

  clearInterval(progressInterval);
  process.stdout.write('\n');
  console.log(`复制完成: ${completed} 个文件`);
  if (retried) console.log(`  （EBUSY 重试 ${retried} 次）`);
  if (skipped) console.warn(`  （跳过 ${skipped} 个因 EBUSY 无法复制的文件）`);
  return { copied: completed, skipped, failedFiles };
}

async function retryFailedFiles(failedFiles, maxAttempts = 3) {
  if (failedFiles.length === 0) return 0;
  console.log(`\n🔄 尝试重新复制 ${failedFiles.length} 个失败文件（串行，最多 ${maxAttempts} 次）...`);
  let successCount = 0;
  let current = 0;
  for (const item of failedFiles) {
    current++;
    process.stdout.write(`\r  重试 ${current}/${failedFiles.length}: ${path.basename(item.src)}`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fs.copyFileSync(longPath(item.src), longPath(item.dest));
        successCount++;
        break;
      } catch (e) {
        if (attempt === maxAttempts - 1) {
          process.stdout.write(`\n  ❌ 重试失败: ${path.basename(item.src)} - ${e.message}`);
        } else {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
  }
  console.log(`\n✅ 重试成功 ${successCount} 个文件`);
  return successCount;
}

// ============================================================
// assembleFromDeploy（使用统一函数）
// ============================================================

async function assembleFromDeploy(projectDir, deployDir, destBase, mode = 'v3') {
  let total = 0, skippedTotal = 0, allFailed = [];

  const processDir = async (src, dest, expandNested = false, label = '') => {
    const files = collectFiles(src, dest, { mode, expandNested });
    if (files.length === 0) {
      console.log(`  ⚠️ ${label || path.basename(src)}: 无文件可复制`);
      return;
    }
    console.log(`  📦 开始复制 ${label || path.basename(src)} (${files.length} 个文件)`);
    const result = await copyFiles(files, 16, SKIP_ON_BUSY);
    total += result.copied;
    skippedTotal += result.skipped;
    allFailed.push(...result.failedFiles);
  };

  console.log('\n📁 复制 deploy 根内容...');
  for (const n of fs.readdirSync(deployDir, { withFileTypes: true })) {
    if (!n.isDirectory() || (n.name !== 'apps' && n.name !== 'node_modules')) {
      continue;
    }
    const srcPath = path.join(deployDir, n.name);
    const destPath = path.join(destBase, n.name);
    await processDir(srcPath, destPath, true, n.name);
  }

  if (allFailed.length > 0) {
    const retrySuccess = await retryFailedFiles(allFailed);
    total += retrySuccess;
    const finalSkipped = allFailed.length - retrySuccess;
    skippedTotal = finalSkipped;
    if (finalSkipped > 0) {
      console.warn(`\n⚠️ 最终跳过 ${finalSkipped} 个文件（EBUSY）`);
    }
  }

  return total;
}

// ============================================================
// 打包辅助函数
// ============================================================

function copyBundledNode(destDir) {
  const src = [
    process.env.NODE_BINARY,
    process.execPath,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ].find((candidate) => candidate && fs.existsSync(candidate) && !/electron/i.test(candidate));
  if (!src) {
    throw new Error('打包时未找到 node.exe，安装包将无法启动官方 Web UI');
  }
  const dest = path.join(destDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(src, dest);
  return dest;
}

function copyBundledPnpm(projectDir, destDir) {
  const candidates = [];

  candidates.push(path.join(projectDir, 'node_modules', 'pnpm'));
  candidates.push(
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'node_modules', 'pnpm'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'pnpm')
  );
  if (process.env.PNPM_HOME) {
    candidates.push(path.join(process.env.PNPM_HOME, 'node_modules', 'pnpm'));
  }

  const corepackBase = path.join(process.env.LOCALAPPDATA || '', 'node', 'corepack', 'v1', 'pnpm');
  if (fs.existsSync(corepackBase)) {
    try {
      const dirs = fs.readdirSync(corepackBase, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const fullPath = path.join(corepackBase, d.name);
          if (fs.existsSync(path.join(fullPath, 'bin', 'pnpm.cjs'))) {
            candidates.push(fullPath);
          }
        }
      }
    } catch (_) { /* ignore */ }
  }

  try {
    let pnpmCmd = '';
    if (process.platform === 'win32') {
      pnpmCmd = execFileSync('where', ['pnpm'], { encoding: 'utf8' }).split('\n')[0]?.trim() || '';
    } else {
      pnpmCmd = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();
    }
    if (pnpmCmd) {
      const realPnpm = fs.realpathSync(pnpmCmd);
      const binDir = path.dirname(realPnpm);
      let testDir = binDir;
      for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(testDir, 'bin', 'pnpm.cjs'))) {
          candidates.unshift(testDir);
          break;
        }
        const parent = path.dirname(testDir);
        if (parent === testDir) break;
        testDir = parent;
      }
    }
  } catch (_) { /* ignore */ }

  const uniqueCandidates = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c && !seen.has(c)) {
      seen.add(c);
      uniqueCandidates.push(c);
    }
  }

  let src = null;
  for (const c of uniqueCandidates) {
    if (fs.existsSync(path.join(c, 'bin', 'pnpm.cjs'))) {
      src = c;
      break;
    }
  }

  if (!src) {
    console.warn('⚠️ 未找到 pnpm（需要包含 bin/pnpm.cjs），安装包将不包含 pnpm。');
    console.warn('搜索路径: ' + uniqueCandidates.join(', '));
    return null;
  }

  const dest = path.join(destDir, 'pnpm');
  console.log(`📦 复制 pnpm 从 ${src} 到 ${dest}`);
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  return dest;
}

// ============================================================
// afterPack 主入口（完全保持原样）
// ============================================================

module.exports = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const resources = path.join(context.appOutDir, 'resources');
  const deployEnv = process.env.DSH_DEPLOY_DIR;
  const deployDir = deployEnv && deployEnv !== 'off'
    ? deployEnv
    : (!deployEnv
      ? [path.join(projectDir, '.pack-v3'), path.join(projectDir, '.pack-tmp')]
        .find((d) => fs.existsSync(path.join(d,  'apps', 'cli','lib', 'bin.js')))
      : null);
  const started = Date.now();

  const harnessDest = path.join(resources, 'vendor', 'deepseek-harness');
  if (fs.existsSync(harnessDest)) {
    console.log(`🧹 清理已存在的 ${harnessDest}`);
    fs.rmSync(harnessDest, { recursive: true, force: true });
  }

  let copied = 0;
  if (deployDir) {
    console.log(`\n🚀 使用精简目录 ${deployDir} 组装运行时到 ${harnessDest}`);
    copied = await assembleFromDeploy(projectDir, deployDir, harnessDest);
  } else {
    console.log('未找到精简目录，回退全量复制（拍平 .pnpm 到顶层，避免超长路径）');
    const harnessSrc = path.join(projectDir, 'vendor', 'deepseek-harness');
    console.log('📂 收集文件清单（解引用 pnpm 链接，跳过循环与 dev-only 包）...');
    const files = collectFilesV2(harnessSrc, harnessDest, false, true);
    console.log(`📦 开始复制 ${files.length} 个文件...`);
    const result = await copyFiles(files, 16, SKIP_ON_BUSY);
    copied = result.copied;
    if (result.failedFiles.length > 0) {
      const retrySuccess = await retryFailedFiles(result.failedFiles);
      copied += retrySuccess;
      const finalSkipped = result.failedFiles.length - retrySuccess;
      if (finalSkipped > 0) {
        console.warn(`⚠️ 最终跳过 ${finalSkipped} 个文件（EBUSY）`);
      }
    }
  }

  const binJs = path.join(harnessDest, 'apps', 'cli', 'lib', 'bin.js');
  const webDist = path.join(harnessDest, 'apps', 'web', 'dist', 'index.html');
  if (!fs.existsSync(binJs) || !fs.existsSync(webDist)) {
    throw new Error('安装包缺少 dsh 构建产物，请先在 vendor/deepseek-harness 跑 pnpm run build');
  }

  const nodeDest = copyBundledNode(resources);
  const pnpmDest = copyBundledPnpm(projectDir, resources);
  if (pnpmDest) {
    console.log(`✅ pnpm 已复制到 ${pnpmDest}`);
  } else {
    console.log('⚠️ pnpm 未复制，安装包可能无法使用 pnpm 功能');
  }

  console.log(`\n✅ 成功复制 ${copied} 个文件到 ${harnessDest}`);
  console.log(`✅ node.exe 写入 ${nodeDest}`);
  console.log(`⏱️ 总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
};

// ============================================================
// 导出所有 API
// ============================================================

module.exports.collectFiles = collectFiles;
module.exports.collectFilesV1 = collectFilesV1;
module.exports.collectFilesV2 = collectFilesV2;
module.exports.collectFilesV3 = collectFilesV3;
module.exports.copyFiles = copyFiles;
module.exports.retryFailedFiles = retryFailedFiles;
module.exports.assembleFromDeploy = assembleFromDeploy;
module.exports.copyBundledNode = copyBundledNode;
module.exports.copyBundledPnpm = copyBundledPnpm;