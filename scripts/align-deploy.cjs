// deploy.cjs - 统一部署脚本
// 用法:
//   独立部署模式: node scripts/deploy.cjs [--deploy-dir <path>] [--verbose]
//   打包后处理模式: node scripts/deploy.cjs --after-pack <appOutDir> [--verbose]
//
//   或通过环境变量:
//   DSH_DEPLOY_DIR=<path> node scripts/deploy.cjs --after-pack <appOutDir>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================
// 配置
// ============================================================
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const AFTER_PACK = process.argv.includes('--after-pack');

// 获取 after-pack 的目标目录
let afterPackOutDir = null;
const afterPackIndex = process.argv.indexOf('--after-pack');
if (afterPackIndex !== -1 && process.argv[afterPackIndex + 1]) {
  afterPackOutDir = process.argv[afterPackIndex + 1];
}

// 部署目录优先级: 命令行参数 > 环境变量 > 默认值
let deployDir = '.pack-v3';
const deployArgIndex = process.argv.indexOf('--deploy-dir');
if (deployArgIndex !== -1 && process.argv[deployArgIndex + 1]) {
  deployDir = process.argv[deployArgIndex + 1];
} else if (process.env.DSH_DEPLOY_DIR) {
  deployDir = process.env.DSH_DEPLOY_DIR;
}
const DEPLOY_DIR = path.resolve(deployDir);

const PROJECT_DIR = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(PROJECT_DIR, 'vendor', 'deepseek-harness');

// ============================================================
// 日志工具
// ============================================================
const logger = {
  info: (msg) => console.log(`📌 ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  debug: (msg) => VERBOSE && console.log(`🔍 ${msg}`),
  section: (title) => console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`),
};

// ============================================================
// 核心部署函数（从 after-pack.cjs 移植）
// ============================================================

const SKIP_DIRS = new Set([
  '.git', '.github', '.agents', '.artifacts', '.cache', '.sessions',
  '.storages', '.turbo', '.vite', '.vite-temp', '.worktrees',
  '__pycache__', 'coverage', 'docs', 'examples', 'python', 'website',
  'worktrees',
]);

const DEV_ONLY_NAMES = new Set([
  'typescript', 'tsx', 'ts-node', 'vite', 'vitest', '@vitest',
  'eslint', '@eslint', '@typescript-eslint', 'turbo', 'rollup',
  'webpack', 'jest', '@jest', 'playwright', '@playwright',
  'storybook', '@storybook', 'prettier', 'knip', 'oxlint',
  'typedoc', 'eslint-plugin', 'babel', '@babel', 'swc', '@swc',
  'nx', 'husky', 'lint-staged',
]);

function realOf(target) {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

function isDevOnlyPnpmEntry(name) {
  const parts = name.split('+');
  const scope = parts.length > 1 ? parts[0] : null;
  const base = parts[parts.length - 1].split('@')[0];
  if (scope && scope.startsWith('@types')) return true;
  if (DEV_ONLY_NAMES.has(base) || (scope && DEV_ONLY_NAMES.has(scope))) return true;
  return false;
}

function shouldSkip(src, root, expandNested = false) {
  const rel = path.relative(root, src);
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split(path.sep);
  let nodeModulesSeen = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (SKIP_DIRS.has(part)) return true;
    if (part === 'node_modules') {
      nodeModulesSeen += 1;
      if (nodeModulesSeen >= 3 && !expandNested) return true;
      if (i + 1 < parts.length && isDevOnlyPnpmEntry(parts[i + 1])) return true;
    }
    if ((part === 'src' || part === 'tests' || part === '__tests__') && /^(packages|apps)(\\|\/)/.test(parts.slice(0, i).join(path.sep))) {
      return true;
    }
  }
  return false;
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

async function copyFiles(files, limit = 16) {
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
      fs.mkdirSync(destDir, { recursive: true });

      let success = false;
      let lastError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await fs.promises.copyFile(item.src, item.dest);
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
          if (error.code === 'EBUSY') {
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
  console.log(`\n🔄 尝试重新复制 ${failedFiles.length} 个失败文件...`);
  let successCount = 0;
  let current = 0;
  for (const item of failedFiles) {
    current++;
    process.stdout.write(`\r  重试 ${current}/${failedFiles.length}: ${path.basename(item.src)}`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const destDir = path.dirname(item.dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(item.src, item.dest);
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
// 部署函数
// ============================================================
async function deploy(srcRoot, destRoot, options = {}) {
  const { flat = true, expandNested = false } = options;

  if (!fs.existsSync(srcRoot)) {
    throw new Error(`源目录不存在: ${srcRoot}`);
  }

  if (fs.existsSync(destRoot)) {
    console.log(`🧹 清理已存在的 ${destRoot}`);
    fs.rmSync(destRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(destRoot, { recursive: true });

  console.log('\n📂 收集文件清单...');
  const files = collectFiles(srcRoot, destRoot, {mode: 'v2',expandNested, flat});

  if (files.length === 0) {
    throw new Error('未收集到任何文件');
  }

  console.log(`\n📦 开始复制 ${files.length} 个文件...`);
  const result = await copyFiles(files, 16);

  if (result.failedFiles.length > 0) {
    const retrySuccess = await retryFailedFiles(result.failedFiles);
    result.copied += retrySuccess;
  }

  console.log(`\n✅ 复制完成: ${result.copied} 个文件`);
  return result.copied;
}

// ============================================================
// 验证部署
// ============================================================
function verifyDeployment(destRoot) {
  console.log('\n🔍 验证部署...');

  const checks = [
    { path: path.join(destRoot, 'apps', 'cli','lib', 'bin.js'), name: 'CLI 核心文件' },
    { path: path.join(destRoot, 'vendor'), name: 'vendor 目录' },
    { path: path.join(destRoot, 'apps', 'web', 'dist', 'index.html'), name: 'web dist' },
    { path: path.join(destRoot, 'node_modules'), name: 'node_modules 目录' },
    { path: path.join(destRoot, 'node_modules', 'sharp', 'package.json'), name: 'sharp 模块' },
    { path: path.join(destRoot, 'node_modules', 'detect-libc', 'package.json'), name: 'detect-libc 模块' },
    { path: path.join(destRoot, 'node_modules', 'semver', 'package.json'), name: 'semver 模块' },
  ];

  let allOk = true;
  for (const check of checks) {
    const exists = fs.existsSync(check.path);
    console.log(`  ${exists ? '✅' : '❌'} ${check.name}: ${exists ? '存在' : '缺失'}`);
    if (!exists) allOk = false;
  }

  // 检查 sharp 二进制
  const platform = `${process.platform}-${process.arch}`;
  const sharpLib = path.join(destRoot, 'node_modules', '@img', `sharp-${platform}`, 'lib');
  if (fs.existsSync(sharpLib)) {
    const files = fs.readdirSync(sharpLib);
    const nodeFiles = files.filter(f => f.endsWith('.node'));
    if (nodeFiles.length > 0) {
      console.log(`  ✅ sharp 二进制: ${nodeFiles.join(', ')}`);
    }
  }

  try {
    require(path.join(destRoot, 'node_modules', 'sharp'));
    console.log(`  ✅ sharp 可以正常加载`);
  } catch (error) {
    console.log(`  ❌ sharp 加载失败: ${error.message}`);
    allOk = false;
  }

  return allOk;
}

// ============================================================
// 复制 node.exe 和 pnpm（仅 after-pack 模式）
// ============================================================
function copyBundledNode(destDir) {
  const src = [
    process.env.NODE_BINARY,
    process.execPath,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ].find((candidate) => candidate && fs.existsSync(candidate) && !/electron/i.test(candidate));
  if (!src) {
    throw new Error('打包时未找到 node.exe');
  }
  const dest = path.join(destDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(src, dest);
  return dest;
}

function copyBundledPnpm(projectDir, destDir) {
  const candidates = [
    path.join(projectDir, 'node_modules', 'pnpm'),
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'node_modules', 'pnpm'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'pnpm'),
  ];
  if (process.env.PNPM_HOME) {
    candidates.push(path.join(process.env.PNPM_HOME, 'node_modules', 'pnpm'));
  }

  const corepackBase = path.join(process.env.LOCALAPPDATA || '', 'node', 'corepack', 'v1', 'pnpm');
  if (fs.existsSync(corepackBase)) {
    try {
      const dirs = fs.readdirSync(corepackBase, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory() && fs.existsSync(path.join(corepackBase, d.name, 'bin', 'pnpm.cjs'))) {
          candidates.push(path.join(corepackBase, d.name));
        }
      }
    } catch (_) {}
  }

  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'bin', 'pnpm.cjs'))) {
      const dest = path.join(destDir, 'pnpm');
      console.log(`📦 复制 pnpm 从 ${c} 到 ${dest}`);
      fs.cpSync(c, dest, { recursive: true, dereference: true });
      return dest;
    }
  }

  console.warn('⚠️ 未找到 pnpm');
  return null;
}

// ============================================================
// after-pack 模式
// ============================================================
async function runAfterPack() {
  logger.section('📦 打包后处理模式');

  // 如果未指定输出目录，默认使用 release
  const appOutDir = afterPackOutDir || 'release';
  if (!appOutDir) {
    logger.error('--after-pack 需要指定输出目录');
    process.exit(1);
  }

  const resources = path.join(appOutDir, 'resources');
  const harnessDest = path.join(resources, 'vendor', 'deepseek-harness');

  // 确定源目录
  let srcRoot = null;
  if (fs.existsSync(path.join(DEPLOY_DIR))) {
    srcRoot = DEPLOY_DIR;
    console.log(`📂 使用部署目录: ${DEPLOY_DIR}`);
  } else {
    srcRoot = VENDOR_ROOT;
    console.log(`📂 使用 vendor 目录: ${VENDOR_ROOT}`);
  }

  // 部署
  const total = await deploy(srcRoot, harnessDest, { flat: srcRoot === VENDOR_ROOT, expandNested: srcRoot === DEPLOY_DIR });

  // 验证
  const verified = verifyDeployment(harnessDest);

  // 复制 node.exe 和 pnpm
  const nodeDest = copyBundledNode(resources);
  const pnpmDest = copyBundledPnpm(PROJECT_DIR, resources);
  if (pnpmDest) console.log(`✅ pnpm 已复制到 ${pnpmDest}`);

  console.log(`\n✅ 成功复制 ${total} 个文件到 ${harnessDest}`);
  console.log(`✅ node.exe 写入 ${nodeDest}`);

  if (!verified) {
    throw new Error('部署验证失败');
  }
}

// ============================================================
// 独立部署模式
// ============================================================
async function runDeployOnly() {
  logger.section('🚀 独立部署模式');

  console.log(`📋 配置:`);
  console.log(`  - 源目录: ${VENDOR_ROOT}`);
  console.log(`  - 目标目录: ${DEPLOY_DIR}`);
  console.log(`  - 详细模式: ${VERBOSE}`);
  console.log('');

  if (!fs.existsSync(VENDOR_ROOT)) {
    logger.error(`vendor 目录不存在: ${VENDOR_ROOT}`);
    logger.error('请先运行: cd vendor/deepseek-harness && pnpm install && pnpm run build');
    process.exit(1);
  }

  const cliLib = path.join(VENDOR_ROOT, 'apps', 'cli', 'lib', 'bin.js');
  if (!fs.existsSync(cliLib)) {
    logger.error(`CLI 未构建: ${cliLib}`);
    logger.error('请先运行: cd vendor/deepseek-harness && pnpm run build');
    process.exit(1);
  }

  const total = await deploy(VENDOR_ROOT, DEPLOY_DIR, { flat: true, expandNested: false });
  const verified = verifyDeployment(DEPLOY_DIR);

  logger.section('🎉 部署完成');
  if (verified) {
    console.log(`  ✅ 所有步骤成功完成！`);
    console.log(`  📁 部署目录: ${DEPLOY_DIR}`);
    console.log(`  📦 复制文件: ${total} 个`);
    console.log(`\n  💡 下一步: 运行 pnpm run dist:win 进行打包`);
  } else {
    console.log(`  ⚠️ 部分步骤可能有问题，请检查上面的日志`);
  }
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  try {
    if (AFTER_PACK) {
      await runAfterPack();
    } else {
      await runDeployOnly();
    }
  } catch (error) {
    logger.error(`执行失败: ${error.message}`);
    if (VERBOSE) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();