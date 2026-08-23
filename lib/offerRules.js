// lib/offerRules.js
//
// De regels die bepalen of er op een order geboden kan worden, en met welk
// VAT-type. Gebruikt door de publieke offer-pagina (/offer/...) om te tonen
// wat er mogelijk is.
//
// LET OP: discord-wtb-bot blijft de handhaver. Elke offer gaat daar langs
// /seller-offer/place-from-portal en wordt daar opnieuw gecontroleerd. Wat
// hier staat is er alleen om de seller vooraf te laten zien wat hij mag, zodat
// hij niet op een geweigerde offer stuit. Wijkt de bot af, dan wint de bot —
// deze module mag nooit ruimer zijn dan wat daar staat.

// Spiegelt de statuscontrole in place-from-portal.
const MEMBER_WTB_CLOSED_STATUSES = ["Confirmed", "Allocated", "Fulfilled", "Cancelled"];

export function normalizeSourceType(input) {
  const value = String(input || "").trim().toLowerCase();

  if (value === "order" || value === "orders") return "order";
  if (value === "member-wtb" || value === "member_wtb") return "member_wtb";

  return null;
}

export function isOpenForOffers({ sourceType, fulfillmentStatus }) {
  const status = String(fulfillmentStatus || "").trim();

  if (sourceType === "order") {
    if (status === "Outsource") return { open: true, reason: "" };

    return {
      open: false,
      reason: "This order is no longer open for offers."
    };
  }

  if (sourceType === "member_wtb") {
    if (!MEMBER_WTB_CLOSED_STATUSES.includes(status)) return { open: true, reason: "" };

    return {
      open: false,
      reason: "This WTB is no longer open for offers."
    };
  }

  return { open: false, reason: "Unknown order type." };
}

// Spiegelt isVatTypeAllowedForMemberWtbFilter in discord-wtb-bot.
export function allowedVatTypesForMemberWtb(filter) {
  const clean = String(filter || "").trim();

  if (clean === "B2B Only") return ["VAT0", "VAT21"];
  if (clean === "Margin Only" || clean === "Private Only") return ["Margin"];

  return ["Margin", "VAT0", "VAT21"];
}

// Spiegelt validateSellerVatEligibility in discord-wtb-bot: zonder VAT ID ben
// je geen geregistreerd bedrijf en kun je alleen Margin verkopen; een Nederlands
// bedrijf kan geen VAT0 leveren aan een Nederlandse B.V. en een niet-Nederlands
// bedrijf geen VAT21.
export function vatTypesForSeller({ vatId, country }) {
  if (!String(vatId || "").trim()) return ["Margin"];

  const isNl = String(country || "").trim().toLowerCase() === "netherlands";

  return isNl ? ["Margin", "VAT21"] : ["Margin", "VAT0"];
}

// Wat deze seller op dit specifieke order mag bieden: de doorsnede van wat de
// koper accepteert en wat de seller fiscaal mag leveren. Is die leeg, dan heeft
// het geen zin de offer-knop te tonen — dat scheelt de seller een afwijzing
// waar hij niets aan kan veranderen.
export function offerableVatTypes({ sourceType, buyingInventoryFilter, vatId, country }) {
  const seller = vatTypesForSeller({ vatId, country });

  if (sourceType !== "member_wtb") return seller;

  const buyer = allowedVatTypesForMemberWtb(buyingInventoryFilter);

  return seller.filter((type) => buyer.includes(type));
}

// Leest een met de hand getypt VAT-type in.
//
// Discord-modals kennen geen dropdown en geen tekenmasker — alleen een vrij
// tekstveld. Een masker was dus geen optie, en had case en spaties toch niet
// opgelost. Daarom hier soepel inlezen: alles wat herkenbaar naar een van de
// drie types wijst wordt genormaliseerd, en alleen echt onleesbare invoer
// wordt geweigerd.
export function normalizeVatTypeInput(input) {
  const clean = String(input ?? "").toLowerCase().replace(/[\s._-]/g, "");

  if (!clean) return "";

  if (clean === "margin" || clean === "marge" || clean === "m") return "Margin";

  // "vat21", "21", "btw21", "vat21%"
  if (/^(vat|btw)?21%?$/.test(clean)) return "VAT21";

  // "vat0", "0", "vat00", "nulvat"
  if (/^(vat|btw)?0+%?$/.test(clean)) return "VAT0";

  return "";
}
