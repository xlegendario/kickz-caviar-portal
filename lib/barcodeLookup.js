/*
 * A barcode on a box, turned into a SKU and a size.
 *
 * The warehouse scans whatever is printed on the box, and that is not one
 * number. A European box carries an EAN-13, an American one a UPC-A, and a
 * UPC-A is the same barcode as an EAN-13 with a leading zero - 197600040076
 * and 0197600040076 are one box. Which length a scanner hands back depends on
 * the symbol, not on the shoe. Stored in one form and scanned in the other,
 * the pair simply is not found, and nothing says why.
 *
 * So every comparison here is on the barcode with its leading zeros removed,
 * and every lookup asks for all the lengths it can be written in.
 *
 * Pure functions only. The calls to Supabase and StockX live in index.js.
 */

const BARCODE = /^\d{8,14}$/;

export function cleanBarcode(value) {
  const digits = String(value ?? "").trim().replace(/\s+/g, "");

  return BARCODE.test(digits) ? digits : "";
}

function core(value) {
  return String(value ?? "").replace(/^0+/, "");
}

/*
 * Every way this barcode can be written: as scanned, and zero-padded to a
 * UPC-A, an EAN-13 and a GTIN-14. A GTIN-8 is its own format and only ever
 * matches itself.
 */
export function barcodeForms(value) {
  const code = cleanBarcode(value);
  if (!code) return [];

  const forms = new Set([code]);
  const stripped = core(code);

  if (code.length > 8 && stripped) {
    for (const length of [12, 13, 14]) {
      if (stripped.length <= length) forms.add(stripped.padStart(length, "0"));
    }
  }

  return [...forms];
}

export function sameBarcode(a, b) {
  const left = cleanBarcode(a);
  const right = cleanBarcode(b);

  if (!left || !right) return false;

  return core(left) === core(right);
}

/*
 * The EU size of a StockX variant, in our notation.
 *
 * Identical to euSizeOf in the marketplace service on purpose: bol_barcodes
 * is filled from both, and a size written "44 1/2" by one and "44.5" by the
 * other is two rows that never match anything.
 */
export function euSizeOf(variant) {
  const conversions = variant?.sizeChart?.availableConversions || [];

  const eu = conversions.find(
    (entry) => String(entry.type || "").toLowerCase() === "eu"
  );

  const raw = eu?.size ?? variant?.variantValue ?? "";

  return String(raw)
    .trim()
    .replace(/^EU\s*/i, "")
    .replace(/\s*1\/2$/, ".5")
    .replace(",", ".")
    .replace(/\.0$/, "");
}

function codesOf(variant) {
  return (variant?.gtins || [])
    .map((g) => String(g?.identifier || "").trim())
    .filter((value) => BARCODE.test(value));
}

/*
 * The size a scanned barcode belongs to, or null.
 *
 * A search by barcode answers with the product, never with the size, and one
 * product has twenty-odd sizes. Only the variant list says which box it was.
 */
export function findVariantForBarcode(variants, barcode) {
  for (const variant of variants || []) {
    if (codesOf(variant).some((code) => sameBarcode(code, barcode))) {
      const size = euSizeOf(variant);

      if (size) return { size, variant };
    }
  }

  return null;
}

/*
 * One bol_barcodes row per size, in the shape the marketplace service writes.
 *
 * The thirteen digit form in `ean`, the twelve digit form in `gtin`, even
 * when they are the same number underneath, because that table is read by
 * bol (which only knows thirteen digits) and by the warehouse (which gets
 * whichever the scanner reads). First size wins when StockX lists one twice.
 */
export function barcodeRowsForVariants(sku, variants) {
  const rows = new Map();

  for (const variant of variants || []) {
    const size = euSizeOf(variant);

    if (!size || rows.has(size)) continue;

    const codes = codesOf(variant);
    if (!codes.length) continue;

    const twelveDigit = codes.find((c) => c.length === 12);

    const thirteen =
      codes.find((c) => c.length === 13) ||
      (twelveDigit ? `0${twelveDigit}` : null);

    const twelve =
      twelveDigit ||
      (thirteen && thirteen.startsWith("0") ? thirteen.slice(1) : null);

    if (!thirteen) continue;

    rows.set(size, {
      sku,
      size,
      ean: thirteen,
      gtin: twelve !== thirteen ? twelve : null
    });
  }

  return [...rows.values()];
}

/*
 * Which of our codes a StockX style id stands for.
 *
 * StockX bundles re-releases under one product: "315115-112/DD8959-100".
 * The box in hand is one of them, and the rest of our system knows each by
 * its own code, so the first part that we already hold is the answer. When
 * we hold neither, the first part is as good a guess as any - both are the
 * same shoe.
 */
export function pickOwnSku(styleId, knownSkus = []) {
  const parts = String(styleId || "")
    .toUpperCase()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) return "";

  const known = new Set(knownSkus.map((sku) => String(sku || "").toUpperCase()));

  return parts.find((part) => known.has(part)) || parts[0];
}

/*
 * StockX answers an unknown barcode with a 404 and this message, not with an
 * empty list. That is "does not exist", and has to stay apart from an outage.
 */
export function isUnknownBarcodeError(err) {
  return (
    Number(err?.status) === 404 &&
    /no product found for gtin/i.test(String(err?.body?.errorMessage || ""))
  );
}
