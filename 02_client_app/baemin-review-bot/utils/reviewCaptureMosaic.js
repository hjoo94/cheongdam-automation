const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isSafeImagePath(filePath) {
  const s = String(filePath || '');
  if (!s || s.length > 520) return false;
  const ext = path.extname(s).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return false;
  try {
    if (!fs.existsSync(s)) return false;
    const st = fs.statSync(s);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_FILE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

function clampMaxDimension(img, maxDim) {
  const { width, height } = img.getSize();
  const m = Number(maxDim) || 2400;
  if (!width || !height) return img;
  if (width <= m && height <= m) return img;
  const scale = m / Math.max(width, height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  return img.resize({ width: w, height: h });
}

function mosaicNativeImage(srcImage, blockPixels = 12) {
  const { width, height } = srcImage.getSize();
  if (!width || !height || width < 2 || height < 2) return srcImage;
  const bp = Math.max(4, Math.min(56, Number(blockPixels) || 12));
  const wSmall = Math.max(1, Math.floor(width / bp));
  const hSmall = Math.max(1, Math.floor(height / bp));
  const thumb = srcImage.resize({ width: wSmall, height: hSmall });
  return thumb.resize({ width, height });
}

function toPreviewDataUrl(mosImage, maxWidth = 420) {
  const { width, height } = mosImage.getSize();
  if (!width || !height) return '';
  if (width <= maxWidth) {
    return `data:image/png;base64,${mosImage.toPNG().toString('base64')}`;
  }
  const scale = maxWidth / width;
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const small = mosImage.resize({ width: w, height: h });
  return `data:image/png;base64,${small.toPNG().toString('base64')}`;
}

/**
 * 배민·쿠팡 등 캡처 이미지에 개인정보 노출을 줄이기 위한 픽셀 모자이크 PNG를 저장합니다.
 * @param {string} inputPath
 * @param {string} outputDir
 * @param {{ blockPixels?: number, maxInputDimension?: number }} opts
 */
function exportMosaicFromFile(inputPath, outputDir, opts = {}) {
  if (!isSafeImagePath(inputPath)) {
    return { ok: false, error: '지원하지 않는 경로이거나 파일이 없습니다.' };
  }

  const blockPixels = opts.blockPixels ?? 12;
  const maxInputDimension = opts.maxInputDimension ?? 2400;

  let img;
  try {
    img = nativeImage.createFromPath(inputPath);
  } catch (e) {
    return { ok: false, error: e.message || '이미지 로드 실패' };
  }

  if (img.isEmpty()) {
    return { ok: false, error: '이미지를 열 수 없습니다.' };
  }

  const work = clampMaxDimension(img, maxInputDimension);
  const mos = mosaicNativeImage(work, blockPixels);
  const buf = mos.toPNG();
  ensureDir(outputDir);

  const base = path.basename(inputPath, path.extname(inputPath)).replace(/[^\w\-가-힣]+/g, '_').slice(0, 36) || 'capture';
  const rand = crypto.randomBytes(4).toString('hex');
  const name = `${base}_mosaic_${Date.now()}_${rand}.png`;
  const outPath = path.join(outputDir, name);

  try {
    fs.writeFileSync(outPath, buf);
  } catch (e) {
    return { ok: false, error: e.message || '파일 저장 실패' };
  }

  return {
    ok: true,
    outputPath: outPath,
    previewDataUrl: toPreviewDataUrl(mos, 420),
    fileName: name,
    byteLength: buf.length,
  };
}

function processReviewCaptureImages(paths = [], outputDir, opts = {}) {
  const list = Array.isArray(paths) ? paths.slice(0, 8) : [];
  const outputs = [];
  const errors = [];

  for (const p of list) {
    const r = exportMosaicFromFile(p, outputDir, opts);
    if (r.ok) {
      outputs.push({
        sourcePath: p,
        outputPath: r.outputPath,
        previewDataUrl: r.previewDataUrl,
        fileName: r.fileName,
      });
    } else {
      errors.push(`${path.basename(String(p))}: ${r.error}`);
    }
  }

  return { outputs, errors };
}

module.exports = {
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  isSafeImagePath,
  exportMosaicFromFile,
  processReviewCaptureImages,
};
