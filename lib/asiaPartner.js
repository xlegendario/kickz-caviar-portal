// lib/asiaPartner.js
//
// The Asia partner (the Dewu supplier) gets the orders where Dewu is the
// cheapest source that he can take (the Outsource Engine decides that:
// Most Valid Sourcing = Dewu). Per order:
//
//   1. the sweep finds it, puts the order on Dewu Processing (the store can
//      no longer fulfil or cancel it), makes a Partner Offers record and
//      posts the offer in the partner's channel: Accept, Change price,
//      Decline;
//   2. his price may go up to Partner Max (Maximum Buying Price - our
//      minimum profit, never above 200); above that he is told the limit;
//   3. once he answered, the store's price is set (storePriceFor). A store
//      that accepts automatically gets the deal right away; any other store
//      gets the price as an offer and the deal follows its accept. The
//      partner hears "deal confirmed" only then - an accept or a price of
//      his is not a deal yet;
//   4. declined, denied by the store, or 48 hours after the order without a
//      deal: the order goes back to Outsource with Dewu Declined?, and the
//      Outsource Engine picks StockX or GOAT instead.
//
// The deal itself (unit, Rompslomp, mail) is made by the Lojiq portal
// (POST /api/internal/asia/deal), the same code as Manual Deal.

export const ASIA_MAX_PRICE = 200;
export const ASIA_DEFAULT_MIN_SPREAD = 12.5;
export const ASIA_MIN_PROFIT = 10;
export const ASIA_WINDOW_HOURS = 48;
export const ASIA_DEWU_CEILING_OVER = 40; // the store never pays more than Dewu + this to start with
export const ASIA_ESTIMATED_TIME = "8-10 business days";

export const PREFIX = {
  accept: "asia_accept:",
  price: "asia_price:",
  priceModal: "asia_price_modal:",
  decline: "asia_decline:"
};

const OPEN = ["Sent", "Waiting for Store"];

const text = (value) => (value === null || value === undefined ? "" : String(Array.isArray(value) ? value[0] ?? "" : value).trim());
const num = (value) => {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) ? n : null;
};
const half = (value) => Math.round(value * 2) / 2;
const euro = (value) => `€${Number(value).toFixed(2).replace(/\.00$/, "")}`;

// ---------------------------------------------------------------- prices

// Our minimum profit for a store: 10, or less when the store lets Dewu run
// closer to the Max (UNION, our own store, is 0).
export function minProfitFor(merchantFields = {}) {
  const setting = merchantFields["Asia Min Spread"];
  const spread = setting === undefined || setting === null || setting === "" ? ASIA_DEFAULT_MIN_SPREAD : Number(setting);
  return Math.max(0, Math.min(ASIA_MIN_PROFIT, Number.isFinite(spread) ? spread : ASIA_DEFAULT_MIN_SPREAD));
}

export function partnerMaxFor({ max, minProfit }) {
  return half(Math.min(max - minProfit, ASIA_MAX_PRICE));
}

/*
 * What the store pays once the partner named his price.
 *
 * Start: halfway between Target and Max - not on the Max, Asia is slower -
 * but never more than Dewu + 40, and at least Dewu + our minimum profit.
 * A partner asking more than Dewu: the store takes half of the difference
 * and we take half, the store never above its Max and we never below our
 * minimum profit; whoever hits a limit leaves the rest to the other.
 */
export function storePriceFor({ target, max, dewu, partnerPrice, minProfit }) {
  const mid = target > 0 && target <= max ? (target + max) / 2 : max;
  let start = Math.min(mid, dewu + ASIA_DEWU_CEILING_OVER, max);
  start = Math.floor(start / 2.5) * 2.5;
  start = Math.max(start, Math.min(dewu + minProfit, max));

  const extra = partnerPrice - dewu;
  let price = extra > 0 ? start + extra / 2 : start;
  price = Math.min(price, max);
  if (price - partnerPrice < minProfit) price = Math.min(max, partnerPrice + minProfit);

  return Math.min(max, half(price));
}

export function expiresAt(orderDate) {
  const t = Date.parse(orderDate || "");
  return Number.isFinite(t) ? new Date(t + ASIA_WINDOW_HOURS * 3600 * 1000) : null;
}

// ---------------------------------------------------------------- Discord

const COLORS = { Sent: 0xf5a623, "Waiting for Store": 0x4a90e2, Accepted: 0x2ecc71, closed: 0x95a5a6 };

const STATE_LINE = {
  Sent: "Waiting for your answer.",
  "Waiting for Store": "Your price is noted and sent to the store. **Not a deal yet** - you get a deal confirmation here once it is.",
  Accepted: "✅ Deal confirmed - please buy this pair.",
  Declined: "You declined this offer.",
  "Store Declined": "❌ The store declined - no deal, do not buy.",
  Expired: "⌛ Closed: no deal within 48 hours of the order.",
  Cancelled: "Closed: the order was handled another way - do not buy."
};

export function offerMessage({ offer, order, status }) {
  const o = order || {};
  const f = offer || {};
  const fields = [
    { name: "SKU", value: text(o.SKU) || "-", inline: true },
    { name: "Size (EU)", value: text(o.Size) || "-", inline: true },
    { name: "Dewu size", value: text(o["Dewu Size Normalized"]) || "-", inline: true },
    { name: "Our price", value: euro(num(f["Our Ask"]) ?? 0), inline: true },
    { name: "Your max", value: euro(num(f["Partner Max"]) ?? 0), inline: true }
  ];
  if (num(f["Partner Offer"]) !== null) fields.push({ name: "Your price", value: euro(num(f["Partner Offer"])), inline: true });

  const expires = f["Expires At"] ? Math.floor(Date.parse(f["Expires At"]) / 1000) : null;
  const picture = Array.isArray(o.Picture) ? o.Picture[0]?.url : "";

  const embed = {
    title: `${text(o["Product Name"]) || text(o.SKU)}`,
    description: [STATE_LINE[status] || "", status === "Sent" && expires ? `Answer before <t:${expires}:f>.` : ""].filter(Boolean).join("\n"),
    color: COLORS[status] ?? COLORS.closed,
    fields,
    footer: { text: `${text(f["Partner Offer ID"]) || ""} · ${text(o["Order ID"])}`.trim() }
  };
  if (picture) embed.thumbnail = { url: picture };

  const id = offer?.id || f.id || "";
  const components = status === "Sent"
    ? [{
      type: 1,
      components: [
        { type: 2, style: 3, label: `Accept ${euro(num(f["Our Ask"]) ?? 0)}`, custom_id: `${PREFIX.accept}${id}` },
        { type: 2, style: 1, label: "Change price", custom_id: `${PREFIX.price}${id}` },
        { type: 2, style: 4, label: "Decline", custom_id: `${PREFIX.decline}${id}` }
      ]
    }]
    : [];

  return { embeds: [embed], components };
}

// ---------------------------------------------------------------- the flow

/*
 * deps:
 *   table(name)          Airtable.js table: select().all(), find, update, create
 *   getChannel(id)       a Discord text channel (send, messages.fetch)
 *   channelId            the partner's channel
 *   partnerDiscordId     mentioned on a confirmed deal (optional)
 *   lojiqDeal(body)      POST /api/internal/asia/deal; resolves its JSON or throws
 *   outsourceCheck(id)   POST outsource-engine /outsource/check
 *   now()                Date
 */
export function createAsiaPartnerFlow(deps) {
  const now = deps.now || (() => new Date());
  const ORDERS = "Unfulfilled Orders Log";
  const OFFERS = "Partner Offers";

  const ORDER_FIELDS = [
    "Order ID", "Fulfillment Status", "Most Valid Sourcing", "Dewu Checked Price", "Dewu Declined?",
    "Maximum Buying Price", "Target Buying Price", "Order Date", "Linked Inventory Unit", "Client",
    "Auto Offer Accept?", "Offer Accepted?", "Offer Denied?", "SKU", "Size", "Dewu Size Normalized",
    "Product Name", "Picture"
  ];

  async function order(id) {
    const r = await deps.table(ORDERS).find(id);
    return r.fields || {};
  }

  async function merchantOf(orderFields) {
    const id = text(orderFields.Client);
    if (!id) return {};
    const r = await deps.table("Merchants").find(id).catch(() => null);
    return r?.fields || {};
  }

  async function dewuSupplierId() {
    const rows = await deps.table("Sellers Database").select({ filterByFormula: "{Dewu Supplier?} = 1", fields: ["Seller ID"], maxRecords: 1 }).all();
    return rows[0]?.id || "";
  }

  async function redraw(offerId, status) {
    const offer = await deps.table(OFFERS).find(offerId);
    const f = offer.fields || {};
    const messageId = text(f["Discord Message ID"]);
    if (!messageId) return;
    const orderFields = await order(text(f["Linked Orders"])).catch(() => ({}));
    const channel = await deps.getChannel(text(f["Discord Channel ID"]) || deps.channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.edit(offerMessage({ offer, order: orderFields, status }));
  }

  async function tell(offerFields, orderFields, line) {
    const channel = await deps.getChannel(text(offerFields["Discord Channel ID"]) || deps.channelId);
    const who = deps.partnerDiscordId ? `<@${deps.partnerDiscordId}> ` : "";
    await channel.send({
      content: `${who}${line}\n**${text(orderFields.SKU)}** · size ${text(orderFields.Size)}${text(orderFields["Dewu Size Normalized"]) ? ` (Dewu ${text(orderFields["Dewu Size Normalized"])})` : ""} · ${euro(num(offerFields["Partner Offer"]) ?? num(offerFields["Our Ask"]) ?? 0)} · ${text(orderFields["Order ID"])}`
    });
  }

  // Back to the open flow, without Dewu.
  async function release(orderId, { clearOffer = false } = {}) {
    const fields = { "Dewu Declined?": true, "Fulfillment Status": "Outsource" };
    if (clearOffer) Object.assign(fields, { "Custom Offer": null, "Offer Sent?": false, "Offer Denied?": false });
    await deps.table(ORDERS).update(orderId, fields, { typecast: true });
    await deps.outsourceCheck(orderId).catch((err) => console.error(`[asia] outsource check ${orderId}:`, err.message));
  }

  async function setOffer(offerId, fields) {
    await deps.table(OFFERS).update(offerId, fields, { typecast: true });
  }

  // ---- 1. new orders

  async function openNew() {
    const rows = await deps.table(ORDERS).select({
      filterByFormula: "AND({Fulfillment Status} = 'Outsource', {Most Valid Sourcing} = 'Dewu', NOT({Dewu Declined?}), {Linked Inventory Unit} = BLANK(), {Dewu Checked Price} > 0)",
      fields: ORDER_FIELDS
    }).all();

    const made = [];
    for (const row of rows) {
      const f = row.fields;
      const dewu = num(f["Dewu Checked Price"]);
      const max = num(f["Maximum Buying Price"]);
      const expires = expiresAt(f["Order Date"]);

      // The Outsource Engine already said yes; these only catch a stale
      // choice (it left Dewu older orders as they were).
      if (dewu === null || max === null || dewu > ASIA_MAX_PRICE) continue;
      if (!expires || now() >= expires) continue;

      const open = await deps.table(OFFERS).select({
        filterByFormula: `AND({Order ID} & '' = '${text(f["Order ID"]).replace(/'/g, "\\'")}', OR({Asia Status} = 'Sent', {Asia Status} = 'Waiting for Store', {Asia Status} = 'Accepted'))`,
        fields: ["Asia Status"],
        maxRecords: 1
      }).all();
      if (open.length) continue;

      const minProfit = minProfitFor(await merchantOf(f));
      const partnerMax = partnerMaxFor({ max, minProfit });
      if (partnerMax < dewu) continue;

      const supplier = await dewuSupplierId();
      await deps.table(ORDERS).update(row.id, { "Fulfillment Status": "Dewu Processing" }, { typecast: true });

      const offer = await deps.table(OFFERS).create({
        "Linked Orders": [row.id],
        ...(supplier ? { "Seller ID": [supplier] } : {}),
        "Our Ask": dewu,
        "Partner Max": partnerMax,
        "Offer Date": now().toISOString(),
        "Expires At": expires.toISOString(),
        "Asia Status": "Sent",
        "Discord Channel ID": deps.channelId
      }, { typecast: true });

      await post(offer.id).catch((err) => console.error(`[asia] post ${text(f["Order ID"])}:`, err.message));
      made.push(text(f["Order ID"]));
    }
    return made;
  }

  async function post(offerId) {
    const offer = await deps.table(OFFERS).find(offerId);
    const orderFields = await order(text(offer.fields["Linked Orders"]));
    const channel = await deps.getChannel(text(offer.fields["Discord Channel ID"]) || deps.channelId);
    const message = await channel.send(offerMessage({ offer, order: orderFields, status: "Sent" }));
    await setOffer(offerId, { "Discord Message ID": message.id });
  }

  // ---- 2. offers that are still open

  async function followUp() {
    const rows = await deps.table(OFFERS).select({
      filterByFormula: "OR({Asia Status} = 'Sent', {Asia Status} = 'Waiting for Store')",
      fields: ["Asia Status", "Linked Orders", "Our Ask", "Partner Max", "Partner Offer", "Store Price", "Expires At", "Discord Message ID", "Discord Channel ID", "Partner Offer ID"]
    }).all();

    const done = [];
    for (const row of rows) {
      const f = row.fields;
      const orderId = text(f["Linked Orders"]);
      if (!orderId) continue;
      const o = await order(orderId).catch(() => null);
      if (!o) continue;

      const status = text(f["Asia Status"]);
      const orderStatus = text(o["Fulfillment Status"]);
      const expired = f["Expires At"] && now() >= new Date(f["Expires At"]);

      try {
        // Posting failed earlier: try again.
        if (status === "Sent" && !text(f["Discord Message ID"]) && orderStatus === "Dewu Processing" && !expired) {
          await post(row.id);
          continue;
        }

        if (status === "Waiting for Store" && !text(o["Linked Inventory Unit"]) && (o["Offer Accepted?"] || orderStatus === "Confirmed")) {
          await deps.lojiqDeal({ order_record_id: orderId, payout: num(f["Partner Offer"]), store_price: num(f["Store Price"]) });
          await setOffer(row.id, { "Asia Status": "Accepted" });
          await redraw(row.id, "Accepted");
          await tell(f, o, "✅ **Deal confirmed** - please buy:");
          done.push([text(o["Order ID"]), "Accepted"]);
          continue;
        }

        if (status === "Waiting for Store" && o["Offer Denied?"]) {
          await setOffer(row.id, { "Asia Status": "Store Declined" });
          await release(orderId, { clearOffer: true });
          await redraw(row.id, "Store Declined");
          await tell(f, o, "❌ **No deal** - the store declined, do not buy:");
          done.push([text(o["Order ID"]), "Store Declined"]);
          continue;
        }

        const stillOurs = status === "Sent" ? orderStatus === "Dewu Processing" : ["Dewu Processing", "Confirmed"].includes(orderStatus);
        if (!stillOurs || text(o["Linked Inventory Unit"])) {
          await setOffer(row.id, { "Asia Status": "Cancelled" });
          await redraw(row.id, "Cancelled");
          if (status === "Waiting for Store") await tell(f, o, "❌ **No deal** - the order was handled another way, do not buy:");
          done.push([text(o["Order ID"]), "Cancelled"]);
          continue;
        }

        if (expired) {
          await setOffer(row.id, { "Asia Status": "Expired" });
          await release(orderId, { clearOffer: status === "Waiting for Store" });
          await redraw(row.id, "Expired");
          if (status === "Waiting for Store") await tell(f, o, "⌛ **No deal** - the store did not answer in time, do not buy:");
          done.push([text(o["Order ID"]), "Expired"]);
        }
      } catch (err) {
        console.error(`[asia] ${text(o["Order ID"])}:`, err.message);
      }
    }
    return done;
  }

  let sweeping = false;

  async function sweep() {
    if (sweeping) return { made: [], done: [] };
    sweeping = true;
    try {
      return await sweepOnce();
    } finally {
      sweeping = false;
    }
  }

  async function sweepOnce() {
    const made = await openNew();
    const done = await followUp();
    if (made.length || done.length) console.log(`[asia] sent ${made.join(", ") || "-"}; ${done.map(([id, s]) => `${id} ${s}`).join(", ")}`);
    return { made, done };
  }

  // ---- 3. the partner's buttons

  // One answer per offer at a time: a double click must not make two pairs.
  const busy = new Set();

  async function settle(offerId, price) {
    if (busy.has(offerId)) return { ok: false, say: "Already being handled - one moment." };
    busy.add(offerId);
    try {
      return await settleOnce(offerId, price);
    } finally {
      busy.delete(offerId);
    }
  }

  // His answer at `price`. Resolves the line he sees.
  async function settleOnce(offerId, price) {
    const offer = await deps.table(OFFERS).find(offerId);
    const f = offer.fields || {};
    if (text(f["Asia Status"]) !== "Sent") return { ok: false, say: "This offer is closed." };
    if (f["Expires At"] && now() >= new Date(f["Expires At"])) return { ok: false, say: "This offer has expired." };

    const partnerMax = num(f["Partner Max"]);
    if (!(price > 0)) return { ok: false, say: "Enter a price above €0." };
    if (partnerMax !== null && price > partnerMax) return { ok: false, say: `The most we can pay for this pair is ${euro(partnerMax)}. Enter ${euro(partnerMax)} or less, or decline.` };

    const orderId = text(f["Linked Orders"]);
    const o = await order(orderId);
    if (text(o["Fulfillment Status"]) !== "Dewu Processing" || text(o["Linked Inventory Unit"])) {
      await setOffer(offerId, { "Asia Status": "Cancelled" });
      return { ok: false, say: "This order is no longer available.", status: "Cancelled" };
    }

    const merchant = await merchantOf(o);
    const storePrice = storePriceFor({
      target: num(o["Target Buying Price"]) ?? 0,
      max: num(o["Maximum Buying Price"]),
      dewu: num(f["Our Ask"]),
      partnerPrice: price,
      minProfit: minProfitFor(merchant)
    });

    const automatic = text(o["Auto Offer Accept?"]).toLowerCase() === "yes";

    if (automatic) {
      await deps.lojiqDeal({ order_record_id: orderId, payout: price, store_price: storePrice });
      await setOffer(offerId, { "Asia Status": "Accepted", "Partner Offer": price, "Store Price": storePrice });
      const fresh = (await deps.table(OFFERS).find(offerId)).fields;
      await tell(fresh, o, "✅ **Deal confirmed** - please buy:");
      return { ok: true, status: "Accepted" };
    }

    // The store answers first; the Custom Offer goes out as an offer.
    await deps.table(ORDERS).update(orderId, {
      "Custom Offer": storePrice,
      "Offer VAT Type": "Margin",
      "Offer Accepted?": false,
      "Offer Denied?": false,
      "Offer Sent?": true,
      "Estimated Time": ASIA_ESTIMATED_TIME,
      offer_request_webhook_key: ""
    }, { typecast: true });
    await setOffer(offerId, { "Asia Status": "Waiting for Store", "Partner Offer": price, "Store Price": storePrice });
    return { ok: true, status: "Waiting for Store" };
  }

  async function decline(offerId) {
    const offer = await deps.table(OFFERS).find(offerId);
    if (text(offer.fields["Asia Status"]) !== "Sent") return { ok: false, say: "This offer is closed." };
    await setOffer(offerId, { "Asia Status": "Declined" });
    const orderId = text(offer.fields["Linked Orders"]);
    const o = await order(orderId);
    if (text(o["Fulfillment Status"]) === "Dewu Processing") await release(orderId);
    return { ok: true, status: "Declined" };
  }

  const isOurs = (customId) => Object.values(PREFIX).some((p) => String(customId || "").startsWith(p));

  async function onInteraction(interaction) {
    const customId = String(interaction.customId || "");
    if (!isOurs(customId)) return false;
    const offerId = customId.split(":")[1] || "";

    // His buttons only.
    if (deps.partnerDiscordId && interaction.user?.id && interaction.user.id !== deps.partnerDiscordId && !(deps.adminDiscordIds || []).includes(interaction.user.id)) {
      await interaction.reply({ content: "This offer is not for you.", ephemeral: true }).catch(() => {});
      return true;
    }

    try {
      if (customId.startsWith(PREFIX.price)) {
        const offer = await deps.table(OFFERS).find(offerId);
        await interaction.showModal({
          title: "Your price",
          custom_id: `${PREFIX.priceModal}${offerId}`,
          components: [{
            type: 1,
            components: [{
              type: 4,
              custom_id: "asia_price",
              label: `Your price in € (max ${num(offer.fields["Partner Max"]) ?? ""})`,
              style: 1,
              min_length: 1,
              max_length: 8,
              placeholder: String(num(offer.fields["Our Ask"]) ?? ""),
              required: true
            }]
          }]
        });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });

      let out;
      if (customId.startsWith(PREFIX.accept)) {
        const offer = await deps.table(OFFERS).find(offerId);
        out = await settle(offerId, num(offer.fields["Our Ask"]));
      } else if (customId.startsWith(PREFIX.priceModal)) {
        const raw = interaction.fields.getTextInputValue("asia_price");
        out = await settle(offerId, Number(String(raw).replace(/[^\d.,]/g, "").replace(",", ".")));
      } else {
        out = await decline(offerId);
      }

      if (out.status) await redraw(offerId, out.status).catch((err) => console.error("[asia] redraw:", err.message));

      const said = out.ok
        ? { Accepted: "Deal confirmed - please buy this pair.", "Waiting for Store": "Noted and sent to the store. This is not a deal yet; you get a confirmation here once it is.", Declined: "Declined. Thank you." }[out.status]
        : out.say;
      await interaction.editReply({ content: said || "Done." });
    } catch (err) {
      console.error(`[asia] ${customId}:`, err.message);
      const reply = { content: `Something went wrong: ${err.message}` };
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
      else await interaction.reply({ ...reply, ephemeral: true }).catch(() => {});
    }
    return true;
  }

  return { sweep, openNew, followUp, settle, decline, onInteraction, isOurs };
}
