/*
 * Partner stock: pairs a partner keeps in our warehouse, one row per pair.
 *
 * The table itself, and the consignment_inventory row that follows it, live
 * in Supabase (partner_stock plus its trigger). What is here are the choices
 * the portal makes around it, as pure functions so they can be tested:
 * what an intake is allowed to contain, which pair a sale takes, which pairs
 * a forward takes.
 */

export const MODES = ["consignment", "forwarding", "both"];
export const VAT_TYPES = ["Margin", "VAT0", "VAT21"];

// A parcel from a partner is tens of pairs, not thousands. Anything above
// this is a typing mistake in a quantity field.
const MAX_PAIRS_PER_LINE = 200;

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function money(value) {
  if (value === null || value === undefined || text(value) === "") return null;

  const n = Number(String(value).replace(",", "."));

  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

export function isListedMode(mode) {
  return mode === "consignment" || mode === "both";
}

/*
 * The lines of one intake, checked and merged.
 *
 * Lines with the same SKU, size, price and markup become one line: the WMS
 * keys its table on the barcode, and two boxes of one size can arrive with
 * different barcodes. Lines that differ in price stay apart, because each
 * pair keeps its own price.
 *
 * Returns every problem at once rather than the first, so the person at the
 * scanner fixes the whole parcel in one go.
 */
export function normalizeIntake({ mode, items }) {
  const errors = [];

  if (!MODES.includes(mode)) {
    return { lines: [], errors: [`Unknown mode "${mode}"`] };
  }

  const listed = isListedMode(mode);
  const merged = new Map();

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const label = `Line ${index + 1}`;
    const sku = text(item?.sku).toUpperCase();
    const size = text(item?.size);
    const quantity = Number(item?.quantity);
    const partnerPrice = money(item?.partner_price);
    const markup = money(item?.markup) ?? 0;

    if (!sku || !size) {
      errors.push(`${label}: SKU and size are required`);
      return;
    }

    const name = `${sku} / ${size}`;

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PAIRS_PER_LINE) {
      errors.push(`${name}: quantity must be a whole number from 1 to ${MAX_PAIRS_PER_LINE}`);
      return;
    }

    if (listed && !(partnerPrice > 0)) {
      errors.push(`${name}: partner price is required`);
      return;
    }

    if (Number.isNaN(partnerPrice) || (partnerPrice !== null && partnerPrice <= 0)) {
      errors.push(`${name}: partner price must be above zero`);
      return;
    }

    if (Number.isNaN(markup) || markup < 0) {
      errors.push(`${name}: markup cannot be negative`);
      return;
    }

    const price = listed ? partnerPrice : partnerPrice ?? null;
    const key = `${sku}|${size}|${price ?? ""}|${markup}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity += quantity;
      if (!existing.barcode && text(item?.barcode)) existing.barcode = text(item.barcode);
      return;
    }

    merged.set(key, {
      sku,
      size,
      barcode: text(item?.barcode) || null,
      quantity,
      partner_price: price,
      markup: listed ? markup : 0
    });
  });

  if (!merged.size && !errors.length) errors.push("No items");

  return { lines: [...merged.values()], errors };
}

function listingPrice(pair) {
  return Number(pair.partner_price) + Number(pair.markup || 0);
}

function byListingThenAge(a, b) {
  return (
    listingPrice(a) - listingPrice(b) ||
    String(a.received_at).localeCompare(String(b.received_at)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/*
 * The pair a sale takes: the cheapest listed pair, oldest first on a tie.
 *
 * Exactly the order the Supabase trigger uses to price the listing. It has to
 * be: the unit was just made with that pair's partner price as its purchase
 * price, so any other pair would leave the books and the shelf disagreeing.
 */
export function orderPairsForSale(pairs) {
  return (pairs || [])
    .filter(
      (pair) =>
        pair.status === "in_stock" &&
        isListedMode(pair.mode) &&
        Number(pair.partner_price) > 0
    )
    .sort(byListingThenAge);
}

/*
 * The pairs a forward takes, in the order they should go.
 *
 * Pairs that were only ever for forwarding first. Then pairs that are also
 * listed, most expensive first, so what stays behind for sale is the pair
 * the market is most likely to take. Oldest first within each.
 */
export function orderPairsForForwarding(pairs) {
  const forwardable = (pairs || []).filter(
    (pair) => pair.status === "in_stock" && (pair.mode === "forwarding" || pair.mode === "both")
  );

  return forwardable.sort((a, b) => {
    const aOnly = a.mode === "forwarding" ? 0 : 1;
    const bOnly = b.mode === "forwarding" ? 0 : 1;

    if (aOnly !== bOnly) return aOnly - bOnly;

    if (aOnly === 1) {
      const byPrice = listingPrice(b) - listingPrice(a);
      if (byPrice) return byPrice;
    }

    return (
      String(a.received_at).localeCompare(String(b.received_at)) ||
      String(a.id).localeCompare(String(b.id))
    );
  });
}

/*
 * What an intake changes about what is already on the shelf.
 *
 * Not an error: a partner who asks 110 this week for a size he asked 100 for
 * last week is normal. But the pairs already here keep their own price, and
 * whoever is scanning should see that the two now sit side by side.
 */
export function priceDifferences(existingPairs, lines) {
  const notes = [];

  for (const line of lines) {
    if (!(line.partner_price > 0)) continue;

    const others = (existingPairs || []).filter(
      (pair) =>
        pair.status === "in_stock" &&
        isListedMode(pair.mode) &&
        pair.sku === line.sku &&
        pair.size === line.size &&
        (Number(pair.partner_price) !== line.partner_price ||
          Number(pair.markup || 0) !== line.markup)
    );

    if (!others.length) continue;

    const prices = [
      ...new Set(others.map((pair) => `${Number(pair.partner_price)} + ${Number(pair.markup || 0)}`))
    ];

    notes.push(
      `${line.sku} / ${line.size}: ${others.length} pair(s) already in stock at ${prices.join(", ")}; ` +
        `the new pair(s) come in at ${line.partner_price} + ${line.markup}. Both stay; the cheapest is listed first.`
    );
  }

  return notes;
}
