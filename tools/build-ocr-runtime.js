'use strict';

// 构建 OCR 捆绑运行时（build/ocr-runtime）：
//   python/        python-3.12.14 embeddable + numpy + Pillow
//   run_ocr.py     采集入口（tools/ocr/run_ocr.py）
//   hp_bars.py / econ_ocr.py / digit_templates.npz（tools/pixel-bars/）
// electron-builder 经 package.json 的 extraResources 把它安装到 resources/ocr，
// src/ocr-supervisor.js 在安装版按 resolveRuntime 的捆绑布局找到它。
//
// 幂等：python/ 已就绪（numpy+PIL 可导入）则跳过下载与 pip 安装，只同步脚本。
// 网络源：默认 npmmirror Python 二进制镜像，可用 PYTHON_EMBED_MIRROR 覆盖；
// pip 索引可用 PIP_INDEX_URL 覆盖。

const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

// 3.12.11+ 是纯安全更新（无 Windows 二进制），嵌入包取最后一个带二进制的 3.12.x。
const PY_VERSION = '3.12.10';
const NUMPY_VERSION = '2.3.5';
const PILLOW_VERSION = '12.3.0';

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'ocr-runtime');
const PY_DIR = path.join(OUT_DIR, 'python');
const ZIP_PATH = path.join(OUT_DIR, 'python-embed.zip');

// 本机全量 Python（跑 pip 与解压；embeddable 自身不带 pip）。
const HELPER_PYTHON_CANDIDATES = process.env.RB_BUILD_PYTHON ? [process.env.RB_BUILD_PYTHON] : [
  'C:/Users/RyeRaven/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  'python.exe'
];

function findHelperPython() {
  for (const candidate of HELPER_PYTHON_CANDIDATES) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('找不到可用于构建的 Python（设 RB_BUILD_PYTHON 指定）');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.message += '\n' + String(stdout || '').slice(-2000) + '\n' + String(stderr || '').slice(-2000);
        reject(error);
      } else resolve(stdout);
    });
  });
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多：' + url));
    const file = fs.createWriteStream(dest);
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close(() => resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1)));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close(() => reject(new Error('HTTP ' + res.statusCode + '：' + url)));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', error => { try { file.close(); } catch { /* 尽力 */ } reject(error); });
  });
}

function embedZipUrl() {
  const mirror = (process.env.PYTHON_EMBED_MIRROR || 'https://registry.npmmirror.com/-/binary/python').replace(/\/+$/, '');
  return mirror + '/' + PY_VERSION + '/python-' + PY_VERSION + '-embed-amd64.zip';
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const helper = findHelperPython();

  // 1) 同步脚本（每次构建都刷新，脚本改动无需重建运行时）
  const scripts = [
    ['tools/ocr/run_ocr.py', 'run_ocr.py'],
    ['tools/pixel-bars/hp_bars.py', 'hp_bars.py'],
    ['tools/pixel-bars/econ_ocr.py', 'econ_ocr.py'],
    ['tools/pixel-bars/digit_templates.npz', 'digit_templates.npz']
  ];
  for (const [from, to] of scripts) {
    fs.copyFileSync(path.join(ROOT, from), path.join(OUT_DIR, to));
  }
  console.log('[build-ocr] 脚本已同步：' + scripts.map(s => s[1]).join(', '));

  // 2) Python 运行时
  if (fs.existsSync(path.join(PY_DIR, 'python.exe'))) {
    try {
      await run(PY_DIR + '/python.exe', ['-c', 'import numpy, PIL']);
      console.log('[build-ocr] 运行时已就绪（numpy+PIL 可导入），跳过下载/安装');
      return;
    } catch (error) {
      console.log('[build-ocr] 现有运行时自检失败，重建：' + error.message.split('\n')[0]);
    }
  }

  fs.rmSync(PY_DIR, { recursive: true, force: true });
  if (!fs.existsSync(ZIP_PATH)) {
    const url = embedZipUrl();
    console.log('[build-ocr] 下载 ' + url);
    try {
      await download(url, ZIP_PATH);
    } catch (error) {
      const fallback = 'https://www.python.org/ftp/python/' + PY_VERSION + '/python-' + PY_VERSION + '-embed-amd64.zip';
      console.log('[build-ocr] 主源失败（' + error.message + '），回退 ' + fallback);
      await download(fallback, ZIP_PATH);
    }
    console.log('[build-ocr] 下载完成 ' + fs.statSync(ZIP_PATH).size + ' bytes');
  }
  await run(helper, ['-c', "import zipfile; zipfile.ZipFile(r'" + ZIP_PATH + "').extractall(r'" + PY_DIR + "')"]);

  // embeddable 的 ._pth 默认不带 site-packages 且不 import site——打开两条。
  const minor = PY_VERSION.split('.').slice(0, 2).join('');
  const pth = path.join(PY_DIR, 'python' + minor + '._pth');
  fs.writeFileSync(pth, 'python' + minor + '.zip\n.\nLib/site-packages\nimport site\n');

  const index = process.env.PIP_INDEX_URL || '';
  const pipArgs = ['-m', 'pip', 'install', '--no-warn-script-location', '--target', path.join(PY_DIR, 'Lib', 'site-packages'),
    'numpy==' + NUMPY_VERSION, 'Pillow==' + PILLOW_VERSION];
  if (index) pipArgs.push('-i', index);
  console.log('[build-ocr] pip install numpy+Pillow → ' + path.join(PY_DIR, 'Lib', 'site-packages'));
  await run(helper, pipArgs, { cwd: PY_DIR });

  // 3) 自检：用捆绑 python 导入 numpy+PIL
  const out = await run(PY_DIR + '/python.exe', ['-c', 'import numpy, PIL; print("numpy", numpy.__version__, "PIL", PIL.__version__)']);
  console.log('[build-ocr] 自检通过：' + out.trim());
  console.log('[build-ocr] 完成：build/ocr-runtime');
}

main().catch(error => { console.error('[build-ocr] 失败：' + error.message); process.exit(1); });
