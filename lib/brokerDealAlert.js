// lib/brokerDealAlert.js
//
// A consignor saying yes on a broker deal books nothing: the pair is parked
// on "partner_agreed" until somebody closes the deal from the Draft tab, and
// after PARTNER_DEAL_CLOCK_HOURS the sweep lets it go. Nothing told anyone
// it was waiting, so EXTD-000173 (14-11-2026) expired with the consignor
// agreed and the buyer still wanting the pair.
//
// This builds the two Discord messages that close that gap: one when he
// agrees, one when the clock is nearly out. Pure, so the wording and the
// timing can be tested without a webhook.

export const BROKER_REMINDER_LEAD_HOURS = 4;

const HOUR_MS = 3600 * 1000;

function euro(value) {
  const amount = Number(value);

  return Number.isFinite(amount) ? `€ ${amount.toFixed(2).replace(".", ",")}` : "-";
}

function text(value) {
  return String(value ?? "").trim();
}

/*
 * Whether the second message is due.
 *
 * Only for a broker round that is still parked, has not been reminded, and
 * is inside the last few hours of its clock. A round already past its
 * deadline is the sweep's to end, not ours to remind about.
 */
export function brokerReminderDue(offer, deadlineMs, nowMs, leadHours = BROKER_REMINDER_LEAD_HOURS) {
  if (text(offer?.source_type) !== "external_sale") return false;
  if (text(offer?.status) !== "partner_agreed") return false;
  if (text(offer?.broker_reminder_sent_at)) return false;
  if (!Number.isFinite(deadlineMs)) return false;

  return deadlineMs > nowMs && deadlineMs - nowMs <= leadHours * HOUR_MS;
}

/*
 * The webhook body.
 *
 * kind "agreed" when the consignor has just said yes, "reminder" when the
 * deal is about to lapse. The deadline is shown as a Discord timestamp so
 * everybody reads it in their own time zone.
 */
export function buildBrokerDealAlert({ kind, offer, buyerName = "", deadlineMs, adminUrl = "" }) {
  const reminder = kind === "reminder";
  const deal = text(offer?.order_id) || "broker deal";
  const pair = [text(offer?.product_name) || text(offer?.sku), text(offer?.size)].filter(Boolean).join(" · ");
  const unix = Number.isFinite(deadlineMs) ? Math.floor(deadlineMs / 1000) : null;

  const fields = [
    { name: "Pair", value: `${pair || "-"}\n${text(offer?.sku) || "-"}`, inline: false },
    { name: "Consignor", value: text(offer?.seller_id) || "-", inline: true },
    { name: "We pay", value: `${euro(offer?.offer_price)} · ${text(offer?.vat_type) || "-"}`, inline: true },
    { name: "Buyer", value: text(buyerName) || "-", inline: true },
    { name: "Expires", value: unix ? `<t:${unix}:f> (<t:${unix}:R>)` : "-", inline: false }
  ];

  return {
    content: reminder
      ? `⏰ **${deal}** expires soon - the consignor agreed, the deal is still not confirmed.`
      : `✅ **${deal}**: the consignor agreed. Confirm the deal in Draft before it expires.`,
    embeds: [
      {
        title: reminder ? "Broker deal about to expire" : "Consignor agreed - waiting for you",
        url: text(adminUrl) || undefined,
        color: reminder ? 0xe67e22 : 0x2ecc71,
        fields
      }
    ]
  };
}
