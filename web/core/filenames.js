const MAX_FILENAME_PART_LENGTH = 64;

function fallbackPart(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'file';
}

/** Turn user-facing labels into portable, predictable filename segments. */
export function filenamePart(value, fallback = 'file') {
  const part = String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_PART_LENGTH)
    .replace(/-+$/g, '');
  return part || fallbackPart(fallback);
}

/** Browser-local timestamp, ordered from the largest unit to the smallest. */
export function filenameTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid export date is required');
  const pad = (number) => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    '-', pad(date.getMonth() + 1),
    '-', pad(date.getDate()),
    '-', pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function dimensionPart(value) {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new TypeError('Positive sheet dimensions are required');
  }
  return String(Number(dimension.toFixed(3))).replace('.', 'p');
}

/**
 * Build a filename whose related exports sort together in ordinary folders.
 * Example: maria_297x420mm_slats_frame_cut_2026-09-15-162005.dxf
 */
export function buildExportFilename({
  projectName,
  sheet,
  styleName,
  includeFrame = true,
  purpose,
  extension,
  timestamp = new Date(),
}) {
  const cleanExtension = String(extension ?? '').toLowerCase();
  if (!/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(cleanExtension)) {
    throw new TypeError('A safe export extension is required');
  }
  return [
    filenamePart(projectName, 'panel'),
    `${dimensionPart(sheet?.widthMm)}x${dimensionPart(sheet?.heightMm)}mm`,
    filenamePart(styleName, 'artwork'),
    includeFrame ? 'frame' : 'no-frame',
    filenamePart(purpose, 'export'),
    filenameTimestamp(timestamp),
  ].join('_') + `.${cleanExtension}`;
}
