function normalizedHex(value) {
  const source = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(source)) {
    return source.split('').map((digit) => `${digit}${digit}`).join('');
  }
  if (/^[0-9a-f]{6}$/i.test(source)) return source;
  throw new TypeError(`Expected a three- or six-digit hex colour, received “${value}”.`);
}

function relativeLuminance(hex) {
  const source = normalizedHex(hex);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(source.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function tabIndexForKey(key, currentIndex, length, { orientation = 'horizontal' } = {}) {
  if (!Number.isInteger(length) || length < 1) return null;
  const current = Math.max(0, Math.min(length - 1, Number(currentIndex) || 0));
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  if (key === previousKey) return (current - 1 + length) % length;
  if (key === nextKey) return (current + 1) % length;
  return null;
}
