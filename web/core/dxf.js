import { assertMask, assertSheet } from "./mask.js";
import { traceMaskContours } from "./svg.js";

const DXF_UNITS = Object.freeze({
  mm: { code: 4, millimetresPerUnit: 1, measurement: 1 },
  in: { code: 1, millimetresPerUnit: 25.4, measurement: 0 },
});

/**
 * Emits a deterministic ASCII DXF (AutoCAD 2000) containing one closed
 * LWPOLYLINE per retained-material contour. Raster Y coordinates are flipped
 * into Cartesian DXF space so the visual orientation matches SVG output.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{widthMm:number,heightMm:number}} sheet
 * @param {{units?:'mm'|'in',title?:string,precision?:number}} [options]
 */
export function exportDxf(mask, sheet, options = {}) {
  assertMask(mask);
  assertSheet(sheet);
  const units = options.units ?? "mm";
  const unit = DXF_UNITS[units];
  if (!unit) throw new RangeError("DXF units must be 'mm' or 'in'");
  const precision = options.precision ?? 6;
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
    throw new RangeError("DXF precision must be an integer from 0 to 12");
  }

  const width = sheet.widthMm / unit.millimetresPerUnit;
  const height = sheet.heightMm / unit.millimetresPerUnit;
  const scaleX = width / mask.width;
  const scaleY = height / mask.height;
  const lines = [];
  const pair = (code, value) => {
    lines.push(String(code), String(value));
  };

  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$ACADVER");
  pair(1, "AC1015");
  pair(9, "$INSUNITS");
  pair(70, unit.code);
  pair(9, "$MEASUREMENT");
  pair(70, unit.measurement);
  pair(9, "$EXTMIN");
  pair(10, "0");
  pair(20, "0");
  pair(30, "0");
  pair(9, "$EXTMAX");
  pair(10, formatNumber(width, precision));
  pair(20, formatNumber(height, precision));
  pair(30, "0");
  if (options.title) pair(999, `Stencil CNC: ${asciiComment(options.title)}`);
  pair(0, "ENDSEC");

  pair(0, "SECTION");
  pair(2, "TABLES");
  pair(0, "TABLE");
  pair(2, "LAYER");
  pair(70, 1);
  pair(0, "LAYER");
  pair(100, "AcDbSymbolTableRecord");
  pair(100, "AcDbLayerTableRecord");
  pair(2, "CUT");
  pair(70, 0);
  pair(62, 7);
  pair(6, "CONTINUOUS");
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");

  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const contour of traceMaskContours(mask)) {
    pair(0, "LWPOLYLINE");
    pair(100, "AcDbEntity");
    pair(8, "CUT");
    pair(100, "AcDbPolyline");
    pair(90, contour.length);
    pair(70, 1);
    for (const point of contour) {
      pair(10, formatNumber(point.x * scaleX, precision));
      pair(20, formatNumber(height - point.y * scaleY, precision));
    }
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return `${lines.join("\n")}\n`;
}

export const maskToDxf = exportDxf;

function formatNumber(value, precision) {
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function asciiComment(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .trim()
    .slice(0, 240);
}
