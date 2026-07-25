import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Airtable from "airtable";
import compression from "compression";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import { createClient } from "@supabase/supabase-js";
import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits
} from "discord.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  MOLLIE_API_KEY,
  AIRTABLE_PAYMENT_BATCHES_TABLE = "Payment Batches",
  APP_URL = "https://www.kickzcaviar.com",
  SENDGRID_API_KEY,
  RESET_EMAIL_FROM,
  APP_PUBLIC_BASE_URL = "https://kickz-caviar-portal.onrender.com",
  LOJIQ_WMS_BASE_URL = "https://lojiq-wms.onrender.com",
  SELLER_SIGNUP_URL = "https://discord.com/channels/922818998163361792/1444130166703128676",
  DISCORD_BOT_BASE_URL,
  KICKZ_WTB_BOT_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RETAILED_STOCKX_SEARCH_URL,
  RETAILED_API_KEY,
  STOCKX_API_KEY,
  STOCKX_CLIENT_ID,
  STOCKX_CLIENT_SECRET,
  STOCKX_REFRESH_TOKEN,
  AIRTABLE_DISCORD_UPDATES_URL = "https://airtable-discord-updates.onrender.com",
  COUNTER_OFFERS_SECRET,
  MEMBER_WTB_POST_CHANNEL_ID,
  BUYING_KC_CONFIRMATION_CHANNEL_ID,
  BUYING_KC_OFFER_REQUESTS_CHANNEL_ID
} = process.env;

const AIRTABLE_ORDERS_TABLE = "Unfulfilled Orders Log";
const AIRTABLE_INVENTORY_UNITS_TABLE = "Inventory Units";
const AIRTABLE_CONSIGNMENT_APPLICATIONS_TABLE = "Consignment Applications";
const ORDERS_TABLE = process.env.AIRTABLE_ORDERS_TABLE || "Unfulfilled Orders Log";
const SELLERS_TABLE = process.env.AIRTABLE_SELLERS_TABLE || "Sellers Database";
const DISCORD_SERVER_ID = "922818998163361792";
const KICKZ_DEAL_SERVER_ID = "922818998163361792";
const CONSIGNMENT_DEAL_CATEGORY_ID = "1339532824000335883";
const KICKZ_ADMIN_ROLE_ID = "942779423449579530";
const AIRTABLE_CONSIGNMENT_CREATED_CHANNEL_ID_FIELD = "Consignment Created Channel ID";
const INVENTORY_UNITS_TABLE = process.env.AIRTABLE_INVENTORY_UNITS_TABLE || "Inventory Units";
const SELLER_OFFERS_TABLE = process.env.AIRTABLE_SELLER_OFFERS_TABLE || "Seller Offers";
const COUNTER_OFFERS_TABLE =
  process.env.AIRTABLE_COUNTER_OFFERS_TABLE || "Counter Offers";
const COUNTER_OFFER_ACCEPT_WEBHOOK_URL =
  process.env.COUNTER_OFFER_ACCEPT_WEBHOOK_URL || "";
const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const STOCKX_ACCESS_TOKEN_TABLE =
  process.env.AIRTABLE_STOCKX_ACCESS_TOKEN_TABLE || "StockX Access Token";
const STOCK_LEVELS_TABLE = process.env.AIRTABLE_STOCK_LEVELS_TABLE || "Stock Levels";
const MERCHANTS_TABLE = process.env.AIRTABLE_MERCHANTS_TABLE || "Merchants";
const MEMBER_WTBS_TABLE = process.env.AIRTABLE_MEMBER_WTBS_TABLE || "Member WTBs";

const PAYMENT_BATCHES_TABLE =
  AIRTABLE_PAYMENT_BATCHES_TABLE || "Payment Batches";

const memberWtbPaymentLocks = new Map();

async function withMemberWtbPaymentLock(
  memberWtbRecordId,
  callback
) {
  const existingLock =
    memberWtbPaymentLocks.get(memberWtbRecordId);

  if (existingLock) {
    return existingLock;
  }

  const lockPromise = Promise.resolve()
    .then(callback)
    .finally(() => {
      if (
        memberWtbPaymentLocks.get(
          memberWtbRecordId
        ) === lockPromise
      ) {
        memberWtbPaymentLocks.delete(
          memberWtbRecordId
        );
      }
    });

  memberWtbPaymentLocks.set(
    memberWtbRecordId,
    lockPromise
  );

  return lockPromise;
}

function mollieMoney(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid Mollie payment amount");
  }

  return amount.toFixed(2);
}

async function mollieRequest(pathname, options = {}) {
  if (!MOLLIE_API_KEY) {
    throw new Error("Missing MOLLIE_API_KEY");
  }

  const response = await fetch(
    `https://api.mollie.com/v2${pathname}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.detail ||
      data.title ||
      data.message ||
      `Mollie request failed with status ${response.status}`
    );

    error.statusCode = response.status;
    error.mollieResponse = data;

    throw error;
  }

  return data;
}

const BUYING_KC_DELIVERY_TIME = "1-2 business days";
const BUYING_CONSIGNMENT_DELIVERY_TIME = "1-2 business days";
const BUYING_MASTER_CACHE_TTL_MS = 2 * 60 * 1000;

const buyingMasterCache = {
  createdAt: 0,
  sources: null,
  refreshPromise: null
};

const CONSIGNMENT_APPLICATIONS_BUCKET =
  process.env.CONSIGNMENT_APPLICATIONS_BUCKET ||
  "consignment-applications";

if (!AIRTABLE_TOKEN) {
  throw new Error("Missing AIRTABLE_TOKEN");
}

if (!AIRTABLE_BASE_ID) {
  throw new Error("Missing AIRTABLE_BASE_ID");
}

const airtable = new Airtable({
  apiKey: AIRTABLE_TOKEN
}).base(AIRTABLE_BASE_ID);

if (!SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const SUPABASE_CSV_IMPORT_JOBS_TABLE = "csv_import_jobs";

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ]
});

const kickzDealDiscordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let discordReady = false;
let kickzDealDiscordReady = false;
let consignmentButtonsBound = false;
let kickzDealButtonsBound = false;
let memberWtbCreationBound = false;
let memberWtbCsvUploadsBound = false;

// FIXED — pre-existing race condition (confirmed present in the original
// uploaded code, not introduced here): both init functions below used a
// "ready" boolean that was only set AFTER `await client.login(...)`
// resolved. If two requests called initKickzDealDiscord() around the
// same time, both could see `kickzDealDiscordReady === false` and BOTH
// proceed to call .login() and bind the interaction handler — resulting
// in the SAME button click being processed twice by two separate
// listeners on the same client, which is exactly what produces
// "InteractionAlreadyReplied" errors (first listener succeeds, second
// fails because the interaction was already acknowledged).
//
// Fix: cache the in-flight PROMISE itself, not just a boolean. Every
// concurrent caller then awaits the exact same promise, so login and
// button-binding can only ever happen once, no matter how many requests
// arrive while it's still starting up.
let discordInitPromise = null;
let kickzDealDiscordInitPromise = null;

const memberWtbDiscordInventoryTypes = new Map();

const MEMBER_WTB_DISCORD_DEFAULT_INVENTORY_TYPE = "all";

const MEMBER_WTB_DISCORD_PANEL_BUTTON_ID =
  "member_wtb_discord_create";

const MEMBER_WTB_DISCORD_INVENTORY_SELECT_ID =
  "member_wtb_discord_inventory_type";

const MEMBER_WTB_DISCORD_MODAL_PREFIX =
  "member_wtb_discord_modal:";

async function initDiscord() {
  if (discordReady) return;

  if (discordInitPromise) {
    await discordInitPromise;
    return;
  }

  discordInitPromise = (async () => {
    if (!process.env.DISCORD_BOT_TOKEN) {
      throw new Error("Missing DISCORD_BOT_TOKEN");
    }

    await discordClient.login(process.env.DISCORD_BOT_TOKEN);

    discordReady = true;

    if (!consignmentButtonsBound) {
      bindConsignmentDiscordButtons(discordClient);
      consignmentButtonsBound = true;
    }

    console.log("✅ Discord bot logged in");
  })();

  try {
    await discordInitPromise;
  } finally {
    discordInitPromise = null;
  }
}

async function initKickzDealDiscord() {
  if (kickzDealDiscordReady) return;

  if (kickzDealDiscordInitPromise) {
    await kickzDealDiscordInitPromise;
    return;
  }

  kickzDealDiscordInitPromise = (async () => {
    if (!process.env.KICKZ_DEAL_DISCORD_BOT_TOKEN) {
      throw new Error("Missing KICKZ_DEAL_DISCORD_BOT_TOKEN");
    }

    await kickzDealDiscordClient.login(
      process.env.KICKZ_DEAL_DISCORD_BOT_TOKEN
    );

    kickzDealDiscordReady = true;

    if (!kickzDealButtonsBound) {
      bindConsignmentDiscordButtons(kickzDealDiscordClient);
      kickzDealButtonsBound = true;
    }

    if (!memberWtbCreationBound) {
      bindMemberWtbDiscordCreation(
        kickzDealDiscordClient
      );
    
      memberWtbCreationBound = true;
    }
    
    if (!memberWtbCsvUploadsBound) {
      bindMemberWtbDiscordCsvUploads(
        kickzDealDiscordClient
      );
    
      memberWtbCsvUploadsBound = true;
    }

    console.log("✅ Kickz deal Discord bot logged in");
  })();

  try {
    await kickzDealDiscordInitPromise;
  } finally {
    kickzDealDiscordInitPromise = null;
  }
}

async function createConsignmentInventoryUnitFromOffer(offer) {
  const purchasePrice = Number(offer.offer_price);

  const inventoryFields = {
    "Product Name": offer.product_name,
    "SKU": offer.sku,
    "Size": offer.size,
    "Brand": offer.brand,
  
    "VAT Type": offer.vat_type,
    "Purchase Price": purchasePrice,
    "Shipping Deduction": 0,
    "Purchase Date": new Date().toLocaleDateString("en-CA"),
  
    "Seller ID": [offer.seller_record_id],
    "Ticket Number": offer.order_id,
  
    "Type": "Consignment",
    "Source": "Regular",
    "Verification Status": "Consigned",
    "Payment Note": `€${purchasePrice.toFixed(2)}`,
    "Payment Status": "To Pay",
    "Availability Status": "Sold",
    "Margin %": "7.5%",
    "Base Costs": 5
  };

  if (Number(offer.selling_price || 0) > 0) {
    inventoryFields["Selling Price"] = Number(offer.selling_price);
  }
  
  if (offer.selling_method) {
    inventoryFields["Selling Method"] = offer.selling_method;
  }
  
  if (asText(offer.source_type) === "member_wtb") {
    inventoryFields["Member WTBs"] = [offer.member_wtb_record_id];
  } else if (offer.order_record_id) {
    inventoryFields["Unfulfilled Orders Log"] = [offer.order_record_id];
  }

  const created = await airtable(AIRTABLE_INVENTORY_UNITS_TABLE).create(
    inventoryFields
  );

  if (asText(offer.source_type) !== "member_wtb") {
    await fetch("https://hook.eu2.make.com/cmq6wlbq5sa9spmwogy4pdordvjzuz4i", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: "consignment_inventory_unit_created",
        inventory_unit_record_id: created.id,
        offer_id: offer.id,
  
        product_name: offer.product_name,
        sku: offer.sku,
        size: offer.size,
        brand: offer.brand,
        vat_type: offer.vat_type,
  
        purchase_price: purchasePrice,
        shipping_deduction: 0,
        purchase_date: inventoryFields["Purchase Date"],
  
        seller_record_id: offer.seller_record_id,
        seller_id: offer.seller_id,
  
        ticket_number: offer.order_id,
        order_id: offer.order_id,
        order_record_id: offer.order_record_id,
        source_type: asText(offer.source_type) || "order",
        member_wtb_record_id: asText(offer.member_wtb_record_id),
  
        type: "Consignment",
        source: "Regular",
        verification_status: "Consigned",
        payment_note: `€${purchasePrice.toFixed(2)}`,
        payment_status: "To Pay",
        availability_status: "Sold",
        margin: "7.5%",
        base_costs: 5,
  
        airtable_fields: inventoryFields,
        created_at: new Date().toISOString()
      })
    });
  }

  return created;
}

if (!SENDGRID_API_KEY) {
  throw new Error("Missing SENDGRID_API_KEY");
}

if (!RESET_EMAIL_FROM) {
  throw new Error("Missing RESET_EMAIL_FROM");
}

sgMail.setApiKey(SENDGRID_API_KEY);

function asText(value) {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return "";
        if (typeof item === "object") {
          return item.name || item.text || item.value || "";
        }
        return String(item);
      })
      .filter(Boolean)
      .join(", ")
      .trim();
  }

  return String(value).trim();
}

function getMemberWtbNetSalePrice(price, vatType, inventoryFilter) {
  const amount = Number(price || 0);
  const type = asText(vatType);
  const filter = asText(inventoryFilter).toLowerCase();

  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (type === "VAT0" || type === "VAT21") {
    if (filter.includes("b2b")) {
      return amount;
    }

    return Math.round((amount / 1.21) * 100) / 100;
  }

  return amount;
}

function getSellerOfferChannelId(sellerRow, isConfirmation) {
  if (!sellerRow) return null;

  return isConfirmation
    ? sellerRow.consignment_confirmation_channel_id
    : sellerRow.consignment_offer_channel_id;
}

function buildCompactConsignmentOfferEmbed({ offer, isConfirmation }) {
  return {
    title: isConfirmation
      ? `🚀 Match: ${offer.sku} / ${offer.size}`
      : `💸 Offer: ${offer.sku} / ${offer.size}`,

    description: [
      `**${offer.product_name || "—"}**`,
      `Your price: €${Number(offer.seller_price).toFixed(2)} → Offer: €${Number(offer.offer_price).toFixed(2)} · ${offer.vat_type || "—"}`,
      "",
      "Confirm if still available."
    ].join("\n"),

    color: isConfirmation ? 0x2ecc71 : 0xf1c40f,

    footer: {
      text: `Order: ${offer.order_id || offer.order_record_id || "—"}`
    }
  };
}

function buildCompactConsignmentDealUpdateEmbed({ offer }) {
  return {
    title: `📦 Ship: ${offer.sku} / ${offer.size}`,

    description: [
      `**${offer.product_name || "—"}**`,
      `€${Number(offer.offer_price || 0).toFixed(2)} · ${offer.vat_type || "—"}`,
      "",
      "Sale confirmed. Request your label below."
    ].join("\n"),

    color: 0x2ecc71,

    footer: {
      text: `Order: ${offer.order_id || offer.order_record_id || "—"}`
    }
  };
}

async function sendConsignmentOfferDiscordMessage({
  seller,
  offer,
  calculatedOfferPrice
}) {
  await initDiscord();

  const isMemberWtbOffer = asText(offer.source_type) === "member_wtb";

  const sellerComparePrice = isMemberWtbOffer
    ? Number(offer.seller_price || 0)
    : getConsignmentComparePrice(
        offer.seller_price,
        offer.vat_type
      );

  const isConfirmation =
    sellerComparePrice <= Number(calculatedOfferPrice);

  const privateChannelId = getSellerOfferChannelId(
    seller,
    isConfirmation
  );

  let target = null;
  let deliveryType = "private_channel";

  if (privateChannelId) {
    target = await discordClient.channels.fetch(privateChannelId);

    if (!target) {
      throw new Error(`Discord channel not found: ${privateChannelId}`);
    }
  } else {
    await initKickzDealDiscord();
  
    const discordUserId = asText(seller?.discord_id);
  
    if (!discordUserId) {
      throw new Error(
        `Missing Discord ID for seller ${seller?.seller_id || offer.seller_id}`
      );
    }
  
    const user = await kickzDealDiscordClient.users.fetch(discordUserId);
    target = await user.createDM();
    deliveryType = "dm";
  }

  const embed = deliveryType === "dm"
    ? buildCompactConsignmentOfferEmbed({
        offer,
        isConfirmation
      })
    : {
        title: isConfirmation
          ? "🚀 Your Item Matched One Of Our Orders"
          : "💸 We Got An Offer For Your Item",
  
        description: [
          "If you still have this pair, click **Confirm** below.",
          "",
          "**Product Name**",
          offer.product_name || "—",
          "",
          "**SKU**",
          offer.sku || "—",
          "",
          "**Size**",
          offer.size || "—",
          "",
          "**Order**",
          offer.order_id || offer.order_record_id || "—"
        ].join("\n"),
  
        color: isConfirmation ? 0x2ecc71 : 0xf1c40f,
  
        fields: [
          {
            name: "Your Price",
            value: `€${Number(offer.seller_price).toFixed(2)}`,
            inline: true
          },
          {
            name: isConfirmation ? "Matched At" : "Our Offer",
            value: `€${Number(offer.offer_price).toFixed(2)}`,
            inline: true
          }
        ],
  
        footer: {
          text: `SellerID: ${offer.seller_id}`
        },
  
        timestamp: new Date().toISOString()
      };

  const message = await target.send({
    content: deliveryType === "dm"
      ? null
      : isConfirmation
        ? `📋 Match found for ${offer.sku} / ${offer.size}`
        : `📑 Offer sent for ${offer.sku} / ${offer.size}`,

    embeds: [embed],

    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: isConfirmation ? "Confirm" : "Accept",
            custom_id: `confirm_offer:${offer.id}`
          },
          ...(!isConfirmation && asText(offer.source_type) !== "member_wtb"
            ? [
                {
                  type: 2,
                  style: 1,
                  label: "Counter",
                  custom_id: `counter_consignment_offer:${offer.id}`
                }
              ]
            : []),
          {
            type: 2,
            style: 4,
            label: "Deny",
            custom_id: `deny_offer:${offer.id}`
          }
        ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType
  };
}

// NEW — additive only: notifies the consignor when the store counters
// back on their counter (starting round 2+ of the ping-pong). Same
// private-channel-vs-DM routing as sendConsignmentOfferDiscordMessage
// above, and same confidentiality rule as Store Orders/Member WTB: only
// shows the consignor-facing (already margin-converted) amount, never
// the store's raw all-in price or our margin.
async function sendConsignmentCounterOfferDiscordMessage({
  offer,
  storeOfferPrice,
  storeOfferVatType,
  yourPreviousCounter,
  noRoomToCounter,
  deniedAmount
}) {
  await initDiscord();

  const sellerRecord = await airtable(SELLERS_TABLE).find(offer.seller_record_id);
  const seller = normalizeSeller(sellerRecord);

  const privateChannelId = getSellerOfferChannelId(seller, false);

  let target = null;
  let deliveryType = "private_channel";

  if (privateChannelId) {
    target = await discordClient.channels.fetch(privateChannelId);
    if (!target) {
      throw new Error(`Discord channel not found: ${privateChannelId}`);
    }
  } else {
    await initKickzDealDiscord();

    const discordUserId = asText(seller?.discord_id);
    if (!discordUserId) {
      throw new Error(`Missing Discord ID for seller ${seller?.seller_id || offer.seller_id}`);
    }

    const user = await kickzDealDiscordClient.users.fetch(discordUserId);
    target = await user.createDM();
    deliveryType = "dm";
  }

  // FIXED — caught my own mistake before shipping it: this must NOT
  // pass an empty {} for orderFields, since that's the exact same
  // silent-margin-lookup-failure bug found and fixed multiple times
  // earlier in this build (Store Orders, Member WTB). Fetch the real
  // order fields so the margin/percentage lookup actually works.
  const orderRecordForNotify = await airtable(ORDERS_TABLE).find(offer.order_record_id);
  const orderFieldsForNotify = orderRecordForNotify.fields || {};
  const clientCountryForNotify = asText(orderFieldsForNotify["Client Country"]);

  const consignorEquivalent = convertStoreBasePriceToConsignorPrice(
    calculateConsignmentBaseFromStoreOffer(storeOfferPrice, orderFieldsForNotify),
    offer.vat_type,
    clientCountryForNotify
  );

  const closingLine = noRoomToCounter
    ? "You're now very close to each other's price — there's no room for another counter. Please accept or deny."
    : "Please accept, counter, or deny below.";

  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? [`❌ Your counter of €${Number(deniedAmount).toFixed(2)} was denied.`, ""]
      : [];

  const embed = {
    title: "🔁 Store Countered",
    description: [
      `**${offer.product_name || "—"}**`,
      `SKU: ${offer.sku || "—"}`,
      `Size: ${offer.size || "—"}`,
      "",
      `Order: ${offer.order_id || offer.order_record_id || "—"}`,
      "",
      ...deniedNote,
      `The store sent a counter offer.`,
      "",
      `**Your Previous Counter**`,
      `€${Number(yourPreviousCounter).toFixed(2)}`,
      "",
      `**New Counter**`,
      `€${Number(consignorEquivalent).toFixed(2)}`,
      "",
      closingLine
    ].join("\n"),
    color: 0xf1c40f
  };

  const message = await target.send({
    content: deliveryType === "dm" ? null : undefined,
    embeds: [embed],
    components: [
      {
        type: 1,
        components: noRoomToCounter
          ? [
              { type: 2, style: 3, label: "Accept", custom_id: `consignment_counter_accept:${offer.id}` },
              { type: 2, style: 4, label: "Deny", custom_id: `consignment_counter_deny:${offer.id}` }
            ]
          : [
              { type: 2, style: 3, label: "Accept", custom_id: `consignment_counter_accept:${offer.id}` },
              { type: 2, style: 1, label: "Counter", custom_id: `consignment_counter_counter:${offer.id}` },
              { type: 2, style: 4, label: "Deny", custom_id: `consignment_counter_deny:${offer.id}` }
            ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType
  };
}


async function disableCounterOfferDiscordButtons(channelId, messageId, note) {
  await initKickzDealDiscord();

  const channel = await kickzDealDiscordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;

  await message.edit({
    content: note || message.content,
    embeds: message.embeds,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: "Accepted",
            custom_id: "counter_offer_accepted_disabled",
            disabled: true
          },
          {
            type: 2,
            style: 2,
            label: "Denied",
            custom_id: "counter_offer_denied_disabled",
            disabled: true
          }
        ]
      }
    ]
  });

  return true;
}

async function disableConsignmentDiscordButtons(channelId, messageId, note, preferredClient = null) {
  const clients = preferredClient
    ? [preferredClient]
    : [discordClient, kickzDealDiscordClient];

  for (const client of clients) {
    try {
      if (!client?.isReady?.()) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);

      if (!channel) continue;

      const message = await channel.messages.fetch(messageId).catch(() => null);

      if (!message) continue;

      await message.edit({
        content: note || message.content,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: "Confirmed",
                custom_id: "consignment_confirmed_disabled",
                disabled: true
              },
              {
                type: 2,
                style: 2,
                label: "Denied",
                custom_id: "consignment_denied_disabled",
                disabled: true
              }
            ]
          }
        ]
      });

      return true;
    } catch (err) {
      console.error("Failed to disable consignment buttons with client:", err);
    }
  }

  console.error("Failed to disable consignment buttons: message not found", {
    channelId,
    messageId
  });

  return false;
}

async function disableMemberWtbKcOfferButtons(memberWtbRecordId, note) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  const channelId = asText(f["KC Offer Channel ID"]);
  const messageId = asText(f["KC Offer Message ID"]);

  if (!channelId || !messageId) return false;

  await initKickzDealDiscord();

  const channel = await kickzDealDiscordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;

  await message.edit({
    content: note || "❌ This Member WTB is no longer available.",
    embeds: message.embeds,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: "Closed",
            custom_id: "kc_offer_closed_disabled",
            disabled: true
          }
        ]
      }
    ]
  });

  return true;
}

function firstLinkedRecordId(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) return "";
    if (typeof first === "string") return first;
    return first.id || "";
  }

  if (typeof value === "string") return value;

  return "";
}

function buildMemberWtbReadyToShipEmbed({ memberFields, payout, compact = false }) {
  if (compact) {
    return {
      title: "📦 Ready to Ship",
      description: [
        "💶 **Payout**",
        `Final payout: €${Number(payout || 0).toFixed(2)}`,
        "",
        "📦 **Next Step**",
        "Click **Request Label** when you are ready to ship.",
        "",
        "📬 **Packaging Instructions**",
        "Use a clean, unbranded box.",
        "Remove all price tags.",
        "No extra items inside."
      ].join("\n"),
      color: 0x2ecc71,
      footer: {
        text: "Kickz Caviar"
      }
    };
  }

  const memberWtbId =
    asText(memberFields["Member WTB ID"]) ||
    asText(memberFields["WTB ID"]) ||
    "Member WTB";

  return {
    title: "📦 Ready To Ship",
    description: [
      `**Member WTB:** ${memberWtbId}`,
      "",
      `**Product:** ${asText(memberFields["Product Name"]) || "—"}`,
      `**SKU:** ${asText(memberFields["SKU"]) || "—"}`,
      `**Size:** ${asText(memberFields["Size"]) || "—"}`,
      `**Brand:** ${asText(memberFields["Brand"]) || "—"}`,
      "",
      `**Final payout:** €${Number(payout || 0).toFixed(2)}`,
      "",
      "Click **Request Label** when you are ready to ship."
    ].join("\n"),
    color: 0x2ecc71,
    footer: {
      text: "Kickz Caviar"
    },
    timestamp: new Date().toISOString()
  };
}

async function sendMemberWtbReadyToShipToChannel({
  channel,
  sellerDiscordId,
  memberWtbRecordId,
  memberFields,
  payout,
  compact = false
}) {
  const message = await channel.send({
    content: sellerDiscordId ? `<@${sellerDiscordId}>` : null,
    embeds: [
      buildMemberWtbReadyToShipEmbed({
        memberFields,
        payout,
        compact
      })
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Request Label",
            custom_id: `request_member_wtb_label:${memberWtbRecordId}`
          }
        ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id
  };
}

async function sendMemberWtbLabelRequestToBuyer(memberWtbRecordId) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  const buyerRecordId = firstLinkedRecordId(f["Buyer Seller ID"]);

  if (!buyerRecordId) {
    throw new Error("Member WTB missing Buyer Seller ID");
  }

  const buyerRecord = await airtable(SELLERS_TABLE).find(buyerRecordId);
  const buyer = normalizeSeller(buyerRecord);

  const discordUserId = asText(
    buyer.discord_id ||
    buyer.discord_user_id ||
    buyer.discord_id_raw ||
    buyerRecord.fields?.["Discord User ID"]
  );

  if (!discordUserId) {
    throw new Error("Buyer is missing Discord ID");
  }

  await initKickzDealDiscord();

  const memberWtbId =
    asText(f["Member WTB ID"]) ||
    asText(f["WTB ID"]) ||
    memberWtbRecordId;

  const uploadUrl = `${APP_PUBLIC_BASE_URL}/member-wtb-label-request.html?member_wtb_id=${encodeURIComponent(memberWtbRecordId)}`;

  const user = await kickzDealDiscordClient.users.fetch(discordUserId);
  const dm = await user.createDM();

  const message = await dm.send({
    embeds: [
      {
        title: "📦 Shipping Label Requested",
        description: [
          `**Order Number:** ${memberWtbId}`,
          "",
          `**Product:** ${asText(f["Product Name"]) || "—"}`,
          `**SKU:** ${asText(f["SKU"]) || "—"}`,
          `**Size:** ${asText(f["Size"]) || "—"}`,
          "",
          "The seller is ready to ship.",
          "Please upload the shipping label and tracking number using the button below."
        ].join("\n"),
        color: 0xf1c40f,
        timestamp: new Date().toISOString()
      }
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Upload Shipping Label",
            url: uploadUrl
          }
        ]
      }
    ]
  });

  await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
    "Label Requested At": new Date().toISOString()
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    url: uploadUrl
  };
}

async function sendMemberWtbDealUpdateAfterPayment(memberWtbRecordId) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  const linkedInventoryUnitId = firstLinkedRecordId(f["Linked Inventory Unit"]);
  const selectedSourceType = asText(f["Buying Selected Source Type"]);
  const selectedSourceTypeKey = selectedSourceType.toLowerCase();

  if (!linkedInventoryUnitId) {
    console.log("Skipping Member WTB deal update: missing Linked Inventory Unit", {
      memberWtbRecordId
    });
    return {
      skipped: true,
      reason: "missing_inventory_unit"
    };
  }

  const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).find(linkedInventoryUnitId);
  const inventoryFields = inventoryUnit.fields || {};

  const sellerRecordId = firstLinkedRecordId(inventoryFields["Seller ID"]);
  const payout =
    Number(inventoryFields["Purchase Price"] || 0) ||
    Number(f["Current Lowest Source Price"] || 0) ||
    Number(f["Final Buying Price"] || 0);

  /*
    KC Owned:
    - No seller needs a Ready To Ship embed.
    - Buyer should receive label upload DM directly.
  */
  if (
    !sellerRecordId ||
    selectedSourceTypeKey.includes("kc") ||
    selectedSourceTypeKey.includes("owned")
  ) {
    await sendMemberWtbLabelRequestToBuyer(memberWtbRecordId);

    return {
      ok: true,
      type: "kc_owned",
      action: "buyer_label_request_sent"
    };
  }

  const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId);
  const seller = normalizeSeller(sellerRecord);
  const sellerFields = sellerRecord.fields || {};

  const sellerDiscordId = asText(
    seller.discord_id ||
    seller.discord_user_id ||
    seller.discord_id_raw ||
    sellerFields["Discord User ID"]
  );

  /*
    WTB Seller winner:
    - WTB bot already created a Member WTB deal channel
    - Member WTB field WTB Created Channel ID should contain that channel
  */
  const memberWtbDealChannelId = asText(f["WTB Created Channel ID"]);

  if (memberWtbDealChannelId) {
    await initKickzDealDiscord();

    const channel = await kickzDealDiscordClient.channels
      .fetch(memberWtbDealChannelId)
      .catch(() => null);

    if (!channel) {
      throw new Error(`Member Created WTB deal channel not found: ${memberWtbDealChannelId}`);
    }

    return await sendMemberWtbReadyToShipToChannel({
      channel,
      sellerDiscordId,
      memberWtbRecordId,
      memberFields: f,
      payout,
      compact: true
    });
  }

  /*
    Consignment private-channel winner:
    - Use seller Deal Updates channel if it exists.
  */
  const privateDealUpdatesChannelId = asText(seller.deal_updates_channel_id);

  if (privateDealUpdatesChannelId) {
    await initDiscord();

    const channel = await discordClient.channels
      .fetch(privateDealUpdatesChannelId)
      .catch(() => null);

    if (!channel) {
      throw new Error(`Deal Updates channel not found: ${privateDealUpdatesChannelId}`);
    }

    return await sendMemberWtbReadyToShipToChannel({
      channel,
      sellerDiscordId,
      memberWtbRecordId,
      memberFields: f,
      payout
    });
  }

  /*
    Consignor without private channels:
    - Create a deal channel in KC server
    - Send Ready To Ship there
    - DM seller the channel link
  */
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error(`Missing Discord ID for seller ${asText(seller.seller_id) || sellerRecordId}`);
  }

  const guild = await kickzDealDiscordClient.guilds.fetch(KICKZ_DEAL_SERVER_ID);

  const memberWtbId =
    asText(f["Member WTB ID"]) ||
    asText(f["WTB ID"]) ||
    memberWtbRecordId;

  const channelName = sanitizeDiscordChannelName(memberWtbId);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: CONSIGNMENT_DEAL_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: sellerDiscordId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: KICKZ_ADMIN_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: kickzDealDiscordClient.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      }
    ],
    reason: `Member WTB deal channel for ${asText(seller.seller_id) || sellerRecordId} / ${memberWtbId}`
  });

  await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
    "WTB Created Channel ID": channel.id
  });

  const readyMessage = await sendMemberWtbReadyToShipToChannel({
    channel,
    sellerDiscordId,
    memberWtbRecordId,
    memberFields: f,
    payout,
    compact: true
  });

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  await user.createDM().then((dm) =>
    dm.send({
      content: `Your Member WTB deal channel has been created: <#${channel.id}>`
    })
  );

  return {
    ...readyMessage,
    deliveryType: "deal_channel"
  };
}

function getMemberWtbPaymentAmount(fields = {}) {
  const amount =
    Number(fields["Invoice Price"] || 0) ||
    Number(fields["Final Buying Price"] || 0) ||
    Number(fields["Max Price"] || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      "Member WTB has no valid Invoice Price, Final Buying Price or Max Price"
    );
  }

  return Math.round(amount * 100) / 100;
}

function getMemberWtbDisplayId(record) {
  const fields = record.fields || {};

  return (
    asText(fields["Member WTB ID"]) ||
    asText(fields["WTB ID"]) ||
    record.id
  );
}

async function findExistingMemberWtbPaymentBatch(
  memberWtbRecordId
) {
  const safeRecordId = asText(memberWtbRecordId)
    .replace(/'/g, "\\'");

  const records = await airtable(PAYMENT_BATCHES_TABLE)
    .select({
      fields: [
        "Batch ID",
        "Linked Member WTBs",
        "Buyer",
        "Amount",
        "Payment Status",
        "Payment Link",
        "Mollie Payment ID"
      ],
      filterByFormula: `AND(
        FIND(
          '${safeRecordId}',
          ARRAYJOIN({Linked Member WTBs})
        ),
        OR(
          {Payment Status} = 'Pending',
          {Payment Status} = 'Awaiting Payment',
          {Payment Status} = 'Pending Payment'
        )
      )`,
      maxRecords: 1
    })
    .firstPage();

  return records[0] || null;
}

async function createMemberWtbMolliePayment(
  memberWtbRecordId,
  options = {}
) {
  const forceNew = options.forceNew === true;

  const memberWtb = await airtable(
    MEMBER_WTBS_TABLE
  ).find(memberWtbRecordId);

  const fields = memberWtb.fields || {};

  const buyerRecordIds = Array.isArray(
    fields["Buyer Seller ID"]
  )
    ? fields["Buyer Seller ID"]
    : [];

  const buyerRecordId = asText(buyerRecordIds[0]);

  if (!buyerRecordId) {
    throw new Error(
      "Member WTB is missing Buyer Seller ID"
    );
  }

  const paymentStatus = asText(
    fields["Payment Status"]
  );

  if (paymentStatus === "Paid") {
    throw new Error(
      "This Member WTB is already paid"
    );
  }

  if (paymentStatus === "Pending Payment") {
    throw new Error(
      "This bank transfer is already awaiting Mollie confirmation"
    );
  }

  if (!forceNew) {
    const existingBatch =
      await findExistingMemberWtbPaymentBatch(
        memberWtbRecordId
      );

    if (existingBatch) {
      const existingPaymentLink = asText(
        existingBatch.fields["Payment Link"]
      );

      if (existingPaymentLink) {
        return {
          reused: true,
          member_wtb_record_id: memberWtbRecordId,
          batch_record_id: existingBatch.id,
          batch_id:
            asText(existingBatch.fields["Batch ID"]) ||
            existingBatch.id,
          payment_url: existingPaymentLink,
          mollie_payment_id: asText(
            existingBatch.fields[
              "Mollie Payment ID"
            ]
          ),
          amount: Number(
            existingBatch.fields["Amount"] || 0
          )
        };
      }
    }
  }

  const amount = getMemberWtbPaymentAmount(fields);
  const memberWtbId =
    getMemberWtbDisplayId(memberWtb);

  const technicalBatchId = `MWTB-${Date.now()}`;

  const batch = await airtable(
    PAYMENT_BATCHES_TABLE
  ).create({
    "Linked Member WTBs": [memberWtbRecordId],
    "Buyer": [buyerRecordId],
    "Order Numbers": memberWtbId,
    "Amount": amount,
    "Payment Status": "Pending",
    "Payment Provider": "Mollie"
  });

  try {
    const payment = await mollieRequest(
      "/payments",
      {
        method: "POST",
        body: JSON.stringify({
          amount: {
            currency: "EUR",
            value: mollieMoney(amount)
          },
          description:
            `Kickz Caviar ${memberWtbId}`,
          redirectUrl:
            `${APP_URL}/dashboard?` +
            `member_wtb_payment=${encodeURIComponent(
              memberWtbRecordId
            )}`,
          webhookUrl:
            `${APP_URL}/api/mollie/member-wtb-webhook`,
          metadata: {
            payment_context: "member_wtb",
            batch_record_id: batch.id,
            batch_id: technicalBatchId,
            member_wtb_record_id:
              memberWtbRecordId,
            member_wtb_id: memberWtbId,
            buyer_record_id: buyerRecordId,
            trusted_buyer: options.trusted === true
          }
        })
      }
    );

    const paymentUrl =
      payment?._links?.checkout?.href || "";

    if (!paymentUrl) {
      throw new Error(
        "Mollie did not return a checkout URL"
      );
    }

    await airtable(PAYMENT_BATCHES_TABLE)
      .update(batch.id, {
        "Payment Status": "Awaiting Payment",
        "Payment Link": paymentUrl,
        "Mollie Payment ID": payment.id
      });

    await airtable(MEMBER_WTBS_TABLE)
      .update(memberWtbRecordId, {
        "Payment Status": "Awaiting Payment",
        "Payment Link": paymentUrl,
        "Mollie Payment ID": payment.id,
        "Payment Batches": [batch.id]
      });

    return {
      reused: false,
      member_wtb_record_id: memberWtbRecordId,
      member_wtb_id: memberWtbId,
      batch_record_id: batch.id,
      batch_id: technicalBatchId,
      payment_url: paymentUrl,
      mollie_payment_id: payment.id,
      amount
    };
  } catch (err) {
    await airtable(PAYMENT_BATCHES_TABLE)
      .update(batch.id, {
        "Payment Status": "Failed"
      })
      .catch(() => {});

    throw err;
  }
}

async function getMemberWtbCheckout(
  memberWtbRecordId
) {
  return withMemberWtbPaymentLock(
    memberWtbRecordId,
    async () => {
      const memberWtb = await airtable(
        MEMBER_WTBS_TABLE
      ).find(memberWtbRecordId);

      const fields = memberWtb.fields || {};

      const paymentStatus = asText(
        fields["Payment Status"]
      );

      if (paymentStatus === "Paid") {
        const error = new Error(
          "This Member WTB is already paid"
        );

        error.statusCode = 409;
        throw error;
      }

      if (paymentStatus === "Pending Payment") {
        const error = new Error(
          "This payment is awaiting Mollie confirmation"
        );

        error.statusCode = 409;
        throw error;
      }

      const buyerRecordId = firstLinkedRecordId(
        fields["Buyer Seller ID"]
      );

      if (!buyerRecordId) {
        throw new Error(
          "Member WTB is missing Buyer Seller ID"
        );
      }

      const buyerRecord = await airtable(
        SELLERS_TABLE
      ).find(buyerRecordId);

      const trustedBuyer =
        buyerRecord.fields?.["Trusted Buyer?"] ===
        true;

      const mustCreateNew = [
        "Expired",
        "Cancelled",
        "Failed"
      ].includes(paymentStatus);

      return createMemberWtbMolliePayment(
        memberWtbRecordId,
        {
          forceNew: mustCreateNew,
          trusted: trustedBuyer
        }
      );
    }
  );
}

async function updateMemberWtbPaymentRequestMessage(
  memberWtbRecordId,
  status
) {
  try {
    const memberWtb = await airtable(
      MEMBER_WTBS_TABLE
    ).find(memberWtbRecordId);

    const fields = memberWtb.fields || {};

    const channelId = asText(
      fields["Payment Request Channel ID"]
    );

    const messageId = asText(
      fields["Payment Request Message ID"]
    );

    if (!channelId || !messageId) {
      return {
        updated: false,
        reason: "missing_payment_request_message"
      };
    }

    await initKickzDealDiscord();

    const channel =
      await kickzDealDiscordClient.channels
        .fetch(channelId)
        .catch(() => null);

    if (!channel) {
      return {
        updated: false,
        reason: "channel_not_found"
      };
    }

    const message = await channel.messages
      .fetch(messageId)
      .catch(() => null);

    if (!message) {
      return {
        updated: false,
        reason: "message_not_found"
      };
    }

    const memberWtbId =
      asText(fields["Member WTB ID"]) ||
      asText(fields["WTB ID"]) ||
      memberWtbRecordId;

    const amount =
      getMemberWtbPaymentAmount(fields);

    let content = "";
    let title = "";
    let description = [];
    let color = 0x95a5a6;
    let buttonLabel = "Payment";
    let buttonStyle = 2;

    if (status === "Pending Payment") {
      content = "🏦 Bank transfer submitted.";

      title = "🏦 Waiting for Mollie";

      description = [
        `**Order Number:** ${memberWtbId}`,
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "Your SEPA bank transfer has been submitted through Mollie.",
        "We are waiting for Mollie to confirm receipt.",
        "",
        "Your payment status will update automatically."
      ];

      color = 0xf1c40f;
      buttonLabel = "Waiting for Mollie";
    } else if (status === "Paid") {
      content = "✅ Payment confirmed by Mollie.";

      title = "✅ Payment Confirmed";

      description = [
        `**Order Number:** ${memberWtbId}`,
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "Mollie has confirmed your payment.",
        "Your order is now being processed."
      ];

      color = 0x2ecc71;
      buttonLabel = "Paid";
      buttonStyle = 3;
    } else if (status === "Cancelled") {
      content = "❌ Payment cancelled.";

      title = "❌ Payment Cancelled";

      description = [
        `**Order Number:** ${memberWtbId}`,
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "This Mollie payment was cancelled.",
        "A new payment link must be created before payment can be completed."
      ];

      color = 0x95a5a6;
      buttonLabel = "Cancelled";
    } else if (status === "Expired") {
      content = "⌛ Payment expired.";

      title = "⌛ Payment Expired";

      description = [
        `**Order Number:** ${memberWtbId}`,
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "This Mollie payment link has expired.",
        "A new payment link must be created before payment can be completed."
      ];

      color = 0x95a5a6;
      buttonLabel = "Expired";
    } else if (status === "Failed") {
      content = "❌ Payment failed.";

      title = "❌ Payment Failed";

      description = [
        `**Order Number:** ${memberWtbId}`,
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "Mollie could not complete this payment.",
        "Please use a new Mollie payment link."
      ];

      color = 0xe74c3c;
      buttonLabel = "Payment Failed";
      buttonStyle = 4;
    } else {
      return {
        updated: false,
        reason: "unsupported_status"
      };
    }

    await message.edit({
      content,

      embeds: [
        {
          title,
          description: description.join("\n"),
          color,
          footer: {
            text: "Secure payment powered by Mollie"
          },
          timestamp: new Date().toISOString()
        }
      ],

      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: buttonStyle,
              label: buttonLabel,
              custom_id:
                `member_wtb_payment_${status
                  .toLowerCase()
                  .replace(/\s+/g, "_")}_disabled`,
              disabled: true
            }
          ]
        }
      ]
    });

    return {
      updated: true
    };
  } catch (err) {
    console.error(
      "Failed to update Member WTB payment request message:",
      err
    );

    return {
      updated: false,
      reason: err.message
    };
  }
}

async function sendMemberWtbPaymentRequest(
  memberWtbRecordId,
  memberFields,
  buyerSeller,
  options = {}
) {
  const trusted = options.trusted === true;

  await initKickzDealDiscord();

  const discordUserId = asText(
    buyerSeller.discord_id ||
    buyerSeller.discord_user_id ||
    buyerSeller.discord_id_raw
  );

  if (!discordUserId) {
    throw new Error("Buyer is missing Discord ID");
  }

  const paymentResult =
    await getMemberWtbCheckout(
      memberWtbRecordId
    );

  const paymentUrl = asText(
    paymentResult.payment_url
  );

  if (!paymentUrl) {
    throw new Error(
      "Member WTB Mollie payment link is missing"
    );
  }

  const amount = Number(
    paymentResult.amount || 0
  );

  const memberWtbId =
    asText(memberFields["Member WTB ID"]) ||
    asText(memberFields["WTB ID"]) ||
    memberWtbRecordId;

  const user =
    await kickzDealDiscordClient.users.fetch(
      discordUserId
    );

  const dm = await user.createDM();

  const paymentExplanation = trusted
    ? [
        "Your deal has already moved forward because your account is trusted.",
        "Please complete the payment through Mollie as soon as possible."
      ]
    : [
        "Please complete your payment through Mollie.",
        "**The order will continue processing once Mollie confirms the payment.**"
      ];

  const message = await dm.send({
    embeds: [
      {
        title: trusted
          ? "💳 Payment Requested"
          : "💳 Payment Required",

        description: [
          "**We successfully matched a seller to your Want To Buy!**",
          "",
          `**Order Number:** ${memberWtbId}`,
          "",
          `**Product:** ${
            asText(memberFields["Product Name"]) ||
            "—"
          }`,
          `**SKU:** ${
            asText(memberFields["SKU"]) ||
            "—"
          }`,
          `**Size:** ${
            asText(memberFields["Size"]) ||
            "—"
          }`,
          "",
          `**Amount:** €${amount.toFixed(2)}`,
          "",
          ...paymentExplanation,
          "",
          "**Available through Mollie**",
          "• iDEAL",
          "• Wero",
          "• SEPA Bank Transfer",
          "",
          "Payments must be completed through Mollie.",
          "Manual bank transfers and PayPal payments are not accepted.",
          "",
          "Once Mollie confirms the payment, the payment status is updated automatically."
        ].join("\n"),

        color: trusted
          ? 0x3498db
          : 0xf1c40f,

        footer: {
          text: "Secure payment powered by Mollie"
        },

        timestamp: new Date().toISOString()
      }
    ],

    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: `Pay €${amount.toFixed(2)} with Mollie`,
            url: paymentUrl
          }
        ]
      }
    ]
  });

  await airtable(MEMBER_WTBS_TABLE).update(
    memberWtbRecordId,
    {
      "Payment Request Channel ID":
        message.channelId,
      "Payment Request Message ID":
        message.id
    }
  );

  return {
    channelId: message.channelId,
    messageId: message.id,
    paymentUrl,
    paymentResult
  };
}

async function disableMemberWtbBuyerOfferMessage(memberFields, note) {
  const channelId = asText(memberFields["Buyer Offer Channel ID"]);
  const messageId = asText(memberFields["Buyer Offer Message ID"]);

  if (!channelId || !messageId) return false;

  await initKickzDealDiscord();

  const channel = await kickzDealDiscordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;

  await message.edit({
    content: note || "❌ A newer offer is available.",
    embeds: message.embeds,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: "Expired",
            custom_id: "member_wtb_buyer_offer_expired",
            disabled: true
          }
        ]
      }
    ]
  });

  return true;
}

async function sendMemberWtbPurchaseWebhook(memberWtbRecordId) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  const inventoryUnitId = firstLinkedRecordId(f["Linked Inventory Unit"]);
  if (!inventoryUnitId) throw new Error("Member WTB missing Linked Inventory Unit");

  const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).find(inventoryUnitId);
  const inventoryFields = inventoryUnit.fields || {};

  const type = asText(inventoryFields["Type"]);
  const isConsignment = type === "Consignment";

  await fetch("https://hook.eu2.make.com/cmq6wlbq5sa9spmwogy4pdordvjzuz4i", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: isConsignment
        ? "consignment_inventory_unit_created"
        : "member_wtb_seller_inventory_unit_created",

      inventory_unit_record_id: inventoryUnit.id,
      member_wtb_record_id: memberWtbRecordId,

      product_name: asText(inventoryFields["Product Name"]),
      sku: asText(inventoryFields["SKU"]),
      size: asText(inventoryFields["Size"]),
      brand: asText(inventoryFields["Brand"]),
      vat_type: asText(inventoryFields["VAT Type"]),

      purchase_price: Number(inventoryFields["Purchase Price"] || 0),
      shipping_deduction: Number(inventoryFields["Shipping Deduction"] || 0),
      purchase_date: asText(inventoryFields["Purchase Date"]),

      seller_record_id: firstLinkedRecordId(inventoryFields["Seller ID"]),

      ticket_number: asText(f["Member WTB ID"]) || asText(f["WTB ID"]) || memberWtbRecordId,
      order_id: asText(f["Member WTB ID"]) || asText(f["WTB ID"]) || memberWtbRecordId,
      source_type: "member_wtb",

      type,
      source: asText(inventoryFields["Source"]),
      verification_status: asText(inventoryFields["Verification Status"]),
      payment_note: asText(inventoryFields["Payment Note"]),
      payment_status: asText(inventoryFields["Payment Status"]),
      availability_status: asText(inventoryFields["Availability Status"]),
      selling_price: Number(inventoryFields["Selling Price"] || 0),
      selling_method: asText(inventoryFields["Selling Method"]),

      airtable_fields: inventoryFields,
      created_at: new Date().toISOString()
    })
  });
}

async function handleMemberWtbPaymentGate(
  memberWtbRecordId
) {
  const memberWtb = await airtable(
    MEMBER_WTBS_TABLE
  ).find(memberWtbRecordId);

  const fields = memberWtb.fields || {};

  const currentPaymentStatus = asText(
    fields["Payment Status"]
  );

  const alreadyProcessedStatuses = new Set([
    "Awaiting Payment",
    "Pending Payment",
    "Paid"
  ]);

  if (
    alreadyProcessedStatuses.has(
      currentPaymentStatus
    )
  ) {
    return {
      status: "already_processed",
      payment_status: currentPaymentStatus
    };
  }

  const buyerRecordId =
    firstLinkedRecordId(
      fields["Buyer Seller ID"]
    );

  if (!buyerRecordId) {
    throw new Error(
      "Member WTB missing Buyer Seller ID"
    );
  }

  const buyerRecord = await airtable(
    SELLERS_TABLE
  ).find(buyerRecordId);

  const buyerFields = buyerRecord.fields || {};
  const buyer = normalizeSeller(buyerRecord);

  const trustedBuyer =
    buyerFields["Trusted Buyer?"] === true;

  await sendMemberWtbPaymentRequest(
    memberWtbRecordId,
    fields,
    buyer,
    {
      trusted: trustedBuyer
    }
  );

  if (trustedBuyer) {
    /*
      Trusted buyers continue immediately.
      Payment is still required through Mollie,
      but payment confirmation does not block the deal.
    */
    await sendMemberWtbPurchaseWebhook(
      memberWtbRecordId
    );

    await sendMemberWtbDealUpdateAfterPayment(
      memberWtbRecordId
    );

    return {
      status: "trusted_payment_requested"
    };
  }

  return {
    status: "payment_requested"
  };
}

function sanitizeDiscordChannelName(value) {
  return asText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

async function createConsignmentDealChannelForDmSeller({
  seller,
  offer,
  inventoryUnitRecordId
}) {
  await initKickzDealDiscord();

  const discordUserId = asText(seller?.discord_id);

  if (!discordUserId) {
    throw new Error(`Missing Discord ID for seller ${seller?.seller_id || offer.seller_id}`);
  }

  const orderRecord = await airtable(ORDERS_TABLE).find(offer.order_record_id);
  const orderFields = orderRecord.fields || {};

  const existingChannelId = asText(
    orderFields[AIRTABLE_CONSIGNMENT_CREATED_CHANNEL_ID_FIELD]
  );

  if (existingChannelId) {
    const existingChannel = await kickzDealDiscordClient.channels.fetch(existingChannelId).catch(() => null);

    if (existingChannel) {
      return {
        channel: existingChannel,
        channelId: existingChannel.id,
        created: false
      };
    }
  }

  const orderId = asText(orderFields["Order ID"]) || asText(offer.order_id);
  const shopifyOrderNumber = asText(orderFields["Shopify Order Number"]);

  const channelName = sanitizeDiscordChannelName(
    [orderId, shopifyOrderNumber].filter(Boolean).join("-")
  );

  if (!channelName) {
    throw new Error(`Could not build channel name for order ${offer.order_record_id}`);
  }

  const guild = await kickzDealDiscordClient.guilds.fetch(KICKZ_DEAL_SERVER_ID);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: CONSIGNMENT_DEAL_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel
        ]
      },
      {
        id: discordUserId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: KICKZ_ADMIN_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: kickzDealDiscordClient.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      }
    ],
    reason: `Consignment deal channel for ${offer.seller_id} / ${orderId}`
  });

  await airtable(ORDERS_TABLE).update(offer.order_record_id, {
    [AIRTABLE_CONSIGNMENT_CREATED_CHANNEL_ID_FIELD]: channel.id
  });

  const price = Number(offer.offer_price || 0);

  const message = await channel.send({
    content: `<@${discordUserId}> your consignment deal channel has been created.`,
    embeds: [
      {
        title: "📦 Consignment Deal Confirmed",
        description: [
          "**Item Details:**",
          offer.product_name || "—",
          "",
          "**SKU**",
          offer.sku || "—",
          "",
          "**Size**",
          offer.size || "—",
          "",
          "**Order**",
          orderId || offer.order_id || offer.order_record_id || "—",
          "",
          "**Shopify Order**",
          shopifyOrderNumber || "—",
          "",
          "**Price**",
          `€${price.toFixed(2)} (${offer.vat_type || "—"})`,
          "",
          "Please request your shipping label below. You can also use this channel for questions about this specific deal."
        ].join("\n"),
        color: 0x2ecc71,
        footer: { text: `SellerID: ${offer.seller_id}` },
        timestamp: new Date().toISOString()
      }
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Request Label",
            custom_id: `request_consignment_label:${offer.order_record_id}:${inventoryUnitRecordId || ""}`
          }
        ]
      }
    ]
  });

  return {
    channel,
    channelId: channel.id,
    messageId: message.id,
    created: true
  };
}

async function notifySellerDealChannelCreatedDM({ seller, channelId }) {
  await initKickzDealDiscord();

  const discordUserId = asText(seller?.discord_id);

  if (!discordUserId) return null;

  const user = await kickzDealDiscordClient.users.fetch(discordUserId);
  const dm = await user.createDM();

  const message = await dm.send({
    content: `Your deal channel has been created: <#${channelId}>`
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm",
    client: "kickz_deal_bot"
  };
}

async function sendConsignmentDealUpdateDiscordMessage({
  seller,
  offer,
  inventoryUnitRecordId
}) {
  const wasOfferDeliveredByDm = offer.discord_delivery_type === "dm";

  if (wasOfferDeliveredByDm) {
    await initKickzDealDiscord();
  } else {
    await initDiscord();
  }

  if (wasOfferDeliveredByDm) {
    const dealChannelResult = await createConsignmentDealChannelForDmSeller({
      seller,
      offer,
      inventoryUnitRecordId
    });

    await notifySellerDealChannelCreatedDM({
      seller,
      channelId: dealChannelResult.channelId
    }).catch((err) => {
      console.error("Failed to notify seller about deal channel DM:", err);
    });

    return {
      channelId: dealChannelResult.channelId,
      messageId: dealChannelResult.messageId || null,
      deliveryType: "deal_channel"
    };
  }

  const channelId = asText(seller?.deal_updates_channel_id);

  if (!channelId) {
    console.log("Skipping deal update: no Deal Updates Channel ID", {
      seller: offer.seller_id,
      offerId: offer.id
    });
    return null;
  }

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel) throw new Error(`Deal Updates channel not found: ${channelId}`);

  const price = Number(offer.offer_price || 0);

  const message = await channel.send({
    content: `✅ Your Deal For ${offer.sku} - ${offer.size} Has Been Confirmed!`,
    embeds: [
      {
        title: "📦 Time To Ship Your Item!",
        description: [
          "**Item Details:**",
          offer.product_name || "—",
          "",
          "**SKU**",
          offer.sku || "—",
          "",
          "**Size**",
          offer.size || "—",
          "",
          "**Order**",
          offer.order_id || offer.order_record_id || "—",
          "",
          "**Price**",
          `€${price.toFixed(2)} (${offer.vat_type || "—"})`,
          "",
          "The sale is now visible in your dashboard. Please request or download the shipping label as soon as possible."
        ].join("\n"),
        color: 0x2ecc71,
        footer: { text: `SellerID: ${offer.seller_id}` },
        timestamp: new Date().toISOString()
      }
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Request Label",
            custom_id: `request_consignment_label:${offer.order_record_id}:${inventoryUnitRecordId || ""}`
          }
        ]
      }
    ]
  });

  return {
    channelId,
    messageId: message.id,
    deliveryType: "private_channel"
  };
}

async function sendConsignorActivationDiscordDM(seller) {
  await initKickzDealDiscord();

  const discordUserId = asText(seller?.discord_id);

  if (!discordUserId) {
    throw new Error(`Missing Discord ID for seller ${seller?.seller_id}`);
  }

  const user = await kickzDealDiscordClient.users.fetch(discordUserId);
  const dm = await user.createDM();

  const message = await dm.send({
    embeds: [
      {
        title: "✅ Consignment Activated",
        description: [
          "Your Kickz Caviar Consignment access has been activated.",
          "",
          "**Please log out and log back in** to unlock the Consignment section in your dashboard.",
          "",
          "**How it works:**",
          "• Upload and manage your stock directly in the portal",
          "• Track all offers, deals and updates in your dashboard",
          "• Offers and matches will also be sent through Discord",
          "• Confirm or deny offers directly in Discord or the portal",
          "",
          "You are now ready to start listing your pairs through Kickz Caviar. 💛"
        ].join("\n"),
        color: 0x2ecc71
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm",
    client: "kickz_deal_bot"
  };
}

async function getOpenConsignmentOffer(offerId) {
  const { data: offer, error } = await supabase
    .from("consignment_offers")
    .select("*")
    .eq("id", offerId)
    .single();

  if (error) throw error;

  if (!offer || offer.status !== "open") {
    return null;
  }

  return offer;
}

async function denyConsignmentOffer(offerId) {
  const offer = await getOpenConsignmentOffer(offerId);

  if (!offer) {
    return {
      ok: false,
      reason: "not_open"
    };
  }

  await supabase
    .from("consignment_offers")
    .update({
      status: "denied",
      denied_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", offer.id);

  return {
    ok: true,
    offer
  };
}

async function closeCompetingMemberWtbOffers(memberWtbRecordId, winningOfferId) {
  const { data: competingOffers } = await supabase
    .from("consignment_offers")
    .select("id, discord_channel_id, discord_message_id, discord_delivery_type")
    .eq("source_type", "member_wtb")
    .eq("member_wtb_record_id", memberWtbRecordId)
    .eq("status", "open");

  for (const offer of competingOffers || []) {
    if (offer.id === winningOfferId) continue;

    await supabase
      .from("consignment_offers")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", offer.id);

    if (offer.discord_channel_id && offer.discord_message_id) {
      await disableConsignmentDiscordButtons(
        offer.discord_channel_id,
        offer.discord_message_id,
        "❌ This request was closed — another seller confirmed first."
      );
    }
  }
}

async function confirmConsignmentOffer(offerId) {
  const { data: lockedOffer, error: lockError } = await supabase
    .from("consignment_offers")
    .update({
      status: "processing",
      updated_at: new Date().toISOString()
    })
    .eq("id", offerId)
    .eq("status", "open")
    .select()
    .single();

  if (lockError || !lockedOffer) {
    return {
      ok: false,
      reason: "not_open"
    };
  }

  if (asText(lockedOffer.source_type) === "member_wtb") {
    const memberWtbRecordId = asText(lockedOffer.member_wtb_record_id);
  
    if (!memberWtbRecordId) {
      throw new Error("Member WTB consignment offer missing member_wtb_record_id");
    }
  
    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const memberFields = memberWtb.fields || {};
  
    if (!memberWtbAllowsConsignmentRequests(memberFields)) {
      await supabase
        .from("consignment_offers")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", lockedOffer.id);
  
      return {
        ok: false,
        reason: "member_wtb_not_open"
      };
    }
  
    const maxPrice = Number(memberFields["Max Price"] || 0);

    const vatType = asText(lockedOffer.vat_type);

    const finalBuyingPrice = getMemberWtbNetSalePrice(
      maxPrice,
      vatType,
      memberFields["Buying Inventory Filter"]
    );

    const memberWtbId =
      asText(memberFields["Member WTB ID"]) ||
      asText(memberFields["WTB ID"]) ||
      memberWtbRecordId;

    const inventoryUnitRecord = await createConsignmentInventoryUnitFromOffer({
      ...lockedOffer,
      order_record_id: null,
      order_id: memberWtbId,
      source_type: "member_wtb",
      member_wtb_record_id: memberWtbRecordId,
      selling_price: finalBuyingPrice,
      selling_method: "Kickz Caviar"
    });
  
    const { data: inventoryRow, error: inventoryFetchError } = await supabase
      .from("consignment_inventory")
      .select("id, quantity, sku, size")
      .eq("id", lockedOffer.inventory_id)
      .single();
  
    if (inventoryFetchError) throw inventoryFetchError;
  
    const newQuantity = Math.max(0, Number(inventoryRow.quantity || 0) - 1);
  
    const { error: inventoryUpdateError } = await supabase
      .from("consignment_inventory")
      .update({
        quantity: newQuantity,
        updated_at: new Date().toISOString()
      })
      .eq("id", inventoryRow.id);
  
    if (inventoryUpdateError) throw inventoryUpdateError;
  
    await refreshConsignmentStockLevel(inventoryRow.sku, inventoryRow.size);
  
    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Purchase Status": "Confirmed",
      "Fulfillment Status": "Allocated",
      "Linked Inventory Unit": [inventoryUnitRecord.id],
      "Final Buying Price": finalBuyingPrice
    });
  
    await supabase
      .from("consignment_offers")
      .update({
        status: "accepted",
        accepted_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", lockedOffer.id);
  
    await closeCompetingMemberWtbOffers(memberWtbRecordId, lockedOffer.id);

    await disableMemberWtbKcOfferButtons(
      memberWtbRecordId,
      "❌ This Member WTB was already allocated to a consignor."
    );

    await handleMemberWtbPaymentGate(memberWtbRecordId);
  
    return {
      ok: true,
      offer: lockedOffer
    };
  }

  if (lockedOffer.is_counter_offer || Number(lockedOffer.consignor_counter_price) > 0) {
    let customOffer = null;
    let offerVatType = "";
  
    if (Number(lockedOffer.consignor_counter_price) > 0) {
      const calculated = getAcceptedStoreCustomOfferFromConsignmentCounter(lockedOffer);
      customOffer = calculated.customOffer;
      offerVatType = calculated.offerVatType;
    } else {
      const storeCounterPrice = Number(lockedOffer.store_counter_price);
      const storeCounterPriceExclVat = Number(lockedOffer.store_counter_price_excl_vat);
  
      const isMargin = asText(lockedOffer.vat_type) === "Margin";
  
      customOffer = isMargin
        ? storeCounterPrice
        : storeCounterPriceExclVat;
  
      offerVatType = isMargin
        ? "Margin"
        : "VAT0";
    }
  
    if (Number.isFinite(customOffer) && customOffer > 0) {
      await airtable(ORDERS_TABLE).update(lockedOffer.order_record_id, {
        "Custom Offer": customOffer,
        "Offer VAT Type": offerVatType,
        "Offer Accepted?": true,
        "Offer Sent?": false
      });
    }
  }

  const inventoryUnitRecord = await createConsignmentInventoryUnitFromOffer(lockedOffer);

  const { data: inventoryRow, error: inventoryFetchError } = await supabase
    .from("consignment_inventory")
    .select("id, quantity, sku, size")
    .eq("id", lockedOffer.inventory_id)
    .single();

  if (inventoryFetchError) throw inventoryFetchError;

  const newQuantity = Math.max(
    0,
    Number(inventoryRow.quantity || 0) - 1
  );

  const { error: inventoryUpdateError } = await supabase
    .from("consignment_inventory")
    .update({
      quantity: newQuantity,
      updated_at: new Date().toISOString()
    })
    .eq("id", inventoryRow.id);

  if (inventoryUpdateError) throw inventoryUpdateError;

  await refreshConsignmentStockLevel(inventoryRow.sku, inventoryRow.size);

  await supabase
    .from("consignment_offers")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", lockedOffer.id);

  try {
    const sellerRecord = await airtable(SELLERS_TABLE).find(lockedOffer.seller_record_id);
    const seller = normalizeSeller(sellerRecord);
  
    await sendConsignmentDealUpdateDiscordMessage({
      seller,
      offer: lockedOffer,
      inventoryUnitRecordId: inventoryUnitRecord?.id
    });
  } catch (err) {
    console.error("Failed to send consignment deal update:", err);
  }

  const { data: competingOffers } = await supabase
    .from("consignment_offers")
    .select("id, discord_channel_id, discord_message_id, discord_delivery_type")
    .eq("order_record_id", lockedOffer.order_record_id)
    .eq("status", "open");

  for (const competingOffer of competingOffers || []) {
    if (competingOffer.id === lockedOffer.id) continue;

    await supabase
      .from("consignment_offers")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", competingOffer.id);

    try {
      if (
        competingOffer.discord_channel_id &&
        competingOffer.discord_message_id
      ) {
        await disableConsignmentDiscordButtons(
          competingOffer.discord_channel_id,
          competingOffer.discord_message_id,
          "❌ This order was matched with another seller."
        );
      }
    } catch (err) {
      console.error("Failed to disable competing offer:", err);
    }
  }

  return {
    ok: true,
    offer: lockedOffer
  };
}

async function requestConsignmentShippingLabel(orderRecordId) {
  if (!orderRecordId) {
    throw new Error("Missing orderRecordId");
  }

  await airtable(ORDERS_TABLE).update(orderRecordId, {
    "Fulfillment Status": "Requested Label"
  });

  return {
    ok: true
  };
}

async function safeEditInteractionMessage(interaction, payload, preferredClient = null) {
  const clients = preferredClient
    ? [preferredClient]
    : [discordClient, kickzDealDiscordClient];

  for (const client of clients) {
    try {
      if (!client?.isReady?.()) continue;

      const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
      if (!channel) continue;

      const message = await channel.messages.fetch(interaction.message.id).catch(() => null);
      if (!message) continue;

      return await message.edit(payload);
    } catch (err) {
      console.error("safeEditInteractionMessage source edit failed:", {
        customId: interaction.customId,
        message: err.message,
        code: err.code
      });
    }
  }

  try {
    return await interaction.message.edit(payload);
  } catch (err) {
    console.error("safeEditInteractionMessage fallback failed:", {
      customId: interaction.customId,
      message: err.message,
      code: err.code
    });
    return null;
  }
}

function bindMemberWtbDiscordCreation(
  client
) {
  client.on(
    Events.InteractionCreate,
    async (interaction) => {
      try {
        const customId =
          String(
            interaction.customId || ""
          );

        if (
          interaction.isStringSelectMenu() &&
          customId ===
            MEMBER_WTB_DISCORD_INVENTORY_SELECT_ID
        ) {
          const inventoryType =
            normalizeBuyingInventoryType(
              interaction.values?.[0]
            );

          memberWtbDiscordInventoryTypes.set(
            interaction.user.id,
            inventoryType
          );

          await interaction.reply({
            content:
              `✅ Buying Type set to **${getBuyingInventoryFilterLabel(
                inventoryType
              )}**.\n\n` +
              "This applies to your next single WTBs and CSV uploads.",
            ephemeral: true
          });

          return;
        }

        if (
          interaction.isButton() &&
          customId ===
            MEMBER_WTB_DISCORD_PANEL_BUTTON_ID
        ) {
          const inventoryType =
            memberWtbDiscordInventoryTypes.get(
              interaction.user.id
            ) ||
            MEMBER_WTB_DISCORD_DEFAULT_INVENTORY_TYPE;

          const modal = {
            title: "Create Member WTB",

            custom_id:
              `${MEMBER_WTB_DISCORD_MODAL_PREFIX}` +
              `${inventoryType}`,

            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "sku",
                    label: "SKU",
                    style: 1,
                    min_length: 2,
                    max_length: 50,
                    placeholder:
                      "Example: DD1391-100",
                    required: true
                  }
                ]
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "size",
                    label: "Size",
                    style: 1,
                    min_length: 1,
                    max_length: 20,
                    placeholder:
                      "Example: 43",
                    required: true
                  }
                ]
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "max_price",
                    label:
                      "Maximum Buying Price",
                    style: 1,
                    min_length: 1,
                    max_length: 10,
                    placeholder:
                      "Example: 120",
                    required: true
                  }
                ]
              }
            ]
          };

          await interaction.showModal(
            modal
          );

          return;
        }

        if (
          interaction.isModalSubmit() &&
          customId.startsWith(
            MEMBER_WTB_DISCORD_MODAL_PREFIX
          )
        ) {
          await interaction.deferReply({
            ephemeral: true
          });

          const sellerRecord =
            await findSellerByDiscordUserId(
              interaction.user.id
            );

          if (!sellerRecord) {
            await interaction.editReply({
              content:
                "❌ Your Discord account is not linked to a Kickz Caviar member account."
            });

            return;
          }

          const seller =
            normalizeSeller(sellerRecord);

          if (seller.portal_enabled === false) {
            await interaction.editReply({
              content:
                "❌ Your Kickz Caviar account is currently disabled."
            });

            return;
          }

          const inventoryType =
            normalizeBuyingInventoryType(
              customId.slice(
                MEMBER_WTB_DISCORD_MODAL_PREFIX
                  .length
              )
            );

          const sku =
            interaction.fields
              .getTextInputValue("sku");

          const size =
            interaction.fields
              .getTextInputValue("size");

          const maxPrice =
            Number(
              interaction.fields
                .getTextInputValue(
                  "max_price"
                )
                .replace(/[^\d]/g, "")
            );

          const result =
            await createOpenMemberWtb({
              sellerRecordId:
                sellerRecord.id,
              sellerId:
                seller.seller_id,
              sku,
              size,
              maxPrice,
              inventoryType,
              createdFrom:
                "Discord Single WTB"
            });

          await interaction.editReply({
            content: [
              "✅ **Member WTB created**",
              "",
              `**Product:** ${result.product_name}`,
              `**SKU:** ${result.sku}`,
              `**Size:** ${result.size}`,
              `**Max Price:** €${Number(
                result.max_price
              ).toFixed(2)}`,
              `**Buying Type:** ${getBuyingInventoryFilterLabel(
                result.inventory_type
              )}`,
              "",
              "You will automatically receive offers when sellers respond."
            ].join("\n")
          });

          return;
        }
      } catch (error) {
        console.error(
          "Member WTB Discord creation failed:",
          error
        );

        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction
            .editReply({
              content:
                `❌ ${error.message}`
            })
            .catch(() => {});
        } else {
          await interaction
            .reply({
              content:
                `❌ ${error.message}`,
              ephemeral: true
            })
            .catch(() => {});
        }
      }
    }
  );
}

function bindMemberWtbDiscordCsvUploads(
  client
) {
  client.on(
    Events.MessageCreate,
    async (message) => {
      if (message.author.bot) {
        return;
      }

      if (
        !MEMBER_WTB_POST_CHANNEL_ID ||
        message.channelId !==
          MEMBER_WTB_POST_CHANNEL_ID
      ) {
        return;
      }

      const csvAttachment =
        [...message.attachments.values()]
          .find((attachment) => {
            const filename =
              String(
                attachment.name || ""
              ).toLowerCase();

            return (
              filename.endsWith(".csv") ||
              attachment.contentType ===
                "text/csv"
            );
          });

      if (!csvAttachment) {
        await message.delete()
          .catch(() => {});

        const warning =
          await message.channel.send({
            content:
              `<@${message.author.id}> ` +
              "please upload a valid `.csv` file."
          });

        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 15000);

        return;
      }

      let resultMessage = null;

      try {
        resultMessage =
          await message.channel.send({
            content:
              `<@${message.author.id}> ` +
              "⏳ Processing your Member WTB CSV..."
          });

        const sellerRecord =
          await findSellerByDiscordUserId(
            message.author.id
          );

        if (!sellerRecord) {
          throw new Error(
            "Your Discord account is not linked to a Kickz Caviar member account."
          );
        }

        const seller =
          normalizeSeller(sellerRecord);

        if (seller.portal_enabled === false) {
          throw new Error(
            "Your Kickz Caviar account is currently disabled."
          );
        }

        const response = await fetch(
          csvAttachment.url
        );

        if (!response.ok) {
          throw new Error(
            "The uploaded CSV could not be downloaded."
          );
        }

        const csvText =
          await response.text();

        const parsed =
          parseMemberWtbCsvText(
            csvText
          );

        if (parsed.errors.length) {
          throw new Error(
            parsed.errors
              .slice(0, 10)
              .join("\n")
          );
        }

        const inventoryType =
          memberWtbDiscordInventoryTypes.get(
            message.author.id
          ) ||
          MEMBER_WTB_DISCORD_DEFAULT_INVENTORY_TYPE;

        let successCount = 0;
        const failedRows = [];

        for (const row of parsed.rows) {
          try {
            await createOpenMemberWtb({
              sellerRecordId:
                sellerRecord.id,
              sellerId:
                seller.seller_id,
              sku:
                row.sku,
              size:
                row.size,
              maxPrice:
                row.max_price,
              inventoryType,
              createdFrom:
                "Discord CSV Upload"
            });

            successCount += 1;

            await resultMessage.edit({
              content:
                `<@${message.author.id}> ` +
                `⏳ Created ${successCount}/${parsed.rows.length} WTBs...`
            });
          } catch (error) {
            failedRows.push(
              `Row ${row.row_number}: ${error.message}`
            );
          }
        }

        const resultLines = [
          `<@${message.author.id}>`,
          "",
          "✅ **CSV processing completed**",
          "",
          `Created: **${successCount}**`,
          `Failed: **${failedRows.length}**`,
          `Buying Type: **${getBuyingInventoryFilterLabel(
            inventoryType
          )}**`
        ];

        if (failedRows.length) {
          resultLines.push(
            "",
            "**Failed rows:**",
            failedRows
              .slice(0, 10)
              .join("\n")
          );
        }

        await resultMessage.edit({
          content:
            resultLines.join("\n")
        });
      } catch (error) {
        console.error(
          "Member WTB Discord CSV processing failed:",
          error
        );

        const content = [
          `<@${message.author.id}>`,
          "",
          "❌ **CSV upload failed**",
          "",
          error.message
        ].join("\n");

        if (resultMessage) {
          await resultMessage.edit({
            content
          });
        } else {
          resultMessage =
            await message.channel.send({
              content
            });
        }
      } finally {
        await message.delete()
          .catch(() => {});

        if (resultMessage) {
          setTimeout(() => {
            resultMessage
              .delete()
              .catch(() => {});
          }, 30000);
        }
      }
    }
  );
}

function bindConsignmentDiscordButtons(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    const customId = String(interaction.customId || "");

    if (
      !customId.startsWith("confirm_offer:") &&
      !customId.startsWith("deny_offer:") &&
      !customId.startsWith("request_consignment_label:") &&
      !customId.startsWith("counter_offer_accept:") &&
      !customId.startsWith("counter_offer_deny:") &&
      !customId.startsWith("counter_consignment_offer:") &&
      !customId.startsWith("counter_consignment_offer_modal:") &&
      !customId.startsWith("consignment_counter_accept:") &&
      !customId.startsWith("consignment_counter_deny:") &&
      !customId.startsWith("consignment_counter_counter:") &&
      !customId.startsWith("consignment_counter_counter_modal:") &&
      !customId.startsWith("consignment_consignor_edit:") &&
      !customId.startsWith("consignment_consignor_edit_modal:") &&
      !customId.startsWith("confirm_member_wtb_kc:") &&
      !customId.startsWith("deny_member_wtb_kc:") &&
      !customId.startsWith("accept_member_wtb_kc_offer:") &&
      !customId.startsWith("deny_member_wtb_kc_offer:") &&
      !customId.startsWith("request_member_wtb_label:") &&
      !customId.startsWith("accept_member_wtb_buyer_offer:") &&
      !customId.startsWith("decline_member_wtb_buyer_offer:") &&
      !customId.startsWith("counter_member_wtb_buyer:") &&
      !customId.startsWith("counter_member_wtb_buyer_modal:") &&
      !customId.startsWith("member_wtb_counter_accept:") &&
      !customId.startsWith("member_wtb_counter_deny:") &&
      !customId.startsWith("member_wtb_counter_counter:") &&
      !customId.startsWith("member_wtb_counter_counter_modal:") &&
      !customId.startsWith("member_wtb_buyer_counter_accept:") &&
      !customId.startsWith("member_wtb_buyer_counter_deny:") &&
      !customId.startsWith("member_wtb_buyer_counter_counter:") &&
      !customId.startsWith("member_wtb_buyer_counter_counter_modal:") &&
      !customId.startsWith("member_wtb_edit:") &&
      !customId.startsWith("member_wtb_edit_modal:") &&
      !customId.startsWith("place_new_offer:") &&
      !customId.startsWith("place_new_offer_modal:") &&
      !customId.startsWith("counter_offer_counter:") &&
      !customId.startsWith("counter_offer_counter_modal:") &&
      !customId.startsWith("counter_offer_edit:") &&
      !customId.startsWith("counter_offer_edit_modal:")
    ) {
      return;
    }
    
    if (customId.startsWith("counter_consignment_offer:")) {
      const offerId = customId.split(":")[1];
    
      const modal = {
        title: "Counter Offer",
        custom_id: `counter_consignment_offer_modal:${offerId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your requested payout",
                style: 1,
                min_length: 1,
                max_length: 10,
                placeholder: "Example: 250",
                required: true
              }
            ]
          }
        ]
      };
    
      await interaction.showModal(modal).catch(async (err) => {
        console.error("Failed to show consignment counter modal:", err);
      });
    
      return;
    }
    
    if (customId.startsWith("counter_consignment_offer_modal:")) {
      const offerId = customId.split(":")[1];
      const rawPrice = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawPrice).replace(/[^\d.,-]/g, "").replace(",", "."));
    
      if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid counter price.",
          ephemeral: true
        }).catch(() => {});
        return;
      }
    
      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/counter`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          counter_price: counterPrice
        })
      });
    
      const data = await response.json().catch(() => ({}));
    
      if (!response.ok) {
        await interaction.reply({
          content: `❌ Failed to submit counter offer.\n${data.details || data.error || "Unknown error"}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }
    
      await interaction.reply({
        content: `🔁 Counter offer sent to store: €${counterPrice.toFixed(2)}.`,
        ephemeral: true
      }).catch(() => {});
    
      return;
    }

    // NEW — additive only: consignor's Accept/Deny/Counter response to
    // the store's counter-back (round 2+ of the Consignment ping-pong).
    if (customId.startsWith("consignment_counter_accept:")) {
      const offerId = customId.split(":")[1];

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await safeEditInteractionMessage(interaction, {
          content: `❌ ${data.error || "Failed to accept offer."}`,
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await safeEditInteractionMessage(interaction, {
        content: "✅ Counter offer accepted.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    if (customId.startsWith("consignment_counter_deny:")) {
      const offerId = customId.split(":")[1];

      const { data: deniedOffer, error: deniedFetchError } = await supabase
        .from("consignment_offers")
        .select("*")
        .eq("id", offerId)
        .single();

      if (deniedFetchError) {
        console.error("Consignment reopen: failed to fetch denied offer:", offerId, deniedFetchError);
      }

      await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).catch((err) => console.error("Failed to deny consignment counter offer:", err));

      await safeEditInteractionMessage(interaction, {
        content: "❌ Counter offer denied.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      // NEW — additive only: same reopen-prior-round pattern as the
      // other two flows. The denied round (store's counter) was itself
      // responding to a CONSIGNOR round (if any) — reopen it and resend
      // the standard store-facing notification so the store can accept
      // it or try again. Round-1 store counters (no previous_offer_id)
      // have nothing to reopen — handled by the existing informational
      // flow already in place for that case.
      try {
        if (deniedOffer?.previous_offer_id) {
          const { data: priorOffer, error: priorFetchError } = await supabase
            .from("consignment_offers")
            .select("*")
            .eq("id", deniedOffer.previous_offer_id)
            .single();

          if (priorFetchError) {
            console.error("Consignment reopen: failed to fetch prior offer:", deniedOffer.previous_offer_id, priorFetchError);
          }

          if (priorOffer) {
            const { error: reopenUpdateError } = await supabase
              .from("consignment_offers")
              .update({ status: "store_pending" })
              .eq("id", priorOffer.id);

            if (reopenUpdateError) {
              console.error("Consignment reopen: failed to set prior offer status to store_pending:", priorOffer.id, reopenUpdateError);
            }

            const orderRecordForReopen = await airtable(ORDERS_TABLE).find(priorOffer.order_record_id);
            const orderFieldsForReopen = orderRecordForReopen.fields || {};
            const clientCountryForReopen = asText(orderFieldsForReopen["Client Country"]);
            const storeOfferVatTypeForReopen = getStoreOfferVatTypeFromConsignmentVat(priorOffer.vat_type, clientCountryForReopen);

            const priorConsignorBase = convertConsignorPriceToStoreBasePrice(
              Number(priorOffer.consignor_counter_price),
              priorOffer.vat_type,
              clientCountryForReopen
            );
            const priorConsignorInStoreTerms = calculateStoreCustomOfferFromConsignmentBase(
              priorConsignorBase,
              orderFieldsForReopen
            );

            console.log("Consignment reopen: sending re-notification to store for prior offer:", priorOffer.id);

            await postConsignmentCounterStoreOffer({
              offer: priorOffer,
              orderFields: orderFieldsForReopen,
              storeOfferPrice: priorConsignorInStoreTerms,
              storeOfferVatType: storeOfferVatTypeForReopen,
              deniedAmount: Number(deniedOffer.store_counter_price)
            });

            console.log("Consignment reopen: re-notification sent successfully for:", priorOffer.id);
          } else {
            console.error("Consignment reopen: priorOffer not found (no error, but empty result) for id:", deniedOffer.previous_offer_id);
          }
        } else {
          console.log("Consignment reopen: no previous_offer_id on denied offer, nothing to reopen:", offerId);
        }
      } catch (reopenErr) {
        console.error("Failed to reopen prior round after consignment consignor-deny (non-blocking):", reopenErr);
      }

      return;
    }

    if (customId.startsWith("consignment_counter_counter:")) {
      const offerId = customId.split(":")[1];

      const modal = {
        title: "Counter Offer",
        custom_id: `consignment_counter_counter_modal:${offerId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your requested payout",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show consignment_counter_counter modal:", err);
      });

      return;
    }

    if (customId.startsWith("consignment_counter_counter_modal:")) {
      const offerId = customId.replace("consignment_counter_counter_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid counter price.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/consignor-counter`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.COUNTER_OFFERS_SECRET || ""
        },
        body: JSON.stringify({ price: counterPrice })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `🔁 Counter offer sent to store: €${counterPrice.toFixed(2)}.`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `🔁 You countered with €${counterPrice.toFixed(2)}. Waiting on the store.`,
        embeds: interaction.message.embeds,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "Accept", custom_id: "consignment_consignor_accept_disabled", disabled: true },
              { type: 2, style: 1, label: "Edit", custom_id: `consignment_consignor_edit:${data.new_offer_id || offerId}` },
              { type: 2, style: 4, label: "Deny", custom_id: "consignment_consignor_deny_disabled", disabled: true }
            ]
          }
        ]
      }).catch(() => {});

      return;
    }

    // NEW — additive only: consignor's Edit button/modal for
    // Consignment.
    if (customId.startsWith("consignment_consignor_edit:")) {
      const offerId = customId.split(":")[1];

      const modal = {
        title: "Edit Your Counter",
        custom_id: `consignment_consignor_edit_modal:${offerId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your requested payout",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show consignment_consignor_edit modal:", err);
      });

      return;
    }

    if (customId.startsWith("consignment_consignor_edit_modal:")) {
      const offerId = customId.replace("consignment_consignor_edit_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const editedPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(editedPrice) || editedPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid counter price.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.COUNTER_OFFERS_SECRET || ""
        },
        body: JSON.stringify({ price: editedPrice })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to edit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter was updated to €${editedPrice.toFixed(2)}.`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `✏️ You edited your counter to €${editedPrice.toFixed(2)}. Waiting on the store.`,
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    if (customId.startsWith("place_new_offer:")) {
      const [, sellerOfferRecordId, sellerRecordId, vatType, deniedAmount] = customId.split(":");

      const modal = {
        title: "Place New Offer",
        custom_id: `place_new_offer_modal:${sellerOfferRecordId}:${sellerRecordId}:${vatType}:${deniedAmount}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "new_offer_amount",
                label: `Your new offer (${vatType || "same VAT type"})`,
                style: 1,
                min_length: 1,
                max_length: 10,
                placeholder: "Example: 120",
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch(async (err) => {
        console.error("Failed to show place-new-offer modal:", err);
      });

      return;
    }

    if (customId.startsWith("place_new_offer_modal:")) {
      const [, sellerOfferRecordId, sellerRecordId, vatType, deniedAmount] = customId.split(":");
      const rawAmount = interaction.fields.getTextInputValue("new_offer_amount");
      const offerAmount = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(offerAmount) || offerAmount <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid offer amount.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      // UPDATED: now calls the new edit-after-denial endpoint, which
      // edits the EXISTING Seller Offer record (instead of creating a
      // new one) and enforces the minimum-€2.50-lower / whole-number
      // rules server-side.
      const response = await fetch(
        `${APP_PUBLIC_BASE_URL}/api/seller-offers/${sellerOfferRecordId}/edit-after-denial`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seller_record_id: sellerRecordId,
            offer_amount: offerAmount,
            vat_type: vatType,
            previous_denied_amount: Number(deniedAmount)
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit new offer."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ New offer sent: €${offerAmount.toFixed(2)} · ${vatType || "—"}`,
        ephemeral: true
      }).catch(() => {});

      return;
    }

    // FIXED — pre-existing bug (confirmed present in the original
    // uploaded code): this deferUpdate ran unconditionally for EVERY
    // customId that fell through to this point, not just the two it was
    // actually written for. Once counter_offer_counter:/
    // counter_offer_edit: (and their modal submits) were added further
    // down the file, they started falling through here too — and since
    // they need to call showModal()/reply() as their FIRST response,
    // an interaction that's already been deferred here fails with
    // "InteractionAlreadyReplied". Scoping this to only the two
    // customIds it was designed for fixes that, without touching how
    // those two behave.
    if (
      customId.startsWith("accept_member_wtb_buyer_offer:") ||
      customId.startsWith("decline_member_wtb_buyer_offer:")
    ) {
      await interaction.deferUpdate().catch(() => {});
    }

        if (customId.startsWith("accept_member_wtb_buyer_offer:")) {
          const [, memberWtbRecordId, sellerOfferRecordId] = customId.split(":");

          await safeEditInteractionMessage(interaction, {
            content: "⏳ Processing your acceptance...",
            embeds: interaction.message.embeds,
            components: []
          }).catch(() => {});
    
          const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

          if (!wtbBotBaseUrl) {
            await safeEditInteractionMessage(interaction, {
              content: "❌ KICKZ_WTB_BOT_BASE_URL is missing.",
              embeds: interaction.message.embeds,
              components: []
            }).catch(() => {});
            return;
          }
          
          const response = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-kc-secret": process.env.KC_PORTAL_SECRET
            },
            body: JSON.stringify({
              member_wtb_record_id: memberWtbRecordId,
              seller_offer_record_id: sellerOfferRecordId
            })
          });
    
          const data = await response.json().catch(() => ({}));
    
          if (!response.ok) {
            console.error("accept_member_wtb_buyer_offer failed:", {
              status: response.status,
              data
            });
          
            await safeEditInteractionMessage(interaction, {
              content: `❌ Failed to accept offer. Status: ${response.status}. ${data.details || data.error || ""}`,
              embeds: interaction.message.embeds,
              components: []
            }).catch(() => {});
            return;
          }
    
          await safeEditInteractionMessage(interaction, {
            content: "✅ Offer accepted. Payment will be requested once the seller confirms the deal.",
            embeds: interaction.message.embeds,
            components: []
          }).catch(() => {});
    
          return;
        }
    
        if (customId.startsWith("decline_member_wtb_buyer_offer:")) {
          const memberWtbRecordId = customId.split(":")[1];
    
          await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
            "Purchase Status": "Offers Sent",
            "Offer Sent?": false
          }).catch(() => null);
    
          await safeEditInteractionMessage(interaction, {
            content: "❌ Offer declined.",
            embeds: interaction.message.embeds,
            components: []
          }).catch(() => {});
    
          return;
        }

    // NEW — additive only: Step 1 of the Member WTB ping-pong. Buyer
    // counters instead of accepting/declining outright.
    if (customId.startsWith("counter_member_wtb_buyer:")) {
      const [, memberWtbRecordId, sellerOfferRecordId] = customId.split(":");

      const modal = {
        title: "Counter Offer",
        custom_id: `counter_member_wtb_buyer_modal:${memberWtbRecordId}:${sellerOfferRecordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show counter_member_wtb_buyer modal:", err);
      });

      return;
    }

    if (customId.startsWith("counter_member_wtb_buyer_modal:")) {
      const [, memberWtbRecordId, sellerOfferRecordId] = customId.split(":");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/member-wtb-counter-offers/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
        },
        body: JSON.stringify({
          member_wtb_record_id: memberWtbRecordId,
          seller_offer_record_id: sellerOfferRecordId,
          price: counterPrice
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter of €${counterPrice} was sent to the seller(s).`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `🔁 You countered with €${counterPrice}. Waiting on the seller(s).`,
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    // NEW — additive only: seller accepts the buyer's counter offer.
    // Calls the SAME deal-channel endpoint the original accept flow
    // uses, but with the negotiated counter amount as an override —
    // never overwrites the Seller Offer record's own price (that
    // record can be linked to more than one Member WTB).
    if (customId.startsWith("member_wtb_counter_accept:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      const f = counterOffer.fields || {};

      if (asText(f["Status"]) !== "Open") {
        await safeEditInteractionMessage(interaction, {
          content: "❌ This counter offer is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await safeEditInteractionMessage(interaction, {
        content: "⏳ Processing your acceptance...",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
      const sellerOfferRecordId = asText(f["Seller Offer Record ID"]);
      const acceptedPayout = numberValue(f["Counter Payout"]);
      const acceptedVatType = asText(f["Counter Payout VAT Type"]);

      if (!memberWtbRecordId || !sellerOfferRecordId) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ Missing linked Member WTB or Seller Offer.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Accepted",
        "Accepted At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

      if (!wtbBotBaseUrl) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ KICKZ_WTB_BOT_BASE_URL is missing.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET
        },
        body: JSON.stringify({
          member_wtb_record_id: memberWtbRecordId,
          seller_offer_record_id: sellerOfferRecordId,
          override_price: acceptedPayout,
          override_vat_type: acceptedVatType
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error("member_wtb_counter_accept failed:", { status: response.status, data });
        await safeEditInteractionMessage(interaction, {
          content: `❌ Failed to accept offer. ${data.error || ""}`,
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await safeEditInteractionMessage(interaction, {
        content: "✅ Counter offer accepted. Payment will be requested once confirmed.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    // NEW — additive only: seller denies the buyer's counter offer.
    // Kept intentionally simple for this stage (no reopen-prior-round
    // logic yet) — that comes with the full back-and-forth build next.
    if (customId.startsWith("member_wtb_counter_deny:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      const deniedFields = deniedRecord.fields || {};

      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Denied",
        "Denied At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      await safeEditInteractionMessage(interaction, {
        content: "❌ Counter offer denied.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      // NEW — additive only: same reopen-prior-round pattern as Store
      // Orders. The denied round (buyer's counter) was itself
      // responding to a SELLER round (if any) — that seller counter
      // never went away, the buyer just couldn't get past it. Reopen it
      // and resend the standard buyer-facing notification so they can
      // accept it or try a lower counter. Round-1 buyer counters (no
      // Previous Record ID) have nothing to reopen — the buyer's only
      // path back in is a fresh initial counter, which the original
      // "New Offer Received" message's Counter button already allows.
      try {
        const priorRoundId = asText(deniedFields["Previous Record ID"]);
        const deniedPrice = numberValue(deniedFields["Store Counter Price"]);

        if (priorRoundId) {
          const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

          if (priorRound) {
            await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, { "Status": "Open" });

            const priorFields = priorRound.fields || {};
            const memberWtbRecordId = firstLinkedRecordId(deniedFields["Member WTB"]);
            const sellerVatType = asText(priorFields["Seller Original VAT Type"] || deniedFields["Seller Original VAT Type"]);
            const priorSellerCounter = numberValue(priorFields["Seller Counter Price"]);

            const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;
            const wtbFields = memberWtb?.fields || {};
            const buyerRecordId = firstLinkedRecordId(wtbFields["Buyer Seller ID"]);
            const buyerRecord = buyerRecordId ? await airtable(SELLERS_TABLE).find(buyerRecordId).catch(() => null) : null;
            const buyerDiscordId = asText(
              buyerRecord?.fields?.["Discord ID"] || buyerRecord?.fields?.["Discord User ID"]
            );

            if (buyerDiscordId) {
              const priorSellerCounterInBuyerTerms = calculateMemberWtbBuyerEquivalent(
                priorSellerCounter,
                sellerVatType,
                wtbFields
              );

              await sendMemberWtbBuyerCounterOfferDiscordDM({
                counterOfferRecordId: priorRoundId,
                buyerDiscordId,
                productName: asText(wtbFields["Product Name"]),
                sku: asText(wtbFields["SKU"]),
                size: asText(wtbFields["Size"]),
                memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
                newPrice: priorSellerCounterInBuyerTerms,
                yourPreviousCounter: deniedPrice,
                deniedAmount: deniedPrice
              }).catch((err) => console.error("Failed to re-notify buyer after seller-deny (non-blocking):", err));
            }
          }
        }
      } catch (reopenErr) {
        console.error("Failed to reopen prior round after member WTB seller-deny (non-blocking):", reopenErr);
      }

      return;
    }

    // NEW — additive only: seller counters back on the buyer's counter.
    if (customId.startsWith("member_wtb_counter_counter:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const modal = {
        title: "Counter Offer",
        custom_id: `member_wtb_counter_counter_modal:${counterOfferRecordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show member_wtb_counter_counter modal:", err);
      });

      return;
    }

    if (customId.startsWith("member_wtb_counter_counter_modal:")) {
      const counterOfferRecordId = customId.replace("member_wtb_counter_counter_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/member-wtb-counter-offers/${counterOfferRecordId}/seller-counter`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
        },
        body: JSON.stringify({ price: counterPrice })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter of €${counterPrice} was sent to the buyer.`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `🔁 You countered with €${counterPrice}. Waiting on the buyer.`,
        embeds: interaction.message.embeds,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "Accept", custom_id: "member_wtb_counter_accept_disabled", disabled: true },
              { type: 2, style: 1, label: "Edit", custom_id: `member_wtb_edit:${data.counter_offer_record_id}` },
              { type: 2, style: 4, label: "Deny", custom_id: "member_wtb_counter_deny_disabled", disabled: true }
            ]
          }
        ]
      }).catch(() => {});

      return;
    }

    // NEW — additive only: buyer accepts the seller's counter-back.
    // CRITICAL: must go through the exact same deal-channel /
    // process-seller-offer override chain as the seller-accepts-buyer
    // path, using the SELLER'S PAYOUT as the override amount in both
    // directions (process-seller-offer always computes the buyer's
    // final price FROM the seller payout + margin, regardless of which
    // side is being accepted) — otherwise this round's negotiated price
    // would silently be lost, exactly like the Store Orders bug found
    // earlier this session.
    if (customId.startsWith("member_wtb_buyer_counter_accept:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      const f = counterOffer.fields || {};

      if (asText(f["Status"]) !== "Open") {
        await safeEditInteractionMessage(interaction, {
          content: "❌ This counter offer is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await safeEditInteractionMessage(interaction, {
        content: "⏳ Processing your acceptance...",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
      const sellerOfferRecordId = asText(f["Seller Offer Record ID"]);
      // This round has "Seller Counter Price" set (a seller-placed
      // round) — that IS the seller's payout directly, already in
      // seller terms, no conversion needed (unlike Store Orders, where
      // an extra store-vs-seller scale conversion was needed — here the
      // seller's own counter number already means "what I want to
      // receive").
      const acceptedPayout = numberValue(f["Seller Counter Price"]);
      const acceptedVatType = asText(f["Seller Original VAT Type"]);

      if (!memberWtbRecordId || !sellerOfferRecordId) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ Missing linked Member WTB or Seller Offer.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Accepted",
        "Accepted At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

      if (!wtbBotBaseUrl) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ KICKZ_WTB_BOT_BASE_URL is missing.",
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET
        },
        body: JSON.stringify({
          member_wtb_record_id: memberWtbRecordId,
          seller_offer_record_id: sellerOfferRecordId,
          override_price: acceptedPayout,
          override_vat_type: acceptedVatType
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error("member_wtb_buyer_counter_accept failed:", { status: response.status, data });
        await safeEditInteractionMessage(interaction, {
          content: `❌ Failed to accept offer. ${data.error || ""}`,
          embeds: interaction.message.embeds,
          components: []
        }).catch(() => {});
        return;
      }

      await safeEditInteractionMessage(interaction, {
        content: "✅ Counter offer accepted. Payment will be requested once confirmed.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    // NEW — additive only: buyer denies the seller's counter-back. Kept
    // simple for this stage (no reopen-prior-round logic yet).
    if (customId.startsWith("member_wtb_buyer_counter_deny:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      const deniedFields = deniedRecord.fields || {};

      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Denied",
        "Denied At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      await safeEditInteractionMessage(interaction, {
        content: "❌ Counter offer denied.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      // NEW — additive only: same reopen-prior-round pattern, other
      // direction. The denied round (seller's counter-back) was itself
      // responding to a BUYER round — reopen it and resend the
      // standard seller-facing notification so the seller can accept
      // the buyer's earlier counter or try again.
      try {
        const priorRoundId = asText(deniedFields["Previous Record ID"]);
        const deniedPrice = numberValue(deniedFields["Seller Counter Price"]);
        const sellerVatType = asText(deniedFields["Seller Original VAT Type"]);
        const sellerOriginalPrice = numberValue(deniedFields["Seller Original Price"]);

        if (priorRoundId) {
          const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

          if (priorRound) {
            await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, { "Status": "Open" });

            const memberWtbRecordId = firstLinkedRecordId(deniedFields["Member WTB"]);
            const sellerRecordId = firstLinkedRecordId(deniedFields["Seller ID"]);
            const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;
            const wtbFields = memberWtb?.fields || {};
            const priorFields = priorRound.fields || {};
            const priorBuyerCounter = numberValue(priorFields["Store Counter Price"]);
            const priorPayout = numberValue(priorFields["Counter Payout"]) ||
              calculateMemberWtbSellerPayout(priorBuyerCounter, sellerVatType, wtbFields);

            const sellerRecord = sellerRecordId ? await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null) : null;
            const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);

            if (sellerDiscordId) {
              await sendMemberWtbCounterOfferDiscordDM({
                counterOfferRecordId: priorRoundId,
                sellerDiscordId,
                productName: asText(wtbFields["Product Name"]),
                sku: asText(wtbFields["SKU"]),
                size: asText(wtbFields["Size"]),
                memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
                payout: priorPayout,
                vatType: sellerVatType,
                sellerOriginalPrice,
                sellerOriginalVatType: sellerVatType,
                deniedAmount: deniedPrice
              }).catch((err) => console.error("Failed to re-notify seller after buyer-deny (non-blocking):", err));
            }
          }
        }
      } catch (reopenErr) {
        console.error("Failed to reopen prior round after member WTB buyer-deny (non-blocking):", reopenErr);
      }

      return;
    }

    // NEW — additive only: buyer counters again on the seller's
    // counter-back.
    if (customId.startsWith("member_wtb_buyer_counter_counter:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const modal = {
        title: "Counter Offer",
        custom_id: `member_wtb_buyer_counter_counter_modal:${counterOfferRecordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show member_wtb_buyer_counter_counter modal:", err);
      });

      return;
    }

    if (customId.startsWith("member_wtb_buyer_counter_counter_modal:")) {
      const counterOfferRecordId = customId.replace("member_wtb_buyer_counter_counter_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/member-wtb-counter-offers/${counterOfferRecordId}/buyer-counter`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
        },
        body: JSON.stringify({ price: counterPrice })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter of €${counterPrice} was sent to the seller.`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `🔁 You countered with €${counterPrice}. Waiting on the seller.`,
        embeds: interaction.message.embeds,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "Accept", custom_id: "member_wtb_buyer_counter_accept_disabled", disabled: true },
              { type: 2, style: 1, label: "Edit", custom_id: `member_wtb_edit:${data.counter_offer_record_id}` },
              { type: 2, style: 4, label: "Deny", custom_id: "member_wtb_buyer_counter_deny_disabled", disabled: true }
            ]
          }
        ]
      }).catch(() => {});

      return;
    }

    // NEW — additive only: shared Edit button/modal, used on both the
    // seller's and buyer's own just-placed follow-up counters.
    if (customId.startsWith("member_wtb_edit:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const modal = {
        title: "Edit Your Counter",
        custom_id: `member_wtb_edit_modal:${counterOfferRecordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show member_wtb_edit modal:", err);
      });

      return;
    }

    if (customId.startsWith("member_wtb_edit_modal:")) {
      const counterOfferRecordId = customId.replace("member_wtb_edit_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const editedPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(editedPrice) || editedPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(`${APP_PUBLIC_BASE_URL}/api/member-wtb-counter-offers/${counterOfferRecordId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
        },
        body: JSON.stringify({ price: editedPrice })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to edit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter was updated to €${editedPrice}.`,
        ephemeral: true
      }).catch(() => {});

      await safeEditInteractionMessage(interaction, {
        content: `✏️ You edited your counter to €${editedPrice}.`,
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    if (customId.startsWith("request_member_wtb_label:")) {
      const memberWtbRecordId = customId.split(":")[1];
      
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const currentStatus = asText(memberWtb.fields?.["Fulfillment Status"]);
      
      if (currentStatus === "Requested Label") {
        await safeEditInteractionMessage(interaction, {
          content: interaction.message.content,
          embeds: interaction.message.embeds,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Requested Label",
                  custom_id: "member_wtb_label_requested_disabled",
                  disabled: true
                }
              ]
            }
          ]
        });
      
        return;
      }
    
      try {
        console.log("📦 request_member_wtb_label clicked", {
          memberWtbRecordId,
          channelId: interaction.channelId,
          messageId: interaction.message?.id
        });
    
        await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
          "Fulfillment Status": "Requested Label",
          "Label Requested At": new Date().toISOString()
        });
    
        console.log("✅ Member WTB status updated to Requested Label", {
          memberWtbRecordId
        });
    
        const labelRequestResult = await sendMemberWtbLabelRequestToBuyer(memberWtbRecordId);
    
        console.log("✅ Member WTB label request DM sent", {
          memberWtbRecordId,
          labelRequestResult
        });
    
        await safeEditInteractionMessage(interaction, {
          content: interaction.message.content,
          embeds: interaction.message.embeds,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Requested Label",
                  custom_id: "member_wtb_label_requested_disabled",
                  disabled: true
                }
              ]
            }
          ]
        });
    
        return;
      } catch (err) {
        console.error("❌ request_member_wtb_label failed:", {
          memberWtbRecordId,
          message: err.message,
          stack: err.stack,
          airtableError: err.error,
          statusCode: err.statusCode
        });
    
        await interaction.followUp({
          content: `❌ Failed to request label: ${err.message || "Unknown error"}`,
          ephemeral: true
        }).catch(() => {});
    
        return;
      }
    }

    if (customId.startsWith("confirm_member_wtb_kc:")) {
      const memberWtbRecordId = customId.split(":")[1];
    
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const f = memberWtb.fields || {};
    
      if (asText(f["Purchase Status"]) !== "KC Pending") {
        await safeEditInteractionMessage(interaction, {
          content: "❌ This KC confirmation is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      const inventoryUnitId = asText(f["Buying Selected Source ID"]);
      const maxPrice = Number(f["Max Price"] || 0);
    
      if (!inventoryUnitId) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ Missing selected KC Inventory Unit.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).find(inventoryUnitId);
      const vatType = asText(inventoryUnit.fields?.["VAT Type"]);

      const finalBuyingPrice = getMemberWtbNetSalePrice(
        maxPrice,
        vatType,
        f["Buying Inventory Filter"]
      );
      const inventoryStatus = asText(inventoryUnit.fields?.["Availability Status"]);
    
      if (inventoryStatus !== "Available") {
        await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
          "Purchase Status": "Out Of Stock"
        });
    
        await safeEditInteractionMessage(interaction, {
          content: "❌ KC stock is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      await airtable(INVENTORY_UNITS_TABLE).update(inventoryUnitId, {
        "Availability Status": "Reserved",
        "Selling Method": "Kickz Caviar",
        "Selling Price": finalBuyingPrice
      });
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Purchase Status": "Confirmed",
        "Fulfillment Status": "Allocated",
        "Linked Inventory Unit": [inventoryUnitId],
        "Final Buying Price": finalBuyingPrice,
        "Buying Selected Source Type": "KC Owned"
      });

      await handleMemberWtbPaymentGate(memberWtbRecordId);
    
      await safeEditInteractionMessage(interaction, {
        content: "✅ KC stock confirmed and allocated.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      return;
    }
    
    if (customId.startsWith("deny_member_wtb_kc:")) {
      const memberWtbRecordId = customId.split(":")[1];
    
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const f = memberWtb.fields || {};
    
      if (asText(f["Purchase Status"]) !== "KC Pending") {
        await safeEditInteractionMessage(interaction, {
          content: "❌ This KC confirmation is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Purchase Status": "Offers Sent",
        "Fulfillment Status": "Outsource"
      });
    
      try {
        await postMemberWtbToWtbBot({
          recordId: memberWtbRecordId,
          productName: asText(f["Product Name"]),
          sku: asText(f["SKU"]),
          size: asText(f["Size"]),
          brand: asText(f["Brand"]),
          imageUrl: Array.isArray(f["Picture"]) && f["Picture"][0]?.url
            ? f["Picture"][0].url
            : ""
        });
      } catch (err) {
        console.error("Failed to post denied KC Member WTB to WTB bot:", err);
      }
      
      try {
        await sendMemberWtbConsignmentRequests(memberWtbRecordId);
      } catch (err) {
        console.error("Failed to send consignment requests after KC deny:", err);
      }
    
      await safeEditInteractionMessage(interaction, {
        content: "❌ KC denied. WTB flow started.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      return;
    }

    if (customId.startsWith("accept_member_wtb_kc_offer:")) {
      const memberWtbRecordId = customId.split(":")[1];
    
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const f = memberWtb.fields || {};
    
      if (asText(f["Fulfillment Status"]) === "Allocated") {
        await safeEditInteractionMessage(interaction, {
          content: "❌ This Member WTB is already allocated.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      const sku = asText(f["SKU"]);
      const size = asText(f["Size"]);
      const maxPrice = Number(f["Max Price"] || 0);
    
      const availableInventoryUnits = await airtable(INVENTORY_UNITS_TABLE)
        .select({
          filterByFormula: `AND(
            {SKU} = "${sku}",
            {Size} = "${size}",
            {Availability Status} = "Available"
          )`,
          maxRecords: 1
        })
        .firstPage();
    
      const inventoryUnit = availableInventoryUnits[0];
    
      if (!inventoryUnit) {
        await safeEditInteractionMessage(interaction, {
          content: "❌ No available KC stock found for this SKU / size.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }

      const vatType = asText(inventoryUnit.fields?.["VAT Type"]);

      const finalBuyingPrice = getMemberWtbNetSalePrice(
        maxPrice,
        vatType,
        f["Buying Inventory Filter"]
      );
    
      await airtable(INVENTORY_UNITS_TABLE).update(inventoryUnit.id, {
        "Availability Status": "Reserved",
        "Selling Method": "Kickz Caviar",
        "Selling Price": finalBuyingPrice,
        "Member WTBs": [memberWtbRecordId]
      });
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Purchase Status": "Confirmed",
        "Fulfillment Status": "Allocated",
        "Linked Inventory Unit": [inventoryUnit.id],
        "Final Buying Price": finalBuyingPrice,
        "Buying Selected Source Type": "KC Owned"
      });

      await closeCompetingMemberWtbOffers(memberWtbRecordId, null);

      await handleMemberWtbPaymentGate(memberWtbRecordId);
    
      await safeEditInteractionMessage(interaction, {
        content: "✅ KC stock accepted and allocated.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      return;
    }
    
    if (customId.startsWith("deny_member_wtb_kc_offer:")) {
      await safeEditInteractionMessage(interaction, {
        content: "❌ KC denied this Member WTB offer.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      return;
    }

    if (customId.startsWith("counter_offer_edit:")) {
      const recordId = customId.replace("counter_offer_edit:", "");

      const modal = {
        title: "Edit Your Counter",
        custom_id: `counter_offer_edit_modal:${recordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "edited_price",
                label: "New counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show counter_offer_edit modal:", err);
      });

      return;
    }

    if (customId.startsWith("counter_offer_edit_modal:")) {
      const recordId = customId.replace("counter_offer_edit_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("edited_price");
      const editedPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(editedPrice) || editedPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(
        `${APP_PUBLIC_BASE_URL}/api/counter-offers/${recordId}/edit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-kc-secret": process.env.COUNTER_OFFERS_SECRET || ""
          },
          body: JSON.stringify({ actor: "seller", price: editedPrice })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to edit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter was updated to €${editedPrice}.`,
        ephemeral: true
      }).catch(() => {});

      await interaction.message.edit({
        content: `🔁 You countered with €${editedPrice}. Waiting on the store.`,
        embeds: interaction.message.embeds,
        components: interaction.message.components
      }).catch(() => {});

      return;
    }

    if (customId.startsWith("counter_offer_counter:")) {
      const counterOfferRecordId = customId.split(":")[1];

      const modal = {
        title: "Counter Offer",
        custom_id: `counter_offer_counter_modal:${counterOfferRecordId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "counter_price",
                label: "Your counter (whole number)",
                style: 1,
                min_length: 1,
                max_length: 10,
                placeholder: "Example: 117",
                required: true
              }
            ]
          }
        ]
      };

      await interaction.showModal(modal).catch((err) => {
        console.error("Failed to show counter_offer_counter modal:", err);
      });

      return;
    }

    if (customId.startsWith("counter_offer_counter_modal:")) {
      const counterOfferRecordId = customId.replace("counter_offer_counter_modal:", "");
      const rawAmount = interaction.fields.getTextInputValue("counter_price");
      const counterPrice = Number(String(rawAmount).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isInteger(counterPrice) || counterPrice <= 0) {
        await interaction.reply({
          content: "⚠️ Please enter a valid whole-number counter.",
          ephemeral: true
        }).catch(() => {});
        return;
      }

      const response = await fetch(
        `${APP_PUBLIC_BASE_URL}/api/counter-offers/${counterOfferRecordId}/seller-counter`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ price: counterPrice })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        await interaction.reply({
          content: `❌ ${data.error || "Failed to submit your counter."}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }

      await interaction.reply({
        content: `✅ Your counter of €${counterPrice} was sent to the store.`,
        ephemeral: true
      }).catch(() => {});

      // FIXED — CRASH: this used the discord.js ActionRowBuilder/
      // ButtonBuilder classes, which are never imported anywhere in
      // this file (only in airtable-discord-updates-main/server.js —
      // this file uses raw component objects everywhere else). That
      // caused a ReferenceError that crashed the entire bot process on
      // every single seller counter. Rewritten as a raw object to match
      // this file's actual pattern.
      const editRow = {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Accept",
            custom_id: "counter_offer_accept_disabled",
            disabled: true
          },
          {
            type: 2,
            style: 1,
            label: "Edit",
            custom_id: `counter_offer_edit:${data.new_round_id || counterOfferRecordId}`
          },
          {
            type: 2,
            style: 4,
            label: "Deny",
            custom_id: "counter_offer_deny_disabled",
            disabled: true
          }
        ]
      };

      await interaction.message.edit({
        content: `🔁 You countered with €${counterPrice}. Waiting on the store.`,
        embeds: interaction.message.embeds,
        components: [editRow]
      }).catch((err) => console.error("Failed to update message with Edit button:", err));

      return;
    }

    if (customId.startsWith("counter_offer_deny:")) {
      const counterOfferRecordId = customId.split(":")[1];
    
      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Denied",
        "Denied At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });
    
      await disableCounterOfferDiscordButtons(
        interaction.channelId,
        interaction.message.id,
        "❌ Counter offer denied."
      );

      // FIXED — same redesign as the symmetric store-deny endpoint: if
      // this denied counter was itself responding to an earlier SELLER
      // counter (i.e. this isn't the very first round-1 counter), that
      // seller counter never went away — the store just couldn't get
      // past it. Reopen it and resend the standard interactive
      // notification so the store can accept it or try a lower counter,
      // instead of only getting an informational, action-less message.
      // Round-1 counters (no Previous Record ID) have no prior round to
      // reopen — those fall back to the plain informational notice,
      // since the store's only option there is a fresh round-1 counter,
      // which they can already do via the existing broadcast flow.
      try {
        const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
        const deniedFields = deniedRecord.fields || {};
        const deniedOrderId = firstLinkedRecordId(deniedFields["Order"]);
        const deniedPrice = numberValue(deniedFields["Store Counter Price"]);
        const priorRoundId = asText(deniedFields["Previous Record ID"]);

        if (deniedOrderId && AIRTABLE_DISCORD_UPDATES_URL) {
          const orderRecord = await airtable(ORDERS_TABLE).find(deniedOrderId);
          const orderFields = orderRecord.fields || {};

          if (priorRoundId) {
            const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

            if (priorRound) {
              await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, {
                "Status": "Open"
              });

              const priorFields = priorRound.fields || {};

              // Store-equivalent of the seller's counter on the
              // reopened round, for both the band and the display.
              const priorSellerCounter = numberValue(priorFields["Seller Counter Price"]);
              const priorVatType = asText(priorFields["Seller Original VAT Type"] || deniedFields["Seller Original VAT Type"]);
              const priorSellerCounterInStoreTerms = calculateStoreCounterEquivalent(
                priorSellerCounter,
                priorVatType,
                orderFields
              );

              await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  trigger_type: "counter-offer-seller-countered",
                  store_name: asText(orderFields["Store Name"]),
                  record_id: deniedOrderId,
                  shopify_order_number: asText(orderFields["Shopify Order Number"]),
                  product_name: asText(deniedFields["Product Name"]),
                  sku: asText(deniedFields["SKU"]),
                  size: asText(deniedFields["Size"]),
                  counter_offer_record_id: priorRoundId,
                  selling_price: numberValue(orderFields["Selling Price"]) || numberValue(orderFields["Shopify Selling Price"]),
                  your_previous_counter: deniedPrice,
                  // FIXED — same display bug: show the seller's raw
                  // counter here, not the store-converted equivalent.
                  seller_counter_price: priorSellerCounterInStoreTerms ?? priorSellerCounter,
                  denied_price: deniedPrice
                })
              });
            }
          } else {
            await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                trigger_type: "counter-offer-denied",
                store_name: asText(orderFields["Store Name"]),
                record_id: deniedOrderId,
                shopify_order_number: asText(orderFields["Shopify Order Number"]),
                product_name: asText(deniedFields["Product Name"]),
                sku: asText(deniedFields["SKU"]),
                size: asText(deniedFields["Size"]),
                denied_price: deniedPrice
              })
            });
          }
        }
      } catch (notifyErr) {
        console.error("Failed to notify store of counter denial (non-blocking):", notifyErr);
      }
    
      return;
    }
    
    if (customId.startsWith("counter_offer_accept:")) {
      const counterOfferRecordId = customId.split(":")[1];
    
      const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      const f = counterOffer.fields || {};
    
      if (asText(f["Status"]) !== "Open") {
        await disableCounterOfferDiscordButtons(
          interaction.channelId,
          interaction.message.id,
          "❌ This counter offer is no longer available."
        );
        return;
      }
    
      const linkedOrderId = firstLinkedRecordId(f["Order"]);
    
      if (!linkedOrderId) {
        throw new Error("Counter Offer missing linked Order");
      }
    
      const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
      const orderStatus = asText(orderRecord.fields?.["Fulfillment Status"]);
    
      if (orderStatus !== "Outsource") {
        await disableCounterOfferDiscordButtons(
          interaction.channelId,
          interaction.message.id,
          "❌ This order is already no longer available."
        );
        return;
      }
    
      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Accepted",
        "Accepted At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      if (!COUNTER_OFFER_ACCEPT_WEBHOOK_URL) {
        throw new Error("Missing COUNTER_OFFER_ACCEPT_WEBHOOK_URL");
      }
      
      await fetch(COUNTER_OFFER_ACCEPT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          trigger_type: "counter-offer-accepted",
      
          counter_offer_record_id: counterOfferRecordId,
          order_record_id: linkedOrderId,
      
          seller_record_id: firstLinkedRecordId(f["Seller ID"]),
          seller_offer_record_id: asText(f["Seller Offer Record ID"]),
      
          source_type: asText(f["Source Type"]),
      
          store_counter_price: numberValue(f["Store Counter Price"]),
          store_counter_price_excl_vat: numberValue(f["Store Counter Price Excl VAT"]),
      
          counter_payout: numberValue(f["Counter Payout"]),
          counter_payout_vat_type: asText(f["Counter Payout VAT Type"]),
      
          seller_original_price: numberValue(f["Seller Original Price"]),
          seller_original_vat_type: asText(f["Seller Original VAT Type"]),
      
          accepted_at_iso: new Date().toISOString()
        })
      });

      // NEW — CRITICAL FIX: this accept flow previously only updated the
      // Counter Offer record and fired a webhook, relying entirely on
      // whatever consumes that webhook (a Make scenario) to write the
      // final price back onto the Order. For a multi-round negotiated
      // deal, that clearly wasn't happening reliably — a store accepted
      // €155 here, but calculateLinkedUnitPrice.js (which reads "Custom
      // Offer"/"Offer To Store" on the Order, not the Counter Offers
      // table) never saw that number, fell through to its Target/Max
      // buying-price fallback, and produced a wrong €185 invoice.
      // "Custom Offer" takes priority over everything else in that
      // script, so writing the accepted Store Counter Price there
      // directly — regardless of what the Make webhook does — makes
      // sure the correct price is always used, with no dependency on a
      // downstream system we don't control.
      try {
        await airtable(ORDERS_TABLE).update(linkedOrderId, {
          "Custom Offer": numberValue(f["Store Counter Price"]),
          "Offer Accepted?": true
        });
      } catch (priceWriteErr) {
        console.error("Failed to write accepted price to Order record (non-blocking):", priceWriteErr);
      }
    
      await disableCounterOfferDiscordButtons(
        interaction.channelId,
        interaction.message.id,
        "✅ Counter offer accepted."
      );
    
      // FIXED — pre-existing bug (confirmed present in the original
      // uploaded code): FIND(recordId, ARRAYJOIN({Order})) never
      // actually matches, because Airtable formulas resolve a linked
      // field to the LINKED RECORD'S DISPLAY TEXT (e.g. "ORD-019118"),
      // not its raw record ID — so this filter silently returned zero
      // competing counters every time, meaning they were never actually
      // auto-closed. Fetching by the other filters and matching the
      // Order link by raw ID in JavaScript (where the API does return
      // real record IDs) fixes it.
      const openCountersForOrderMatch = await airtable(COUNTER_OFFERS_TABLE)
        .select({
          filterByFormula: `AND(
            {Status} = 'Open',
            RECORD_ID() != '${counterOfferRecordId}'
          )`
        })
        .all();

      const competingCounters = openCountersForOrderMatch.filter((r) =>
        firstLinkedRecordId(r.fields?.["Order"]) === linkedOrderId
      );
      
      for (const competing of competingCounters) {
        await airtable(COUNTER_OFFERS_TABLE).update(competing.id, {
          "Status": "Closed",
          "Closed At": new Date().toISOString()
        });
      
        const cf = competing.fields || {};
        const channelId = asText(cf["Discord Channel ID"]);
        const messageId = asText(cf["Discord Message ID"]);
      
        if (channelId && messageId) {
          await disableCounterOfferDiscordButtons(
            channelId,
            messageId,
            "❌ Counter offer closed — another seller accepted."
          );
        }
      }
    
      return;
    }

    const [action, offerId] = customId.split(":");

    try {
      if (customId.startsWith("request_consignment_label:")) {
        const [, orderRecordId] = customId.split(":");
      
        await requestConsignmentShippingLabel(orderRecordId);
      
        await safeEditInteractionMessage(interaction, {
          content: interaction.message.content,
          embeds: interaction.message.embeds,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Requested Label",
                  custom_id: "label_requested_disabled",
                  disabled: true
                }
              ]
            }
          ]
        });
      
        return;
      }
      
      if (action === "deny_offer") {
        const result = await denyConsignmentOffer(offerId);

        await disableConsignmentDiscordButtons(
          interaction.channelId,
          interaction.message.id,
          result.ok
            ? "❌ Offer denied."
            : "❌ This offer is no longer available.",
          client
        );

        return;
      }

      if (action === "confirm_offer") {
        await safeEditInteractionMessage(interaction, {
          content: "⏳ Processing confirmation...",
          embeds: interaction.message.embeds,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Processing...",
                  custom_id: "consignment_processing_disabled",
                  disabled: true
                }
              ]
            }
          ]
        }, client).catch((err) => {
          console.error("Failed to set consignment message to processing:", err);
        });
      
        const result = await confirmConsignmentOffer(offerId);
      
        if (!result.ok) {
          await safeEditInteractionMessage(interaction, {
            content: "❌ This offer is no longer available.",
            embeds: interaction.message.embeds,
            components: []
          }, client).catch((err) => {
            console.error("Failed to mark consignment offer unavailable:", err);
          });
      
          return;
        }
      
        await safeEditInteractionMessage(interaction, {
          content: `✅ Confirmed by ${result.offer.seller_id}. Deal update has been sent.`,
          embeds: interaction.message.embeds,
          components: []
        }, client).catch((err) => {
          console.error("Failed to mark consignment offer confirmed:", err);
        });
      
        return;
      }
    } catch (err) {
      console.error("Consignment Discord button error:", err);
    }
  });
}

app.use(compression());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({
  extended: false,
  limit: "25mb"
}));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/reset-password", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reset-password.html"));
});

app.get("/consignment-application", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "consignment-application.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Kickz Caviar Portal"
  });
});

function sanitizeUploadFileName(filename) {
  return String(filename || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 140);
}

function getBase64Buffer(file) {
  if (!file?.data) return null;

  const base64 = String(file.data).includes(",")
    ? String(file.data).split(",").pop()
    : String(file.data);

  return Buffer.from(base64, "base64");
}

async function uploadConsignmentApplicationFile({
  sellerRecordId,
  type,
  file
}) {
  if (!file?.data || !file?.name) return null;

  const buffer = getBase64Buffer(file);
  const safeName = sanitizeUploadFileName(file.name);
  const path = `${sellerRecordId}/${Date.now()}-${type}-${safeName}`;

  const { error } = await supabase.storage
    .from(CONSIGNMENT_APPLICATIONS_BUCKET)
    .upload(path, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: false
    });

  if (error) {
    throw new Error(`Failed to upload ${type}: ${error.message}`);
  }

  const { data } = supabase.storage
    .from(CONSIGNMENT_APPLICATIONS_BUCKET)
    .getPublicUrl(path);

  return {
    url: data.publicUrl,
    filename: safeName
  };
}

async function uploadMemberWtbLabelFile({ memberWtbRecordId, file }) {
  if (!file?.data || !file?.name) return null;

  const buffer = getBase64Buffer(file);
  const safeName = sanitizeUploadFileName(file.name);
  const path = `member-wtb-labels/${memberWtbRecordId}/${Date.now()}-${safeName}`;

  const { error } = await supabase.storage
    .from(CONSIGNMENT_APPLICATIONS_BUCKET)
    .upload(path, buffer, {
      contentType: file.type || "application/pdf",
      upsert: true
    });

  if (error) {
    throw new Error(`Failed to upload label: ${error.message}`);
  }

  const { data } = supabase.storage
    .from(CONSIGNMENT_APPLICATIONS_BUCKET)
    .getPublicUrl(path);

  return {
    url: data.publicUrl,
    filename: safeName
  };
}

app.get("/api/member-wtb/label-request/:recordId", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);

    if (!recordId) {
      return res.status(400).json({ error: "Missing recordId" });
    }

    const record = await airtable(MEMBER_WTBS_TABLE).find(recordId);
    const f = record.fields || {};

    let buyerName = "";
    const buyerRecordId = firstLinkedRecordId(f["Buyer Seller ID"]);

    if (buyerRecordId) {
      const buyerRecord = await airtable(SELLERS_TABLE).find(buyerRecordId);

      buyerName =
        asText(buyerRecord.fields?.["Full Name"]) ||
        asText(buyerRecord.fields?.["Name"]) ||
        buyerRecordId;
    }

    res.json({
      record_id: record.id,
      member_wtb_id: asText(f["Member WTB ID"]) || asText(f["WTB ID"]) || record.id,
      buyer_name: buyerName,
      buyer_seller_id: buyerRecordId,
      product_name: asText(f["Product Name"]),
      sku: asText(f["SKU"]),
      size: asText(f["Size"]),
      brand: asText(f["Brand"]),
      invoice_price: Number(f["Invoice Price"] || 0),
      max_price: Number(f["Max Price"] || 0),
      final_buying_price: Number(f["Final Buying Price"] || 0),
      shipping_label_url:
        asText(f["Shipping Label Permanent URL"]) ||
        asText(f["Shipping Label URL"]),
      tracking_number: asText(f["Tracking Number"])
    });
  } catch (err) {
    console.error("Failed to load Member WTB label request:", err);

    res.status(500).json({
      error: "Failed to load label request",
      details: err.message
    });
  }
});

app.post("/api/member-wtb/label-request-submit", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const trackingNumber = asText(req.body?.tracking_number);
    const labelFile = req.body?.label_file;

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id" });
    }

    if (!trackingNumber) {
      return res.status(400).json({ error: "Missing tracking_number" });
    }

    if (!labelFile?.data) {
      return res.status(400).json({ error: "Missing label_file" });
    }

    const upload = await uploadMemberWtbLabelFile({
      memberWtbRecordId,
      file: labelFile
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Shipping Label": [
        {
          url: upload.url,
          filename: upload.filename
        }
      ],
      "Shipping Label Permanent URL": upload.url,
      "Tracking Number": trackingNumber,
      "Label Uploaded At": new Date().toISOString()
    });

    res.json({
      ok: true,
      label_url: upload.url,
      tracking_number: trackingNumber
    });
  } catch (err) {
    console.error("Failed to submit Member WTB label:", err);

    res.status(500).json({
      error: "Failed to submit label",
      details: err.message
    });
  }
});

app.post("/api/member-wtb/send-label-to-discord", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.recordId);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing recordId" });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const f = memberWtb.fields || {};

    const labelUrl = asText(f["Shipping Label Permanent URL"]);
    const trackingNumber = asText(f["Tracking Number"]);

    if (!labelUrl) {
      return res.status(400).json({ error: "Missing Shipping Label Permanent URL" });
    }

    if (!trackingNumber) {
      return res.status(400).json({ error: "Missing Tracking Number" });
    }

    const memberWtbId =
      asText(f["Member WTB ID"]) ||
      asText(f["WTB ID"]) ||
      memberWtbRecordId;

    const linkedInventoryUnitId = firstLinkedRecordId(f["Linked Inventory Unit"]);

    let targetChannelId = asText(f["WTB Created Channel ID"]);
    let targetReason = targetChannelId ? "wtb_created_channel" : "";

    if (!targetChannelId && linkedInventoryUnitId) {
      const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).find(linkedInventoryUnitId);
      const inventoryFields = inventoryUnit.fields || {};
      const sellerRecordId = firstLinkedRecordId(inventoryFields["Seller ID"]);

      if (sellerRecordId) {
        const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId);
        targetChannelId = asText(sellerRecord.fields?.["Label Channel ID"]);

        if (targetChannelId) {
          targetReason = "seller_label_channel";
        }
      }
    }

    if (!targetChannelId) {
      targetChannelId = asText(process.env.MEMBER_WTB_KC_LABEL_CHANNEL_ID);
      targetReason = "kc_label_channel";
    }

    if (!targetChannelId) {
      return res.status(500).json({
        error: "No target label channel found"
      });
    }

    await initKickzDealDiscord();

    const channel = await kickzDealDiscordClient.channels
      .fetch(targetChannelId)
      .catch(() => null);

    if (!channel) {
      return res.status(404).json({
        error: "Target Discord channel not found",
        details: targetChannelId
      });
    }

    const isGlobalLabelChannel =
      targetReason === "seller_label_channel" ||
      targetReason === "kc_label_channel";
    
    const embedDescription = isGlobalLabelChannel
      ? [
          `**Order:** ${memberWtbId}`,
          `**Product:** ${asText(f["Product Name"]) || "—"}`,
          `**SKU:** ${asText(f["SKU"]) || "—"}`,
          `**Size:** ${asText(f["Size"]) || "—"}`,
          "",
          `**Tracking:**`,
          trackingNumber,
          "",
          `📄 [Download Label](${labelUrl})`
        ].join("\n")
      : [
          `**Order:** ${memberWtbId}`,
          `**Tracking:**`,
          trackingNumber,
          "",
          `📄 [Download Label](${labelUrl})`
        ].join("\n");
    
    const message = await channel.send({
      embeds: [
        {
          title: "📦 Shipping Label Ready",
          description: embedDescription,
          color: 0x2ecc71,
          footer: {
            text: "Kickz Caviar"
          },
          timestamp: new Date().toISOString()
        }
      ]
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Label Sent To Discord?": true
    });

    res.json({
      ok: true,
      channel_id: message.channelId,
      message_id: message.id,
      target_reason: targetReason
    });
  } catch (err) {
    console.error("Failed to send Member WTB label to Discord:", err);

    res.status(500).json({
      error: "Failed to send Member WTB label to Discord",
      details: err.message
    });
  }
});

app.post("/api/consignment/application", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const discord = asText(req.body?.discord);
    const notes = asText(req.body?.notes);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId);
    const seller = normalizeSeller(sellerRecord);

    if (seller.consignor === true) {
      return res.status(409).json({
        error: "Seller is already approved as consignor"
      });
    }

    const inventoryUpload = await uploadConsignmentApplicationFile({
      sellerRecordId,
      type: "inventory",
      file: req.body?.inventory_file
    });

    const proofUpload = await uploadConsignmentApplicationFile({
      sellerRecordId,
      type: "proof",
      file: req.body?.proof_file
    });

    const fields = {
      "Seller": [sellerRecordId],
      "Discord": discord || seller.discord || "",
      "Notes": notes || ""
    };

    if (inventoryUpload) {
      fields["Inventory Upload URL"] = inventoryUpload.url;
      fields["Inventory Filename"] = inventoryUpload.filename;
    }
    
    if (proofUpload) {
      fields["Proof / References URL"] = proofUpload.url;
      fields["Proof Filename"] = proofUpload.filename;
    }

    const created = await airtable(AIRTABLE_CONSIGNMENT_APPLICATIONS_TABLE).create(fields);

    res.json({
      success: true,
      application_id: created.id
    });
  } catch (err) {
    console.error("Failed to create consignment application:", err);

    res.status(500).json({
      error: "Failed to create consignment application",
      details: err.message
    });
  }
});

app.post("/api/make/consignor-activated", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.AIRTABLE_WEBHOOK_SECRET ||
      secret !== process.env.AIRTABLE_WEBHOOK_SECRET
    ) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const sellerRecordId = asText(req.body?.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const sellerRecord =
      await airtable(SELLERS_TABLE).find(sellerRecordId);

    const seller = normalizeSeller(sellerRecord);

    if (seller.consignor !== true) {
      return res.status(409).json({
        error: "Seller is not a consignor"
      });
    }

    if (
      asText(
        sellerRecord.fields?.["Consignor Activation DM Sent At"]
      )
    ) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "already_sent"
      });
    }

    const discordResult =
      await sendConsignorActivationDiscordDM(seller);

    await airtable(SELLERS_TABLE).update(
      sellerRecordId,
      {
        "Consignor Activation DM Sent At":
          new Date().toISOString()
      }
    );

    res.json({
      ok: true,
      discord: discordResult
    });
  } catch (err) {
    console.error(
      "Failed to send consignor activation DM:",
      err
    );

    res.status(500).json({
      error: "Failed to send consignor activation DM",
      details: err.message
    });
  }
});

app.get("/api/consignment/inventory", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const { data: inventoryRows, error: inventoryError } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity
      `)
      .eq("seller_record_id", sellerRecordId)
      .gt("quantity", 0)
      .order("sku", { ascending: true })
      .order("size", { ascending: true });

    if (inventoryError) throw inventoryError;

    const stockKeys = [
      ...new Set(
        (inventoryRows || []).map((row) =>
          getStockCounterKey(row.sku, row.size)
        )
      )
    ];

    let stockLevelMap = new Map();

    if (stockKeys.length) {
      const { data: stockLevels, error: stockLevelError } = await supabase
        .from("consignment_stock_levels")
        .select("stock_counter_key, lowest_suggested_price")
        .in("stock_counter_key", stockKeys);

      if (stockLevelError) throw stockLevelError;

      stockLevelMap = new Map(
        (stockLevels || []).map((row) => [
          row.stock_counter_key,
          row.lowest_suggested_price
        ])
      );
    }

    const items = (inventoryRows || []).map((row) => {
      const lowestComparePrice =
        stockLevelMap.get(getStockCounterKey(row.sku, row.size)) ?? null;
    
      return {
        ...row,
        lowest_suggested_price:
          lowestComparePrice === null
            ? null
            : getConsignmentLowestDisplayPrice(
                lowestComparePrice,
                row.vat_type
              )
      };
    });

    res.json({
      count: items.length,
      items
    });
  } catch (err) {
    console.error("Failed to load consignment inventory:", err);

    res.status(500).json({
      error: "Failed to load consignment inventory",
      details: err.message
    });
  }
});

async function addConsignmentInventoryRow({
  sellerRecordId,
  sellerId,
  sku,
  size,
  vatType,
  sellingPriceSuggested,
  quantity
}) {
  const cleanSku = asText(sku).toUpperCase();
  const cleanSize = asText(size);
  const cleanVatType = asText(vatType);
  const cleanPrice = Number(sellingPriceSuggested);
  const cleanQuantity = Number(quantity);

  const productInfo = await lookupSkuMasterProduct(cleanSku);

  const { data: existingRows, error: existingError } = await supabase
    .from("consignment_inventory")
    .select("id, quantity")
    .eq("seller_record_id", sellerRecordId)
    .eq("sku", cleanSku)
    .eq("size", cleanSize)
    .limit(1);

  if (existingError) throw existingError;

  if (existingRows.length) {
    const existing = existingRows[0];

    const { data, error } = await supabase
      .from("consignment_inventory")
      .update({
        seller_id: sellerId,
        product_name: productInfo.product_name,
        brand: productInfo.brand,
        vat_type: cleanVatType,
        selling_price_suggested: cleanPrice,
        quantity: Number(existing.quantity || 0) + cleanQuantity,
        updated_at: new Date().toISOString()
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;

    const stockLevel = await refreshConsignmentStockLevel(cleanSku, cleanSize);

    return {
      mode: "updated",
      item: data,
      stock_level: stockLevel
    };
  }

  const { data, error } = await supabase
    .from("consignment_inventory")
    .insert({
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      product_name: productInfo.product_name,
      brand: productInfo.brand,
      sku: cleanSku,
      size: cleanSize,
      vat_type: cleanVatType,
      selling_price_suggested: cleanPrice,
      quantity: cleanQuantity
    })
    .select()
    .single();

  if (error) throw error;

  const stockLevel = await refreshConsignmentStockLevel(cleanSku, cleanSize);

  return {
    mode: "created",
    item: data,
    stock_level: stockLevel
  };
}

async function setConsignmentInventoryRow({
  sellerRecordId,
  sellerId,
  sku,
  size,
  vatType,
  sellingPriceSuggested,
  quantity
}) {
  const cleanSku = asText(sku).toUpperCase();
  const cleanSize = asText(size);
  const cleanVatType = asText(vatType);
  const cleanPrice = Number(sellingPriceSuggested);
  const cleanQuantity = Number(quantity);

  const productInfo = await lookupSkuMasterProduct(cleanSku);

  const { data: existingRows, error: existingError } = await supabase
    .from("consignment_inventory")
    .select("id")
    .eq("seller_record_id", sellerRecordId)
    .eq("sku", cleanSku)
    .eq("size", cleanSize)
    .limit(1);

  if (existingError) throw existingError;

  if (existingRows.length) {
    const { data, error } = await supabase
      .from("consignment_inventory")
      .update({
        seller_id: sellerId,
        product_name: productInfo.product_name,
        brand: productInfo.brand,
        vat_type: cleanVatType,
        selling_price_suggested: cleanPrice,
        quantity: cleanQuantity,
        updated_at: new Date().toISOString()
      })
      .eq("id", existingRows[0].id)
      .select()
      .single();

    if (error) throw error;

    return {
      mode: "updated",
      item: data
    };
  }

  const { data, error } = await supabase
    .from("consignment_inventory")
    .insert({
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      product_name: productInfo.product_name,
      brand: productInfo.brand,
      sku: cleanSku,
      size: cleanSize,
      vat_type: cleanVatType,
      selling_price_suggested: cleanPrice,
      quantity: cleanQuantity
    })
    .select()
    .single();

  if (error) throw error;

  return {
    mode: "created",
    item: data
  };
}

app.post("/api/consignment/inventory/manual", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const sellerId = asText(req.body?.seller_id);
    const sku = asText(req.body?.sku).toUpperCase();
    const size = asText(req.body?.size);
    const vatType = asText(req.body?.vat_type);
    const sellingPriceSuggested = Number(req.body?.selling_price_suggested);
    const quantity = Number(req.body?.quantity);

    if (!sellerRecordId) return res.status(400).json({ error: "Missing seller_record_id" });
    if (!sku) return res.status(400).json({ error: "Missing SKU" });
    if (!size) return res.status(400).json({ error: "Missing size" });

    if (!["Margin", "VAT0", "VAT21"].includes(vatType)) {
      return res.status(400).json({ error: "VAT Type must be Margin, VAT0 or VAT21" });
    }

    if (!Number.isFinite(sellingPriceSuggested) || sellingPriceSuggested <= 0) {
      return res.status(400).json({ error: "Selling Price must be higher than 0" });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive whole number" });
    }

    const result = await addConsignmentInventoryRow({
      sellerRecordId,
      sellerId,
      sku,
      size,
      vatType,
      sellingPriceSuggested,
      quantity
    });

    res.json({
      ok: true,
      ...result
    });
  } catch (err) {
    console.error("Failed to manually add consignment inventory:", err);

    res.status(500).json({
      error: "Failed to add consignment inventory",
      details: err.message
    });
  }
});

function normalizeConsignmentCsvRows(rows) {
  return rows.map((row) => ({
    row_number: row.row_number,
    sku: asText(row.sku).toUpperCase(),
    size: asText(row.size),
    vat_type: asText(row.vat_type),
    selling_price_suggested: Number(row.selling_price_suggested),
    quantity: Number(row.quantity)
  }));
}

function validateConsignmentCsvAddRows(rows) {
  const csvKeys = new Set();

  for (const row of rows) {
    const key = getStockCounterKey(row.sku, row.size);

    if (!row.sku || !row.size) {
      throw new Error(`Invalid row ${row.row_number || ""}: missing SKU or Size`);
    }

    if (csvKeys.has(key)) {
      throw new Error(`Duplicate SKU + Size in CSV: ${row.sku} / ${row.size}`);
    }

    csvKeys.add(key);

    if (!["Margin", "VAT0", "VAT21"].includes(row.vat_type)) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid VAT Type`);
    }

    if (!Number.isFinite(row.selling_price_suggested) || row.selling_price_suggested <= 0) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid Selling Price`);
    }

    if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid Quantity`);
    }
  }
}

function validateConsignmentCsvReplaceRows(rows) {
  const csvKeys = new Set();

  for (const row of rows) {
    const key = getStockCounterKey(row.sku, row.size);

    if (!row.sku || !row.size) {
      throw new Error(`Invalid row ${row.row_number || ""}: missing SKU or Size`);
    }

    if (csvKeys.has(key)) {
      throw new Error(`Duplicate SKU + Size in CSV: ${row.sku} / ${row.size}`);
    }

    csvKeys.add(key);

    if (!["Margin", "VAT0", "VAT21"].includes(row.vat_type)) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid VAT Type`);
    }

    if (!Number.isFinite(row.selling_price_suggested) || row.selling_price_suggested <= 0) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid Selling Price`);
    }

    if (!Number.isInteger(row.quantity) || row.quantity < 0) {
      throw new Error(`Invalid row ${row.row_number || ""}: invalid Quantity`);
    }
  }

  return csvKeys;
}

async function getActiveCsvImportJobForSeller(sellerRecordId) {
  const { data, error } = await supabase
    .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
    .select("id, status, total_rows, processed_rows, import_type, created_at")
    .eq("seller_record_id", sellerRecordId)
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;

  return data?.[0] || null;
}

async function createCsvImportJob({
  sellerRecordId,
  sellerId,
  importType,
  rows
}) {
  const activeJob = await getActiveCsvImportJobForSeller(sellerRecordId);

  if (activeJob) {
    return {
      existing: true,
      job: activeJob
    };
  }

  const { data, error } = await supabase
    .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
    .insert({
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      import_type: importType,
      status: "queued",
      total_rows: rows.length,
      processed_rows: 0,
      rows_json: rows
    })
    .select()
    .single();

  if (error) throw error;

  return {
    existing: false,
    job: data
  };
}

async function updateCsvImportJob(jobId, fields) {
  const { error } = await supabase
    .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
    .update({
      ...fields,
      heartbeat_at: new Date().toISOString()
    })
    .eq("id", jobId);

  if (error) throw error;
}

async function getNextCsvImportJob() {
  const staleIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const queued = await supabase
    .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (queued.error) throw queued.error;
  if (queued.data?.length) return queued.data[0];

  const stale = await supabase
    .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
    .select("*")
    .eq("status", "processing")
    .lt("heartbeat_at", staleIso)
    .order("created_at", { ascending: true })
    .limit(1);

  if (stale.error) throw stale.error;

  return stale.data?.[0] || null;
}

let csvImportWorkerRunning = false;

async function processCsvImportQueue() {
  if (csvImportWorkerRunning) return;

  csvImportWorkerRunning = true;

  try {
    while (true) {
      const job = await getNextCsvImportJob();
      if (!job) return;

      await processCsvImportJob(job);
    }
  } finally {
    csvImportWorkerRunning = false;
  }
}

async function processCsvImportJob(job) {
  const rows = Array.isArray(job.rows_json) ? job.rows_json : [];
  let processed = Number(job.processed_rows || 0);

  const affectedStockKeys = new Map();

  function rememberStockKey(sku, size) {
    const cleanSku = asText(sku).toUpperCase();
    const cleanSize = asText(size).toUpperCase();
    const key = getStockCounterKey(cleanSku, cleanSize);

    affectedStockKeys.set(key, {
      sku: cleanSku,
      size: cleanSize
    });
  }

  await updateCsvImportJob(job.id, {
    status: "processing",
    started_at: job.started_at || new Date().toISOString()
  });

  try {
    if (job.import_type === "replace" && processed === 0) {
      const csvKeys = new Set(
        rows.map((row) => getStockCounterKey(row.sku, row.size))
      );

      const { data: existingRows, error: existingError } = await supabase
        .from("consignment_inventory")
        .select("id, sku, size, quantity")
        .eq("seller_record_id", job.seller_record_id);

      if (existingError) throw existingError;

      for (const existing of existingRows || []) {
        const key = getStockCounterKey(existing.sku, existing.size);

        if (!csvKeys.has(key) && Number(existing.quantity || 0) !== 0) {
          const { error } = await supabase
            .from("consignment_inventory")
            .update({
              quantity: 0,
              updated_at: new Date().toISOString()
            })
            .eq("id", existing.id);

          if (error) throw error;

          rememberStockKey(existing.sku, existing.size);
        }
      }
    }

    for (let i = processed; i < rows.length; i += 1) {
      const row = rows[i];

      await updateCsvImportJob(job.id, {
        current_row_number: row.row_number || i + 1
      });

      if (job.import_type === "replace") {
        await setConsignmentInventoryRow({
          sellerRecordId: job.seller_record_id,
          sellerId: job.seller_id,
          sku: row.sku,
          size: row.size,
          vatType: row.vat_type,
          sellingPriceSuggested: row.selling_price_suggested,
          quantity: row.quantity
        });

        rememberStockKey(row.sku, row.size);
      } else {
        await addConsignmentInventoryRow({
          sellerRecordId: job.seller_record_id,
          sellerId: job.seller_id,
          sku: row.sku,
          size: row.size,
          vatType: row.vat_type,
          sellingPriceSuggested: row.selling_price_suggested,
          quantity: row.quantity
        });
      
        rememberStockKey(row.sku, row.size);
      }

      processed = i + 1;

      await updateCsvImportJob(job.id, {
        processed_rows: processed
      });
    }

    for (const item of affectedStockKeys.values()) {
      await refreshConsignmentStockLevel(item.sku, item.size);
    }

    await updateCsvImportJob(job.id, {
      status: "completed",
      processed_rows: rows.length,
      completed_at: new Date().toISOString(),
      current_row_number: null,
      error_message: null
    });
  } catch (err) {
    await updateCsvImportJob(job.id, {
      status: "failed",
      processed_rows: processed,
      failed_at: new Date().toISOString(),
      error_message: err.message
    });

    console.error("CSV import job failed:", {
      jobId: job.id,
      sellerRecordId: job.seller_record_id,
      processed,
      total: rows.length,
      error: err.message
    });
  }
}

app.post("/api/consignment/inventory/csv-add", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const sellerId = asText(req.body?.seller_id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    if (!rows.length) {
      return res.status(400).json({ error: "No CSV rows provided" });
    }

    const normalizedRows = normalizeConsignmentCsvRows(rows);

    try {
      validateConsignmentCsvAddRows(normalizedRows);
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const result = await createCsvImportJob({
      sellerRecordId,
      sellerId,
      importType: "add",
      rows: normalizedRows
    });

    if (result.existing) {
      return res.status(409).json({
        error: "CSV import already in progress",
        job: result.job,
        message: `CSV Import already in progress: ${result.job.processed_rows || 0} / ${result.job.total_rows || 0} rows processed.`
      });
    }

    res.json({
      ok: true,
      queued: true,
      job_id: result.job.id,
      count: normalizedRows.length,
      message: `${normalizedRows.length} rows received. Processing has started.`
    });

    setImmediate(() => {
      processCsvImportQueue().catch((err) => {
        console.error("CSV import queue failed:", err);
      });
    });
  } catch (err) {
    console.error("Failed to queue consignment CSV add:", err);

    res.status(500).json({
      error: "Failed to queue consignment CSV add",
      details: err.message
    });
  }
});

app.post("/api/consignment/inventory/csv-replace", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const sellerId = asText(req.body?.seller_id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    if (!rows.length) {
      return res.status(400).json({ error: "No CSV rows provided" });
    }

    const normalizedRows = normalizeConsignmentCsvRows(rows);

    try {
      validateConsignmentCsvReplaceRows(normalizedRows);
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const result = await createCsvImportJob({
      sellerRecordId,
      sellerId,
      importType: "replace",
      rows: normalizedRows
    });

    if (result.existing) {
      return res.status(409).json({
        error: "CSV import already in progress",
        job: result.job,
        message: `CSV Import already in progress: ${result.job.processed_rows || 0} / ${result.job.total_rows || 0} rows processed.`
      });
    }

    res.json({
      ok: true,
      queued: true,
      job_id: result.job.id,
      count: normalizedRows.length,
      message: `${normalizedRows.length} rows received. Replacement processing has started.`
    });

    setImmediate(() => {
      processCsvImportQueue().catch((err) => {
        console.error("CSV import queue failed:", err);
      });
    });
  } catch (err) {
    console.error("Failed to queue consignment CSV replace:", err);

    res.status(500).json({
      error: "Failed to queue consignment CSV replace",
      details: err.message
    });
  }
});

app.get("/api/consignment/csv-import/latest", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const { data, error } = await supabase
      .from(SUPABASE_CSV_IMPORT_JOBS_TABLE)
      .select("id, import_type, status, total_rows, processed_rows, error_message, created_at, started_at, completed_at, failed_at")
      .eq("seller_record_id", sellerRecordId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    setImmediate(() => {
      processCsvImportQueue().catch((err) => {
        console.error("CSV import queue resume failed:", err);
      });
    });

    res.json({
      job: data?.[0] || null
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to load CSV import status",
      details: err.message
    });
  }
});

app.delete("/api/consignment/inventory/:id", async (req, res) => {
  try {
    const inventoryId = asText(req.params.id);

    if (!inventoryId) {
      return res.status(400).json({
        error: "Missing inventory id"
      });
    }

    const { data: existingItem, error: existingError } = await supabase
      .from("consignment_inventory")
      .select("id, sku, size")
      .eq("id", inventoryId)
      .single();

    if (existingError) {
      throw existingError;
    }

    const { error } = await supabase
      .from("consignment_inventory")
      .delete()
      .eq("id", inventoryId);

    if (error) {
      throw error;
    }

    await refreshConsignmentStockLevel(
      existingItem.sku,
      existingItem.size
    );

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("Failed to delete consignment inventory:", err);

    res.status(500).json({
      error: "Failed to delete consignment inventory",
      details: err.message
    });
  }
});

app.patch("/api/consignment/inventory/:id", async (req, res) => {
  try {
    const inventoryId = asText(req.params.id);
    const sellingPriceSuggested = Number(req.body?.selling_price_suggested);
    const quantity = Number(req.body?.quantity);

    if (!inventoryId) {
      return res.status(400).json({ error: "Missing inventory id" });
    }

    if (!Number.isFinite(sellingPriceSuggested) || sellingPriceSuggested <= 0) {
      return res.status(400).json({
        error: "Selling Price must be higher than 0"
      });
    }

    if (!Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({
        error: "Quantity must be a whole number"
      });
    }

    const { data: existingItem, error: existingError } = await supabase
      .from("consignment_inventory")
      .select("id, sku, size")
      .eq("id", inventoryId)
      .single();

    if (existingError) {
      throw existingError;
    }

    const { data, error } = await supabase
      .from("consignment_inventory")
      .update({
        selling_price_suggested: sellingPriceSuggested,
        quantity,
        updated_at: new Date().toISOString()
      })
      .eq("id", inventoryId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    const stockLevel = await refreshConsignmentStockLevel(
      existingItem.sku,
      existingItem.size
    );

    res.json({
      ok: true,
      item: data,
      stock_level: stockLevel
    });
  } catch (err) {
    console.error("Failed to update consignment inventory:", err);

    res.status(500).json({
      error: "Failed to update consignment inventory",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/preview", async (req, res) => {
  try {
    const sku = asText(req.body?.sku).toUpperCase();
    const size = asText(req.body?.size);
    const maximumBuyingPrice = Number(req.body?.maximum_buying_price);

    if (!sku) return res.status(400).json({ error: "Missing SKU" });
    if (!size) return res.status(400).json({ error: "Missing size" });

    const orderRecordId = asText(req.body?.order_record_id);

    let orderFields = {};
    
    if (orderRecordId) {
      const orderRecord =
        await airtable(ORDERS_TABLE).find(orderRecordId);
    
      orderFields = orderRecord.fields || {};
    }
    
    const calculatedOfferPrice =
      calculateConsignmentOfferPrice(
        maximumBuyingPrice,
        orderFields
      );

    if (calculatedOfferPrice === null) {
      return res.status(400).json({ error: "Invalid Maximum Buying Price" });
    }

    const { data: inventoryRows, error } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity,
        seller_id,
        seller_record_id
      `)
      .eq("sku", sku)
      .eq("size", size)
      .gt("quantity", 0);

    if (error) throw error;

    const offers = (inventoryRows || []).map((row) => {
      const sellerPrice = Number(row.selling_price_suggested);
    
      const sellerComparePrice =
        getConsignmentComparePrice(sellerPrice, row.vat_type);
    
      const offerPrice =
        sellerComparePrice <= calculatedOfferPrice
          ? sellerPrice
          : getConsignmentSellerOfferPrice(
              calculatedOfferPrice,
              row.vat_type
            );
    
      return {
        inventory_id: row.id,
        seller_record_id: row.seller_record_id,
        seller_id: row.seller_id,
        sku: row.sku,
        size: row.size,
        product_name: row.product_name,
        brand: row.brand,
        vat_type: row.vat_type,
        seller_price: sellerPrice,
        seller_compare_price: sellerComparePrice,
        calculated_offer_price: calculatedOfferPrice,
        offer_price: offerPrice,
        quantity: Number(row.quantity || 0)
      };
    });

    res.json({
      ok: true,
      sku,
      size,
      maximum_buying_price: maximumBuyingPrice,
      calculated_offer_price: calculatedOfferPrice,
      count: offers.length,
      offers
    });
  } catch (err) {
    console.error("Failed to preview consignment offers:", err);

    res.status(500).json({
      error: "Failed to preview consignment offers",
      details: err.message
    });
  }
});

app.post("/api/consignment/pre-offer/calculate", async (req, res) => {
  try {
    const orderRecordId = asText(req.body?.order_record_id);
    const sku = asText(req.body?.sku).toUpperCase();
    const size = asText(req.body?.size);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    if (!sku) {
      return res.status(400).json({ error: "Missing SKU" });
    }

    if (!size) {
      return res.status(400).json({ error: "Missing size" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(orderRecordId);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    const { data: inventoryRows, error: inventoryError } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity,
        seller_id,
        seller_record_id
      `)
      .eq("sku", sku)
      .eq("size", size)
      .gt("quantity", 0);

    if (inventoryError) throw inventoryError;

    const validRows = (inventoryRows || [])
      .map((row) => {
        const sellerPrice = Number(row.selling_price_suggested);
        const sellerComparePrice = getConsignmentComparePrice(
          sellerPrice,
          row.vat_type
        );

        const storeBasePrice = convertConsignorPriceToStoreBasePrice(
          sellerPrice,
          row.vat_type,
          clientCountry
        );

        const storeOfferVatType = getStoreOfferVatTypeFromConsignmentVat(
          row.vat_type,
          clientCountry
        );

        const customOffer = calculateStoreCustomOfferFromConsignmentBase(
          storeBasePrice,
          orderFields
        );

        return {
          row,
          sellerPrice,
          sellerComparePrice,
          storeBasePrice,
          storeOfferVatType,
          customOffer
        };
      })
      .filter((item) =>
        Number.isFinite(item.sellerPrice) &&
        item.sellerPrice > 0 &&
        Number.isFinite(item.sellerComparePrice) &&
        Number.isFinite(item.storeBasePrice) &&
        Number.isFinite(item.customOffer)
      )
      .sort((a, b) => a.sellerComparePrice - b.sellerComparePrice);

    const best = validRows[0];

    if (!best) {
      return res.status(404).json({
        error: "No valid consignment stock found"
      });
    }

    res.json({
      ok: true,
      order_record_id: orderRecordId,
      sku,
      size,

      custom_offer: best.customOffer,
      offer_vat_type: best.storeOfferVatType,
      estimated_time: 2,

      consignment_offer_price: best.sellerComparePrice,

      best_inventory: {
        inventory_id: best.row.id,
        seller_record_id: best.row.seller_record_id,
        seller_id: best.row.seller_id,
        product_name: best.row.product_name,
        brand: best.row.brand,
        vat_type: best.row.vat_type,
        seller_price: best.sellerPrice,
        seller_compare_price: best.sellerComparePrice,
        store_base_price: best.storeBasePrice,
        quantity: Number(best.row.quantity || 0)
      }
    });
  } catch (err) {
    console.error("Failed to calculate consignment pre-offer:", err);

    res.status(500).json({
      error: "Failed to calculate consignment pre-offer",
      details: err.message
    });
  }
});

app.post("/api/counter-offers/create", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderRecordId = asText(req.body?.order_record_id);
    const storeCounterPrice = Number(req.body?.store_counter_price);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    if (!Number.isFinite(storeCounterPrice) || storeCounterPrice <= 0) {
      return res.status(400).json({ error: "Invalid store_counter_price" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(orderRecordId);
    const orderFields = orderRecord.fields || {};

    const orderId = asText(orderFields["Order ID"]);
    const productName =
      asText(orderFields["Shopify Product Name"]) ||
      asText(orderFields["Product Name"]);

    const sku = asText(orderFields["SKU"]).toUpperCase();
    const size = asText(orderFields["Size"]);
    const brand = asText(orderFields["Brand"]);

    if (!sku || !size) {
      return res.status(400).json({ error: "Order missing SKU or Size" });
    }

    const nowIso = new Date().toISOString();

    let createdSellerCounters = 0;
    let createdConsignmentOffers = 0;
    let dmErrors = 0;

    const linkedOrderNeedle = escapeFormulaValue(orderId || orderRecordId);

    const sellerOfferRecords = await airtable(SELLER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          FIND('${linkedOrderNeedle}', ARRAYJOIN({Linked Orders})),
          {Seller Offer} > 0
        )`
      })
      .all();

    for (const sellerOfferRecord of sellerOfferRecords) {
      const f = sellerOfferRecord.fields || {};

      const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
      const sellerId = asText(f["Seller ID (Lookup)"]);
      const sellerDiscordId = asText(f["Seller Discord ID"]);
      const sellerOriginalPrice = numberValue(f["Seller Offer"]);
      const sellerVatType = asText(f["Offer VAT Type"]);

      if (!sellerRecordId || !sellerOriginalPrice || !sellerVatType) continue;

      const counterPayout = calculateCounterPayoutForVatType(
        storeCounterPrice,
        sellerVatType,
        orderFields
      );

      if (!Number.isFinite(counterPayout) || counterPayout <= 0) continue;

      const finalSellerCounterPayout =
        sellerOriginalPrice <= counterPayout
          ? sellerOriginalPrice
          : counterPayout;

      const createdCounter = await airtable(COUNTER_OFFERS_TABLE).create({
        "Order": [orderRecordId],
        "Seller ID": [sellerRecordId],
        "Source Type": "Seller Offer",
        "Seller Offer Record ID": sellerOfferRecord.id,

        "Seller Original Price": sellerOriginalPrice,
        "Seller Original VAT Type": sellerVatType,

        "Store Counter Price": storeCounterPrice,

        "Counter Payout": finalSellerCounterPayout,
        "Counter Payout VAT Type": sellerVatType,

        "Status": "Open",
        "Created At": nowIso
      });

      createdSellerCounters++;

      try {
        const discordResult = await sendCounterOfferDiscordDM({
          counterOfferRecordId: createdCounter.id,
          sellerDiscordId,
          productName,
          sku,
          size,
          orderId,
          payout: finalSellerCounterPayout,
          vatType: sellerVatType,
          sellerOriginalPrice,
          sellerOriginalVatType: sellerVatType
        });

        await airtable(COUNTER_OFFERS_TABLE).update(createdCounter.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        });
      } catch (err) {
        dmErrors++;
        console.error("Failed to send seller counter offer DM:", {
          counterOfferRecordId: createdCounter.id,
          sellerId,
          error: err.message
        });
      }
    }

    const { data: consignmentRows, error: consignmentError } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity,
        seller_id,
        seller_record_id
      `)
      .eq("sku", sku)
      .eq("size", size)
      .gt("quantity", 0);

    if (consignmentError) throw consignmentError;

    for (const row of consignmentRows || []) {
      const sellerVatType = asText(row.vat_type);
      const sellerOriginalPrice = Number(row.selling_price_suggested);

      if (!sellerVatType || !Number.isFinite(sellerOriginalPrice)) continue;

      const counterPayout = calculateCounterPayoutForVatType(
        storeCounterPrice,
        sellerVatType,
        orderFields
      );

      if (!Number.isFinite(counterPayout) || counterPayout <= 0) continue;

      const finalConsignmentOfferPrice =
        sellerOriginalPrice <= counterPayout
          ? sellerOriginalPrice
          : counterPayout;
      
      const { data: existingCounterOffer, error: existingCounterError } = await supabase
        .from("consignment_offers")
        .select("id")
        .eq("order_record_id", orderRecordId)
        .eq("inventory_id", row.id)
        .eq("seller_record_id", row.seller_record_id)
        .eq("is_counter_offer", true)
        .in("status", ["open", "processing", "store_pending"])
        .maybeSingle();
      
      if (existingCounterError) throw existingCounterError;
      
      if (existingCounterOffer) {
        continue;
      }

      const { data: createdOffer, error: offerError } = await supabase
        .from("consignment_offers")
        .insert({
          order_record_id: orderRecordId,
          order_id: orderId,
          inventory_id: row.id,

          seller_record_id: row.seller_record_id,
          seller_id: row.seller_id,

          product_name: row.product_name || productName,
          sku,
          size,
          brand: row.brand || brand,

          vat_type: sellerVatType,
          seller_price: sellerOriginalPrice,
          offer_price: finalConsignmentOfferPrice,
          
          is_counter_offer: true,
          store_counter_price: storeCounterPrice,
          store_counter_price_excl_vat:
            numberValue(orderFields["Client VAT Rate"]) > 0
              ? storeCounterPrice / (1 + numberValue(orderFields["Client VAT Rate"]))
              : storeCounterPrice,
          
          status: "open",
          created_at: nowIso,
          updated_at: nowIso
        })
        .select()
        .single();

      if (offerError) throw offerError;

      createdConsignmentOffers++;

      try {
        const sellerRecord = await airtable(SELLERS_TABLE).find(row.seller_record_id);
        const seller = normalizeSeller(sellerRecord);

        const calculatedComparePrice = getConsignmentComparePrice(
          counterPayout,
          sellerVatType
        );

        const discordResult = await sendConsignmentOfferDiscordMessage({
          seller,
          offer: createdOffer,
          calculatedOfferPrice: calculatedComparePrice
        });

        await supabase
          .from("consignment_offers")
          .update({
            discord_channel_id: discordResult.channelId,
            discord_message_id: discordResult.messageId,
            discord_delivery_type: discordResult.deliveryType,
            updated_at: new Date().toISOString()
          })
          .eq("id", createdOffer.id);
      } catch (err) {
        dmErrors++;
        console.error("Failed to send consignment counter offer:", {
          offerId: createdOffer.id,
          sellerId: row.seller_id,
          error: err.message
        });
      }
    }

    res.json({
      ok: true,
      count: createdSellerCounters + createdConsignmentOffers,
      seller_counter_offers: createdSellerCounters,
      consignment_offers: createdConsignmentOffers,
      dm_errors: dmErrors
    });
  } catch (err) {
    console.error("Failed to create counter offers:", err);

    res.status(500).json({
      error: "Failed to create counter offers",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets the store edit its round-1 counter (the
// very first broadcast created by /api/counter-offers/create above)
// while sellers haven't responded yet. Round 1 fans out to potentially
// several sellers as separate records, so this loops through all of
// them for the order rather than editing a single record like the
// 1-to-1 edit endpoint does. Each seller's own record is validated
// against THEIR OWN original price (sellers can have different asks).
// ---------------------------------------------------------------------
app.post("/api/counter-offers/edit-broadcast", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderRecordId = asText(req.body?.order_record_id);
    const proposedPrice = Number(req.body?.price);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    // Round-1 records: still Open, belong to this order, and have no
    // "Previous Record ID" — that's what distinguishes them from
    // follow-up 1-to-1 rounds (seller-counter / store-counter).
    //
    // FIXED — the real bug (confirmed via debug logging, not a timing
    // issue): FIND(orderRecordId, ARRAYJOIN({Order})) never matches,
    // because Airtable formulas resolve a linked field to the LINKED
    // RECORD'S DISPLAY TEXT, not its raw record ID. Fetching by the
    // other filters and matching the Order link by raw ID in
    // JavaScript (where the API does return real record IDs) fixes it.
    const openRoundOneCandidates = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          {Status} = 'Open',
          {Source Type} = 'Seller Offer',
          {Previous Record ID} = ''
        )`
      })
      .all();

    const roundOneRecords = openRoundOneCandidates.filter(
      (r) => firstLinkedRecordId(r.fields?.["Order"]) === orderRecordId
    );

    if (roundOneRecords.length === 0) {
      return res.status(409).json({ error: "No open round-1 counters found for this order to edit." });
    }

    // FIXED — this endpoint previously passed an empty {} as orderFields
    // into calculateCounterPayoutForVatType, so the margin lookup
    // (Offer Margin / Offer Percentage / Offer Method) always came back
    // empty and every record silently fell into the "skipped" bucket.
    // Fetching the real order once here (same order for every record in
    // this loop) fixes that.
    const orderRecordForBroadcast = await airtable(ORDERS_TABLE).find(orderRecordId);
    const orderFieldsForBroadcast = orderRecordForBroadcast.fields || {};

    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const record of roundOneRecords) {
      const f = record.fields || {};
      const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
      const sellerVatType = asText(f["Seller Original VAT Type"]);

      // FIXED — proposedPrice is a STORE price (what the store is
      // willing to pay), while sellerOriginalPrice is in SELLER terms
      // (what the seller asked for) — comparing them directly ignored
      // our margin. Convert the seller's ask UP to what the store would
      // need to pay for it, and compare on that scale instead.
      const sellerAskInStoreTerms = calculateStoreCounterEquivalent(
        sellerOriginalPrice,
        sellerVatType,
        orderFieldsForBroadcast
      );

      if (!sellerOriginalPrice || !Number.isFinite(sellerAskInStoreTerms) || proposedPrice >= sellerAskInStoreTerms) {
        skipped++;
        continue;
      }

      const recomputedPayout = calculateCounterPayoutForVatType(proposedPrice, sellerVatType, orderFieldsForBroadcast);

      if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) {
        skipped++;
        continue;
      }

      await airtable(COUNTER_OFFERS_TABLE).update(record.id, {
        "Store Counter Price": proposedPrice,
        "Counter Payout": recomputedPayout,
        "Counter Payout VAT Type": sellerVatType
      });

      const oldChannelId = asText(f["Discord Channel ID"]);
      const oldMessageId = asText(f["Discord Message ID"]);

      if (oldChannelId && oldMessageId) {
        await disableCounterOfferDiscordButtons(
          oldChannelId,
          oldMessageId,
          "✏️ The store revised this counter — see the new message below."
        ).catch(() => {});
      }

      const sellerDiscordId = asText(f["Seller Discord ID"]);

      if (sellerDiscordId) {
        const discordResult = await sendCounterOfferDiscordDM({
          counterOfferRecordId: record.id,
          sellerDiscordId,
          productName: asText(f["Product Name"]),
          sku: asText(f["SKU"]),
          size: asText(f["Size"]),
          orderId: asText(f["Order ID"]),
          payout: recomputedPayout,
          vatType: sellerVatType,
          sellerOriginalPrice,
          sellerOriginalVatType: sellerVatType
        }).catch((err) => {
          errors.push(err.message);
          return null;
        });

        if (discordResult) {
          await airtable(COUNTER_OFFERS_TABLE).update(record.id, {
            "Discord Channel ID": discordResult.channelId,
            "Discord Message ID": discordResult.messageId,
            "Discord Delivery Type": discordResult.deliveryType
          });
        }
      }

      updated++;
    }

    res.json({ ok: true, updated, skipped, errors });
  } catch (err) {
    console.error("Failed to edit broadcast counter offer:", err);
    res.status(500).json({ error: "Failed to edit counter offer", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only, first piece of the actual ping-pong: lets the
// SELLER counter back on an existing Counter Offer thread, instead of
// only Accept/Deny. Creates a NEW round (new row), linked to the
// previous one via "Previous Record ID" — the original round-1 record
// created by /api/counter-offers/create above is never edited.
//
// Requires 2 new fields on the Counter Offers table (must be added in
// Airtable first): "Seller Counter Price" (currency) and
// "Previous Record ID" (singleLineText). No "Turn" or "Seller Counter At"
// field needed — both derivable from existing data (see below).
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/seller-counter", async (req, res) => {
  try {
    const previousRecordId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const f = previousRecord.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    // No "Turn" field needed: since every round is its own row, whether
    // it's the seller's turn is directly derivable — if this row already
    // has a Seller Counter Price, the seller already responded to it
    // (also guards against a double-click submitting the same round twice).
    const sellerAlreadyCountered =
      f["Seller Counter Price"] !== undefined &&
      f["Seller Counter Price"] !== null &&
      f["Seller Counter Price"] !== "";

    if (sellerAlreadyCountered) {
      return res.status(403).json({ error: "You already countered on this round." });
    }

    // FIXED — scale mismatch: "Store Counter Price" is in STORE terms
    // (what the store pays), while "Seller Original Price" is in SELLER
    // terms (what the seller wants). Comparing them directly ignored our
    // margin entirely, which could make the gap look like €0 even when
    // there was plenty of real room. "Counter Payout" is already the
    // store's counter converted DOWN to seller terms (margin removed) —
    // exactly the number the seller sees in their DM — so comparing
    // against that keeps everything on one consistent scale.
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const lastPrice = numberValue(f["Counter Payout"]);

    // FIXED — second bug, same root cause as the store-editing one:
    // this always used "Seller Original Price" (the very first ask) as
    // the seller's own reference point, even when the seller had ALREADY
    // countered in an earlier round of this same back-and-forth. Once
    // they've countered once, their real own position is that counter,
    // not their original ask from several rounds ago — otherwise the
    // min-step check gets computed against a stale number and lets
    // through a "counter" that doesn't actually move from where they
    // last stood. If the round this record responds to (via its own
    // Previous Record ID) has a Seller Counter Price, that's the
    // seller's true last position; only fall back to the original ask
    // when this is genuinely their first-ever counter-back.
    let sellerOwnReference = sellerOriginalPrice;
    const priorRoundIdForSeller = asText(f["Previous Record ID"]);

    if (priorRoundIdForSeller) {
      const priorRoundForSeller = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundIdForSeller);
      const priorSellerCounter = numberValue(priorRoundForSeller.fields?.["Seller Counter Price"]);
      if (priorSellerCounter) {
        sellerOwnReference = priorSellerCounter;
      }
    }

    const validation = validateNextCounterPrice(sellerOwnReference, lastPrice, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};

    const sellerVatType = asText(f["Seller Original VAT Type"]);

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [linkedOrderId],
      "Seller ID": linkedSellerId ? [linkedSellerId] : undefined,
      "Source Type": asText(f["Source Type"]) || "Seller Offer",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Seller Counter Price": proposedPrice,
      "Previous Record ID": previousRecordId,
      "Status": "Open"
    });

    // Close the previous round so it no longer shows as actionable —
    // mirrors the existing "competingCounters" closing pattern used
    // elsewhere in this file, just applied to the round we just
    // superseded rather than to a competing seller.
    await airtable(COUNTER_OFFERS_TABLE).update(previousRecordId, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    // Notify the store — this reuses the SAME notification path as a
    // brand new counter, since from the store's perspective this is just
    // a fresh number to respond to. Private-channel logic does not apply
    // here (confirmed: only relevant for consignment sellers).
    if (AIRTABLE_DISCORD_UPDATES_URL) {
      // FIXED — the store must see what THEY would pay (store terms,
      // with margin added back), not the seller's raw ask. This was
      // sending proposedPrice straight through, making the margin
      // appear to vanish entirely in what the store saw.
      const sellerCounterInStoreTerms = calculateStoreCounterEquivalent(
        proposedPrice,
        sellerVatType,
        orderFields
      );

      // NEW — proactively check whether the STORE would have any room
      // left to counter again, so the notification can show "no room,
      // accept or deny" upfront instead of the store discovering it
      // only after trying and getting an error.
      const storeOwnPosition = numberValue(f["Store Counter Price"]);
      const noRoomToCounter =
        Number.isFinite(storeOwnPosition) &&
        Number.isFinite(sellerCounterInStoreTerms) &&
        !hasRoomForNextStep(storeOwnPosition, sellerCounterInStoreTerms);

      await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: "counter-offer-seller-countered",
          store_name: asText(orderFields["Store Name"]),
          record_id: linkedOrderId,
          shopify_order_number: asText(orderFields["Shopify Order Number"]),
          product_name: asText(f["Product Name"]),
          sku: asText(f["SKU"]),
          size: asText(f["Size"]),
          counter_offer_record_id: newRound.id,
          selling_price: numberValue(orderFields["Selling Price"]) || numberValue(orderFields["Shopify Selling Price"]),
          your_previous_counter: numberValue(f["Store Counter Price"]),
          // FIXED — this was sending the STORE-CONVERTED equivalent
          // (e.g. €155, seller's ask + margin) under "seller_counter_price",
          // which the embed displays as "Seller's New Counter" — making
          // it look like the seller asked for €155 when they actually
          // asked for €145. That's what led to real confusion tracing
          // an accepted deal (confirmed by comparing the raw Counter
          // Offers records). Now sends the seller's RAW counter here,
          // and the store-converted number separately, clearly labeled.
          seller_counter_price: sellerCounterInStoreTerms ?? proposedPrice,
          no_room_to_counter: noRoomToCounter
        })
      }).catch((err) => console.error("Failed to notify store of seller counter (non-blocking):", err));
    }

    res.json({ ok: true, band: validation.band, new_round_id: newRound.id });
  } catch (err) {
    console.error("Failed to submit seller counter-back:", err);
    res.status(500).json({ error: "Failed to submit counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only, step 2 of the ping-pong: lets the STORE counter
// back on a seller's counter-back round. Same shape as seller-counter
// above, just the other direction. Same secret-header protection used
// by /api/counter-offers/create and the consignment counter endpoints.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/store-counter", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const previousRecordId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const f = previousRecord.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    // This round (created by seller-counter above) only has a Seller
    // Counter Price on it, no Store Counter Price yet — that's exactly
    // the signal that it's the store's turn to respond. If it already
    // has one, the store already acted on this round.
    const storeAlreadyCountered =
      f["Store Counter Price"] !== undefined &&
      f["Store Counter Price"] !== null &&
      f["Store Counter Price"] !== "";

    if (storeAlreadyCountered) {
      return res.status(403).json({ error: "You already countered on this round." });
    }

    // Band = the previous round's Store Counter Price (fetched via
    // Previous Record ID) and this round's Seller Counter Price.
    const previousRoundId = asText(f["Previous Record ID"]);

    if (!previousRoundId) {
      return res.status(409).json({ error: "Missing previous round reference." });
    }

    const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(previousRoundId);
    const priorFields = priorRound.fields || {};
    const priorStorePrice = numberValue(priorFields["Store Counter Price"]);
    const sellerCounterPrice = numberValue(f["Seller Counter Price"]);

    const linkedOrderIdForBand = firstLinkedRecordId(f["Order"]);
    const orderRecordForBand = await airtable(ORDERS_TABLE).find(linkedOrderIdForBand);
    const orderFieldsForBand = orderRecordForBand.fields || {};
    const sellerVatTypeForBand = asText(f["Seller Original VAT Type"]);

    // FIXED — same scale mismatch as the seller-counter endpoint, other
    // direction: "priorStorePrice" is STORE terms, but "sellerCounterPrice"
    // is SELLER terms. Convert the seller's counter UP to what the store
    // would need to pay for it (adding margin back), so both sides of
    // the comparison are in store terms — matching what the store
    // actually types into the modal.
    const sellerCounterInStoreTerms = calculateStoreCounterEquivalent(
      sellerCounterPrice,
      sellerVatTypeForBand,
      orderFieldsForBand
    );

    if (!Number.isFinite(sellerCounterInStoreTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this order." });
    }

    const validation = validateNextCounterPrice(priorStorePrice, sellerCounterInStoreTerms, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);

    // FIXED — this was passing an empty {} instead of the real order's
    // margin fields (same bug pattern as edit-broadcast), so the margin
    // lookup always came back empty and the payout silently came back
    // as null → displayed as €0.00 to the seller. orderFieldsForBand was
    // already fetched above for the band conversion — reuse it here.
    const recomputedPayout = calculateCounterPayoutForVatType(
      proposedPrice,
      sellerVatType,
      orderFieldsForBand
    );

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [linkedOrderId],
      "Seller ID": linkedSellerId ? [linkedSellerId] : undefined,
      "Source Type": asText(f["Source Type"]) || "Seller Offer",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": proposedPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": previousRecordId,
      "Status": "Open"
    });

    await airtable(COUNTER_OFFERS_TABLE).update(previousRecordId, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    // Notify the seller — reuses the exact same DM function as round 1,
    // now with the Counter button already added, so the seller can
    // accept, counter again, or deny this new round.
    const sellerDiscordId = asText(f["Seller Discord ID"]);
    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};
    const orderId = asText(orderFields["Order ID"]);

    if (sellerDiscordId) {
      // NEW — same proactive check, mirrored: whether the SELLER would
      // have any room left to counter again. Both values are already in
      // seller terms (their own stored counter, and the store's new
      // counter already converted via recomputedPayout), so no extra
      // conversion needed here.
      const sellerOwnPosition = numberValue(f["Seller Counter Price"]);
      const noRoomToCounter =
        Number.isFinite(sellerOwnPosition) &&
        Number.isFinite(recomputedPayout) &&
        !hasRoomForNextStep(sellerOwnPosition, recomputedPayout);

      const discordResult = await sendCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(f["Product Name"]),
        sku: asText(f["SKU"]),
        size: asText(f["Size"]),
        orderId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        noRoomToCounter
      }).catch((err) => {
        console.error("Failed to DM seller of store counter-back (non-blocking):", err);
        return null;
      });

      if (discordResult) {
        await airtable(COUNTER_OFFERS_TABLE).update(newRound.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        });
      }
    }

    res.json({ ok: true, band: validation.band, new_round_id: newRound.id });
  } catch (err) {
    console.error("Failed to submit store counter-back:", err);
    res.status(500).json({ error: "Failed to submit counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: store accepts a seller's counter-back round.
// Mirrors the logic already used by the Discord "counter_offer_accept:"
// handler above (same status update, same webhook, same competing-round
// closing) — just reachable over HTTP so the store-side Discord bot
// (airtable-discord-updates-main) can call it, the same way it already
// calls the consignment store-accept/store-deny endpoints.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/store-accept", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const counterOfferRecordId = asText(req.params.id);
    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const f = counterOffer.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer available." });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);

    if (!linkedOrderId) {
      return res.status(409).json({ error: "Counter Offer missing linked Order" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderStatus = asText(orderRecord.fields?.["Fulfillment Status"]);

    if (orderStatus !== "Outsource") {
      return res.status(409).json({ error: "This order is already no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Accepted",
      "Accepted At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    // FIXED — CRITICAL: this record can be either a store-placed round
    // (has "Store Counter Price") or a seller-placed round (has "Seller
    // Counter Price" instead, with "Store Counter Price"/"Counter
    // Payout" left empty). The webhook payload below used to read those
    // two fields unconditionally — for a seller-placed round they were
    // simply empty, so downstream deal-channel creation apparently fell
    // back to "Seller Original Price" as its only available number
    // (€150, the seller's very first ask, not the €155 actually
    // accepted here). Computing the correct values up front for BOTH
    // round types, and using those in the webhook AND the Order-record
    // write below, fixes both at once.
    const orderFieldsForAccept = orderRecord.fields || {};
    const sellerVatTypeForAccept = asText(f["Seller Original VAT Type"]);
    const sellerCounterPriceForAccept = numberValue(f["Seller Counter Price"]);
    const isSellerPlacedRound = !!sellerCounterPriceForAccept;

    const acceptedStorePrice = isSellerPlacedRound
      ? calculateStoreCounterEquivalent(sellerCounterPriceForAccept, sellerVatTypeForAccept, orderFieldsForAccept)
      : numberValue(f["Store Counter Price"]);

    const acceptedSellerPayout = isSellerPlacedRound
      ? sellerCounterPriceForAccept
      : numberValue(f["Counter Payout"]);

    if (COUNTER_OFFER_ACCEPT_WEBHOOK_URL) {
      await fetch(COUNTER_OFFER_ACCEPT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: "counter-offer-accepted",
          counter_offer_record_id: counterOfferRecordId,
          order_record_id: linkedOrderId,
          seller_record_id: firstLinkedRecordId(f["Seller ID"]),
          seller_offer_record_id: asText(f["Seller Offer Record ID"]),
          source_type: asText(f["Source Type"]),
          store_counter_price: acceptedStorePrice,
          // FIXED — same class of bug as store_counter_price/
          // counter_payout above: this read "Store Counter Price Excl
          // VAT" straight from the Counter Offer record, but that's a
          // formula derived from "Store Counter Price" — which is
          // empty on a seller-placed round (only "Seller Counter Price"
          // is set there), so it silently sent an empty value whenever
          // the seller's VAT type was VAT0/VAT21 (the Make scenario's
          // "If VAT" branch, not the "If Margin" one). Computing it
          // from the already-correct acceptedStorePrice instead, using
          // the exact same Dutch+VAT21-only exclusion rule that
          // calculateLinkedUnitPrice.js itself applies downstream, so
          // both sides of that pipeline agree on what this number means.
          store_counter_price_excl_vat: isSellerPlacedRound
            ? computeStoreExclVatForOrder(acceptedStorePrice, sellerVatTypeForAccept, orderFieldsForAccept)
            : numberValue(f["Store Counter Price Excl VAT"]),
          counter_payout: acceptedSellerPayout,
          counter_payout_vat_type: asText(f["Counter Payout VAT Type"]) || sellerVatTypeForAccept,
          seller_original_price: numberValue(f["Seller Original Price"]),
          seller_original_vat_type: sellerVatTypeForAccept,
          accepted_at_iso: new Date().toISOString()
        })
      });
    }

    // CRITICAL FIX: relying only on the webhook/Make scenario to write
    // the final price back onto the Order let a real accepted price
    // (€155) get silently ignored, falling back to a Target-Buying-
    // Price calculation and producing a wrong invoice. "Custom Offer"
    // takes priority over everything else in calculateLinkedUnitPrice.js,
    // so writing the accepted price there directly guarantees the
    // correct number regardless of what the webhook consumer does.
    try {
      if (Number.isFinite(acceptedStorePrice) && acceptedStorePrice > 0) {
        await airtable(ORDERS_TABLE).update(linkedOrderId, {
          "Custom Offer": acceptedStorePrice,
          "Offer Accepted?": true
        });
      } else {
        console.error("Could not compute a valid accepted store price to write back for order:", linkedOrderId);
      }
    } catch (priceWriteErr) {
      console.error("Failed to write accepted price to Order record (non-blocking):", priceWriteErr);
    }

    // FIXED — same formula bug as elsewhere: FIND(recordId,
    // ARRAYJOIN({Order})) never matches a raw record ID, only display
    // text. Matching the Order link by raw ID in JavaScript instead.
    const openCountersForStoreAcceptMatch = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          {Status} = 'Open',
          RECORD_ID() != '${counterOfferRecordId}'
        )`
      })
      .all();

    const competingCounters = openCountersForStoreAcceptMatch.filter(
      (r) => firstLinkedRecordId(r.fields?.["Order"]) === linkedOrderId
    );

    for (const competing of competingCounters) {
      await airtable(COUNTER_OFFERS_TABLE).update(competing.id, {
        "Status": "Closed",
        "Closed At": new Date().toISOString()
      });

      const cf = competing.fields || {};
      const channelId = asText(cf["Discord Channel ID"]);
      const messageId = asText(cf["Discord Message ID"]);

      if (channelId && messageId) {
        await disableCounterOfferDiscordButtons(
          channelId,
          messageId,
          "❌ This order was fulfilled through a different offer."
        ).catch(() => {});
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to store-accept counter offer:", err);
    res.status(500).json({ error: "Failed to accept counter offer", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: store denies a seller's counter-back round.
// Notifies the seller with the denied amount (reusing the same
// sendOfferDeniedDiscordDM used for scenario 1), so they can immediately
// place a new, lower counter — this is scenario 3 from the design.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/store-deny", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const counterOfferRecordId = asText(req.params.id);
    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const f = counterOffer.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
    const sellerDiscordId = asText(f["Seller Discord ID"]);

    // FIXED — completely redesigned. This used to call
    // sendOfferDeniedDiscordDM with the Counter Offer record's ID passed
    // as if it were a Seller Offer record ID, wired to
    // /api/seller-offers/:offerId/edit-after-denial — a totally
    // different table, which is why "Place New Offer" failed with
    // "This offer is not linked to an order". A denied COUNTER isn't the
    // same thing as a denied original offer (scenario 1) — there's no
    // Seller Offer record to edit here.
    //
    // The correct, fair behavior: the round this denied counter was
    // itself responding to (via Previous Record ID) is the store's last
    // real counter — that offer never went away, the seller just
    // couldn't get past it. Reopen that round and resend the seller the
    // exact same standard Accept/Counter/Deny notification for it, so
    // they can either accept the store's standing counter or try a new,
    // lower counter against it — reusing the existing, already-tested
    // seller-counter mechanism rather than inventing a new one.
    if (sellerDiscordId && linkedOrderId) {
      const priorRoundId = asText(f["Previous Record ID"]);
      const deniedSellerCounter = numberValue(f["Seller Counter Price"]);
      const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
      const orderFields = orderRecord.fields || {};
      const orderId = asText(orderFields["Order ID"]);

      if (priorRoundId) {
        const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

        if (priorRound) {
          await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, {
            "Status": "Open"
          });

          const priorFields = priorRound.fields || {};

          const discordResult = await sendCounterOfferDiscordDM({
            counterOfferRecordId: priorRoundId,
            sellerDiscordId,
            productName: asText(f["Product Name"]),
            sku: asText(f["SKU"]),
            size: asText(f["Size"]),
            orderId,
            payout: numberValue(priorFields["Counter Payout"]),
            vatType: asText(priorFields["Seller Original VAT Type"] || f["Seller Original VAT Type"]),
            sellerOriginalPrice: numberValue(f["Seller Original Price"]),
            sellerOriginalVatType: asText(f["Seller Original VAT Type"]),
            deniedAmount: deniedSellerCounter
          }).catch((err) => {
            console.error("Failed to re-notify seller after store-deny (non-blocking):", err);
            return null;
          });

          if (discordResult) {
            await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, {
              "Discord Channel ID": discordResult.channelId,
              "Discord Message ID": discordResult.messageId,
              "Discord Delivery Type": discordResult.deliveryType
            });
          }
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to store-deny counter offer:", err);
    res.status(500).json({ error: "Failed to deny counter offer", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets whoever placed the CURRENT price on an open
// 1-to-1 counter round edit it, while the other side hasn't responded
// yet. Scoped to rounds created by seller-counter/store-counter above
// (records that have a "Previous Record ID") — the very first,
// broadcast-to-many-sellers round-1 counter (created by
// /api/counter-offers/create) is NOT covered here, since editing one
// record there wouldn't cleanly map to a single Discord message.
//
// The valid range for the edit is recomputed the exact same way it was
// when this round was first created — i.e. re-derived from the record
// this one was responding to — so an edit can never accidentally widen
// the negotiation outside what was already agreed as the boundary.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/edit", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const recordId = asText(req.params.id);
    const actor = asText(req.body?.actor); // "seller" or "store"
    const proposedPrice = Number(req.body?.price);

    if (!["seller", "store"].includes(actor)) {
      return res.status(400).json({ error: "actor must be 'seller' or 'store'" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(recordId);
    const f = record.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open — nothing to edit." });
    }

    const previousRecordId = asText(f["Previous Record ID"]);
    if (!previousRecordId) {
      return res.status(400).json({
        error: "Editing isn't supported for the very first counter yet — only for follow-up rounds."
      });
    }

    const hasSellerCounter =
      f["Seller Counter Price"] !== undefined &&
      f["Seller Counter Price"] !== null &&
      f["Seller Counter Price"] !== "";
    const hasStoreCounter =
      f["Store Counter Price"] !== undefined &&
      f["Store Counter Price"] !== null &&
      f["Store Counter Price"] !== "";

    if (hasSellerCounter && actor !== "seller") {
      return res.status(403).json({ error: "Only the seller can edit this round." });
    }
    if (hasStoreCounter && actor !== "store") {
      return res.status(403).json({ error: "Only the store can edit this round." });
    }

    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const previousRound = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const previousFields = previousRound.fields || {};

    // FIXED — same scale mismatch as the two counter-back endpoints.
    // Seller edits must be validated entirely in SELLER terms (their
    // own ask vs. the store's counter converted down via Counter
    // Payout). Store edits must be validated entirely in STORE terms
    // (converting the seller's ask and counter UP via the margin
    // formula), since the store is editing a store-scale number.
    let ownReferencePrice;
    let counterpartPrice;
    let orderFieldsForEdit = null;

    if (hasSellerCounter) {
      // FIXED — same bug as the seller-counter endpoint: always using
      // sellerOriginalPrice ignores that the seller may have already
      // countered in an earlier round of this back-and-forth. Walk back
      // one more hop (the round being responded to's own Previous
      // Record ID) to find the seller's true last counter, if any.
      ownReferencePrice = sellerOriginalPrice;
      const grandparentRoundId = asText(previousFields["Previous Record ID"]);

      if (grandparentRoundId) {
        const grandparentRound = await airtable(COUNTER_OFFERS_TABLE).find(grandparentRoundId);
        const grandparentSellerCounter = numberValue(grandparentRound.fields?.["Seller Counter Price"]);
        if (grandparentSellerCounter) {
          ownReferencePrice = grandparentSellerCounter;
        }
      }

      counterpartPrice = numberValue(previousFields["Counter Payout"]);
    } else {
      const orderIdForEdit = firstLinkedRecordId(f["Order"]);
      const orderRecordForEdit = await airtable(ORDERS_TABLE).find(orderIdForEdit);
      orderFieldsForEdit = orderRecordForEdit.fields || {};
      const sellerVatTypeForEdit = asText(f["Seller Original VAT Type"]);

      // FIXED — this was recomputing "own reference" from the seller's
      // ORIGINAL price via margin conversion, producing a theoretical
      // number (e.g. €467.50) that had nothing to do with what the
      // store actually last countered with. The store's own previous
      // position is simply whatever is already stored in THIS record's
      // "Store Counter Price" field — no recomputation needed, it's
      // already in store terms. Mirrors exactly how the seller-editing
      // branch above uses sellerOriginalPrice straight from the record.
      ownReferencePrice = numberValue(f["Store Counter Price"]);

      const previousSellerCounter = numberValue(previousFields["Seller Counter Price"]);

      counterpartPrice = previousSellerCounter
        ? calculateStoreCounterEquivalent(previousSellerCounter, sellerVatTypeForEdit, orderFieldsForEdit)
        : ownReferencePrice;

      if (!Number.isFinite(ownReferencePrice) || !Number.isFinite(counterpartPrice)) {
        return res.status(500).json({ error: "Could not compute margin conversion for this order." });
      }
    }

    // UPDATED — editing now follows the exact same min-€2.50-step rule
    // as countering (previously exempt). Agreed for consistency: once
    // the gap is too small for a real counter, it's also too small to
    // "sneak through" via an edit — everyone hits the same wall at the
    // same time, rather than Edit being a quiet exception to the rule.
    const validation = validateNextCounterPrice(ownReferencePrice, counterpartPrice, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const priceField = hasSellerCounter ? "Seller Counter Price" : "Store Counter Price";
    const updates = { [priceField]: proposedPrice };

    if (!hasSellerCounter) {
      // FIXED — same empty-{} bug as the store-counter endpoint.
      // orderFieldsForEdit was already fetched above for the band
      // conversion — reuse it here too instead of passing {}.
      const sellerVatType = asText(f["Seller Original VAT Type"]);
      updates["Counter Payout"] = calculateCounterPayoutForVatType(proposedPrice, sellerVatType, orderFieldsForEdit || {});
      updates["Counter Payout VAT Type"] = sellerVatType;
    }

    await airtable(COUNTER_OFFERS_TABLE).update(recordId, updates);

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};

    if (hasSellerCounter) {
      // Seller edited — notify the store with the revised number, same
      // channel/format as a fresh seller-counter notification.
      if (AIRTABLE_DISCORD_UPDATES_URL) {
        // FIXED — same as the seller-counter endpoint: the store must
        // see the store-equivalent (margin-adjusted) price, not the
        // seller's raw edited ask.
        const editedSellerPriceInStoreTerms = calculateStoreCounterEquivalent(
          proposedPrice,
          asText(f["Seller Original VAT Type"]),
          orderFields
        );

        await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trigger_type: "counter-offer-seller-countered",
            store_name: asText(orderFields["Store Name"]),
            record_id: linkedOrderId,
            shopify_order_number: asText(orderFields["Shopify Order Number"]),
            product_name: asText(f["Product Name"]),
            sku: asText(f["SKU"]),
            size: asText(f["Size"]),
            counter_offer_record_id: recordId,
            selling_price: numberValue(orderFields["Selling Price"]) || numberValue(orderFields["Shopify Selling Price"]),
            your_previous_counter: numberValue(previousFields["Store Counter Price"]),
            // FIXED — same display bug as the seller-counter endpoint:
            // must show the seller's raw edited counter here, not the
            // store-converted (margin-included) equivalent.
            seller_counter_price: editedSellerPriceInStoreTerms ?? proposedPrice
          })
        }).catch((err) => console.error("Failed to notify store of edited counter (non-blocking):", err));
      }
    } else {
      // Store edited — disable the old DM (we have its stored IDs) and
      // send the seller a fresh DM with the revised number and buttons.
      const oldChannelId = asText(f["Discord Channel ID"]);
      const oldMessageId = asText(f["Discord Message ID"]);

      if (oldChannelId && oldMessageId) {
        await disableCounterOfferDiscordButtons(
          oldChannelId,
          oldMessageId,
          "✏️ The store revised this counter — see the new message below."
        ).catch(() => {});
      }

      const sellerDiscordId = asText(f["Seller Discord ID"]);

      if (sellerDiscordId) {
        const discordResult = await sendCounterOfferDiscordDM({
          counterOfferRecordId: recordId,
          sellerDiscordId,
          productName: asText(f["Product Name"]),
          sku: asText(f["SKU"]),
          size: asText(f["Size"]),
          orderId: asText(orderFields["Order ID"]),
          payout: updates["Counter Payout"],
          vatType: asText(f["Seller Original VAT Type"]),
          sellerOriginalPrice: numberValue(f["Seller Original Price"]),
          sellerOriginalVatType: asText(f["Seller Original VAT Type"])
        }).catch((err) => {
          console.error("Failed to DM seller of edited counter (non-blocking):", err);
          return null;
        });

        if (discordResult) {
          await airtable(COUNTER_OFFERS_TABLE).update(recordId, {
            "Discord Channel ID": discordResult.channelId,
            "Discord Message ID": discordResult.messageId,
            "Discord Delivery Type": discordResult.deliveryType
          });
        }
      }
    }

    res.json({ ok: true, band: validation.band });
  } catch (err) {
    console.error("Failed to edit counter offer:", err);
    res.status(500).json({ error: "Failed to edit counter offer", details: err.message });
  }
});

app.post("/api/consignment/offers/create", async (req, res) => {
  try {
    const orderRecordId = asText(req.body?.order_record_id);
    const orderId = asText(req.body?.order_id);
    const sku = asText(req.body?.sku).toUpperCase();
    const size = asText(req.body?.size);
    const maximumBuyingPrice = Number(req.body?.maximum_buying_price);
    const directSellerOfferPrice = Number(req.body?.direct_seller_offer_price);

    if (!orderRecordId) {
      return res.status(400).json({
        error: "Missing order_record_id"
      });
    }

    if (!sku) {
      return res.status(400).json({
        error: "Missing SKU"
      });
    }

    if (!size) {
      return res.status(400).json({
        error: "Missing size"
      });
    }

    const orderRecord =
      await airtable(ORDERS_TABLE).find(orderRecordId);
    
    const calculatedOfferPrice =
      Number.isFinite(directSellerOfferPrice) && directSellerOfferPrice > 0
        ? directSellerOfferPrice
        : calculateConsignmentOfferPrice(
            maximumBuyingPrice,
            orderRecord.fields || {}
          );

    if (calculatedOfferPrice === null) {
      return res.status(400).json({
        error: "Invalid Maximum Buying Price"
      });
    }

    const { data: inventoryRows, error: inventoryError } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity,
        seller_id,
        seller_record_id
      `)
      .eq("sku", sku)
      .eq("size", size)
      .gt("quantity", 0);

    if (inventoryError) {
      throw inventoryError;
    }

    const results = [];

    for (const row of inventoryRows || []) {
      const sellerPrice = Number(row.selling_price_suggested);

      const sellerComparePrice =
        getConsignmentComparePrice(sellerPrice, row.vat_type);
      
      const offerPrice =
        sellerComparePrice <= calculatedOfferPrice
          ? sellerPrice
          : getConsignmentSellerOfferPrice(
              calculatedOfferPrice,
              row.vat_type
            );

      const { data: existingOffers, error: existingError } = await supabase
        .from("consignment_offers")
        .select("id")
        .eq("order_record_id", orderRecordId)
        .eq("seller_record_id", row.seller_record_id)
        .eq("inventory_id", row.id)
        .eq("status", "open")
        .limit(1);

      if (existingError) {
        throw existingError;
      }

      if (existingOffers?.length) {
        results.push({
          mode: "skipped_existing",
          offer_id: existingOffers[0].id
        });

        continue;
      }

      const offerPayload = {
        order_record_id: orderRecordId,
        order_id: orderId,
        sku: row.sku,
        size: row.size,
        product_name: row.product_name,
        brand: row.brand,
        seller_record_id: row.seller_record_id,
        seller_id: row.seller_id,
        inventory_id: row.id,
        seller_price: sellerPrice,
        offer_price: offerPrice,
        vat_type: row.vat_type,
        quantity_at_offer: Number(row.quantity || 0),
        status: "open",
        discord_channel_id: null,
        discord_message_id: null,
        discord_delivery_type: null,
        discord_delivery_error: null,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("consignment_offers")
        .insert(offerPayload)
        .select()
        .single();

      if (error) {
        throw error;
      }

      const sellerRecord = await airtable(SELLERS_TABLE).find(row.seller_record_id);
      
      const sellerRow = normalizeSeller(sellerRecord);

      let discordResult = null;

      try {
        discordResult = await sendConsignmentOfferDiscordMessage({
          seller: sellerRow,
          offer: data,
          calculatedOfferPrice
        });
      
        await supabase
          .from("consignment_offers")
          .update({
            discord_channel_id: discordResult.channelId,
            discord_message_id: discordResult.messageId,
            discord_delivery_type: discordResult.deliveryType,
            discord_delivery_error: null
          })
          .eq("id", data.id);
      } catch (err) {
        console.error("Failed to deliver consignment offer Discord message:", {
          offerId: data.id,
          sellerId: data.seller_id,
          sellerRecordId: data.seller_record_id,
          error: err.message
        });
      
        await supabase
          .from("consignment_offers")
          .update({
            discord_delivery_type: null,
            discord_delivery_error: err.message,
            updated_at: new Date().toISOString()
          })
          .eq("id", data.id);
      }

      results.push({
        mode: "created",
        offer: {
          ...data,
          discord_channel_id: discordResult?.channelId || null,
          discord_message_id: discordResult?.messageId || null,
          discord_delivery_type: discordResult?.deliveryType || null,
          discord_delivery_error: discordResult ? null : "Discord delivery failed"
        }
      });
    }

    res.json({
      ok: true,
      order_record_id: orderRecordId,
      order_id: orderId,
      sku,
      size,
      calculated_offer_price: calculatedOfferPrice,
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Failed to create consignment offers:", err);

    res.status(500).json({
      error: "Failed to create consignment offers",
      details: err.message
    });
  }
});

app.get("/api/consignment/offers", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const { data, error } = await supabase
      .from("consignment_offers")
      .select(`
        id,
        order_id,
        order_record_id,
        product_name,
        sku,
        size,
        brand,
        seller_price,
        offer_price,
        vat_type,
        status,
        created_at
      `)
      .eq("seller_record_id", sellerRecordId)
      .eq("status", "open")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      ok: true,
      count: data?.length || 0,
      items: data || []
    });
  } catch (err) {
    console.error("Failed to load consignment offers:", err);

    res.status(500).json({
      error: "Failed to load consignment offers",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/:id/counter", async (req, res) => {
  try {
    const offerId = asText(req.params.id);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const counterPrice = Number(req.body?.counter_price);

    if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
      return res.status(400).json({
        error: "Invalid counter price"
      });
    }

    const offer = await getOpenConsignmentOffer(offerId);

    if (!offer) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    if (sellerRecordId && offer.seller_record_id !== sellerRecordId) {
      return res.status(403).json({
        error: "Not allowed"
      });
    }

    if (Number(offer.offer_price) >= Number(offer.seller_price)) {
      return res.status(400).json({
        error: "This is already a confirmation, counter offer is not needed"
      });
    }

    const currentOfferPrice = Number(offer.offer_price || 0);

    if (!Number.isFinite(currentOfferPrice) || currentOfferPrice <= 0) {
      return res.status(400).json({
        error: "Invalid current offer price"
      });
    }
    
    if (counterPrice <= currentOfferPrice) {
      return res.status(400).json({
        error: `Counter must be higher than the current offer (€${currentOfferPrice.toFixed(2)}).`
      });
    }
    
    const orderRecord = await airtable(ORDERS_TABLE).find(offer.order_record_id);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    const storeBasePrice = convertConsignorPriceToStoreBasePrice(
      counterPrice,
      offer.vat_type,
      clientCountry
    );

    const storeOfferVatType = getStoreOfferVatTypeFromConsignmentVat(
      offer.vat_type,
      clientCountry
    );

    const storeOfferPrice = calculateStoreCustomOfferFromConsignmentBase(
      storeBasePrice,
      orderFields
    );

    if (!Number.isFinite(storeBasePrice) || !Number.isFinite(storeOfferPrice)) {
      return res.status(400).json({
        error: "Could not calculate store offer price"
      });
    }

    const storeOfferPriceExclVat =
      storeOfferVatType === "VAT21"
        ? Math.round((storeOfferPrice / 1.21) * 100) / 100
        : storeOfferPrice;

    const { data: updatedOffer, error: updateError } = await supabase
      .from("consignment_offers")
      .update({
        status: "store_pending",
        consignor_counter_price: counterPrice,
        consignor_counter_store_price: storeOfferPrice,
        consignor_counter_store_price_excl_vat: storeOfferPriceExclVat,
        consignor_counter_at: new Date().toISOString(),
        store_response_status: "pending",
        updated_at: new Date().toISOString()
      })
      .eq("id", offer.id)
      .eq("status", "open")
      .select()
      .single();

    if (updateError || !updatedOffer) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    const discordResult = await postConsignmentCounterStoreOffer({
      offer: updatedOffer,
      orderFields,
      storeOfferPrice,
      storeOfferVatType
    });

    await supabase
      .from("consignment_offers")
      .update({
        store_offer_channel_id: discordResult.channel_id || null,
        store_offer_message_id: discordResult.message_id || null,
        updated_at: new Date().toISOString()
      })
      .eq("id", offer.id);

    if (offer.discord_channel_id && offer.discord_message_id) {
      await disableConsignmentDiscordButtons(
        offer.discord_channel_id,
        offer.discord_message_id,
        `🔁 Counter offer sent to store: €${counterPrice.toFixed(2)} (${offer.vat_type}).`
      ).catch(() => {});
    }

    res.json({
      ok: true,
      offer: updatedOffer,
      store_offer_price: storeOfferPrice,
      store_offer_vat_type: storeOfferVatType
    });
  } catch (err) {
    console.error("Failed to submit consignment counter offer:", err);

    res.status(500).json({
      error: "Failed to submit counter offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: store counters back on the consignor's counter,
// starting the full Consignment ping-pong. The EXISTING /counter
// endpoint above is untouched — it still handles the first consignor
// counter exactly as before (updating the same row). This endpoint
// creates a NEW row via previous_offer_id whenever the ping-pong goes
// deeper than that first exchange, mirroring the Store Orders/Member
// WTB chain pattern.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/store-counter", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!COUNTER_OFFERS_SECRET || secret !== COUNTER_OFFERS_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const previousOfferId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Counter must be a valid whole number." });
    }

    const { data: previousOffer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", previousOfferId)
      .single();

    if (fetchError || !previousOffer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (!["open", "store_pending"].includes(previousOffer.status)) {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    if (!(Number(previousOffer.consignor_counter_price) > 0)) {
      return res.status(409).json({ error: "This offer has no consignor counter to respond to yet." });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(previousOffer.order_record_id);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    // Chain-aware own reference: if this round itself already has a
    // store_counter_price (the combined "round 1 + first consignor
    // counter" row, where both fields live on one record), that IS the
    // store's own last position. Otherwise walk back one hop via
    // previous_offer_id to find the store's true prior round.
    let storeOwnReference = Number(previousOffer.store_counter_price);

    if (!(storeOwnReference > 0) && previousOffer.previous_offer_id) {
      const { data: grandparent } = await supabase
        .from("consignment_offers")
        .select("store_counter_price")
        .eq("id", previousOffer.previous_offer_id)
        .single();

      storeOwnReference = Number(grandparent?.store_counter_price) || null;
    }

    if (!(storeOwnReference > 0)) {
      return res.status(500).json({ error: "Could not determine the store's previous counter." });
    }

    // Counterpart: consignor's counter, converted UP to store terms
    // (forward direction — same functions the initial broadcast uses).
    const consignorCounterBase = convertConsignorPriceToStoreBasePrice(
      Number(previousOffer.consignor_counter_price),
      previousOffer.vat_type,
      clientCountry
    );
    const consignorCounterInStoreTerms = calculateStoreCustomOfferFromConsignmentBase(
      consignorCounterBase,
      orderFields
    );

    if (!Number.isFinite(consignorCounterInStoreTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this order." });
    }

    const validation = validateNextCounterPrice(storeOwnReference, consignorCounterInStoreTerms, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    await supabase
      .from("consignment_offers")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", previousOfferId);

    const storeOfferVatType = getStoreOfferVatTypeFromConsignmentVat(previousOffer.vat_type, clientCountry);
    const proposedExclVat = storeOfferVatType === "VAT21"
      ? Math.round((proposedPrice / 1.21) * 100) / 100
      : proposedPrice;

    const nowIso = new Date().toISOString();

    const { data: newOffer, error: createError } = await supabase
      .from("consignment_offers")
      .insert({
        order_record_id: previousOffer.order_record_id,
        order_id: previousOffer.order_id,
        inventory_id: previousOffer.inventory_id,

        seller_record_id: previousOffer.seller_record_id,
        seller_id: previousOffer.seller_id,

        product_name: previousOffer.product_name,
        sku: previousOffer.sku,
        size: previousOffer.size,
        brand: previousOffer.brand,

        vat_type: previousOffer.vat_type,
        seller_price: previousOffer.seller_price,
        offer_price: previousOffer.offer_price,

        is_counter_offer: true,
        store_counter_price: proposedPrice,
        store_counter_price_excl_vat: proposedExclVat,

        previous_offer_id: previousOfferId,
        status: "open",
        created_at: nowIso,
        updated_at: nowIso
      })
      .select()
      .single();

    if (createError) throw createError;

    let discordResult = null;

    // NEW — proactive no-room check: after this counter, would the
    // consignor have any valid step left to respond with?
    const consignorOwnPosition = Number(previousOffer.consignor_counter_price);
    const storeCounterInConsignorTermsForRoomCheck = convertStoreBasePriceToConsignorPrice(
      calculateConsignmentBaseFromStoreOffer(proposedPrice, orderFields),
      previousOffer.vat_type,
      clientCountry
    );
    const noRoomToCounter =
      Number.isFinite(storeCounterInConsignorTermsForRoomCheck) &&
      !hasRoomForNextStep(consignorOwnPosition, storeCounterInConsignorTermsForRoomCheck);

    try {
      discordResult = await sendConsignmentCounterOfferDiscordMessage({
        offer: newOffer,
        storeOfferPrice: proposedPrice,
        storeOfferVatType,
        yourPreviousCounter: Number(previousOffer.consignor_counter_price),
        noRoomToCounter
      });

      await supabase
        .from("consignment_offers")
        .update({
          discord_channel_id: discordResult.channelId,
          discord_message_id: discordResult.messageId,
          discord_delivery_type: discordResult.deliveryType,
          updated_at: new Date().toISOString()
        })
        .eq("id", newOffer.id);
    } catch (err) {
      console.error("Failed to notify consignor of store counter-back (non-blocking):", err);
    }

    res.json({ ok: true, new_offer_id: newOffer.id, dm_sent: !!discordResult });
  } catch (err) {
    console.error("Failed to process consignment store-counter:", err);
    res.status(500).json({ error: "Failed to process store counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: consignor counters again on the store's
// counter-back, mirroring the Member WTB buyer-counter pattern.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/consignor-counter", async (req, res) => {
  try {
    // FIXED — consistency gap: store-counter and edit both check
    // COUNTER_OFFERS_SECRET, this endpoint didn't. Added to match.
    const secret = asText(req.headers["x-kc-secret"]);

    if (!COUNTER_OFFERS_SECRET || secret !== COUNTER_OFFERS_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const previousOfferId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Invalid counter price" });
    }

    const { data: previousOffer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", previousOfferId)
      .single();

    if (fetchError || !previousOffer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (previousOffer.status !== "open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    if (!(Number(previousOffer.store_counter_price) > 0)) {
      return res.status(409).json({ error: "This offer has no store counter to respond to yet." });
    }

    if (!previousOffer.previous_offer_id) {
      return res.status(409).json({ error: "Missing previous round reference." });
    }

    const { data: priorConsignorRound, error: priorError } = await supabase
      .from("consignment_offers")
      .select("consignor_counter_price")
      .eq("id", previousOffer.previous_offer_id)
      .single();

    if (priorError || !priorConsignorRound) {
      return res.status(500).json({ error: "Could not find the consignor's previous counter." });
    }

    const consignorOwnReference = Number(priorConsignorRound.consignor_counter_price);

    if (!(consignorOwnReference > 0)) {
      return res.status(500).json({ error: "Could not determine the consignor's previous counter." });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(previousOffer.order_record_id);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    // Counterpart: store's counter, converted DOWN to consignor terms
    // (the new inverse functions).
    const storeCounterBase = calculateConsignmentBaseFromStoreOffer(
      Number(previousOffer.store_counter_price),
      orderFields
    );
    const storeCounterInConsignorTerms = convertStoreBasePriceToConsignorPrice(
      storeCounterBase,
      previousOffer.vat_type,
      clientCountry
    );

    if (!Number.isFinite(storeCounterInConsignorTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this order." });
    }

    const validation = validateNextCounterPrice(consignorOwnReference, storeCounterInConsignorTerms, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    await supabase
      .from("consignment_offers")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", previousOfferId);

    const storeBaseForProposed = convertConsignorPriceToStoreBasePrice(proposedPrice, previousOffer.vat_type, clientCountry);
    const proposedInStoreTerms = calculateStoreCustomOfferFromConsignmentBase(storeBaseForProposed, orderFields);
    const proposedInStoreTermsExclVat = getStoreOfferVatTypeFromConsignmentVat(previousOffer.vat_type, clientCountry) === "VAT21"
      ? Math.round((proposedInStoreTerms / 1.21) * 100) / 100
      : proposedInStoreTerms;

    if (!Number.isFinite(proposedInStoreTerms)) {
      return res.status(500).json({ error: "Could not compute a valid store price for this counter." });
    }

    const nowIso = new Date().toISOString();

    const { data: newOffer, error: createError } = await supabase
      .from("consignment_offers")
      .insert({
        order_record_id: previousOffer.order_record_id,
        order_id: previousOffer.order_id,
        inventory_id: previousOffer.inventory_id,

        seller_record_id: previousOffer.seller_record_id,
        seller_id: previousOffer.seller_id,

        product_name: previousOffer.product_name,
        sku: previousOffer.sku,
        size: previousOffer.size,
        brand: previousOffer.brand,

        vat_type: previousOffer.vat_type,
        seller_price: previousOffer.seller_price,
        offer_price: previousOffer.offer_price,

        is_counter_offer: true,
        consignor_counter_price: proposedPrice,
        consignor_counter_store_price: proposedInStoreTerms,
        consignor_counter_store_price_excl_vat: proposedInStoreTermsExclVat,
        consignor_counter_at: nowIso,

        previous_offer_id: previousOfferId,
        status: "store_pending",
        created_at: nowIso,
        updated_at: nowIso
      })
      .select()
      .single();

    if (createError) throw createError;

    let discordResult = null;

    // NEW — proactive no-room check: after this counter, would the
    // store have any valid step left to respond with?
    const storeOwnPositionForRoomCheck = Number(previousOffer.store_counter_price);
    const noRoomToCounter =
      Number.isFinite(proposedInStoreTerms) &&
      !hasRoomForNextStep(storeOwnPositionForRoomCheck, proposedInStoreTerms);

    try {
      discordResult = await postConsignmentCounterStoreOffer({
        offer: newOffer,
        orderFields,
        storeOfferPrice: proposedInStoreTerms,
        storeOfferVatType: getStoreOfferVatTypeFromConsignmentVat(previousOffer.vat_type, clientCountry),
        noRoomToCounter
      });

      await supabase
        .from("consignment_offers")
        .update({
          store_offer_channel_id: discordResult.channel_id || null,
          store_offer_message_id: discordResult.message_id || null,
          updated_at: new Date().toISOString()
        })
        .eq("id", newOffer.id);
    } catch (err) {
      console.error("Failed to notify store of consignor counter-back (non-blocking):", err);
    }

    res.json({ ok: true, new_offer_id: newOffer.id, dm_sent: !!discordResult });
  } catch (err) {
    console.error("Failed to process consignment consignor-counter:", err);
    res.status(500).json({ error: "Failed to process consignor counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: shared edit endpoint for Consignment, mirroring
// Store Orders/Member WTB exactly — same chain-aware own-reference
// lookup for both directions, same min-step rule as countering.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/edit", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!COUNTER_OFFERS_SECRET || secret !== COUNTER_OFFERS_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const recordId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Invalid counter price" });
    }

    const { data: offer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", recordId)
      .single();

    if (fetchError || !offer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (offer.status !== "open" && offer.status !== "store_pending") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    if (!offer.previous_offer_id) {
      return res.status(409).json({ error: "Editing isn't supported for the very first counter yet." });
    }

    const { data: previousOffer, error: prevError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", offer.previous_offer_id)
      .single();

    if (prevError || !previousOffer) {
      return res.status(500).json({ error: "Could not find the previous round." });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(offer.order_record_id);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    const hasStoreCounter = Number(offer.store_counter_price) > 0;

    let ownReference;
    let counterpart;

    if (hasStoreCounter) {
      // Store editing — same chain-aware own-reference lookup as the
      // store-counter endpoint.
      ownReference = Number(previousOffer.store_counter_price);

      if (!(ownReference > 0) && previousOffer.previous_offer_id) {
        const { data: grandparent } = await supabase
          .from("consignment_offers")
          .select("store_counter_price")
          .eq("id", previousOffer.previous_offer_id)
          .single();
        ownReference = Number(grandparent?.store_counter_price) || null;
      }

      const consignorBase = convertConsignorPriceToStoreBasePrice(
        Number(previousOffer.consignor_counter_price),
        offer.vat_type,
        clientCountry
      );
      counterpart = calculateStoreCustomOfferFromConsignmentBase(consignorBase, orderFields);
    } else {
      // Consignor editing — own reference is one hop further back (the
      // round being responded to is always store-placed, so it never
      // carries the consignor's own reference itself).
      if (!previousOffer.previous_offer_id) {
        return res.status(500).json({ error: "Could not determine the consignor's previous counter." });
      }

      const { data: grandparent } = await supabase
        .from("consignment_offers")
        .select("consignor_counter_price")
        .eq("id", previousOffer.previous_offer_id)
        .single();

      ownReference = Number(grandparent?.consignor_counter_price) || null;

      const storeBase = calculateConsignmentBaseFromStoreOffer(
        Number(previousOffer.store_counter_price),
        orderFields
      );
      counterpart = convertStoreBasePriceToConsignorPrice(storeBase, offer.vat_type, clientCountry);
    }

    if (!Number.isFinite(ownReference) || !Number.isFinite(counterpart)) {
      return res.status(500).json({ error: "Could not compute reference prices for this edit." });
    }

    const validation = validateNextCounterPrice(ownReference, counterpart, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const nowIso = new Date().toISOString();

    if (hasStoreCounter) {
      const proposedExclVat = getStoreOfferVatTypeFromConsignmentVat(offer.vat_type, clientCountry) === "VAT21"
        ? Math.round((proposedPrice / 1.21) * 100) / 100
        : proposedPrice;

      await supabase
        .from("consignment_offers")
        .update({
          store_counter_price: proposedPrice,
          store_counter_price_excl_vat: proposedExclVat,
          updated_at: nowIso
        })
        .eq("id", recordId);

      try {
        await sendConsignmentCounterOfferDiscordMessage({
          offer: { ...offer, store_counter_price: proposedPrice },
          storeOfferPrice: proposedPrice,
          storeOfferVatType: getStoreOfferVatTypeFromConsignmentVat(offer.vat_type, clientCountry),
          yourPreviousCounter: Number(previousOffer.consignor_counter_price)
        });
      } catch (err) {
        console.error("Failed to notify consignor of edited counter (non-blocking):", err);
      }
    } else {
      const storeBaseForProposed = convertConsignorPriceToStoreBasePrice(proposedPrice, offer.vat_type, clientCountry);
      const proposedInStoreTerms = calculateStoreCustomOfferFromConsignmentBase(storeBaseForProposed, orderFields);
      const proposedInStoreTermsExclVat = getStoreOfferVatTypeFromConsignmentVat(offer.vat_type, clientCountry) === "VAT21"
        ? Math.round((proposedInStoreTerms / 1.21) * 100) / 100
        : proposedInStoreTerms;

      if (!Number.isFinite(proposedInStoreTerms)) {
        return res.status(500).json({ error: "Could not compute a valid store price for this counter." });
      }

      await supabase
        .from("consignment_offers")
        .update({
          consignor_counter_price: proposedPrice,
          consignor_counter_store_price: proposedInStoreTerms,
          consignor_counter_store_price_excl_vat: proposedInStoreTermsExclVat,
          consignor_counter_at: nowIso,
          updated_at: nowIso
        })
        .eq("id", recordId);

      try {
        await postConsignmentCounterStoreOffer({
          offer: { ...offer, consignor_counter_price: proposedPrice },
          orderFields,
          storeOfferPrice: proposedInStoreTerms,
          storeOfferVatType: getStoreOfferVatTypeFromConsignmentVat(offer.vat_type, clientCountry)
        });
      } catch (err) {
        console.error("Failed to notify store of edited counter (non-blocking):", err);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to edit consignment offer:", err);
    res.status(500).json({ error: "Failed to edit counter offer", details: err.message });
  }
});

app.post("/api/consignment/offers/:id/deny", async (req, res) => {
  try {
    const offerId = asText(req.params.id);
    const sellerRecordId = asText(req.body?.seller_record_id);

    const offer = await getOpenConsignmentOffer(offerId);

    if (!offer) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    if (sellerRecordId && offer.seller_record_id !== sellerRecordId) {
      return res.status(403).json({
        error: "Not allowed"
      });
    }

    const result = await denyConsignmentOffer(offerId);

    if (!result.ok) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    res.json({
      ok: true,
      offer: result.offer
    });
  } catch (err) {
    console.error("Failed to deny consignment offer:", err);

    res.status(500).json({
      error: "Failed to deny consignment offer",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/:id/confirm", async (req, res) => {
  try {
    const offerId = asText(req.params.id);
    const sellerRecordId = asText(req.body?.seller_record_id);

    const offer = await getOpenConsignmentOffer(offerId);

    if (!offer) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    if (sellerRecordId && offer.seller_record_id !== sellerRecordId) {
      return res.status(403).json({
        error: "Not allowed"
      });
    }

    // FIXED — CRITICAL: this previously called confirmConsignmentOffer
    // straight away, which reads offer_price for "Purchase Price" on
    // the created Inventory Unit (and the Make webhook payload).
    // offer_price is only ever carried forward on new counter rounds —
    // for a STORE-placed round (created by the new store-counter
    // endpoint) being accepted directly by the consignor via this
    // endpoint, it never got synced to the negotiated amount, so this
    // would have written a stale, wrong (original round-1) purchase
    // price. /store-accept already does this exact sync for the other
    // direction (consignor round → offer_price) — mirroring that here.
    // Scoped strictly to previous_offer_id being set (a genuinely NEW
    // chain round) — round 1 itself already gets offer_price set
    // correctly at creation via a different, pre-existing formula
    // (calculateCounterPayoutForVatType), and must not be touched here.
    if (
      offer.previous_offer_id &&
      offer.is_counter_offer &&
      !(Number(offer.consignor_counter_price) > 0) &&
      Number(offer.store_counter_price) > 0
    ) {
      const orderRecordForSync = await airtable(ORDERS_TABLE).find(offer.order_record_id);
      const orderFieldsForSync = orderRecordForSync.fields || {};
      const clientCountryForSync = asText(orderFieldsForSync["Client Country"]);

      const storeCounterBaseForSync = calculateConsignmentBaseFromStoreOffer(
        Number(offer.store_counter_price),
        orderFieldsForSync
      );
      const consignorEquivalentForSync = convertStoreBasePriceToConsignorPrice(
        storeCounterBaseForSync,
        offer.vat_type,
        clientCountryForSync
      );

      if (!Number.isFinite(consignorEquivalentForSync) || consignorEquivalentForSync <= 0) {
        return res.status(500).json({ error: "Could not compute consignor payout for this counter." });
      }

      await supabase
        .from("consignment_offers")
        .update({ offer_price: consignorEquivalentForSync, updated_at: new Date().toISOString() })
        .eq("id", offerId);
    }

    const result = await confirmConsignmentOffer(offerId);

    if (!result.ok) {
      return res.status(409).json({
        error: "Offer is no longer available"
      });
    }

    if (result.offer.discord_channel_id && result.offer.discord_message_id) {
      await disableConsignmentDiscordButtons(
        result.offer.discord_channel_id,
        result.offer.discord_message_id,
        `✅ Confirmed by ${result.offer.seller_id}.`
      );
    }

    res.json({
      ok: true,
      offer: result.offer
    });
  } catch (err) {
    console.error("Failed to confirm consignment offer:", err);

    res.status(500).json({
      error: "Failed to confirm consignment offer",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/:id/store-accept", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const offerId = asText(req.params.id);

    const { data: offer, error } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", offerId)
      .eq("status", "store_pending")
      .single();

    if (error || !offer) {
      return res.status(409).json({
        error: "Counter offer is no longer pending"
      });
    }

    await supabase
      .from("consignment_offers")
      .update({
        status: "open",
        offer_price: Number(offer.consignor_counter_price),
        store_response_status: "accepted",
        store_response_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", offer.id);

    const result = await confirmConsignmentOffer(offer.id);

    if (!result.ok) {
      return res.status(409).json({
        error: "Offer could not be confirmed",
        reason: result.reason
      });
    }

    res.json({
      ok: true,
      offer: result.offer
    });
  } catch (err) {
    console.error("Failed to accept consignment counter store offer:", err);

    res.status(500).json({
      error: "Failed to accept store counter offer",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/:id/store-deny", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const offerId = asText(req.params.id);

    const { data: offer, error } = await supabase
      .from("consignment_offers")
      .update({
        status: "store_denied",
        store_response_status: "denied",
        store_response_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", offerId)
      .eq("status", "store_pending")
      .select()
      .single();

    if (error || !offer) {
      return res.status(409).json({
        error: "Counter offer is no longer pending"
      });
    }

    // NEW — additive only: same reopen-prior-round pattern as the other
    // direction and the other two flows. The denied round (consignor's
    // counter) was itself responding to a STORE round (if any) —
    // reopen it and resend the standard consignor-facing notification
    // so the consignor can accept it or try a lower counter.
    try {
      if (offer.previous_offer_id) {
        const { data: priorOffer, error: priorFetchError } = await supabase
          .from("consignment_offers")
          .select("*")
          .eq("id", offer.previous_offer_id)
          .single();

        if (priorFetchError) {
          console.error("Consignment reopen: failed to fetch prior offer:", offer.previous_offer_id, priorFetchError);
        }

        if (priorOffer) {
          const { error: reopenUpdateError } = await supabase
            .from("consignment_offers")
            .update({ status: "open" })
            .eq("id", priorOffer.id);

          if (reopenUpdateError) {
            console.error("Consignment reopen: failed to set prior offer status to open:", priorOffer.id, reopenUpdateError);
          }

          let consignorOwnPreviousPosition = null;

          if (priorOffer.previous_offer_id) {
            const { data: grandparentOffer, error: grandparentError } = await supabase
              .from("consignment_offers")
              .select("consignor_counter_price")
              .eq("id", priorOffer.previous_offer_id)
              .single();

            if (grandparentError) {
              console.error("Consignment reopen: failed to fetch grandparent offer:", priorOffer.previous_offer_id, grandparentError);
            }

            consignorOwnPreviousPosition = Number(grandparentOffer?.consignor_counter_price) || null;
          }

          console.log("Consignment reopen: sending re-notification for prior offer:", priorOffer.id);

          await sendConsignmentCounterOfferDiscordMessage({
            offer: priorOffer,
            storeOfferPrice: Number(priorOffer.store_counter_price),
            storeOfferVatType: null,
            yourPreviousCounter: consignorOwnPreviousPosition,
            deniedAmount: Number(offer.consignor_counter_price)
          });

          console.log("Consignment reopen: re-notification sent successfully for:", priorOffer.id);
        } else {
          console.error("Consignment reopen: priorOffer not found (no error, but empty result) for id:", offer.previous_offer_id);
        }
      } else {
        console.log("Consignment reopen: no previous_offer_id on denied offer, nothing to reopen:", offer.id);
      }
    } catch (reopenErr) {
      console.error("Failed to reopen prior round after consignment store-deny (non-blocking):", reopenErr);
    }

    res.json({
      ok: true,
      offer
    });
  } catch (err) {
    console.error("Failed to deny consignment counter store offer:", err);

    res.status(500).json({
      error: "Failed to deny store counter offer",
      details: err.message
    });
  }
});

function normalizeTempPassword(discord, sellerId) {
  const cleanDiscord = asText(discord).toLowerCase().replace(/\s+/g, "");
  const cleanSellerId = asText(sellerId).replace(/^SE-/i, "");

  return `${cleanDiscord}-${cleanSellerId}`;
}

function normalizeSeller(record) {
  const f = record.fields || {};

  return {
    id: record.id,
    seller_id: displayValue(f["Seller ID"]),
    email: displayValue(f["Email"]),
    discord: displayValue(f["Discord"]),
    discord_id: displayValue(f["Discord ID"]),
    portal_password: displayValue(f["Portal Password"]),
    portal_enabled: f["Portal Enabled"] !== false,
    consignor: f["Consignor?"] === true,
    deal_updates_channel_id: displayValue(f["Deal Updates Channel ID"]),
    consignment_offer_channel_id: displayValue(f["Consignment Offer Channel ID"]),
    consignment_confirmation_channel_id: displayValue(f["Consignment Confirmation Channel ID"])
  };
}

function escapeFormulaValue(value) {
  return asText(value).replace(/'/g, "\\'");
}

function displayValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asText(v)).filter(Boolean).join(", ");
  }

  return asText(value);
}

function numberValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// NEW — additive only: shared narrowing-band validator for the
// counter-offer ping-pong. Given the two most recent prices in a
// negotiation thread, checks whether a proposed new price is strictly
// between them (and therefore narrows the gap). Used by every
// counter-back endpoint (Store Orders now, Member WTBs / Consignment
// later) so the rule can never be bypassed from one entry point but not
// another.
// FIXED — the min-€2.50-step rule (established early in the design,
// combined with whole-number-only offers to effectively become steps of
// 3) was never actually enforced here — only the "strictly within the
// band" check was. This let someone counter with almost no real
// movement (e.g. €2 less), and gave a confusing "No room left" message
// that didn't explain the actual rule. Now takes a directional
// ownReferencePrice (the price the mover themselves last stated) vs
// counterpartPrice (the other side's last price), and requires the
// proposal to be at least MIN_STEP away from ownReferencePrice AND
// strictly on the correct side of counterpartPrice. enforceMinStep can
// be turned off for editing an already-placed price, where the person
// isn't making a new negotiating move, just correcting their current
// unanswered offer.
const MIN_COUNTER_STEP = 2.5;

function validateNextCounterPrice(ownReferencePrice, counterpartPrice, proposed, options = {}) {
  const { enforceMinStep = true } = options;

  if (!Number.isInteger(proposed)) {
    return { ok: false, reason: "Counter offers must be a whole number." };
  }

  const movingDown = ownReferencePrice > counterpartPrice;
  const low = Math.min(ownReferencePrice, counterpartPrice);
  const high = Math.max(ownReferencePrice, counterpartPrice);

  let minAllowed = low + 1;
  let maxAllowed = high - 1;

  if (enforceMinStep) {
    if (movingDown) {
      maxAllowed = Math.floor(ownReferencePrice - MIN_COUNTER_STEP);
    } else {
      minAllowed = Math.ceil(ownReferencePrice + MIN_COUNTER_STEP);
    }
  }

  if (minAllowed > maxAllowed) {
    return {
      ok: false,
      reason: "No room left to counter — the gap is too small for another step, please accept or deny.",
      band: [low, high]
    };
  }

  if (proposed < minAllowed || proposed > maxAllowed) {
    // FIXED — shortened per feedback: the unreachable bound (e.g. a
    // store's theoretical upper limit near the seller's ask, which a
    // store paying as little as possible will never approach) just adds
    // noise. State only the bound that's actually relevant to which
    // direction this mover is going.
    const reason = movingDown
      ? `Your counter must be lower than your previous €${ownReferencePrice} — maximum €${maxAllowed}.`
      : `Your counter must be higher than your previous €${ownReferencePrice} — minimum €${minAllowed}.`;
    return {
      ok: false,
      reason,
      band: [minAllowed, maxAllowed]
    };
  }

  return { ok: true, band: [minAllowed, maxAllowed] };
}

// NEW — additive only: proactively checks whether the NEXT party to act
// would have any valid counter available at all, without needing a
// specific proposed amount — used right when sending a notification, so
// we can show "no room left, accept or deny" upfront instead of only
// discovering it after someone tries and fails. Same math as
// validateNextCounterPrice's internal room check, factored out.
function hasRoomForNextStep(ownReferencePrice, counterpartPrice) {
  const low = Math.min(ownReferencePrice, counterpartPrice);
  const high = Math.max(ownReferencePrice, counterpartPrice);
  const movingDown = ownReferencePrice > counterpartPrice;

  let minAllowed = low + 1;
  let maxAllowed = high - 1;

  if (movingDown) {
    maxAllowed = Math.floor(ownReferencePrice - MIN_COUNTER_STEP);
  } else {
    minAllowed = Math.ceil(ownReferencePrice + MIN_COUNTER_STEP);
  }

  return minAllowed <= maxAllowed;
}

function moneyValue(value) {
  const n = numberValue(value);

  if (!n) return "";

  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR"
  }).format(n);
}

function moneyWholeValue(value) {
  const n = numberValue(value);

  if (!n) return "";

  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.floor(n));
}

function getImageUrl(value) {
  if (!Array.isArray(value) || !value[0]?.url) return "";
  return value[0].url;
}

function firstAttachmentUrl(value) {
  if (!Array.isArray(value) || !value.length) {
    return "";
  }

  return value[0]?.url || "";
}

function hoursSince(value) {
  if (!value) return 0;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;

  return (Date.now() - date.getTime()) / 1000 / 60 / 60;
}

function linkedRecordIncludes(value, recordId) {
  return Array.isArray(value) && value.includes(recordId);
}

function linkedRecordIsEmpty(value) {
  return !Array.isArray(value) || value.length === 0;
}

function formatDateEU(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return displayValue(value);

  return new Intl.DateTimeFormat("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function sortDashboardItemsNewestFirst(items) {
  return [...items].sort((a, b) => {
    const dateA = new Date(a.raw_date || 0).getTime();
    const dateB = new Date(b.raw_date || 0).getTime();

    return dateB - dateA;
  });
}

function getStockCounterKey(sku, size) {
  return `${asText(sku).toUpperCase()}-${asText(size).toUpperCase()}`;
}

function roundDownToStep(value, step = 2.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / step) * step;
}

function getCounterEquivalentPriceForVatType(storeCounterAllInPrice, vatType) {
  const price = Number(storeCounterAllInPrice);
  const type = asText(vatType);

  if (!Number.isFinite(price) || price <= 0) return null;

  if (type === "VAT0") {
    return price / 1.21;
  }

  return price;
}

function calculateCounterPayoutForVatType(storeCounterAllInPrice, vatType, orderFields = {}) {
  const converted = getCounterEquivalentPriceForVatType(storeCounterAllInPrice, vatType);

  if (!Number.isFinite(converted) || converted <= 0) return null;

  const margin = numberValue(orderFields["Offer Margin"]);
  const percentage = numberValue(orderFields["Offer Percentage"]);
  const method = asText(orderFields["Offer Method"]);

  let payout;

  if (method === "Firm Range" && Number.isFinite(margin) && margin > 0) {
    payout = converted - margin;
  } else if (Number.isFinite(percentage) && percentage > 0) {
    payout = Math.min(
      converted - 10,
      converted / (1 + percentage)
    );
  } else if (Number.isFinite(margin) && margin > 0) {
    payout = converted - margin;
  } else {
    return null;
  }

  return roundDownToStep(payout, 2.5);
}

function roundToNearestStep(value, step = 2.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n / step) * step;
}

// NEW — additive only: the FORWARD direction of the margin conversion
// above — given a seller's ask, what would the store need to pay so the
// seller still receives (approximately) that ask after margin. This is
// the exact inverse logic of the "Offer To Store" Airtable formula
// (Firm Range: add the margin; Percentage: apply the percentage with a
// minimum +€10 floor), rounded to the nearest €2.50 step rather than
// floored, matching that formula's ROUND(...) behavior. Needed so the
// ping-pong can compare the seller's and store's numbers on the SAME
// scale — without this, a seller's raw ask and a store's raw counter
// price look like two unrelated numbers even when the margin between
// them is the only real difference.
function calculateStoreCounterEquivalent(sellerAskPrice, vatType, orderFields = {}) {
  const converted = getCounterEquivalentPriceForVatType(sellerAskPrice, vatType);

  if (!Number.isFinite(converted) || converted <= 0) return null;

  const margin = numberValue(orderFields["Offer Margin"]);
  const percentage = numberValue(orderFields["Offer Percentage"]);
  const method = asText(orderFields["Offer Method"]);

  let storePrice;

  if (method === "Firm Range" && Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else if (Number.isFinite(percentage) && percentage > 0) {
    storePrice = Math.max(
      converted + 10,
      converted * (1 + percentage)
    );
  } else if (Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else {
    return null;
  }

  return roundToNearestStep(storePrice, 2.5);
}

// NEW — additive only: replicates the EXACT VAT-exclusion rule used
// downstream in calculateLinkedUnitPrice.js (the Airtable automation
// that sets the order's Final Buying Price): only divide by 1.21 when
// the client is Dutch AND the seller's VAT type is VAT21 — otherwise
// leave the number as-is. Used to compute a correct
// store_counter_price_excl_vat for the accept webhook when the
// Airtable formula field it would normally read is empty (seller-
// placed rounds never populate "Store Counter Price", so the formula
// derived from it comes back empty too).
function computeStoreExclVatForOrder(storeAllInPrice, vatType, orderFields = {}) {
  const price = Number(storeAllInPrice);
  if (!Number.isFinite(price)) return null;

  const clientCountry = asText(orderFields["Client Country"]).toLowerCase();
  const type = asText(vatType).toUpperCase().replace(/\s+/g, "");

  if (clientCountry.includes("netherland") && type === "VAT21") {
    return Math.round((price / 1.21) * 100) / 100;
  }

  return Math.round(price * 100) / 100;
}

// NEW — Member WTB margin conversion. Much simpler than Store Orders:
// always a flat €10 between seller and buyer, no per-seller or
// percentage variability (confirmed — not feasible to set individual
// margins per member buyer). MEMBER_WTB_MARGIN reads "Offer Margin" on
// the Member WTB record itself if set, falling back to €10 — mirrors
// the exact same fallback already used in discord-wtb-bot-main
// (`parseNumeric(record.get('Offer Margin')) ?? 10`), so this can never
// drift from that established behavior.
// FIXED — corrected per explicit instruction: this is NOT a fallback
// that only applies when a field is empty. Member WTB margin is always
// a flat €10, full stop, no per-record override, no per-seller
// variability. Kept as its own named function (rather than inlining
// "10" everywhere) purely so the one place this rule lives is easy to
// find and change later if that policy ever changes — not because
// there's any conditional logic here.
function getMemberWtbMargin() {
  return 10;
}

// FIXED — this pair originally reused the Store Orders VAT/rounding
// logic (getCounterEquivalentPriceForVatType + roundToNearestStep at a
// €2.50 step), which does NOT match the real "Offer To Buyer" Airtable
// formula. The actual formula: (1) sellers with VAT Type "Margin" just
// get the flat margin added, no VAT math; (2) otherwise, if the buyer
// has a VAT ID AND their country isn't Netherlands/Nederland (reverse
// charge), the amount stays VAT-excl; otherwise the final amount is
// grossed back up ×1.21; (3) VAT21 sellers get divided by 1.21 before
// the margin is applied, VAT0/other sellers don't; (4) rounding is to
// 2 decimals (cents), not a €2.50 step. Both directions below mirror
// that exact branching so a buyer counter and its seller-payout
// equivalent always match what "Offer To Buyer" would show.
function memberWtbIsReverseCharge(memberWtbFields = {}) {
  const buyerVatId = asText(memberWtbFields["Buyer VAT ID"]);
  const buyerCountry = asText(memberWtbFields["Buyer Country"]);
  return !!buyerVatId && buyerCountry !== "Netherlands" && buyerCountry !== "Nederland";
}

function calculateMemberWtbBuyerEquivalent(sellerAskPrice, vatType, memberWtbFields = {}) {
  const price = Number(sellerAskPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const margin = getMemberWtbMargin();
  const type = asText(vatType);

  if (type === "Margin") {
    return Math.round((price + margin) * 100) / 100;
  }

  const reverseCharge = memberWtbIsReverseCharge(memberWtbFields);

  if (reverseCharge) {
    const result = type === "VAT21" ? (price / 1.21) + margin : price + margin;
    return Math.round(result * 100) / 100;
  }

  const result = type === "VAT21" ? ((price / 1.21) + margin) * 1.21 : (price + margin) * 1.21;
  return Math.round(result * 100) / 100;
}

function calculateMemberWtbSellerPayout(buyerPrice, vatType, memberWtbFields = {}) {
  const price = Number(buyerPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const margin = getMemberWtbMargin();
  const type = asText(vatType);

  if (type === "Margin") {
    return Math.round((price - margin) * 100) / 100;
  }

  const reverseCharge = memberWtbIsReverseCharge(memberWtbFields);

  if (reverseCharge) {
    const result = type === "VAT21" ? (price - margin) * 1.21 : price - margin;
    return Math.round(result * 100) / 100;
  }

  const grossless = price / 1.21;
  const result = type === "VAT21" ? (grossless - margin) * 1.21 : grossless - margin;
  return Math.round(result * 100) / 100;
}

async function sendCounterOfferDiscordDM({
  counterOfferRecordId,
  sellerDiscordId,
  productName,
  sku,
  size,
  orderId,
  payout,
  vatType,
  sellerOriginalPrice,
  sellerOriginalVatType,
  noRoomToCounter,
  deniedAmount
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  const originalText =
    sellerOriginalPrice !== undefined && sellerOriginalPrice !== null && sellerOriginalPrice !== ""
      ? `€${Number(sellerOriginalPrice).toFixed(2)} · ${sellerOriginalVatType || "—"}`
      : null;

  const diffText =
    originalText && Number.isFinite(Number(sellerOriginalPrice)) && Number.isFinite(Number(payout))
      ? ` (${Number(payout) - Number(sellerOriginalPrice) >= 0 ? "+" : ""}€${(Number(payout) - Number(sellerOriginalPrice)).toFixed(2)})`
      : "";

  // NEW — when there's no valid step left for either side, say so
  // plainly and only offer Accept/Deny, instead of showing a Counter
  // button that would just fail if clicked.
  const closingLine = noRoomToCounter
    ? "You're now very close to each other's price — there's no room for another counter. Please accept or deny."
    : "Accept if you can fulfill this order at the counter price.";

  // NEW — used when this notification is a RE-SEND of an already-open
  // round after the seller's own follow-up counter got denied. Makes
  // clear this isn't a brand new counter from the store — it's the
  // same standing offer as before, still available to accept or
  // counter again, lower this time.
  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? [`❌ Your counter of €${Number(deniedAmount).toFixed(2)} was denied.`, ""]
      : [];

  const message = await dm.send({
    embeds: [
      {
        title: "🔁 Counter Offer",
        description: [
          `**${productName || "—"}**`,
          `SKU: ${sku || "—"}`,
          `Size: ${size || "—"}`,
          "",
          `Order: ${orderId || "—"}`,
          "",
          ...deniedNote,
          `The store sent a counter offer.`,
          "",
          ...(originalText ? [`**Your original offer**`, originalText, ""] : []),
          `**Counter payout**`,
          `€${Number(payout).toFixed(2)} · ${vatType || "—"}${diffText}`,
          "",
          closingLine
        ].join("\n"),
        color: 0xf1c40f
      }
    ],
    components: [
      {
        type: 1,
        components: noRoomToCounter
          ? [
              {
                type: 2,
                style: 3,
                label: "Accept",
                custom_id: `counter_offer_accept:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 4,
                label: "Deny",
                custom_id: `counter_offer_deny:${counterOfferRecordId}`
              }
            ]
          : [
          {
            type: 2,
            style: 3,
            label: "Accept",
            custom_id: `counter_offer_accept:${counterOfferRecordId}`
          },
          {
            type: 2,
            style: 1,
            label: "Counter",
            custom_id: `counter_offer_counter:${counterOfferRecordId}`
          },
          {
            type: 2,
            style: 4,
            label: "Deny",
            custom_id: `counter_offer_deny:${counterOfferRecordId}`
          }
        ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm"
  };
}

// NEW — additive only: Member WTB counterpart of sendCounterOfferDiscordDM
// above. Same structure (original offer + counter payout + Accept/
// Counter/Deny), but uses its own customId scheme
// (member_wtb_counter_*) so it never collides with the Store Orders
// buttons, and always shows the Member WTB ID — sellers must never see
// anything Shopify-order-shaped.
async function sendMemberWtbCounterOfferDiscordDM({
  counterOfferRecordId,
  sellerDiscordId,
  productName,
  sku,
  size,
  memberWtbId,
  payout,
  vatType,
  sellerOriginalPrice,
  sellerOriginalVatType,
  noRoomToCounter,
  deniedAmount
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  const originalText =
    sellerOriginalPrice !== undefined && sellerOriginalPrice !== null && sellerOriginalPrice !== ""
      ? `€${Number(sellerOriginalPrice).toFixed(2)} · ${sellerOriginalVatType || "—"}`
      : null;

  const diffText =
    originalText && Number.isFinite(Number(sellerOriginalPrice)) && Number.isFinite(Number(payout))
      ? ` (${Number(payout) - Number(sellerOriginalPrice) >= 0 ? "+" : ""}€${(Number(payout) - Number(sellerOriginalPrice)).toFixed(2)})`
      : "";

  const closingLine = noRoomToCounter
    ? "You're now very close to each other's price — there's no room for another counter. Please accept or deny."
    : "Accept if you can fulfill this at the counter price.";

  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? [`❌ Your counter of €${Number(deniedAmount).toFixed(2)} was denied.`, ""]
      : [];

  const message = await dm.send({
    embeds: [
      {
        title: "🔁 Counter Offer",
        description: [
          `**${productName || "—"}**`,
          `SKU: ${sku || "—"}`,
          `Size: ${size || "—"}`,
          "",
          `Member WTB: ${memberWtbId || "—"}`,
          "",
          ...deniedNote,
          `The buyer sent a counter offer.`,
          "",
          ...(originalText ? [`**Your original offer**`, originalText, ""] : []),
          `**Counter payout**`,
          `€${Number(payout).toFixed(2)} · ${vatType || "—"}${diffText}`,
          "",
          closingLine
        ].join("\n"),
        color: 0xf1c40f
      }
    ],
    components: [
      {
        type: 1,
        components: noRoomToCounter
          ? [
              {
                type: 2,
                style: 3,
                label: "Accept",
                custom_id: `member_wtb_counter_accept:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 4,
                label: "Deny",
                custom_id: `member_wtb_counter_deny:${counterOfferRecordId}`
              }
            ]
          : [
              {
                type: 2,
                style: 3,
                label: "Accept",
                custom_id: `member_wtb_counter_accept:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 1,
                label: "Counter",
                custom_id: `member_wtb_counter_counter:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 4,
                label: "Deny",
                custom_id: `member_wtb_counter_deny:${counterOfferRecordId}`
              }
            ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm"
  };
}

// NEW — additive only: notifies the BUYER when the seller counters
// back. Mirrors the Store Orders "Seller Countered" pattern (own
// previous counter + new counter, Accept/Counter/Deny) but as a DM
// (Member WTB buyers/sellers only ever use DMs, no channels) — and,
// same confidentiality rule as Store Orders: only ever shows the
// BUYER-FACING (already margin-converted) amount, never the seller's
// raw ask or our margin.
async function sendMemberWtbBuyerCounterOfferDiscordDM({
  counterOfferRecordId,
  buyerDiscordId,
  productName,
  sku,
  size,
  memberWtbId,
  newPrice,
  yourPreviousCounter,
  noRoomToCounter,
  deniedAmount
}) {
  await initKickzDealDiscord();

  if (!buyerDiscordId) {
    throw new Error("Missing buyer Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(buyerDiscordId);
  const dm = await user.createDM();

  const closingLine = noRoomToCounter
    ? "You're now very close to each other's price — there's no room for another counter. Please accept or deny."
    : "Please accept, counter, or deny below.";

  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? [`❌ Your counter of €${Number(deniedAmount).toFixed(2)} was denied.`, ""]
      : [];

  const message = await dm.send({
    embeds: [
      {
        title: "🔁 Seller Countered",
        description: [
          `**${productName || "—"}**`,
          `SKU: ${sku || "—"}`,
          `Size: ${size || "—"}`,
          "",
          `Member WTB: ${memberWtbId || "—"}`,
          "",
          ...deniedNote,
          `The seller sent a counter offer.`,
          "",
          `**Your Previous Counter**`,
          `€${Number(yourPreviousCounter).toFixed(2)}`,
          "",
          `**New Counter**`,
          `€${Number(newPrice).toFixed(2)}`,
          "",
          closingLine
        ].join("\n"),
        color: 0xf1c40f
      }
    ],
    components: [
      {
        type: 1,
        components: noRoomToCounter
          ? [
              {
                type: 2,
                style: 3,
                label: "Accept",
                custom_id: `member_wtb_buyer_counter_accept:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 4,
                label: "Deny",
                custom_id: `member_wtb_buyer_counter_deny:${counterOfferRecordId}`
              }
            ]
          : [
              {
                type: 2,
                style: 3,
                label: "Accept",
                custom_id: `member_wtb_buyer_counter_accept:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 1,
                label: "Counter",
                custom_id: `member_wtb_buyer_counter_counter:${counterOfferRecordId}`
              },
              {
                type: 2,
                style: 4,
                label: "Deny",
                custom_id: `member_wtb_buyer_counter_deny:${counterOfferRecordId}`
              }
            ]
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm"
  };
}


// offer (not a counter). Shows the seller their own denied amount + VAT
// type and a button to place a new offer, using the modal below which
// calls the existing place-offer relay — no new offer-placement logic.
async function sendOfferDeniedDiscordDM({
  orderRecordId,
  orderId,
  sellerOfferRecordId,
  sellerRecordId,
  sellerDiscordId,
  productName,
  sku,
  size,
  shopifyOrderNumber,
  deniedAmount,
  vatType
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  const amountText =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? `€${Number(deniedAmount).toFixed(2)}`
      : "—";

  await dm.send({
    embeds: [
      {
        title: "❌ Offer Denied",
        description: [
          `**${productName || "—"}**`,
          `SKU: ${sku || "—"}`,
          `Size: ${size || "—"}`,
          "",
          `Order: ${orderId || orderRecordId || "—"}`,
          "",
          `**Your denied offer**`,
          `${amountText} · ${vatType || "—"}`,
          "",
          "You can place a new offer below."
        ].join("\n"),
        color: 0xe74c3c
      }
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "Place New Offer",
            // UPDATED: now points at the existing Seller Offer record
            // (sellerOfferRecordId) plus the denied amount, so the modal
            // handler can call the new edit-after-denial endpoint with
            // the minimum-decrease validation, instead of creating a
            // brand new offer record.
            custom_id: `place_new_offer:${sellerOfferRecordId || ""}:${sellerRecordId}:${vatType || ""}:${deniedAmount ?? ""}`
          }
        ]
      }
    ]
  });
}

function roundUpToStep(value, step = 2.5) {
  return Math.ceil(Number(value || 0) / step) * step;
}

function isDutchClientCountry(country) {
  const value = asText(country).toLowerCase();

  return [
    "nl",
    "nederland",
    "netherlands",
    "the netherlands"
  ].includes(value);
}

function getStoreOfferVatTypeFromConsignmentVat(consignorVatType, clientCountry) {
  const vatType = asText(consignorVatType);
  const isDutch = isDutchClientCountry(clientCountry);

  if (vatType === "Margin") return "Margin";

  return isDutch ? "VAT21" : "VAT0";
}

function convertConsignorPriceToStoreBasePrice(consignorPrice, consignorVatType, clientCountry) {
  const price = Number(consignorPrice);
  const vatType = asText(consignorVatType);
  const isDutch = isDutchClientCountry(clientCountry);

  if (!Number.isFinite(price) || price <= 0) return null;

  if (vatType === "Margin") return price;

  if (vatType === "VAT0" && isDutch) {
    return price * 1.21;
  }

  if (vatType === "VAT21" && !isDutch) {
    return price / 1.21;
  }

  return price;
}

function calculateStoreCustomOfferFromConsignmentBase(basePrice, orderFields = {}) {
  const base = Number(basePrice);

  if (!Number.isFinite(base) || base <= 0) return null;

  const method = asText(firstLookupValue(orderFields["Offer Method"]));
  const percentage = Number(firstLookupValue(orderFields["Offer Percentage"]));
  const margin = Number(firstLookupValue(orderFields["Offer Margin"]));

  let rawOffer;

  if (method === "Firm Range") {
    if (!Number.isFinite(margin)) return null;
    rawOffer = base + margin;
  } else {
    if (!Number.isFinite(percentage) || percentage >= 1) return null;
    rawOffer = (base + 5) / (1 - percentage);
  }

  return roundUpToStep(rawOffer, 2.5);
}

// NEW — additive only: the exact inverse of the two functions above,
// needed so a STORE counter (entered in store/all-in terms) can be
// compared against and converted back to consignor terms. Reversing
// each step in the opposite order (undo the margin first, then undo
// the VAT/country conversion) mirrors exactly how the forward
// direction was built, so both sides of the ping-pong agree on what
// a given number means.
function calculateConsignmentBaseFromStoreOffer(storeOfferPrice, orderFields = {}) {
  const store = Number(storeOfferPrice);

  if (!Number.isFinite(store) || store <= 0) return null;

  const method = asText(firstLookupValue(orderFields["Offer Method"]));
  const percentage = Number(firstLookupValue(orderFields["Offer Percentage"]));
  const margin = Number(firstLookupValue(orderFields["Offer Margin"]));

  let base;

  if (method === "Firm Range") {
    if (!Number.isFinite(margin)) return null;
    base = store - margin;
  } else {
    if (!Number.isFinite(percentage) || percentage >= 1) return null;
    base = store * (1 - percentage) - 5;
  }

  return base;
}

function convertStoreBasePriceToConsignorPrice(basePrice, consignorVatType, clientCountry) {
  const base = Number(basePrice);
  const vatType = asText(consignorVatType);
  const isDutch = isDutchClientCountry(clientCountry);

  if (!Number.isFinite(base) || base <= 0) return null;

  if (vatType === "Margin") return roundDownToStep(base, 2.5);

  if (vatType === "VAT0" && isDutch) {
    return roundDownToStep(base / 1.21, 2.5);
  }

  if (vatType === "VAT21" && !isDutch) {
    return roundDownToStep(base * 1.21, 2.5);
  }

  return roundDownToStep(base, 2.5);
}

async function postConsignmentCounterStoreOffer({
  offer,
  orderFields,
  storeOfferPrice,
  storeOfferVatType,
  noRoomToCounter,
  deniedAmount
}) {
  const secret = COUNTER_OFFERS_SECRET || process.env.COUNTER_OFFERS_SECRET || "";

  const response = await fetch(`${AIRTABLE_DISCORD_UPDATES_URL}/post-consignment-counter-store-offer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-kc-secret": secret } : {})
    },
    body: JSON.stringify({
      consignment_offer_id: offer.id,
      order_record_id: offer.order_record_id,

      store_name: asText(orderFields["Store Name"]),
      shopify_order_number: asText(orderFields["Shopify Order Number"]),
      selling_price:
        asText(orderFields["Shopify Selling Price"]) ||
        asText(orderFields["Selling Price"]),

      product_name:
        asText(orderFields["Shopify Product Name"]) ||
        asText(orderFields["Product Name"]) ||
        offer.product_name,

      sku:
        asText(orderFields["SKU"]) ||
        asText(orderFields["SKU Soft"]) ||
        offer.sku,

      size:
        asText(orderFields["Size"]) ||
        offer.size,

      brand: offer.brand,
      store_offer_price: storeOfferPrice,
      store_offer_vat_type: storeOfferVatType,

      consignor_counter_price: Number(offer.consignor_counter_price),
      consignor_vat_type: offer.vat_type,
      no_room_to_counter: !!noRoomToCounter,
      denied_amount: deniedAmount ?? null
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.details || data.error || "Failed to post store counter offer");
  }

  return data;
}

function getAcceptedStoreCustomOfferFromConsignmentCounter(offer) {
  const isMargin = asText(offer.vat_type) === "Margin";

  if (isMargin) {
    return {
      customOffer: Number(offer.consignor_counter_store_price),
      offerVatType: "Margin"
    };
  }

  return {
    customOffer: Number(offer.consignor_counter_store_price_excl_vat),
    offerVatType: "VAT0"
  };
}

function getConsignmentComparePrice(price, vatType) {
  const amount = Number(price || 0);

  return vatType === "VAT0"
    ? amount * 1.21
    : amount;
}

function getConsignmentSellerOfferPrice(calculatedOfferPrice, vatType) {
  const amount = Number(calculatedOfferPrice || 0);

  const rawOffer = vatType === "VAT0"
    ? amount / 1.21
    : amount;

  return roundDownToStep(rawOffer, 2.5);
}

function getConsignmentLowestDisplayPrice(comparePrice, vatType) {
  const amount = Number(comparePrice || 0);

  const rawDisplay = vatType === "VAT0"
    ? amount / 1.21
    : amount;

  return Math.round(rawDisplay);
}

function firstLookupValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function calculateConsignmentOfferPrice(
  maximumBuyingPrice,
  orderFields = {}
) {
  const max = Number(maximumBuyingPrice);

  if (!Number.isFinite(max) || max <= 0) {
    return null;
  }

  const method = asText(
    firstLookupValue(orderFields["Offer Method"])
  );

  const percentage = Number(
    firstLookupValue(orderFields["Offer Percentage"])
  );

  const margin = Number(
    firstLookupValue(orderFields["Offer Margin"])
  );

  let rawOffer;

  if (method === "Firm Range") {
    rawOffer = max - margin;
  } else {
    rawOffer = max * (1 - percentage) - 5;
  }

  return roundUpToStep(rawOffer, 2.5);
}

async function lookupProductFromRetailed(sku) {
  if (!RETAILED_STOCKX_SEARCH_URL || !RETAILED_API_KEY) {
    throw new Error("Missing Retailed API config");
  }

  const cleanSku = asText(sku).toUpperCase();

  const url = new URL(RETAILED_STOCKX_SEARCH_URL);
  url.searchParams.set("query", cleanSku);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": RETAILED_API_KEY
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Retailed request failed: ${response.status} ${text}`);
    }

    const results = await response.json();

    if (!Array.isArray(results) || !results.length) {
      throw new Error(`No Retailed result found for SKU ${cleanSku}`);
    }

    const exactMatch = results.find(
      (item) =>
        asText(item.sku).toUpperCase() === cleanSku
    );

    const match = exactMatch || results[0];
    const isExactSkuMatch = !!exactMatch;

    const productName = [
      asText(match.name),
      asText(match.colorway)
    ].filter(Boolean).join(" ");

    return {
      product_name: productName || cleanSku,
      brand: asText(match.brand),
      image: asText(match.image),
      slug: asText(match.slug),
      colorway: asText(match.colorway),
      is_exact_sku_match: isExactSkuMatch,
      raw: match
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupProductFromRetailedStrictSku(sku) {
  const cleanSku = normalizeSku(sku);

  const product = await lookupProductFromRetailed(cleanSku).catch(() => null);
  const rawSku = normalizeSku(product?.raw?.sku);

  if (!product || !rawSku || rawSku !== cleanSku) {
    return null;
  }

  return product;
}

async function createSkuMasterFromRetailedIfExactSku(sku) {
  const cleanSku = normalizeSku(sku);

  const existing = await airtable(SKU_MASTER_TABLE)
    .select({
      fields: ["SKU"],
      filterByFormula: `{SKU} = "${escapeFormulaValue(cleanSku)}"`,
      maxRecords: 1
    })
    .firstPage();

  if (existing[0]) return null;

  const product = await lookupProductFromRetailedStrictSku(cleanSku);

  if (!product) return null;

  const productName = product.product_name || cleanSku;
  
  const fields = {
    "SKU": cleanSku,
    "Product Name": productName || cleanSku,
    "Brand": product.brand || ""
  };
  
  if (product.image) {
    fields["Picture"] = [
      {
        url: product.image
      }
    ];
  }

  return await airtable(SKU_MASTER_TABLE).create(fields);
}

async function getStoredStockxAccessToken() {
  const records = await airtable(STOCKX_ACCESS_TOKEN_TABLE)
    .select({
      fields: ["Access Token", "Refreshed At"],
      maxRecords: 1
    })
    .firstPage();

  const record = records[0];

  if (!record) {
    throw new Error("No StockX Access Token record found in Airtable");
  }

  const accessToken = asText(record.fields?.["Access Token"]);

  if (!accessToken) {
    throw new Error("StockX Access Token field is empty in Airtable");
  }

  return accessToken;
}

async function refreshStockxAccessToken() {
  if (!STOCKX_CLIENT_ID || !STOCKX_CLIENT_SECRET || !STOCKX_REFRESH_TOKEN) {
    throw new Error("Missing StockX refresh token config");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: STOCKX_CLIENT_ID,
    client_secret: STOCKX_CLIENT_SECRET,
    audience: "gateway.stockx.com",
    refresh_token: STOCKX_REFRESH_TOKEN
  });

  const response = await fetch("https://accounts.stockx.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      `StockX token refresh failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const records = await airtable(STOCKX_ACCESS_TOKEN_TABLE)
    .select({
      fields: ["Access Token", "Refreshed At"],
      maxRecords: 1
    })
    .firstPage();

  const record = records[0];

  if (!record) {
    throw new Error("No StockX Access Token record found to update");
  }

  await airtable(STOCKX_ACCESS_TOKEN_TABLE).update(record.id, {
    "Access Token": data.access_token,
    "Refreshed At": new Date().toISOString()
  });

  return data.access_token;
}

function normalizeStockxCatalogResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.products)) return data.products;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

async function stockxCatalogSearchWithToken(sku, accessToken) {
  if (!STOCKX_API_KEY) {
    throw new Error("Missing STOCKX_API_KEY");
  }

  const cleanSku = normalizeSku(sku);

  const url = new URL("https://api.stockx.com/v2/catalog/search");
  url.searchParams.set("query", cleanSku);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-api-key": STOCKX_API_KEY,
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      `StockX catalog search failed: ${response.status} ${JSON.stringify(data)}`
    );

    err.status = response.status;
    throw err;
  }

  return data;
}

async function lookupProductFromStockx(sku) {
  const cleanSku = normalizeSku(sku);

  let accessToken = await getStoredStockxAccessToken();
  let data;

  try {
    data = await stockxCatalogSearchWithToken(cleanSku, accessToken);
  } catch (err) {
    if (![401, 403].includes(Number(err.status))) {
      throw err;
    }

    accessToken = await refreshStockxAccessToken();
    data = await stockxCatalogSearchWithToken(cleanSku, accessToken);
  }

  const results = normalizeStockxCatalogResults(data);

  const exactMatch = results.find((item) => {
    const stockxSku =
      normalizeSku(item.styleId) ||
      normalizeSku(item.style_id) ||
      normalizeSku(item.sku);

    return stockxSku === cleanSku;
  });

  if (!exactMatch) return null;

  const productName =
    asText(exactMatch.title) ||
    asText(exactMatch.name) ||
    asText(exactMatch.productName) ||
    cleanSku;

  const brand =
    asText(exactMatch.brand) ||
    asText(exactMatch.primaryCategory) ||
    "";

  const image =
    asText(exactMatch.image) ||
    asText(exactMatch.media?.imageUrl) ||
    asText(exactMatch.media?.smallImageUrl) ||
    asText(exactMatch.thumbnail) ||
    "";

  return {
    product_name: productName,
    brand,
    image,
    is_exact_sku_match: true,
    raw: exactMatch
  };
}

async function lookupSkuMasterProduct(sku) {
  const cleanSku = normalizeSku(sku);

  if (!cleanSku) {
    return {
      product_name: "",
      brand: ""
    };
  }

  const records = await airtable(SKU_MASTER_TABLE)
    .select({
      fields: ["SKU", "Product Name", "Brand"],
      filterByFormula: `{SKU} = '${escapeFormulaValue(cleanSku)}'`,
      maxRecords: 1
    })
    .all();

  const record = records[0];

  if (record) {
    return {
      product_name: displayValue(record.fields?.["Product Name"]),
      brand: displayValue(record.fields?.["Brand"])
    };
  }

  const stockxProduct = await lookupProductFromStockx(cleanSku).catch((err) => {
    console.error("StockX SKU lookup failed:", {
      sku: cleanSku,
      error: err.message
    });

    return null;
  });

  if (!stockxProduct || !stockxProduct.is_exact_sku_match) {
    return {
      product_name: cleanSku,
      brand: ""
    };
  }

  const productName = stockxProduct.product_name || cleanSku;

  await airtable(SKU_MASTER_TABLE).create({
    "SKU": cleanSku,
    "Product Name": productName || cleanSku,
    "Brand": stockxProduct.brand || "",
    "Picture": stockxProduct.image
      ? [{ url: stockxProduct.image }]
      : []
  });

  return {
    product_name: productName || cleanSku,
    brand: stockxProduct.brand || ""
  };
}

async function syncConsignmentStockLevelToAirtable(stockLevel) {
  const stockCounterKey = asText(stockLevel?.stock_counter_key);
  const sku = asText(stockLevel?.sku).toUpperCase();
  const size = asText(stockLevel?.size);
  const partnerStockLevel = Number(stockLevel?.stock_level || 0);

  if (!stockCounterKey || !sku || !size) {
    return;
  }

  const records = await airtable(STOCK_LEVELS_TABLE)
    .select({
      fields: ["Stock Counter Key", "SKU", "Size", "Partner Stock Level"],
      filterByFormula: `{Stock Counter Key} = '${escapeFormulaValue(stockCounterKey)}'`,
      maxRecords: 1
    })
    .all();

  const fields = {
    "SKU": sku,
    "Size": size,
    "Partner Stock Level": partnerStockLevel
  };

  if (records.length) {
    await airtable(STOCK_LEVELS_TABLE).update(records[0].id, fields);
    return;
  }

  await airtable(STOCK_LEVELS_TABLE).create(fields);
}

async function refreshConsignmentStockLevel(sku, size) {
  const cleanSku = asText(sku).toUpperCase();
  const cleanSize = asText(size).toUpperCase();
  const stockCounterKey = getStockCounterKey(cleanSku, cleanSize);

  const { data: rows, error: rowsError } = await supabase
    .from("consignment_inventory")
    .select("product_name, sku, size, brand, vat_type, quantity, selling_price_suggested")
    .eq("sku", cleanSku)
    .eq("size", cleanSize);

  if (rowsError) {
    throw rowsError;
  }

  const activeRows = (rows || []).filter((row) => Number(row.quantity || 0) > 0);

  const stockLevel = activeRows.reduce(
    (sum, row) => sum + Number(row.quantity || 0),
    0
  );

  const comparePrices = activeRows
    .map((row) =>
      getConsignmentComparePrice(
        row.selling_price_suggested,
        row.vat_type
      )
    )
    .filter((price) => Number.isFinite(price) && price > 0);
  
  const lowestComparePrice = comparePrices.length
    ? Math.min(...comparePrices)
    : null;
  
  const lowestSuggestedPrice = lowestComparePrice === null
    ? null
    : lowestComparePrice;

  const { data: existingStockLevel } = await supabase
    .from("consignment_stock_levels")
    .select("product_name, brand")
    .eq("stock_counter_key", stockCounterKey)
    .maybeSingle();
  
  const firstInfoRow =
    activeRows[0] ||
    rows?.find((row) => row.product_name || row.brand) ||
    rows?.[0] ||
    {};

  const { data, error } = await supabase
    .from("consignment_stock_levels")
    .upsert(
      {
        stock_counter_key: stockCounterKey,
        product_name:
          firstInfoRow.product_name ||
          existingStockLevel?.product_name ||
          "",
        sku: cleanSku,
        size: cleanSize,
        brand:
          firstInfoRow.brand ||
          existingStockLevel?.brand ||
          "",
        stock_level: stockLevel,
        lowest_suggested_price: lowestSuggestedPrice,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "stock_counter_key"
      }
    )
    .select()
    .single();

  if (error) {
    throw error;
  }
  
  await syncConsignmentStockLevelToAirtable(data);
  
  return data;
}

async function loadOrderFieldsMap(orderRecordIds) {
  const uniqueIds = [...new Set(orderRecordIds)].filter(Boolean);
  const orderMap = new Map();

  for (let i = 0; i < uniqueIds.length; i += 25) {
    const batch = uniqueIds.slice(i, i + 25);

    const formula = `OR(${batch
      .map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`)
      .join(",")})`;

    const records = await airtable(ORDERS_TABLE)
      .select({
        fields: [
          "Order ID",
          "Claimed Channel ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Current Lowest (Normalized)",
          "Current Lowest (VAT0)",
          "Partner or Seller",
          "Lowest Offer Seller ID",
          "WTB Created Channel ID",
          "Client",
          "Shopify Order Number",
          "Store Name",
          "Channel Created?",
          "Shipping Label URL (Permanent)",
          "Shipping Label",
          "Tracking URL"
        ],
        filterByFormula: formula
      })
      .all();

    records.forEach((record) => {
      orderMap.set(record.id, record.fields || {});
    });
  }

  return orderMap;
}

function normalizeDashboardOpenClaim(record) {
  const f = record.fields || {};
  const channelId = displayValue(f["Claimed Channel ID"]);

  return {
    id: record.id,

    order_id: displayValue(f["Order ID"]),
    product: displayValue(f["Product Name"]),
    sku: displayValue(f["SKU"]),
    size: displayValue(f["Size"]),
    brand: displayValue(f["Brand"]),

    payout: moneyValue(f["Claimed Seller Payout"]),
    vat_type: displayValue(f["Claimed Seller VAT Type"]),
    date: formatDateEU(f["Claimed At"]),
    raw_date: f["Claimed At"],

    discord_url: channelId
      ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
      : ""
  };
}

function getTimeToMax(startTime) {
  if (!startTime) return "";

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return "";

  const maxAt = start.getTime() + 12 * 60 * 60 * 1000;
  const remainingMs = maxAt - Date.now();

  if (remainingMs <= 0) return "Max payout reached";

  const hours = Math.floor(remainingMs / 1000 / 60 / 60);
  const minutes = Math.floor((remainingMs / 1000 / 60) % 60);

  if (hours <= 0) return `${minutes}m left`;

  return `${hours}h ${minutes}m left`;
}

function normalizeDeal(record) {
  const f = record.fields || {};

  return {
    id: record.id,
    source_type: "order",
    order_id: displayValue(f["Order ID"]),
    product: displayValue(f["Product Name"]),
    sku: displayValue(f["SKU"]),
    size: displayValue(f["Size"]),
    brand: displayValue(f["Brand"]),
    image_url: getImageUrl(f["Picture"]),

    auto_offer_accept: displayValue(f["Auto Offer Accept?"]),
    fulfillment_status: displayValue(f["Fulfillment Status"]),

    outsource_start_time: displayValue(f["Outsource Start Time"]),
    time_to_max: getTimeToMax(displayValue(f["Outsource Start Time"])),

    current_payout_margin: moneyValue(f["Outsource Buying Price"]),
    max_payout_margin: moneyValue(f["Final Outsource Buying Price"]),

    current_payout_vat0: moneyValue(f["Outsource Buying Price (VAT 0%)"]),
    max_payout_vat0: moneyValue(f["Final Outsource Buying Price (VAT 0%)"]),

    current_offer_margin: moneyValue(Math.floor(numberValue(f["Current Lowest (Normalized)"]))),
    current_offer_vat0: moneyValue(Math.floor(numberValue(f["Current Lowest (VAT0)"]))),
    maximum_buying_price: numberValue(f["Maximum Buying Price"])
  };
}

function normalizeMemberWtbDeal(record) {
  const f = record.fields || {};

  return {
    id: record.id,
    source_type: "member_wtb",

    order_id:
      displayValue(f["Member WTB ID"]) || record.id,

    product: displayValue(f["Product Name"]),
    sku: displayValue(f["SKU"]),
    size: displayValue(f["Size"]),
    brand: displayValue(f["Brand"]),
    image_url: getImageUrl(f["Picture"]),

    auto_offer_accept: "No",
    fulfillment_status: displayValue(f["Fulfillment Status"]),

    outsource_start_time: displayValue(f["Date"]),
    time_to_max: "",

    current_payout_margin: "",
    max_payout_margin: "",

    current_payout_vat0: "",
    max_payout_vat0: "",

    current_offer_margin: moneyValue(
      Math.floor(
        numberValue(f["Current Lowest Normalized"]) ||
        numberValue(f["Current Lowest Offer"]) ||
        numberValue(f["Lowest Offer"])
      )
    ),

    current_offer_vat0: moneyValue(
      Math.floor(
        numberValue(f["Lowest Offer VAT Type"]) === "VAT0"
          ? numberValue(f["Current Lowest Offer"])
          : 0
      )
    ),

    maximum_buying_price: numberValue(f["Max Price"]),
    raw_date: f["Date"] || f["Created At"] || ""
  };
}

app.get("/api/dashboard/wtb-counter-offers", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          {Status} = 'Open',
          {Source Type} = 'Seller Offer'
        )`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};

        return {
          id: record.id,
          order_id: displayValue(f["Order ID"]) || displayValue(f["Order"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          original_offer: moneyValue(f["Seller Original Price"]),
          counter_payout: moneyValue(f["Counter Payout"]),
          vat_type: displayValue(f["Counter Payout VAT Type"]),
          raw_date: displayValue(f["Created At"])
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load WTB counter offers:", err);

    res.status(500).json({
      error: "Failed to load WTB counter offers",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-accepted", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    const sellerCode = asText(req.query.seller_id);

    if (!sellerRecordId || !sellerCode) {
      return res.status(400).json({
        error: "Missing seller_record_id or seller_id"
      });
    }

    const offerRecords = await airtable(SELLER_OFFERS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Linked Orders",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Seller Offer",
          "Offer VAT Type",
          "Offer Date",
          "Fulfillment Status",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Fulfillment Status (MWTB)",
          "Product Name (MWTB)",
          "SKU (MWTB)",
          "Size (MWTB)",
          "Brand (MWTB)"
        ],
        filterByFormula: `OR(
          {Fulfillment Status} = 'Confirmed',
          {Fulfillment Status (MWTB)} = 'Confirmed'
        )`
      })
      .all();

    const filteredOffers = offerRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const linkedOrderIds = [
      ...new Set(
        filteredOffers
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const acceptedOffers = filteredOffers.filter((record) => {
      const f = record.fields || {};

      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      if (isMemberWtb) {
        return !!displayValue(f["WTB Created Channel ID (MWTB)"]);
      }
      
      const channelCreated = orderFields["Channel Created?"] === true;
      
      return (
        displayValue(orderFields["Partner or Seller"]) === "Seller" &&
        displayValue(orderFields["Lowest Offer Seller ID"]) === sellerCode &&
        !channelCreated
      );
    });

    const items = acceptedOffers.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;
      
      const orderFields = orderMap.get(linkedOrderId) || {};

      const offerAmount = numberValue(f["Seller Offer"]);

      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      return {
        id: record.id,
        order_record_id: linkedOrderId,
        member_wtb_record_id: linkedMemberWtbId,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: isMemberWtb
          ? displayValue(f["Product Name (MWTB)"] || f["Product Name"])
          : displayValue(f["Product Name"] || orderFields["Product Name"]),
        
        sku: isMemberWtb
          ? displayValue(f["SKU (MWTB)"] || f["SKU"])
          : displayValue(f["SKU"] || orderFields["SKU"]),
        
        size: isMemberWtb
          ? displayValue(f["Size (MWTB)"] || f["Size"])
          : displayValue(f["Size"] || orderFields["Size"]),
        
        brand: isMemberWtb
          ? displayValue(f["Brand (MWTB)"] || f["Brand"])
          : displayValue(f["Brand"] || orderFields["Brand"]),
        offer: moneyWholeValue(offerAmount),
        vat_type: displayValue(f["Offer VAT Type"]),
        date: formatDateEU(f["Offer Date"]),
        raw_date: f["Offer Date"],
        status: "Offer accepted, waiting processing..",
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB accepted:", err);

    res.status(500).json({
      error: "Failed to load accepted offers",
      details: err.message
    });
  }
});

app.post("/api/dashboard/wtb-counter-offers/:id/deny", async (req, res) => {
  try {
    const counterOfferId = asText(req.params.id);
    const sellerRecordId = asText(req.body?.seller_record_id);

    const record = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferId);
    const f = record.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (displayValue(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "Counter offer is no longer open" });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    const channelId = displayValue(f["Discord Channel ID"]);
    const messageId = displayValue(f["Discord Message ID"]);

    if (channelId && messageId) {
      await disableCounterOfferDiscordButtons(
        channelId,
        messageId,
        "❌ Counter offer denied."
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to deny counter offer:", err);

    res.status(500).json({
      error: "Failed to deny counter offer",
      details: err.message
    });
  }
});

app.post("/api/dashboard/wtb-counter-offers/:id/accept", async (req, res) => {
  try {
    const counterOfferId = asText(req.params.id);
    const sellerRecordId = asText(req.body?.seller_record_id);

    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferId);
    const f = counterOffer.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (displayValue(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "Counter offer is no longer open" });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);

    if (!linkedOrderId) {
      return res.status(400).json({ error: "Counter offer missing linked order" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderStatus = displayValue(orderRecord.fields?.["Fulfillment Status"]);

    if (orderStatus !== "Outsource") {
      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferId, {
        "Status": "Closed",
        "Closed At": new Date().toISOString()
      });

      return res.status(409).json({
        error: "This order is already no longer available"
      });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferId, {
      "Status": "Accepted",
      "Accepted At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    if (!COUNTER_OFFER_ACCEPT_WEBHOOK_URL) {
      throw new Error("Missing COUNTER_OFFER_ACCEPT_WEBHOOK_URL");
    }

    await fetch(COUNTER_OFFER_ACCEPT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        trigger_type: "counter-offer-accepted",

        counter_offer_record_id: counterOfferId,
        order_record_id: linkedOrderId,

        seller_record_id: firstLinkedRecordId(f["Seller ID"]),
        seller_offer_record_id: displayValue(f["Seller Offer Record ID"]),

        source_type: displayValue(f["Source Type"]),

        store_counter_price: numberValue(f["Store Counter Price"]),
        store_counter_price_excl_vat: numberValue(f["Store Counter Price Excl VAT"]),

        counter_payout: numberValue(f["Counter Payout"]),
        counter_payout_vat_type: displayValue(f["Counter Payout VAT Type"]),

        seller_original_price: numberValue(f["Seller Original Price"]),
        seller_original_vat_type: displayValue(f["Seller Original VAT Type"]),

        accepted_at_iso: new Date().toISOString()
      })
    });

    const channelId = displayValue(f["Discord Channel ID"]);
    const messageId = displayValue(f["Discord Message ID"]);

    if (channelId && messageId) {
      await disableCounterOfferDiscordButtons(
        channelId,
        messageId,
        "✅ Counter offer accepted."
      ).catch(() => {});
    }

    const competingCounters = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          {Status} = 'Open',
          {Source Type} = 'Seller Offer'
        )`
      })
      .all();

    for (const competing of competingCounters) {
      if (competing.id === counterOfferId) continue;

      const cf = competing.fields || {};

      if (!linkedRecordIncludes(cf["Order"], linkedOrderId)) continue;

      await airtable(COUNTER_OFFERS_TABLE).update(competing.id, {
        "Status": "Closed",
        "Closed At": new Date().toISOString()
      });

      const competingChannelId = displayValue(cf["Discord Channel ID"]);
      const competingMessageId = displayValue(cf["Discord Message ID"]);

      if (competingChannelId && competingMessageId) {
        await disableCounterOfferDiscordButtons(
          competingChannelId,
          competingMessageId,
          "❌ Counter offer closed — another seller accepted."
        ).catch(() => {});
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to accept counter offer:", err);

    res.status(500).json({
      error: "Failed to accept counter offer",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-confirmed", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Fulfillment Status (MWTB)",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Payment Status (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Allocated',
            {Fulfillment Status (MWTB)} = 'Allocated'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};
      const isMemberWtb = !linkedRecordIsEmpty(f["Member WTBs"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const isMemberWtb = !linkedOrderId && !linkedRecordIsEmpty(f["Member WTBs"]);
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      return {
        id: record.id,
        member_wtb_record_id: isMemberWtb
          ? firstLinkedRecordId(f["Member WTBs"])
          : "",
        payment_status: isMemberWtb
          ? displayValue(f["Payment Status (MWTB)"])
          : "Paid",
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        order_record_id: linkedOrderId,
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        payment_status: isMemberWtb
          ? displayValue(f["Payment Status (MWTB)"])
          : "Paid",
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const offerRecords = await airtable(SELLER_OFFERS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Linked Orders",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Seller Offer",
          "Offer VAT Type",
          "Offer Date",
          "Fulfillment Status",
          "Product Name",
          "SKU",
          "Size",
          "Brand"
        ],
        filterByFormula: `{Fulfillment Status} = 'Confirmed'`
      })
      .all();
    
    const filteredOffers = offerRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );
    
    const offerLinkedOrderIds = [
      ...new Set(
        filteredOffers
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];
    
    const offerOrderMap = await loadOrderFieldsMap(offerLinkedOrderIds);
    
    const channelCreatedOffers = filteredOffers
      .filter((record) => {
        const f = record.fields || {};
    
        const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
        const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
    
        if (linkedMemberWtbId) {
          return false;
        }
        
        const orderFields = offerOrderMap.get(linkedOrderId) || {};
        return orderFields["Channel Created?"] === true;
      })
      .map((record) => {
        const f = record.fields || {};
    
        const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
        const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
        const isMemberWtb = !!linkedMemberWtbId;
    
        const orderFields = offerOrderMap.get(linkedOrderId) || {};
    
        const channelId = isMemberWtb
          ? displayValue(f["WTB Created Channel ID (MWTB)"])
          : displayValue(orderFields["WTB Created Channel ID"]);
    
        return {
          id: record.id,
          order_id: isMemberWtb
            ? displayValue(f["Member WTB ID"])
            : displayValue(orderFields["Order ID"]),
          order_record_id: linkedOrderId,
          product: displayValue(f["Product Name"] || orderFields["Product Name"]),
          sku: displayValue(f["SKU"] || orderFields["SKU"]),
          size: displayValue(f["Size"] || orderFields["Size"]),
          brand: displayValue(f["Brand"] || orderFields["Brand"]),
          payout: moneyWholeValue(f["Seller Offer"]),
          vat_type: displayValue(f["Offer VAT Type"]),
          date: formatDateEU(f["Offer Date"]),
          raw_date: f["Offer Date"],
          discord_url: channelId
            ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
            : ""
        };
      });
    
    const sortedItems = sortDashboardItemsNewestFirst([
      ...items,
      ...channelCreatedOffers
    ]);
    
    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB confirmed:", err);

    res.status(500).json({
      error: "Failed to load confirmed WTB sales",
      details: err.message
    });
  }
});

app.post("/api/dashboard/request-label", async (req, res) => {
  try {
    const orderRecordId = asText(req.body?.order_record_id);

    if (!orderRecordId) {
      return res.status(400).json({
        error: "Missing order_record_id"
      });
    }

    if (!DISCORD_BOT_BASE_URL) {
      return res.status(500).json({
        error: "Missing DISCORD_BOT_BASE_URL"
      });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(orderRecordId);
    const f = orderRecord.fields || {};

    const orderId = displayValue(f["Order ID"]) || orderRecord.id;
    const clientId = Array.isArray(f["Client"]) ? f["Client"][0] : "";

    if (!clientId) {
      return res.status(400).json({
        error: `Order ${orderId} has no linked merchant/client`
      });
    }

    const merchantRecord = await airtable(MERCHANTS_TABLE).find(clientId);
    const mf = merchantRecord.fields || {};

    const labelRequestChannelId =
      displayValue(mf["Label Request Channel ID"]) || "1506989427183058996";

    const labelRequestUrl =
      `${LOJIQ_WMS_BASE_URL.replace(/\/$/, "")}/label-request.html?record_id=${encodeURIComponent(orderRecord.id)}`;


    const response = await fetch(
      `${DISCORD_BOT_BASE_URL.replace(/\/$/, "")}/post-label-request`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          channel_id: labelRequestChannelId,
          record_id: orderRecord.id,
          order_id: orderId,
          shopify_order_number: displayValue(f["Shopify Order Number"]),
          product_name: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          store_name: displayValue(f["Store Name"]) || displayValue(mf["Store Name"]),
          label_request_url: labelRequestUrl,
          seller_country_code: "",
          preferred_courier: "",
          courier_instruction: ""
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to post label request");
    }

    await airtable(ORDERS_TABLE).update(orderRecord.id, {
      "Fulfillment Status": "Requested Label",
      "Label Error Message": null
    });

    res.json({
      ok: true,
      order_id: orderId
    });
  } catch (err) {
    console.error("Dashboard request label failed:", err);

    res.status(500).json({
      error: "Failed to request label",
      details: err.message
    });
  }
});

app.post("/api/dashboard/member-wtb-request-label", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({
        error: "Missing member_wtb_record_id"
      });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const currentStatus = asText(memberWtb.fields?.["Fulfillment Status"]);

    if (currentStatus === "Requested Label") {
      return res.json({
        ok: true,
        already_requested: true
      });
    }

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Fulfillment Status": "Requested Label",
      "Label Requested At": new Date().toISOString()
    });

    await sendMemberWtbLabelRequestToBuyer(memberWtbRecordId);

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("Failed to request Member WTB label:", err);

    res.status(500).json({
      error: "Failed to request Member WTB label",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-label-requested", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Fulfillment Status (MWTB)",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Shipping Label URL (Permanent) (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Requested Label',
            {Fulfillment Status (MWTB)} = 'Requested Label'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};
      const isMemberWtb = !linkedRecordIsEmpty(f["Member WTBs"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const isMemberWtb = !linkedOrderId && !linkedRecordIsEmpty(f["Member WTBs"]);
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      return {
        id: record.id,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB label requested:", err);

    res.status(500).json({
      error: "Failed to load label requested WTB sales",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-ready-to-ship", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Fulfillment Status (MWTB)",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Shipping Label URL (Permanent) (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Ready to Ship',
            {Fulfillment Status (MWTB)} = 'Ready to Ship'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};
      const isMemberWtb = !linkedRecordIsEmpty(f["Member WTBs"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const isMemberWtb = !linkedOrderId && !linkedRecordIsEmpty(f["Member WTBs"]);
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      const permanentLabelUrl = isMemberWtb
        ? displayValue(f["Shipping Label URL (Permanent) (MWTB)"])
        : displayValue(orderFields["Shipping Label URL (Permanent)"]);
      
      const shippingLabelAttachment = isMemberWtb
        ? ""
        : firstAttachmentUrl(orderFields["Shipping Label"]);
      
      const labelUrl =
        permanentLabelUrl || shippingLabelAttachment || "";

      return {
        id: record.id,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        label_url: labelUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB ready to ship:", err);

    res.status(500).json({
      error: "Failed to load ready to ship WTB sales",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-shipped", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Fulfillment Status (MWTB)",
          "Shipping Status",
          "Shipping Status (MWTB)",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Tracking URL (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Shipping Status} = 'Shipped',
            {Shipping Status (MWTB)} = 'Shipped'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};
      const isMemberWtb = !linkedRecordIsEmpty(f["Member WTBs"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const isMemberWtb = !linkedOrderId && !linkedRecordIsEmpty(f["Member WTBs"]);
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      const trackingUrl = isMemberWtb
        ? displayValue(f["Tracking URL (MWTB)"])
        : displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        tracking_url: trackingUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB shipped:", err);

    res.status(500).json({
      error: "Failed to load shipped WTB sales",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-delivered", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Shipping Status",
          "Shipping Status (MWTB)",
          "Payment Status",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Tracking URL (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Shipping Status} = 'Delivered',
            {Shipping Status (MWTB)} = 'Delivered'
          ),
          {Payment Status} = 'To Pay'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};
      const isMemberWtb = !linkedRecordIsEmpty(f["Member WTBs"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const isMemberWtb = !linkedOrderId && !linkedRecordIsEmpty(f["Member WTBs"]);
      
      const orderFields = orderMap.get(linkedOrderId) || {};
      
      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);
      
      const trackingUrl = isMemberWtb
        ? displayValue(f["Tracking URL (MWTB)"])
        : displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        tracking_url: trackingUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB delivered:", err);

    res.status(500).json({
      error: "Failed to load delivered WTB sales",
      details: err.message
    });
  }
});

app.get("/api/dashboard/wtb-open-offers", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const offerRecords = await airtable(SELLER_OFFERS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Linked Orders",
          "Member WTBs",
          "Member WTB ID",
          "Current Lowest Source Price (MWTB)",
          "Current Lowest Offer (MWTB)",
          "Lowest Offer Seller ID (MWTB)",
          "Seller Offer",
          "Offer VAT Type",
          "Offer Date",
          "Fulfillment Status",
          "Fulfillment Status (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Product Name (MWTB)",
          "SKU (MWTB)",
          "Size (MWTB)",
          "Brand (MWTB)"
        ],
        filterByFormula: `OR(
          {Fulfillment Status} = 'Outsource',
          {Fulfillment Status (MWTB)} = 'Outsource'
        )`
      })
      .all();

    const filteredOffers = offerRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const linkedOrderIds = [
      ...new Set(
        filteredOffers
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredOffers.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;
      
      const orderFields = orderMap.get(linkedOrderId) || {};

      const vatType = displayValue(f["Offer VAT Type"]);
      const offerAmount = numberValue(f["Seller Offer"]);

      const currentLowest = isMemberWtb
        ? (
            numberValue(f["Current Lowest Offer (MWTB)"]) ||
            numberValue(f["Current Lowest Source Price (MWTB)"])
          )
        : vatType === "VAT0"
          ? numberValue(orderFields["Current Lowest (VAT0)"])
          : numberValue(orderFields["Current Lowest (Normalized)"]);

      const isLowest = isMemberWtb
        ? Number.isFinite(offerAmount) &&
          Number.isFinite(currentLowest) &&
          Math.abs(offerAmount - currentLowest) < 0.01
        : displayValue(orderFields["Lowest Offer Seller ID"]) === displayValue(req.query.seller_id);

      return {
        id: record.id,
        order_record_id: linkedOrderId,
        member_wtb_record_id: linkedMemberWtbId,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        product: isMemberWtb
          ? displayValue(f["Product Name (MWTB)"] || f["Product Name"])
          : displayValue(f["Product Name"] || orderFields["Product Name"]),
        
        sku: isMemberWtb
          ? displayValue(f["SKU (MWTB)"] || f["SKU"])
          : displayValue(f["SKU"] || orderFields["SKU"]),
        
        size: isMemberWtb
          ? displayValue(f["Size (MWTB)"] || f["Size"])
          : displayValue(f["Size"] || orderFields["Size"]),
        
        brand: isMemberWtb
          ? displayValue(f["Brand (MWTB)"] || f["Brand"])
          : displayValue(f["Brand"] || orderFields["Brand"]),
        offer: moneyWholeValue(offerAmount),
        offer_raw: offerAmount,
        vat_type: vatType,
        current_lowest: moneyWholeValue(currentLowest),
        status: isLowest ? "Lowest" : "Beaten",
        date: formatDateEU(f["Offer Date"]),
        raw_date: f["Offer Date"]
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load WTB open offers:", err);

    res.status(500).json({
      error: "Failed to load open offers",
      details: err.message
    });
  }
});

app.post("/api/member-wtb/place-offer", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const offerAmount = Number(req.body?.offer_amount);
    const vatType = asText(req.body?.vat_type);

    if (!memberWtbRecordId || !sellerRecordId) {
      return res.status(400).json({
        error: "Missing member_wtb_record_id or seller_record_id"
      });
    }

    if (!Number.isInteger(offerAmount) || offerAmount <= 0) {
      return res.status(400).json({
        error: "Invalid offer amount"
      });
    }

    if (!["Margin", "VAT21", "VAT0"].includes(vatType)) {
      return res.status(400).json({
        error: "Invalid VAT type"
      });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const f = memberWtb.fields || {};

    if (["Confirmed", "Allocated", "Fulfilled", "Cancelled"].includes(asText(f["Fulfillment Status"]))) {
      return res.status(409).json({
        error: "This Want To Buy is no longer open for offers"
      });
    }

    const normalizedOffer =
      vatType === "VAT0"
        ? offerAmount * 1.21
        : offerAmount;

    const createdOffer = await airtable(SELLER_OFFERS_TABLE).create({
      "Seller ID": [sellerRecordId],
      "Member WTBs": [memberWtbRecordId],
      "Seller Offer": offerAmount,
      "Offer VAT Type": vatType,
      "Offer Cost (Normalized)": normalizedOffer,
      "Offer Date": new Date().toISOString()
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Current Lowest Offer": offerAmount,
      "Current Lowest Normalized": normalizedOffer,
      "Current Lowest Seller Offer": [createdOffer.id],
      "Lowest Offer": offerAmount,
      "Lowest Offer Normalized": normalizedOffer,
      "Lowest Offer VAT Type": vatType,
      "Lowest Offer Seller ID": [sellerRecordId],
      "New Offer Available": false,
      "Offer Sent?": true
    });

    return res.json({
      ok: true,
      offer_id: createdOffer.id,
      member_wtb_record_id: memberWtbRecordId
    });
  } catch (err) {
    console.error("Failed to place Member WTB offer:", err);

    return res.status(500).json({
      error: "Failed to place Member WTB offer",
      details: err.message
    });
  }
});

app.post("/api/dashboard/wtb-open-offers/:offerId/edit", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const offerAmount = Number(req.body?.offer_amount);
    const vatType = asText(req.body?.vat_type);

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    if (!Number.isFinite(offerAmount) || offerAmount <= 0) {
      return res.status(400).json({ error: "Invalid offer amount" });
    }

    if (!["Margin", "VAT0", "VAT21"].includes(vatType)) {
      return res.status(400).json({ error: "Invalid VAT type" });
    }

    const offerRecord = await airtable(SELLER_OFFERS_TABLE).find(offerId);
    const f = offerRecord.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
    const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);

    const normalizedOffer =
      vatType === "VAT0"
        ? offerAmount * 1.21
        : offerAmount;

    await airtable(SELLER_OFFERS_TABLE).update(offerId, {
      "Seller Offer": offerAmount,
      "Offer VAT Type": vatType,
      "Offer Cost (Normalized)": normalizedOffer,
      "Offer Date": new Date().toISOString()
    });

    if (linkedMemberWtbId) {
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(linkedMemberWtbId);
      const mf = memberWtb.fields || {};

      if (["Confirmed", "Allocated", "Fulfilled", "Cancelled"].includes(asText(mf["Fulfillment Status"]))) {
        return res.status(409).json({ error: "This WTB is no longer open for offers" });
      }

      await airtable(MEMBER_WTBS_TABLE).update(linkedMemberWtbId, {
        "Current Lowest Offer": offerAmount,
        "Current Lowest Normalized": normalizedOffer,
        "Current Lowest Seller Offer": [offerId],
        "Lowest Offer": offerAmount,
        "Lowest Offer Normalized": normalizedOffer,
        "Lowest Offer VAT Type": vatType,
        "Lowest Offer Seller ID": [sellerRecordId],
        "New Offer Available": false,
        "Offer Sent?": true
      });

      await fetch(`${APP_PUBLIC_BASE_URL}/api/member-wtb/send-current-offer-to-buyer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET
        },
        body: JSON.stringify({
          member_wtb_record_id: linkedMemberWtbId
        })
      }).catch((err) => {
        console.error("Failed to send edited Member WTB offer to buyer:", err);
      });
    }

    return res.json({
      ok: true,
      offer_id: offerId,
      member_wtb_record_id: linkedMemberWtbId,
      order_record_id: linkedOrderId
    });
  } catch (err) {
    console.error("Failed to edit open WTB offer:", err);

    res.status(500).json({
      error: "Failed to edit offer",
      details: err.message
    });
  }
});

app.delete("/api/dashboard/wtb-open-offers/:offerId", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({
        error: "Missing offerId or seller_record_id"
      });
    }

    const offerRecord = await airtable(SELLER_OFFERS_TABLE).find(offerId);
    const f = offerRecord.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({
        error: "Not allowed"
      });
    }

    await airtable(SELLER_OFFERS_TABLE).destroy(offerId);

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete open offer:", err);

    res.status(500).json({
      error: "Failed to delete offer",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-confirmed", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Seller Offer",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Allocated'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        linkedRecordIsEmpty(f["Seller Offer"])
      );
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        order_record_id: linkedOrderId,
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick confirmed:", err);

    res.status(500).json({
      error: "Failed to load confirmed quick deals",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-label-requested", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Seller Offer",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Requested Label'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        linkedRecordIsEmpty(f["Seller Offer"])
      );
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick label requested:", err);

    res.status(500).json({
      error: "Failed to load label requested quick deals",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-ready-to-ship", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Seller Offer",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Ready to Ship'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        linkedRecordIsEmpty(f["Seller Offer"])
      );
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);
      const permanentLabelUrl =
        displayValue(orderFields["Shipping Label URL (Permanent)"]);
      
      const shippingLabelAttachment =
        firstAttachmentUrl(orderFields["Shipping Label"]);
      
      const labelUrl =
        permanentLabelUrl || shippingLabelAttachment || "";

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        label_url: labelUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick ready to ship:", err);

    res.status(500).json({
      error: "Failed to load ready to ship quick deals",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-shipped", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Shipping Status",
          "Seller Offer",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Shipping Status} = 'Shipped'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        linkedRecordIsEmpty(f["Seller Offer"])
      );
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);
      const trackingUrl = displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        tracking_url: trackingUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick shipped:", err);

    res.status(500).json({
      error: "Failed to load shipped quick deals",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-delivered", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Shipping Status",
          "Payment Status",
          "Seller Offer",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          AND(
            {Shipping Status} = 'Delivered',
            {Payment Status} = 'To Pay'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        linkedRecordIsEmpty(f["Seller Offer"])
      );
    });

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);
      const trackingUrl = displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : "",
        tracking_url: trackingUrl
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick delivered:", err);

    res.status(500).json({
      error: "Failed to load delivered quick deals",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-open-wtbs", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Max Price",
          "Current Lowest Source Price",
          "Current Lowest Offer",
          "Fulfillment Status",
          "Purchase Status",
          "Payment Status",
          "Buying Inventory Filter",
          "Date"
        ],
        filterByFormula: `OR(
          {Fulfillment Status} = 'Pending',
          {Fulfillment Status} = 'Outsource'
        )`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};

        const currentLowest = numberValue(f["Current Lowest Offer"]);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          max_price: moneyWholeValue(f["Max Price"]),
          current_lowest: currentLowest
            ? moneyWholeValue(currentLowest)
            : "-",
          status: "Open",
          inventory_filter: displayValue(f["Buying Inventory Filter"]),
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying open WTBs:", err);

    res.status(500).json({
      error: "Failed to load buying open WTBs",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-offers", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Max Price",
          "Current Lowest Offer",
          "Purchase Status",
          "Fulfillment Status",
          "Date"
        ],
        filterByFormula: `AND(
          OR(
            {Fulfillment Status} = 'Pending',
            {Fulfillment Status} = 'Outsource'
          ),
          {Current Lowest Offer} > 0
        )`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const offerAmount = numberValue(f["Current Lowest Offer"]);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          max_price: moneyWholeValue(f["Max Price"]),
          offer: Number.isFinite(offerAmount) && offerAmount > 0
            ? moneyWholeValue(offerAmount)
            : "-",
          status: "Offer Received",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying offers:", err);

    res.status(500).json({
      error: "Failed to load buying offers",
      details: err.message
    });
  }
});

function getBuyingPaymentUiFields(fields = {}) {
  const paymentStatus = displayValue(
    fields["Payment Status"]
  );

  const paymentLink = displayValue(
    fields["Payment Link"]
  );

  const canPay =
    paymentStatus === "Awaiting Payment" &&
    Boolean(paymentLink);

  const waitingForMollie =
    paymentStatus === "Pending Payment";

  return {
    payment_status: paymentStatus,
    payment_link: paymentLink,
    can_pay: canPay,
    waiting_for_mollie: waitingForMollie
  };
}

app.get("/api/dashboard/buying-accepted", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Max Price",
          "Current Lowest Offer",
          "Purchase Status",
          "Fulfillment Status",
          "Date"
        ],
        filterByFormula: `{Fulfillment Status} = 'Confirmed'`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          offer: moneyWholeValue(f["Current Lowest Offer"]),
          status: "Waiting for seller",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying accepted:", err);
    res.status(500).json({
      error: "Failed to load buying accepted",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-payment-required", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Fulfillment Status",
          "Date"
        ],
        filterByFormula: `OR(
          {Payment Status} = 'Awaiting Payment',
          {Payment Status} = 'Pending Payment'
        )`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
          amount_raw: amount,
          
          ...getBuyingPaymentUiFields(f),
          
          status:
            displayValue(f["Payment Status"]) ===
            "Pending Payment"
              ? "Waiting for Mollie"
              : "Payment Required",
          
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying payment required:", err);
    res.status(500).json({
      error: "Failed to load buying payment required",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-confirmed", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Fulfillment Status",
          "Date"
        ],
        filterByFormula: `AND(
          {Fulfillment Status} = 'Allocated',
          OR(
            {Payment Status} = 'Paid',
            {Payment Status} = 'Awaiting Payment',
            {Payment Status} = 'Pending Payment',
            {Payment Status} = 'Trusted'
          )
        )`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
          ...getBuyingPaymentUiFields(f),

          status: "Confirmed",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying confirmed:", err);
    res.status(500).json({
      error: "Failed to load buying confirmed",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-label-requested", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Fulfillment Status",
          "Date"
        ],
        filterByFormula: `{Fulfillment Status} = 'Requested Label'`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
          ...getBuyingPaymentUiFields(f),

          status: "Waiting for Label",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"],
          label_url: `https://kickzcaviar.com/member-wtb-label-request.html?member_wtb_id=${record.id}`
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying label requested:", err);
    res.status(500).json({
      error: "Failed to load buying label requested",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-ready-to-ship", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Fulfillment Status",
          "Shipping Label Permanent URL",
          "Tracking Number",
          "Date"
        ],
        filterByFormula: `{Fulfillment Status} = 'Ready to Ship'`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
          ...getBuyingPaymentUiFields(f),
          status: "Ready to Ship",
          tracking_number: displayValue(f["Tracking Number"]),
          label_url: displayValue(f["Shipping Label Permanent URL"]),
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying ready to ship:", err);
    res.status(500).json({
      error: "Failed to load buying ready to ship",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-shipped", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Shipping Status",
          "Tracking Number",
          "Tracking URL",
          "Date"
        ],
        filterByFormula: `{Shipping Status} = 'Shipped'`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
          ...getBuyingPaymentUiFields(f),
          tracking_number: displayValue(f["Tracking Number"]),
          tracking_url: displayValue(f["Tracking URL"]),
          status: "Shipped",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying shipped:", err);
    res.status(500).json({
      error: "Failed to load buying shipped",
      details: err.message
    });
  }
});

app.get("/api/dashboard/buying-delivered", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const records = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Invoice Price",
          "Final Buying Price",
          "Max Price",
          "Payment Status",
          "Payment Link",
          "Shipping Status",
          "Tracking Number",
          "Tracking URL",
          "Date"
        ],
        filterByFormula: `{Shipping Status} = 'Delivered'`
      })
      .all();

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const amount =
          Number(f["Invoice Price"] || 0) ||
          Number(f["Final Buying Price"] || 0) ||
          Number(f["Max Price"] || 0);

        const paymentStatus = displayValue(
          f["Payment Status"]
        );
        
        const paymentLink = displayValue(
          f["Payment Link"]
        );
        
        const requiresPayment = [
          "Awaiting Payment",
          "Expired",
          "Cancelled",
          "Failed"
        ].includes(paymentStatus);
        
        const waitingForMollie =
          paymentStatus === "Pending Payment";

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          amount: moneyValue(amount),
        
          payment_status: paymentStatus,
          payment_link: paymentLink,
          requires_payment: requiresPayment,
          waiting_for_mollie: waitingForMollie,
        
          tracking_number: displayValue(
            f["Tracking Number"]
          ),
          tracking_url: displayValue(
            f["Tracking URL"]
          ),
        
          status: waitingForMollie
            ? "Waiting for Mollie"
            : requiresPayment && paymentLink
              ? "Payment Required"
              : "Delivered",
        
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      });

    res.json({
      count: items.length,
      payment_warning_count: items.filter((item) => item.requires_payment).length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load buying delivered:", err);
    res.status(500).json({
      error: "Failed to load buying delivered",
      details: err.message
    });
  }
});

app.post("/api/dashboard/buying/deny-offer", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id" });
    }

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Offer Sent?": false
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to deny buying offer:", err);
    res.status(500).json({
      error: "Failed to deny buying offer",
      details: err.message
    });
  }
});

app.post("/api/dashboard/buying/accept-offer", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id" });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const f = memberWtb.fields || {};

    const sellerOfferRecordId = firstLinkedRecordId(f["Current Lowest Seller Offer"]);

    if (!sellerOfferRecordId) {
      return res.status(400).json({
        error: "Missing Current Lowest Seller Offer linked seller offer"
      });
    }

    const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

    if (!wtbBotBaseUrl) {
      return res.status(500).json({
        error: "KICKZ_WTB_BOT_BASE_URL is missing"
      });
    }

    const response = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.KC_PORTAL_SECRET
      },
      body: JSON.stringify({
        member_wtb_record_id: memberWtbRecordId,
        seller_offer_record_id: sellerOfferRecordId
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error || "Failed to accept offer",
        details: data.details || ""
      });
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Failed to accept buying offer:", err);
    res.status(500).json({
      error: "Failed to accept buying offer",
      details: err.message
    });
  }
});

app.get("/api/dashboard/history-completed", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    const sellerCode = asText(req.query.seller_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Shipping Status",
          "Payment Status",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date",
          "Issue Notes",
          "Issue Status"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Payment Status} = 'Paid',
          {Seller ID (Lookup)} = '${escapeFormulaValue(sellerCode)}'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords;

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
      const channelId = displayValue(orderFields["Claimed Channel ID"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load quick completed:", err);

    res.status(500).json({
      error: "Failed to load completed history",
      details: err.message
    });
  }
});

app.get("/api/dashboard/history-issues", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Payment Status",
          "Issue Notes",
          "Issue Status",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Final Purchase Price",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Payment Status} = 'Paid',
          {Issue Status} = 'Troubled'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const orderFields = orderMap.get(linkedOrderId) || {};

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyValue(f["Final Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        issue_notes: displayValue(f["Issue Notes"]),
        issue_status: displayValue(f["Issue Status"])
      };
    });

    const sortedItems = sortDashboardItemsNewestFirst(items);

    res.json({
      count: sortedItems.length,
      items: sortedItems
    });
  } catch (err) {
    console.error("Failed to load history issues:", err);

    res.status(500).json({
      error: "Failed to load history issues",
      details: err.message
    });
  }
});

app.post("/api/dashboard/history/:inventoryId/issue", async (req, res) => {
  try {
    const inventoryId = asText(req.params.inventoryId);
    const sellerRecordId = asText(req.body.seller_record_id);
    const issueNotes = asText(req.body.issue_notes);

    if (!inventoryId || !sellerRecordId || !issueNotes) {
      return res.status(400).json({
        error: "Missing inventoryId, seller_record_id or issue_notes"
      });
    }

    const record = await airtable(INVENTORY_UNITS_TABLE).find(inventoryId);

    if (!linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await airtable(INVENTORY_UNITS_TABLE).update(inventoryId, {
      "Issue Notes": issueNotes,
      "Issue Status": "Troubled"
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to report issue:", err);

    res.status(500).json({
      error: "Failed to report issue",
      details: err.message
    });
  }
});

app.post("/api/dashboard/history/:inventoryId/solve-issue", async (req, res) => {
  try {
    const inventoryId = asText(req.params.inventoryId);
    const sellerRecordId = asText(req.body.seller_record_id);

    if (!inventoryId || !sellerRecordId) {
      return res.status(400).json({
        error: "Missing inventoryId or seller_record_id"
      });
    }

    const record = await airtable(INVENTORY_UNITS_TABLE).find(inventoryId);

    if (!linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await airtable(INVENTORY_UNITS_TABLE).update(inventoryId, {
      "Issue Status": "Solved"
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to solve issue:", err);

    res.status(500).json({
      error: "Failed to solve issue",
      details: err.message
    });
  }
});

app.get("/api/dashboard/quick-counts", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    async function loadInventoryCount(formula) {
      const records = await airtable(INVENTORY_UNITS_TABLE)
        .select({
          fields: [
            "Seller ID",
            "Seller Offer"
          ],
          filterByFormula: formula
        })
        .all();

      return records.filter((record) => {
        const f = record.fields || {};

        return (
          linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
          linkedRecordIsEmpty(f["Seller Offer"])
        );
      }).length;
    }

    const [
      openClaimsRecords,

      confirmedCount,
      labelRequestedCount,
      readyToShipCount,
      shippedCount,
      deliveredCount
    ] = await Promise.all([
      airtable(ORDERS_TABLE)
        .select({
          fields: [
            "Claimed Seller ID"
          ],
          filterByFormula: `{Fulfillment Status} = 'Claim Processing'`
        })
        .all(),

      loadInventoryCount(`AND(
        LEFT({Item ID} & '', 4) = 'OUT-',
        {Type} = 'Custom',
        {Fulfillment Status (UOL)} = 'Allocated'
      )`),

      loadInventoryCount(`AND(
        LEFT({Item ID} & '', 4) = 'OUT-',
        {Type} = 'Custom',
        {Fulfillment Status (UOL)} = 'Requested Label'
      )`),

      loadInventoryCount(`AND(
        LEFT({Item ID} & '', 4) = 'OUT-',
        {Type} = 'Custom',
        {Fulfillment Status (UOL)} = 'Ready to Ship'
      )`),

      loadInventoryCount(`AND(
        LEFT({Item ID} & '', 4) = 'OUT-',
        {Type} = 'Custom',
        {Shipping Status} = 'Shipped'
      )`),

      loadInventoryCount(`AND(
        LEFT({Item ID} & '', 4) = 'OUT-',
        {Type} = 'Custom',
        {Shipping Status} = 'Delivered',
        {Payment Status} = 'To Pay'
      )`)
    ]);

    const openClaimsCount = openClaimsRecords.filter((record) =>
      linkedRecordIncludes(
        record.fields?.["Claimed Seller ID"],
        sellerRecordId
      )
    ).length;

    res.json({
      open_claims: openClaimsCount,

      confirmed: confirmedCount,
      label_requested: labelRequestedCount,
      ready_to_ship: readyToShipCount,
      shipped: shippedCount,
      delivered: deliveredCount
    });
  } catch (err) {
    console.error("Failed to load quick counts:", err);

    res.status(500).json({
      error: "Failed to load quick counts",
      details: err.message
    });
  }
});

app.get("/api/dashboard/counts", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    const sellerCode = asText(req.query.seller_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    async function loadInventoryCount(formula, requireEmptySellerOffer = true) {
      const records = await airtable(INVENTORY_UNITS_TABLE)
        .select({
          fields: ["Seller ID", "Seller Offer"],
          filterByFormula: formula
        })
        .all();

      return records.filter((record) => {
        const f = record.fields || {};

        return (
          linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
          (!requireEmptySellerOffer || linkedRecordIsEmpty(f["Seller Offer"]))
        );
      }).length;
    }

    async function loadMemberWtbCount(formula) {
      const records = await airtable(MEMBER_WTBS_TABLE)
        .select({
          fields: ["Buyer Seller ID"],
          filterByFormula: formula
        })
        .all();
    
      return records.filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      ).length;
    }

    const [
      openClaimsRecords,
      quickConfirmed,
      quickLabelRequested,
      quickReadyToShip,
      quickShipped,
      quickDelivered,
      wtbOpenOffersRecords,
      wtbCounterOffersRecords,
      wtbAcceptedRecords,
      wtbConfirmedRecords,
      wtbLabelRequestedRecords,
      wtbReadyToShipRecords,
      wtbShippedRecords,
      wtbDeliveredRecords,
      historyIssuesRecords,
      historyCompletedRecords
    ] = await Promise.all([
      airtable(ORDERS_TABLE)
        .select({
          fields: ["Claimed Seller ID"],
          filterByFormula: `{Fulfillment Status} = 'Claim Processing'`
        })
        .all(),

      loadInventoryCount(`AND(LEFT({Item ID} & '', 4) = 'OUT-', {Type} = 'Custom', {Fulfillment Status (UOL)} = 'Allocated')`),
      loadInventoryCount(`AND(LEFT({Item ID} & '', 4) = 'OUT-', {Type} = 'Custom', {Fulfillment Status (UOL)} = 'Requested Label')`),
      loadInventoryCount(`AND(LEFT({Item ID} & '', 4) = 'OUT-', {Type} = 'Custom', {Fulfillment Status (UOL)} = 'Ready to Ship')`),
      loadInventoryCount(`AND(LEFT({Item ID} & '', 4) = 'OUT-', {Type} = 'Custom', {Shipping Status} = 'Shipped')`),
      loadInventoryCount(`AND(LEFT({Item ID} & '', 4) = 'OUT-', {Type} = 'Custom', {Shipping Status} = 'Delivered', {Payment Status} = 'To Pay')`),

      airtable(SELLER_OFFERS_TABLE)
        .select({
          fields: ["Seller ID"],
          filterByFormula: `OR(
            {Fulfillment Status} = 'Outsource',
            {Fulfillment Status (MWTB)} = 'Outsource'
          )`
        })
        .all(),

      airtable(COUNTER_OFFERS_TABLE)
        .select({
          fields: ["Seller ID", "Status", "Source Type"],
          filterByFormula: `AND(
            {Status} = 'Open',
            {Source Type} = 'Seller Offer'
          )`
        })
        .all(),
      
      airtable(SELLER_OFFERS_TABLE)
        .select({
          fields: [
            "Seller ID",
            "Linked Orders",
            "Member WTBs",
            "Fulfillment Status",
            "Fulfillment Status (MWTB)",
            "WTB Created Channel ID (MWTB)"
          ],
          filterByFormula: `OR(
            {Fulfillment Status} = 'Confirmed',
            {Fulfillment Status (MWTB)} = 'Confirmed'
          )`
        })
        .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer",
          "Fulfillment Status (MWTB)"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Allocated',
            {Fulfillment Status (MWTB)} = 'Allocated'
          )
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer",
          "Fulfillment Status (MWTB)"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Requested Label',
            {Fulfillment Status (MWTB)} = 'Requested Label'
          )
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer",
          "Fulfillment Status (MWTB)"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Fulfillment Status (UOL)} = 'Ready to Ship',
            {Fulfillment Status (MWTB)} = 'Ready to Ship'
          )
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer",
          "Shipping Status (MWTB)"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Shipping Status} = 'Shipped',
            {Shipping Status (MWTB)} = 'Shipped'
          )
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer",
          "Shipping Status (MWTB)"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          OR(
            {Shipping Status} = 'Delivered',
            {Shipping Status (MWTB)} = 'Delivered'
          ),
          {Payment Status} = 'To Pay'
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: ["Seller ID"],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Payment Status} = 'Paid',
          {Issue Status} = 'Troubled'
        )`
      })
      .all(),
    
    airtable(INVENTORY_UNITS_TABLE)
        .select({
          fields: ["Seller ID (Lookup)"],
          filterByFormula: `AND(
            LEFT({Item ID} & '', 4) = 'OUT-',
            {Type} = 'Custom',
            {Payment Status} = 'Paid',
            {Seller ID (Lookup)} = '${escapeFormulaValue(sellerCode)}'
          )`
        })
        .all()
    ]);

    const openClaims = openClaimsRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Claimed Seller ID"], sellerRecordId)
    ).length;

    const wtbOpenOffers = wtbOpenOffersRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    ).length;

    const wtbCounterOffers = wtbCounterOffersRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    ).length;

    const wtbAcceptedBase = wtbAcceptedRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const historyIssues = historyIssuesRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    ).length;
    
    const wtbAcceptedOrderIds = [
      ...new Set(
        wtbAcceptedBase
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];
    
    const wtbAcceptedOrderMap = await loadOrderFieldsMap(wtbAcceptedOrderIds);
    
    const wtbAccepted = wtbAcceptedBase.filter((record) => {
      const f = record.fields || {};
    
      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;
    
      const orderFields = wtbAcceptedOrderMap.get(linkedOrderId) || {};
    
      if (isMemberWtb) {
        return displayValue(f["Fulfillment Status (MWTB)"]) === "Confirmed";
      }
    
      return (
        displayValue(orderFields["Partner or Seller"]) === "Seller" &&
        displayValue(orderFields["Lowest Offer Seller ID"]) === sellerCode
      );
    }).length;
    
    function isVisibleMemberWtbInventory(record) {
      const f = record.fields || {};
      const isMemberWtb =
        !linkedRecordIsEmpty(f["Fulfillment Status (MWTB)"]) ||
        !linkedRecordIsEmpty(f["Shipping Status (MWTB)"]);
    
      if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
        return false;
      }
    
      if (isMemberWtb) {
        return true;
      }
    
      return !linkedRecordIsEmpty(f["Seller Offer"]);
    }

    const wtbConfirmed = wtbConfirmedRecords.filter(isVisibleMemberWtbInventory).length;

    const wtbLabelRequested = wtbLabelRequestedRecords.filter(isVisibleMemberWtbInventory).length;

    const wtbReadyToShip = wtbReadyToShipRecords.filter(isVisibleMemberWtbInventory).length;

    const wtbShipped = wtbShippedRecords.filter(isVisibleMemberWtbInventory).length;

    const wtbDelivered = wtbDeliveredRecords.filter(isVisibleMemberWtbInventory).length;

    const { data: consignmentInventoryRows, error: consignmentInventoryError } =
      await supabase
        .from("consignment_inventory")
        .select("quantity")
        .eq("seller_record_id", sellerRecordId)
        .gt("quantity", 0);
    
    if (consignmentInventoryError) throw consignmentInventoryError;
    
    const consignmentInventoryCount = (consignmentInventoryRows || [])
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    
    const { count: consignmentOffersCount, error: consignmentOffersError } =
      await supabase
        .from("consignment_offers")
        .select("id", { count: "exact", head: true })
        .eq("seller_record_id", sellerRecordId)
        .eq("status", "open");
    
    if (consignmentOffersError) throw consignmentOffersError;
    
    const consignmentConfirmedCount = await loadInventoryCount(
      `AND(
        {Type} = 'Consignment',
        OR(
          {Fulfillment Status (UOL)} = 'Allocated',
          {Fulfillment Status (MWTB)} = 'Allocated'
        )
      )`,
      false
    );
    
    const consignmentLabelRequestedCount = await loadInventoryCount(
      `AND(
        {Type} = 'Consignment',
        OR(
          {Fulfillment Status (UOL)} = 'Requested Label',
          {Fulfillment Status (MWTB)} = 'Requested Label'
        )
      )`,
      false
    );
    
    const consignmentReadyToShipCount = await loadInventoryCount(
      `AND(
        {Type} = 'Consignment',
        OR(
          {Fulfillment Status (UOL)} = 'Ready to Ship',
          {Fulfillment Status (MWTB)} = 'Ready to Ship'
        )
      )`,
      false
    );
    
    const consignmentShippedCount = await loadInventoryCount(
      `AND(
        {Type} = 'Consignment',
        OR(
          {Shipping Status} = 'Shipped',
          {Shipping Status (MWTB)} = 'Shipped'
        )
      )`,
      false
    );
    
    const consignmentDeliveredCount = await loadInventoryCount(
      `AND(
        {Type} = 'Consignment',
        OR(
          {Shipping Status} = 'Delivered',
          {Shipping Status (MWTB)} = 'Delivered'
        ),
        {Payment Status} = 'To Pay'
      )`,
      false
    );

    const buyingRecords = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Fulfillment Status",
          "Payment Status",
          "Shipping Status",
          "Current Lowest Offer"
        ]
      })
      .all();
    
    const myBuyingRecords = buyingRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
    );
    
    const buyingOpenWtbsCount = myBuyingRecords.filter((record) => {
      const status = asText(record.fields?.["Fulfillment Status"]);
      return status === "Pending" || status === "Outsource";
    }).length;
    
    const buyingOffersCount = myBuyingRecords.filter((record) => {
      const status = asText(record.fields?.["Fulfillment Status"]);
      const lowestOffer = Number(record.fields?.["Current Lowest Offer"] || 0);
    
      return (
        (status === "Pending" || status === "Outsource") &&
        lowestOffer > 0
      );
    }).length;
    
    const buyingAcceptedCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Fulfillment Status"]) === "Confirmed"
    ).length;
    
    const buyingPaymentRequiredCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Payment Status"]) === "Requested"
    ).length;
    
    const buyingConfirmedCount = myBuyingRecords.filter((record) => {
      const paymentStatus = asText(record.fields?.["Payment Status"]);
      const fulfillmentStatus = asText(record.fields?.["Fulfillment Status"]);
    
      return (
        (paymentStatus === "Paid" || paymentStatus === "Trusted") &&
        fulfillmentStatus === "Allocated"
      );
    }).length;
    
    const buyingLabelRequestedCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Fulfillment Status"]) === "Requested Label"
    ).length;
    
    const buyingReadyToShipCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Fulfillment Status"]) === "Ready to Ship"
    ).length;
    
    const buyingShippedCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Shipping Status"]) === "Shipped"
    ).length;
    
    const buyingDeliveredCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Shipping Status"]) === "Delivered"
    ).length;
    
    const buyingDeliveredPaymentWarningCount = myBuyingRecords.filter((record) =>
      asText(record.fields?.["Shipping Status"]) === "Delivered" &&
      asText(record.fields?.["Payment Status"]) === "Trusted"
    ).length;

    res.json({
      quick: {
        open_claims: openClaims,
        confirmed: quickConfirmed,
        label_requested: quickLabelRequested,
        ready_to_ship: quickReadyToShip,
        shipped: quickShipped,
        delivered: quickDelivered
      },
      wtb: {
        open_offers: wtbOpenOffers,
        counter_offers: wtbCounterOffers,
        accepted: wtbAccepted,
        confirmed: wtbConfirmed,
        label_requested: wtbLabelRequested,
        ready_to_ship: wtbReadyToShip,
        shipped: wtbShipped,
        delivered: wtbDelivered
      },

      consignment: {
        inventory: consignmentInventoryCount,
        offers: consignmentOffersCount,
        confirmed: consignmentConfirmedCount,
        label_requested: consignmentLabelRequestedCount,
        ready_to_ship: consignmentReadyToShipCount,
        shipped: consignmentShippedCount,
        delivered: consignmentDeliveredCount
      },

      buying: {
        open_wtbs: buyingOpenWtbsCount,
        offers: buyingOffersCount,
        accepted: buyingAcceptedCount,
        payment_required: buyingPaymentRequiredCount,
        confirmed: buyingConfirmedCount,
        label_requested: buyingLabelRequestedCount,
        ready_to_ship: buyingReadyToShipCount,
        shipped: buyingShippedCount,
        delivered: buyingDeliveredCount,
        delivered_payment_warning: buyingDeliveredPaymentWarningCount
      },
      
      history: {
        completed: historyCompletedRecords.length,
        issues: historyIssues
      }
    });
  } catch (err) {
    console.error("Failed to load dashboard counts:", err);

    res.status(500).json({
      error: "Failed to load dashboard counts",
      details: err.message
    });
  }
});

app.get("/api/dashboard/open-claims", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({
        error: "Missing seller_record_id"
      });
    }

    const records = await airtable(ORDERS_TABLE)
      .select({
        fields: [
          "Order ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Claimed Seller Payout",
          "Claimed Seller VAT Type",
          "Claimed At",
          "Claimed Channel ID",
          "Claimed Seller ID",
          "Fulfillment Status"
        ],
        filterByFormula: `{Fulfillment Status} = 'Claim Processing'`
      })
      .all();

    const claims = records
      .filter((record) =>
        linkedRecordIncludes(
          record.fields?.["Claimed Seller ID"],
          sellerRecordId
        )
      )
      .map(normalizeDashboardOpenClaim);

    const sortedClaims = sortDashboardItemsNewestFirst(claims);

    res.json({
      count: sortedClaims.length,
      claims: sortedClaims
    });
  } catch (err) {
    console.error("Failed to load dashboard open claims:", err);

    res.status(500).json({
      error: "Failed to load open claims",
      details: err.message
    });
  }
});

async function loadConsignmentDashboardItemsByStatus(status) {
  const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
    .select({
      fields: [
        "Seller ID",
        "Item ID",
        "Type",
        "Fulfillment Status (UOL)",
        "Fulfillment Status (MWTB)",
        "Shipping Status",
        "Shipping Status (MWTB)",
        "Payment Status",
        "Purchase Price",
        "Unfulfilled Orders Log",
        "Member WTBs",
        "Member WTB ID",
        "WTB Created Channel ID (MWTB)",
        "Shipping Label URL (Permanent) (MWTB)",
        "Tracking URL (MWTB)",
        "Product Name",
        "SKU",
        "Size",
        "Brand",
        "VAT Type",
        "Purchase Date"
      ],
      filterByFormula: `AND(
        {Type} = 'Consignment',
        OR(
          {Fulfillment Status (UOL)} = '${escapeFormulaValue(status)}',
          {Fulfillment Status (MWTB)} = '${escapeFormulaValue(status)}',
          {Shipping Status} = '${escapeFormulaValue(status)}',
          {Shipping Status (MWTB)} = '${escapeFormulaValue(status)}'
        )
      )`
    })
    .all();

  return inventoryRecords;
}

async function normalizeConsignmentDashboardItems(records, sellerRecordId) {
  const filteredInventory = records.filter((record) =>
    linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
  );

  const linkedOrderIds = [
    ...new Set(
      filteredInventory
        .map((record) =>
          firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"])
        )
        .filter(Boolean)
    )
  ];

  const orderMap = await loadOrderFieldsMap(linkedOrderIds);

  const items = filteredInventory.map((record) => {
    const f = record.fields || {};

    const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
    const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
    const isMemberWtb = !!linkedMemberWtbId;

    const orderFields = orderMap.get(linkedOrderId) || {};

    const channelId = isMemberWtb
      ? displayValue(f["WTB Created Channel ID (MWTB)"])
      : displayValue(orderFields["WTB Created Channel ID"]);

    const labelUrl = isMemberWtb
      ? displayValue(f["Shipping Label URL (Permanent) (MWTB)"])
      : (
          displayValue(orderFields["Shipping Label URL (Permanent)"]) ||
          displayValue(orderFields["Shipping Label"])
        );

    const trackingUrl = isMemberWtb
      ? displayValue(f["Tracking URL (MWTB)"])
      : displayValue(orderFields["Tracking URL"]);

    return {
      id: record.id,
      order_id: isMemberWtb
        ? displayValue(f["Member WTB ID"])
        : displayValue(orderFields["Order ID"]),
      order_record_id: linkedOrderId,
      member_wtb_record_id: linkedMemberWtbId,
      product: displayValue(f["Product Name"]),
      sku: displayValue(f["SKU"]),
      size: displayValue(f["Size"]),
      brand: displayValue(f["Brand"]),
      payout: moneyWholeValue(f["Purchase Price"]),
      vat_type: displayValue(f["VAT Type"]),
      date: formatDateEU(f["Purchase Date"]),
      raw_date: f["Purchase Date"],
      discord_url: channelId
        ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
        : "",
      label_url: labelUrl,
      tracking_url: trackingUrl
    };
  });

  return sortDashboardItemsNewestFirst(items);
}

app.get("/api/dashboard/consignment-confirmed", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Item ID",
          "Type",
          "Fulfillment Status (UOL)",
          "Fulfillment Status (MWTB)",
          "Purchase Price",
          "Unfulfilled Orders Log",
          "Member WTBs",
          "Member WTB ID",
          "WTB Created Channel ID (MWTB)",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          {Type} = 'Consignment',
          OR(
            {Fulfillment Status (UOL)} = 'Allocated',
            {Fulfillment Status (MWTB)} = 'Allocated'
          )
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const linkedOrderIds = [
      ...new Set(
        filteredInventory
          .map((record) => firstLinkedRecordId(record.fields?.["Unfulfilled Orders Log"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = filteredInventory.map((record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Unfulfilled Orders Log"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;

      const orderFields = orderMap.get(linkedOrderId) || {};

      const channelId = isMemberWtb
        ? displayValue(f["WTB Created Channel ID (MWTB)"])
        : displayValue(orderFields["WTB Created Channel ID"]);

      return {
        id: record.id,
        order_id: isMemberWtb
          ? displayValue(f["Member WTB ID"])
          : displayValue(orderFields["Order ID"]),
        order_record_id: linkedOrderId,
        member_wtb_record_id: linkedMemberWtbId,
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"],
        discord_url: channelId
          ? `https://discord.com/channels/${DISCORD_SERVER_ID}/${channelId}`
          : ""
      };
    });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load consignment confirmed:", err);

    res.status(500).json({
      error: "Failed to load consignment confirmed",
      details: err.message
    });
  }
});

app.get("/api/dashboard/consignment-label-requested", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    if (!sellerRecordId) return res.status(400).json({ error: "Missing seller_record_id" });

    const records = await loadConsignmentDashboardItemsByStatus("Requested Label");
    const items = await normalizeConsignmentDashboardItems(records, sellerRecordId);

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load consignment label requested:", err);
    res.status(500).json({ error: "Failed to load consignment label requested", details: err.message });
  }
});

app.get("/api/dashboard/consignment-ready-to-ship", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    if (!sellerRecordId) return res.status(400).json({ error: "Missing seller_record_id" });

    const records = await loadConsignmentDashboardItemsByStatus("Ready to Ship");
    const items = await normalizeConsignmentDashboardItems(records, sellerRecordId);

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load consignment ready to ship:", err);
    res.status(500).json({ error: "Failed to load consignment ready to ship", details: err.message });
  }
});

app.get("/api/dashboard/consignment-shipped", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    if (!sellerRecordId) return res.status(400).json({ error: "Missing seller_record_id" });

    const records = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Type",
          "Shipping Status",
          "Payment Status",
          "Purchase Price",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          {Type} = 'Consignment',
          {Shipping Status} = 'Shipped'
        )`
      })
      .all();

    const items = await normalizeConsignmentDashboardItems(records, sellerRecordId);

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load consignment shipped:", err);
    res.status(500).json({ error: "Failed to load consignment shipped", details: err.message });
  }
});

app.get("/api/dashboard/consignment-delivered", async (req, res) => {
  try {
    const sellerRecordId = asText(req.query.seller_record_id);
    if (!sellerRecordId) return res.status(400).json({ error: "Missing seller_record_id" });

    const records = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Type",
          "Shipping Status",
          "Payment Status",
          "Purchase Price",
          "Unfulfilled Orders Log",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "VAT Type",
          "Purchase Date"
        ],
        filterByFormula: `AND(
          {Type} = 'Consignment',
          {Shipping Status} = 'Delivered',
          {Payment Status} = 'To Pay'
        )`
      })
      .all();

    const items = await normalizeConsignmentDashboardItems(records, sellerRecordId);

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load consignment delivered:", err);
    res.status(500).json({ error: "Failed to load consignment delivered", details: err.message });
  }
});
app.post("/api/login", async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase();
    const password = asText(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required"
      });
    }

    const records = await airtable(SELLERS_TABLE)
      .select({
        filterByFormula: `LOWER(TRIM({Email} & '')) = '${escapeFormulaValue(email)}'`,
        maxRecords: 1
      })
      .firstPage();

    if (!records.length) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    const seller = normalizeSeller(records[0]);

    if (!seller.portal_enabled) {
      return res.status(403).json({
        error: "Portal access disabled"
      });
    }

    if (!seller.seller_id) {
      return res.status(403).json({
        error: "Please sign up through Discord first"
      });
    }

    if (!seller.portal_password) {
      return res.status(403).json({
        error: "Please set your password first"
      });
    }

    if (seller.portal_password !== password) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    res.json({
      seller: {
        id: seller.id,
        seller_id: seller.seller_id,
        email: seller.email,
        discord: seller.discord,
        discord_id: seller.discord_id,
        consignor: seller.consignor
      }
    });
  } catch (err) {
    console.error("Login failed:", err);

    res.status(500).json({
      error: "Login failed",
      details: err.message
    });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const records = await airtable(SELLERS_TABLE)
      .select({
        filterByFormula: `LOWER(TRIM({Email} & '')) = '${escapeFormulaValue(email)}'`,
        maxRecords: 1
      })
      .firstPage();

    if (!records.length) {
      return res.json({ ok: true });
    }

    const seller = normalizeSeller(records[0]);

    if (!seller.seller_id || !seller.portal_enabled) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await airtable(SELLERS_TABLE).update(records[0].id, {
      "Password Reset Token": token,
      "Password Reset Expires At": expiresAt
    });

    const resetUrl = `${APP_PUBLIC_BASE_URL}/reset-password?token=${token}`;

    await sgMail.send({
      to: email,
      from: RESET_EMAIL_FROM,
      subject: "Set your Kickz Caviar Seller Portal password",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;background:#f5f5f5;padding:28px;">
          <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:18px;padding:30px;text-align:center;">
            <img
              src="https://i.imgur.com/gRmfHif.png"
              alt="Kickz Caviar"
              style="width:120px;height:auto;margin:0 auto 22px;display:block;"
            />
      
            <h2 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#111;">
              Set your seller portal password
            </h2>
      
            <p style="margin:0 0 24px;color:#555;font-size:15px;">
              Click the button below to set or reset your Kickz Caviar Seller Portal password.
            </p>
      
            <a href="${resetUrl}"
               style="
                 background:linear-gradient(180deg,#fff27a,#f0a500);
                 color:#050505;
                 padding:14px 22px;
                 border-radius:14px;
                 text-decoration:none;
                 font-weight:900;
                 display:inline-block;
               ">
              Set Password
            </a>
      
            <p style="margin:24px 0 0;color:#555;font-size:14px;">
              This link expires in 1 hour.
            </p>
      
            <p style="margin:18px 0 0;color:#999;font-size:12px;">
              If you did not request this, you can ignore this email.
            </p>
          </div>
        </div>
      `
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Forgot password failed:", err);

    res.status(500).json({
      error: "Failed to send reset email",
      details: err.message
    });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const token = asText(req.body.token);
    const password = asText(req.body.password);
    const passwordConfirm = asText(req.body.password_confirm);

    if (!token) {
      return res.status(400).json({ error: "Missing reset token" });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters"
      });
    }

    if (password !== passwordConfirm) {
      return res.status(400).json({
        error: "Passwords do not match"
      });
    }

    const records = await airtable(SELLERS_TABLE)
      .select({
        filterByFormula: `{Password Reset Token} = '${escapeFormulaValue(token)}'`,
        maxRecords: 1
      })
      .firstPage();

    if (!records.length) {
      return res.status(400).json({
        error: "Invalid or expired reset link"
      });
    }

    const seller = records[0];
    const expiresAtRaw = seller.fields["Password Reset Expires At"];

    if (!expiresAtRaw) {
      return res.status(400).json({
        error: "Invalid or expired reset link"
      });
    }

    const expiresAt = new Date(expiresAtRaw);

    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        error: "Reset link expired"
      });
    }

    await airtable(SELLERS_TABLE).update(seller.id, {
      "Portal Password": password,
      "Password Reset Token": "",
      "Password Reset Expires At": null
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Reset password failed:", err);

    res.status(500).json({
      error: "Failed to reset password",
      details: err.message
    });
  }
});

app.post("/api/claim-deal", async (req, res) => {
  try {
    const {
      recordId,
      sellerRecordId,
      sellerId,
      sellerDiscordId,
      vatType
    } = req.body || {};

    const botBaseUrl = process.env.KICKZ_BOT_BASE_URL;

    if (!botBaseUrl) {
      return res.status(500).json({
        error: "Missing KICKZ_BOT_BASE_URL"
      });
    }

    const response = await fetch(`${botBaseUrl.replace(/\/$/, "")}/quick-deal/claim-from-portal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recordId,
        sellerRecordId,
        sellerId,
        sellerDiscordId,
        vatType
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error || "Claim failed",
        details: data.details || ""
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Portal claim failed:", err);

    res.status(500).json({
      error: "Claim failed",
      details: err.message
    });
  }
});

app.post("/api/place-offer", async (req, res) => {
  try {
    const {
      orderRecordId,
      sellerRecordId,
      offerAmount,
      vatType,
      sourceType = "order"
    } = req.body || {};

    const wtbBotBaseUrl = process.env.KICKZ_WTB_BOT_BASE_URL;

    if (!wtbBotBaseUrl) {
      return res.status(500).json({
        error: "Missing KICKZ_WTB_BOT_BASE_URL"
      });
    }

    const response = await fetch(`${wtbBotBaseUrl.replace(/\/$/, "")}/seller-offer/place-from-portal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        orderRecordId,
        sellerRecordId,
        offerAmount,
        vatType,
        sourceType
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error || "Offer failed",
        details: data.details || ""
      });
    }

    res.json(data);
  } catch (err) {
    console.error("Portal offer failed:", err);

    res.status(500).json({
      error: "Offer failed",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: edit an EXISTING Seller Offer after it was denied,
// instead of creating a brand new one. Mirrors the exact pattern already
// used by /api/dashboard/wtb-open-offers/:offerId/edit for Member WTBs,
// just applied to a Store-Order Seller Offer. Enforces that the new
// amount is at least €2.50 lower than the previously denied amount, so a
// seller can't just resubmit the same (already-rejected) price.
// ---------------------------------------------------------------------
app.post("/api/seller-offers/:offerId/edit-after-denial", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const offerAmount = Number(req.body?.offer_amount);
    const vatType = asText(req.body?.vat_type);
    const previousDeniedAmount = Number(req.body?.previous_denied_amount);

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    if (!Number.isFinite(offerAmount) || offerAmount <= 0) {
      return res.status(400).json({ error: "Invalid offer amount" });
    }

    if (!Number.isInteger(offerAmount)) {
      return res.status(400).json({ error: "Offers must be a whole number (no cents)." });
    }

    if (!["Margin", "VAT0", "VAT21"].includes(vatType)) {
      return res.status(400).json({ error: "Invalid VAT type" });
    }

    // Minimum-decrease check: must be at least €2.50 below what was
    // already denied, otherwise the seller is just resubmitting the same
    // rejected price. Combined with the whole-number rule above, €441
    // denied means the new offer must be €438 at most (438.50 rounds
    // down, since 438.50 isn't a valid whole-number offer).
    if (
      Number.isFinite(previousDeniedAmount) &&
      offerAmount > previousDeniedAmount - 2.5
    ) {
      const maxAllowed = Math.floor(previousDeniedAmount - 2.5);
      return res.status(400).json({
        error: `Your new offer must be a whole number at least €2.50 lower than your denied offer (€${previousDeniedAmount.toFixed(2)}). Maximum allowed: €${maxAllowed}.`
      });
    }

    const offerRecord = await airtable(SELLER_OFFERS_TABLE).find(offerId);
    const f = offerRecord.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);

    if (!linkedOrderId) {
      return res.status(409).json({ error: "This offer is not linked to an order" });
    }

    const normalizedOffer = vatType === "VAT0" ? offerAmount * 1.21 : offerAmount;

    await airtable(SELLER_OFFERS_TABLE).update(offerId, {
      "Seller Offer": offerAmount,
      "Offer VAT Type": vatType,
      "Offer Cost (Normalized)": normalizedOffer,
      "Offer Date": new Date().toISOString()
    });

    // Editing "Seller Offer" changes the rollup fields on Unfulfilled
    // Orders Log (Lowest Seller Offer etc.), which is exactly what
    // computeAndPushLowestOffer's watchFields listens for — so simply
    // updating this record is enough to naturally re-trigger a fresh
    // Offer Request to the store, same as any other new/changed offer.

    return res.json({
      ok: true,
      offer_id: offerId,
      order_record_id: linkedOrderId
    });
  } catch (err) {
    console.error("Failed to edit offer after denial:", err);

    res.status(500).json({
      error: "Failed to edit offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: called from airtable-discord-updates-main when a
// store denies a seller's current offer, so the seller gets a DM showing
// their denied amount and a button to place a new offer. Reuses the
// existing /api/place-offer relay internally (via placeOfferFromPortal
// below) — no new offer-placement logic is introduced.
// ---------------------------------------------------------------------
app.post("/api/notify-seller-offer-denied", async (req, res) => {
  try {
    const {
      orderRecordId,
      orderId,
      sellerOfferRecordId,
      sellerRecordId,
      sellerDiscordId,
      productName,
      sku,
      size,
      shopifyOrderNumber,
      deniedAmount,
      vatType
    } = req.body || {};

    if (!sellerDiscordId || !orderRecordId || !sellerRecordId) {
      return res.status(400).json({
        error: "Missing sellerDiscordId, orderRecordId, or sellerRecordId"
      });
    }

    await sendOfferDeniedDiscordDM({
      orderRecordId,
      orderId,
      sellerOfferRecordId,
      sellerRecordId,
      sellerDiscordId,
      productName,
      sku,
      size,
      shopifyOrderNumber,
      deniedAmount,
      vatType
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to notify seller of offer denial:", err);
    res.status(500).json({ error: "Failed to notify seller", details: err.message });
  }
});

app.get("/api/brands", async (req, res) => {
  try {
    const type = asText(req.query.type) || "quick";

    let formula;

    if (type === "quick") {
      formula = `AND(
        OR(
          {Fulfillment Status} = 'Outsource',
          {Fulfillment Status} = 'Claim Processing'
        ),
        {Auto Offer Accept?} = 'Yes',
        {Brand} != ''
      )`;
    } else if (type === "wtb") {
      formula = `AND(
        {Fulfillment Status} = 'Outsource',
        {Brand} != '',
        OR(
          {Auto Offer Accept?} = 'No',
          AND(
            {Auto Offer Accept?} = 'Yes',
            DATETIME_DIFF(NOW(), {Outsource Start Time}, 'hours') >= 48
          )
        )
      )`;
    } else {
      return res.status(400).json({ error: "Invalid deal type" });
    }

    const records = await airtable(ORDERS_TABLE)
      .select({
        fields: ["Brand"],
        filterByFormula: formula
      })
      .all();

    const brands = [...new Set(
      records
        .map((record) => displayValue(record.fields?.["Brand"]))
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    res.json({ type, brands });
  } catch (err) {
    console.error("Failed to load brands:", err);

    res.status(500).json({
      error: "Failed to load brands",
      details: err.message
    });
  }
});

app.get("/api/deals", async (req, res) => {
  try {
    const type = asText(req.query.type) || "quick";
    const brand = asText(req.query.brand);
    const search = asText(req.query.search);
    const sort = asText(req.query.sort) || "newest";
    const priceView = asText(req.query.price_view) || "margin";

    let formula;

    if (type === "quick") {
      formula = `AND(
        OR(
          {Fulfillment Status} = 'Outsource',
          {Fulfillment Status} = 'Claim Processing'
        ),
        {Auto Offer Accept?} = 'Yes'
      )`;
    } else if (type === "wtb") {
      formula = `AND(
        {Fulfillment Status} = 'Outsource',
        OR(
          {Auto Offer Accept?} = 'No',
          AND(
            {Auto Offer Accept?} = 'Yes',
            DATETIME_DIFF(NOW(), {Outsource Start Time}, 'hours') >= 48
          )
        )
      )`;
    } else {
      return res.status(400).json({
        error: "Invalid deal type"
      });
    }

    const extraFilters = [];

    if (brand) {
      extraFilters.push(`{Brand} = '${escapeFormulaValue(brand)}'`);
    }
    
    if (search) {
      const safeSearch = escapeFormulaValue(search);
    
      extraFilters.push(`OR(
        SEARCH(LOWER('${safeSearch}'), LOWER({Product Name} & '')),
        SEARCH(LOWER('${safeSearch}'), LOWER({SKU} & '')),
        SEARCH(LOWER('${safeSearch}'), LOWER({Brand} & '')),
        SEARCH(LOWER('${safeSearch}'), LOWER({Size} & ''))
      )`);
    }
    
    if (extraFilters.length) {
      formula = `AND(${formula}, ${extraFilters.join(",")})`;
    }

    const pageSize = Math.min(Number(req.query.page_size || 40), 40);
    const offset = asText(req.query.offset);
    
    const airtableUrl = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(ORDERS_TABLE)}`
    );
    
    airtableUrl.searchParams.set("filterByFormula", formula);
    airtableUrl.searchParams.set("pageSize", String(pageSize));
    let sortField = "Order Date";
    let sortDirection = "desc";
    
    if (sort === "oldest") {
      sortField = "Order Date";
      sortDirection = "asc";
    }
    
    if (sort === "az") {
      sortField = "Product Name";
      sortDirection = "asc";
    }
    
    if (sort === "za") {
      sortField = "Product Name";
      sortDirection = "desc";
    }
    
    if (sort === "payout_low" || sort === "payout_high") {
      if (type === "quick") {
        sortField =
          priceView === "vat0"
            ? "Outsource Buying Price (VAT 0%)"
            : "Outsource Buying Price";
      } else {
        sortField =
          priceView === "vat0"
            ? "Current Lowest (VAT0)"
            : "Current Lowest (Normalized)";
      }
    
      sortDirection = sort === "payout_low" ? "asc" : "desc";
    }
    
    airtableUrl.searchParams.set("sort[0][field]", sortField);
    airtableUrl.searchParams.set("sort[0][direction]", sortDirection);
    
    if (offset) {
      airtableUrl.searchParams.set("offset", offset);
    }
    
    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });
    
    const airtableData = await airtableResponse.json();
    
    if (!airtableResponse.ok) {
      throw new Error(
        airtableData?.error?.message ||
        airtableData?.error?.type ||
        "Airtable request failed"
      );
    }
    
    const records = airtableData.records || [];
    let deals = records.map(normalizeDeal);
    
    if (type === "wtb") {
      const memberWtbRecords = await airtable(MEMBER_WTBS_TABLE)
        .select({
          fields: [
            "Member WTB ID",
            "Product Name",
            "SKU",
            "Size",
            "Brand",
            "Picture",
            "Date",
            "Max Price",
            "Fulfillment Status",
            "Purchase Status",
            "Current Lowest Offer",
            "Current Lowest Normalized",
            "Lowest Offer",
            "Lowest Offer Normalized",
            "Lowest Offer VAT Type"
          ],
          filterByFormula: `AND(
            {Fulfillment Status} = 'Outsource',
            OR(
              {Purchase Status} = 'Offers Sent',
              {Purchase Status} = 'Pending',
              {Purchase Status} = ''
            )
          )`
        })
        .all();
    
      const memberDeals = memberWtbRecords.map(normalizeMemberWtbDeal);
    
      deals = [
        ...deals,
        ...memberDeals
      ];
    }
    
    res.json({
      type,
      count: deals.length,
      next_offset: airtableData.offset || "",
      has_more: !!airtableData.offset,
      deals
    });
  } catch (err) {
    console.error("Failed to load deals:", err);

    res.status(500).json({
      error: "Failed to load deals",
      details: err.message
    });
  }
});

function buyingMoneyValue(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return "";

  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.ceil(n));
}

function getBuyingProductKey(source) {
  return [
    asText(source.sku).toUpperCase(),
    asText(source.product_name).toLowerCase()
  ].filter(Boolean).join("::");
}

function getBuyingSizeKey(size) {
  return asText(size).toUpperCase();
}

function getBuyingInventoryPrice(fields) {
  return numberValue(fields["Ideal Selling Price"]);
}

function getBuyingInventoryProduct(record) {
  const f = record.fields || {};

  return {
    source_type: "kc_owned",
    source_label: "KC Owned",
    source_id: record.id,
    product_name: displayValue(f["Product Name"]),
    sku: displayValue(f["SKU"]),
    size: displayValue(f["Size"]),
    brand: displayValue(f["Brand"]),
    image_url: getImageUrl(f["Picture"]) || getImageUrl(f["Image"]),
    price: getBuyingInventoryPrice(f),
    vat_type: normalizeBuyingVatType(f["VAT Type"]),
    compare_price: getBuyingComparePrice(
      getBuyingInventoryPrice(f),
      f["VAT Type"],
      "kc_owned"
    ),
    delivery_time: BUYING_KC_DELIVERY_TIME,
    quantity: 1
  };
}

function getBuyingConsignmentProduct(row, imageMap = new Map()) {
  const sku = normalizeSku(row.sku);
  const rowImageUrl = asText(row.image_url);
  const fallbackImageUrl = imageMap.get(sku) || "";

  return {
    source_type: "consignment",
    source_label: "Consignment",
    source_id: row.id,
    seller_record_id: asText(row.seller_record_id),
    seller_id: asText(row.seller_id),
    product_name: asText(row.product_name),
    sku,
    size: asText(row.size),
    brand: asText(row.brand),
    image_url: isUnstableImageUrl(rowImageUrl)
      ? fallbackImageUrl
      : rowImageUrl,
    price: Number(row.selling_price_suggested || 0) + 10,
    seller_price: Number(row.selling_price_suggested || 0),
    kc_markup: 10,
    vat_type: normalizeBuyingVatType(row.vat_type),
    compare_price: getBuyingComparePrice(
      Number(row.selling_price_suggested || 0) + 10,
      row.vat_type,
      "consignment"
    ),
    delivery_time: BUYING_CONSIGNMENT_DELIVERY_TIME,
    quantity: Number(row.quantity || 0)
  };
}

function normalizeBuyingVatType(value) {
  const vatType = asText(value);

  if (vatType.toUpperCase() === "VAT0") return "VAT0";
  if (vatType.toUpperCase() === "VAT21") return "VAT21";
  if (vatType.toLowerCase() === "margin") return "Margin";

  return vatType || "Margin";
}

function getBuyingComparePrice(price, vatType, sourceType = "") {
  const n = Number(price || 0);
  const cleanVatType = normalizeBuyingVatType(vatType);
  const cleanSourceType = asText(sourceType);

  if (!Number.isFinite(n) || n <= 0) return 0;

  if (
    cleanSourceType === "kc_owned" &&
    (cleanVatType === "VAT0" || cleanVatType === "VAT21")
  ) {
    return n * 1.21;
  }

  if (cleanVatType === "VAT0") {
    return n * 1.21;
  }

  return n;
}

function isBuyingB2BSource(source) {
  const vatType = normalizeBuyingVatType(source.vat_type);
  return vatType === "VAT0" || vatType === "VAT21";
}

function isBuyingPrivateSource(source) {
  return normalizeBuyingVatType(source.vat_type) === "Margin";
}

function sourceMatchesBuyingInventoryType(source, inventoryType) {
  if (inventoryType === "b2b") return isBuyingB2BSource(source);
  if (inventoryType === "private") return isBuyingPrivateSource(source);
  return true;
}

function getBuyingDisplayPrice(price, vatType, inventoryType, sourceType = "") {
  const n = Number(price || 0);
  const cleanVatType = normalizeBuyingVatType(vatType);
  const cleanSourceType = asText(sourceType);

  if (!Number.isFinite(n) || n <= 0) return 0;

  if (inventoryType !== "all") {
    return n;
  }

  if (
    cleanSourceType === "kc_owned" &&
    (cleanVatType === "VAT0" || cleanVatType === "VAT21")
  ) {
    return n * 1.21;
  }

  if (cleanVatType === "VAT0") {
    return n * 1.21;
  }

  return n;
}

function addBuyingSourceToProductMap(productMap, source, inventoryType = "all") {
  if (!source.sku || !source.size || !source.price) return;
  if (!sourceMatchesBuyingInventoryType(source, inventoryType)) return;

  source.display_price = getBuyingDisplayPrice(
    source.price,
    source.vat_type,
    inventoryType,
    source.source_type
  );
  
  source.compare_price = source.display_price;
  source.vat_type = normalizeBuyingVatType(source.vat_type);

  source.compare_price = source.compare_price || getBuyingComparePrice(
    source.price,
    source.vat_type,
    source.source_type
  );
  source.vat_type = normalizeBuyingVatType(source.vat_type);

  const productKey = getBuyingProductKey(source);
  const sizeKey = getBuyingSizeKey(source.size);

  if (!productMap.has(productKey)) {
    productMap.set(productKey, {
      key: productKey,
      product_name: source.product_name || source.sku,
      sku: source.sku,
      brand: source.brand,
      image_url: source.image_url,
      sizes: new Map(),
      all_sources: []
    });
  }

  const product = productMap.get(productKey);

  if (source.image_url && (!product.image_url || source.source_type === "consignment")) {
    product.image_url = source.image_url;
  }

  if (!product.brand && source.brand) {
    product.brand = source.brand;
  }

  if (!product.sizes.has(sizeKey)) {
    product.sizes.set(sizeKey, {
      size: source.size,
      lowest_price: source.display_price,
      lowest_compare_price: source.compare_price,
      lowest_price_display: buyingMoneyValue(source.display_price),
      lowest_vat_type: source.vat_type,
      available_qty: Number(source.quantity || 1),
      fastest_delivery_time: source.delivery_time,
      source_count: 0,
      sources: []
    });
  }

  const size = product.sizes.get(sizeKey);

  size.sources.push(source);

  const sourceGroups = new Set(
    size.sources.map((item) => {
      if (item.source_type === "kc_owned") return "kc_owned";
      return `${item.source_type}:${item.seller_record_id || item.source_id}`;
    })
  );
  
  size.source_count = sourceGroups.size;

  if (source.compare_price < size.lowest_compare_price) {
    size.lowest_price = source.display_price;
    size.lowest_compare_price = source.compare_price;
    size.lowest_price_display = buyingMoneyValue(source.display_price);
    size.lowest_vat_type = source.vat_type;
    size.fastest_delivery_time = source.delivery_time;
  }

  size.available_qty = size.sources.reduce(
    (sum, item) => sum + Number(item.quantity || 1),
    0
  );

  product.all_sources.push(source);
}

function normalizeBuyingProducts(productMap) {
  return [...productMap.values()].map((product) => {
    const sizes = [...product.sizes.values()]
      .map((size) => ({
        ...size,
        sources: size.sources
          .sort((a, b) => Number(a.price || 0) - Number(b.price || 0))
          .map((source) => ({
            ...source,
            price_display: buyingMoneyValue(source.price),
            compare_price_display: buyingMoneyValue(source.compare_price),
            vat_type: source.vat_type
          }))
      }))
      .sort((a, b) => String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));

    const lowestPrice = Math.min(...sizes.map((size) => Number(size.lowest_price || 0)).filter(Boolean));

    return {
      key: product.key,
      product_name: product.product_name,
      sku: product.sku,
      brand: product.brand,
      image_url: product.image_url,
      from_price: Number.isFinite(lowestPrice) ? lowestPrice : 0,
      from_price_display: buyingMoneyValue(lowestPrice),
      size_count: sizes.length,
      fastest_delivery_time: sizes.some((size) => size.fastest_delivery_time === BUYING_KC_DELIVERY_TIME)
        ? BUYING_KC_DELIVERY_TIME
        : BUYING_CONSIGNMENT_DELIVERY_TIME,
      sizes
    };
  });
}

function normalizeSku(value) {
  return asText(value).toUpperCase().trim();
}

function isUnstableImageUrl(value) {
  const url = asText(value).toLowerCase();

  return (
    !url ||
    url.includes("airtableusercontent.com") ||
    url.includes("dl.airtable.com")
  );
}

async function getSkuMasterImageMap(skus) {
  const cleanSkus = [...new Set(skus.map(normalizeSku).filter(Boolean))];
  const imageMap = new Map();

  if (!cleanSkus.length) return imageMap;

  for (let i = 0; i < cleanSkus.length; i += 50) {
    const batch = cleanSkus.slice(i, i + 50);

    const formula = `OR(${batch
      .map((sku) => `{SKU} = '${sku.replaceAll("'", "\\'")}'`)
      .join(",")})`;

    const records = await airtable(SKU_MASTER_TABLE)
      .select({
        fields: ["SKU", "Picture"],
        filterByFormula: formula,
        maxRecords: 50
      })
      .all()
      .catch(() => []);

    for (const record of records) {
      const sku = normalizeSku(record.fields?.["SKU"]);
      const image = getImageUrl(record.fields?.["Picture"]);

      if (sku && image && !imageMap.has(sku)) {
        imageMap.set(sku, image);
      }
    }
  }

  return imageMap;
}

async function getStoreListingsImageMap(skus) {
  const cleanSkus = [...new Set(skus.map(normalizeSku).filter(Boolean))];
  const imageMap = new Map();

  if (!cleanSkus.length) return imageMap;

  const { data, error } = await supabase
    .from("store_listings")
    .select("sku, picture_url")
    .in("sku", cleanSkus);

  if (error) {
    console.error("Store listings image lookup failed:", error);
    return imageMap;
  }

  for (const row of data || []) {
    const sku = normalizeSku(row.sku);
    const image = asText(row.picture_url);

    if (sku && image && !imageMap.has(sku)) {
      imageMap.set(sku, image);
    }
  }

  return imageMap;
}

async function getUolImageMap(skus) {
  const cleanSkus = [...new Set(skus.map(normalizeSku).filter(Boolean))];
  const imageMap = new Map();

  if (!cleanSkus.length) return imageMap;

  for (let i = 0; i < cleanSkus.length; i += 50) {
    const batch = cleanSkus.slice(i, i + 50);

    const formula = `AND(
      OR(${batch.map((sku) => `{SKU} = '${sku.replaceAll("'", "\\'")}'`).join(",")}),
      {Picture} != ''
    )`;

    const records = await airtable(ORDERS_TABLE)
      .select({
        fields: ["SKU", "Picture"],
        filterByFormula: formula,
        maxRecords: 50
      })
      .all()
      .catch(() => []);

    for (const record of records) {
      const sku = normalizeSku(record.fields?.["SKU"]);
      const image = getImageUrl(record.fields?.["Picture"]);

      if (sku && image && !imageMap.has(sku)) {
        imageMap.set(sku, image);
      }
    }
  }

  return imageMap;
}

async function buildConsignmentImageMap(consignmentRows) {
  const missingImageSkus = [
    ...new Set(
      (consignmentRows || [])
        .filter((row) => isUnstableImageUrl(row.image_url))
        .map((row) => normalizeSku(row.sku))
        .filter(Boolean)
    )
  ];

  const imageMap = new Map();

  if (!missingImageSkus.length) return imageMap;

  const storeListingsMap = await getStoreListingsImageMap(missingImageSkus);

  for (const [sku, image] of storeListingsMap.entries()) {
    if (!isUnstableImageUrl(image)) {
      imageMap.set(sku, image);
    }
  }

  const stillMissingAfterStoreListings = missingImageSkus.filter((sku) => !imageMap.has(sku));
  const skuMasterMap = await getSkuMasterImageMap(stillMissingAfterStoreListings);

  for (const [sku, image] of skuMasterMap.entries()) {
    if (!isUnstableImageUrl(image)) {
      imageMap.set(sku, image);
    }
  }

  const stillMissingAfterSkuMaster = missingImageSkus.filter((sku) => !imageMap.has(sku));
  const uolMap = await getUolImageMap(stillMissingAfterSkuMaster);

  for (const [sku, image] of uolMap.entries()) {
    if (!isUnstableImageUrl(image)) {
      imageMap.set(sku, image);
    }
  }

  return imageMap;
}

async function cacheConsignmentImages(consignmentRows, imageMap) {
  const rowsToUpdate = (consignmentRows || []).filter((row) => {
    const sku = normalizeSku(row.sku);
    return row.id && isUnstableImageUrl(row.image_url) && imageMap.has(sku);
  });

  for (const row of rowsToUpdate) {
    const sku = normalizeSku(row.sku);
    const imageUrl = imageMap.get(sku);

    supabase
      .from("consignment_inventory")
      .update({
        image_url: imageUrl,
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .then(({ error }) => {
        if (error) {
          console.error("Failed to cache consignment image:", error);
        }
      });
  }
}

function buildBuyingProductsFromSources(sources, inventoryType = "all") {
  const productMap = new Map();

  (sources || []).forEach((source) => {
    addBuyingSourceToProductMap(productMap, { ...source }, inventoryType);
  });

  return normalizeBuyingProducts(productMap);
}

function normalizeBuyingInventoryType(value) {
  const clean = asText(value).toLowerCase();

  if (clean === "b2b") return "b2b";
  if (clean === "private") return "private";
  return "all";
}

function getBuyingInventoryFilterLabel(value) {
  const clean = normalizeBuyingInventoryType(value);

  if (clean === "b2b") return "B2B Only";
  if (clean === "private") return "Margin Only";
  return "All Inventory";
}

function getBuyingSourceTypeLabel(value) {
  const clean = asText(value);

  if (clean === "kc_owned") return "KC Owned";
  if (clean === "consignment") return "Consignment";

  return clean;
}

async function getLiveBuyingSources({ force = false } = {}) {
  if (force) {
    buyingMasterCache.sources = null;
    buyingMasterCache.createdAt = 0;
    buyingMasterCache.refreshPromise = null;
  }

  return refreshBuyingMasterCache();
}

function selectBuyingSourceFromLiveSources({ sources, sku, size, inventoryType }) {
  const cleanSku = normalizeSku(sku);
  const cleanSize = getBuyingSizeKey(size);
  const cleanInventoryType = normalizeBuyingInventoryType(inventoryType);

  const productMap = new Map();

  (sources || [])
    .filter((source) =>
      normalizeSku(source.sku) === cleanSku &&
      getBuyingSizeKey(source.size) === cleanSize
    )
    .forEach((source) => {
      addBuyingSourceToProductMap(productMap, { ...source }, cleanInventoryType);
    });

  const products = normalizeBuyingProducts(productMap);

  const selectedSize = products
    .flatMap((product) => product.sizes || [])
    .find((item) => getBuyingSizeKey(item.size) === cleanSize);

  const matchingSources = [...(selectedSize?.sources || [])].sort(
    (a, b) => Number(a.compare_price || 0) - Number(b.compare_price || 0)
  );

  return {
    selectedSource: matchingSources[0] || null,
    matchingSources,
    product: products[0] || null
  };
}

function getBuyingPurchaseStatusForSource(source) {
  return source?.source_type === "kc_owned" ? "KC Pending" : "Offers Sent";
}

function buildBuyingSourceSnapshot(sources) {
  return JSON.stringify(
    (sources || []).map((source) => ({
      source_type: source.source_type,
      source_id: source.source_id,
      seller_id: source.seller_id || "",
      seller_record_id: source.seller_record_id || "",
      sku: source.sku,
      size: source.size,
      vat_type: source.vat_type,
      price: Number(source.price || 0),
      display_price: Number(source.display_price || 0),
      compare_price: Number(source.compare_price || 0),
      quantity: Number(source.quantity || 0)
    })),
    null,
    2
  );
}

async function fetchAllConsignmentInventoryRows() {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from("consignment_inventory")
      .select(`
        id,
        seller_record_id,
        seller_id,
        product_name,
        sku,
        size,
        brand,
        vat_type,
        selling_price_suggested,
        quantity,
        image_url
      `)
      .gt("quantity", 0)
      .gt("selling_price_suggested", 0)
      .range(from, to);

    if (error) throw error;

    const rows = data || [];
    allRows.push(...rows);

    if (rows.length < pageSize) break;

    from += pageSize;
  }

  return allRows;
}

async function refreshBuyingMasterCache() {
  if (buyingMasterCache.refreshPromise) {
    return buyingMasterCache.refreshPromise;
  }

  buyingMasterCache.refreshPromise = (async () => {
    const inventoryRecords = await airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Picture",
          "Ideal Selling Price",
          "VAT Type",
          "Availability Status"
        ],
        filterByFormula: `AND(
          {Availability Status} = 'Available',
          {SKU} != '',
          {Size} != '',
          {Ideal Selling Price} > 0
        )`,
        maxRecords: 500
      })
      .all();

    const inventorySources = inventoryRecords.map(getBuyingInventoryProduct);

    let rawConsignmentRows;
    
    try {
      rawConsignmentRows = await fetchAllConsignmentInventoryRows();
    } catch (err) {
      console.error("BUYING CONSIGNMENT INVENTORY ERROR:", {
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
        statusCode: err.statusCode,
        stack: err.stack
      });
    
      throw err;
    }
    
    const consignmentStockKeys = [
      ...new Set(
        (rawConsignmentRows || [])
          .map((row) => getStockCounterKey(row.sku, row.size))
          .filter(Boolean)
      )
    ];

    let consignmentStockLevelMap = new Map();

    if (consignmentStockKeys.length) {
      const batchSize = 100;
      const concurrency = 5;
      const batches = [];
    
      for (let i = 0; i < consignmentStockKeys.length; i += batchSize) {
        batches.push(consignmentStockKeys.slice(i, i + batchSize));
      }
    
      const allConsignmentStockLevels = [];
    
      for (let i = 0; i < batches.length; i += concurrency) {
        const batchGroup = batches.slice(i, i + concurrency);
    
        const results = await Promise.all(
          batchGroup.map(async (keyBatch) => {
            const {
              data: consignmentStockLevels,
              error: consignmentStockLevelError
            } = await supabase
              .from("consignment_stock_levels")
              .select("stock_counter_key, stock_level, lowest_suggested_price")
              .in("stock_counter_key", keyBatch);
    
            if (consignmentStockLevelError) {
              throw consignmentStockLevelError;
            }
    
            return consignmentStockLevels || [];
          })
        );
    
        for (const rows of results) {
          allConsignmentStockLevels.push(...rows);
        }
      }
    
      consignmentStockLevelMap = new Map(
        allConsignmentStockLevels.map((row) => [
          row.stock_counter_key,
          {
            stock_level: Number(row.stock_level || 0),
            lowest_suggested_price: Number(row.lowest_suggested_price || 0)
          }
        ])
      );
    }

    const consignmentRows = (rawConsignmentRows || []).filter((row) => {
      const stockKey = getStockCounterKey(row.sku, row.size);
      const stockInfo = consignmentStockLevelMap.get(stockKey);

      return (
        Number(row.quantity || 0) > 0 &&
        Number(row.selling_price_suggested || 0) > 0 &&
        Number(stockInfo?.stock_level || 0) > 0
      );
    });

    const consignmentImageMap = await buildConsignmentImageMap(consignmentRows || []);

    cacheConsignmentImages(consignmentRows || [], consignmentImageMap).catch((err) => {
      console.error("Failed to cache consignment images:", err);
    });

    const consignmentSources = (consignmentRows || []).map((row) =>
      getBuyingConsignmentProduct(row, consignmentImageMap)
    );

    const sources = [...inventorySources, ...consignmentSources];

    buyingMasterCache.sources = sources;
    buyingMasterCache.createdAt = Date.now();

    return sources;
  })();

  try {
    return await buyingMasterCache.refreshPromise;
  } finally {
    buyingMasterCache.refreshPromise = null;
  }
}

async function getBuyingMasterSources() {
  const hasCache = Array.isArray(buyingMasterCache.sources);
  const isStale = Date.now() - buyingMasterCache.createdAt > BUYING_MASTER_CACHE_TTL_MS;

  if (hasCache) {
    if (isStale && !buyingMasterCache.refreshPromise) {
      refreshBuyingMasterCache().catch((err) => {
        console.error("Failed to refresh buying master cache:", err);
      });
    }

    return buyingMasterCache.sources;
  }

  return refreshBuyingMasterCache();
}

app.get("/api/buying/products", async (req, res) => {
  try {
    const search = asText(req.query.search).toLowerCase();
    const brand = asText(req.query.brand);
    const sort = asText(req.query.sort) || "price_low";
    const inventoryType = asText(req.query.inventory_type) || "all";

    const sources = await getBuyingMasterSources();

    let products = buildBuyingProductsFromSources(sources, inventoryType);

    if (brand) {
      products = products.filter((product) => product.brand === brand);
    }

    if (search) {
      products = products.filter((product) =>
        [
          product.product_name,
          product.sku,
          product.brand,
          ...product.sizes.map((size) => size.size)
        ].join(" ").toLowerCase().includes(search)
      );
    }

    if (sort === "az") {
      products.sort((a, b) => a.product_name.localeCompare(b.product_name));
    } else if (sort === "za") {
      products.sort((a, b) => b.product_name.localeCompare(a.product_name));
    } else if (sort === "price_high") {
      products.sort((a, b) => Number(b.from_price || 0) - Number(a.from_price || 0));
    } else {
      products.sort((a, b) => Number(a.from_price || 0) - Number(b.from_price || 0));
    }

    res.json({
      count: products.length,
      products
    });
  } catch (err) {
    console.error("Failed to load buying products:", err);

    res.status(500).json({
      error: "Failed to load buying products",
      details: err.message
    });
  }
});

async function sendBuyingKcConfirmationRequest({ memberWtbRecordId, fields }) {
  if (!BUYING_KC_CONFIRMATION_CHANNEL_ID) {
    console.warn("Skipping KC confirmation: missing BUYING_KC_CONFIRMATION_CHANNEL_ID");
    return null;
  }

  await initKickzDealDiscord();

  const channel = await kickzDealDiscordClient.channels.fetch(BUYING_KC_CONFIRMATION_CHANNEL_ID);

  const maxPrice = Number(fields["Max Price"] || 0);

  const message = await channel.send({
    embeds: [{
      title: "🟡 KC Stock Confirmation Needed",
      description: [
        `**${asText(fields["Product Name"]) || "—"}**`,
        "",
        `**SKU:** ${asText(fields["SKU"]) || "—"}`,
        `**Size:** ${asText(fields["Size"]) || "—"}`,
        `**Brand:** ${asText(fields["Brand"]) || "—"}`,
        `**Buy Now Price:** €${maxPrice.toFixed(2)}`,
        "",
        "Confirm only if KC stock is still available."
      ].join("\n"),
      color: 0xf1c40f,
      footer: {
        text: `Member WTB: ${memberWtbRecordId}`
      },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Confirm",
          custom_id: `confirm_member_wtb_kc:${memberWtbRecordId}`
        },
        {
          type: 2,
          style: 4,
          label: "Deny",
          custom_id: `deny_member_wtb_kc:${memberWtbRecordId}`
        }
      ]
    }]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    url: message.url
  };
}

async function sendBuyingKcOfferRequest({ memberWtbRecordId, fields }) {
  if (!BUYING_KC_OFFER_REQUESTS_CHANNEL_ID) {
    console.warn("Skipping KC offer request: missing BUYING_KC_OFFER_REQUESTS_CHANNEL_ID");
    return null;
  }

  await initKickzDealDiscord();

  const channel = await kickzDealDiscordClient.channels.fetch(
    BUYING_KC_OFFER_REQUESTS_CHANNEL_ID
  );

  const maxPrice = Number(fields["Max Price"] || 0);

  const message = await channel.send({
    embeds: [{
      title: "🟡 KC Buying Offer Received",
      description: [
        `**${asText(fields["Product Name"]) || "—"}**`,
        "",
        `**SKU:** ${asText(fields["SKU"]) || "—"}`,
        `**Size:** ${asText(fields["Size"]) || "—"}`,
        `**Brand:** ${asText(fields["Brand"]) || "—"}`,
        `**Buyer Offer:** €${maxPrice.toFixed(2)}`,
        `**Inventory Filter:** ${asText(fields["Buying Inventory Filter"]) || "—"}`,
        "",
        "Accept only if KC wants to fulfill this Member WTB at this price."
      ].join("\n"),
      color: 0xf1c40f,
      footer: {
        text: `Member WTB: ${memberWtbRecordId}`
      },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Accept KC Offer",
          custom_id: `accept_member_wtb_kc_offer:${memberWtbRecordId}`
        },
        {
          type: 2,
          style: 4,
          label: "Deny",
          custom_id: `deny_member_wtb_kc_offer:${memberWtbRecordId}`
        }
      ]
    }]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    url: message.url
  };
}

async function postMemberWtbToWtbBot({
  recordId,
  productName,
  sku,
  size,
  brand,
  imageUrl
}) {
  const wtbBotBaseUrl = process.env.KICKZ_WTB_BOT_BASE_URL;

  if (!wtbBotBaseUrl) {
    console.warn("Skipping Member WTB Discord post: missing KICKZ_WTB_BOT_BASE_URL");
    return null;
  }

  const response = await fetch(`${wtbBotBaseUrl.replace(/\/$/, "")}/partner-offer-deal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sourceType: "member_wtb",
      recordId,
      productName,
      sku,
      size,
      brand,
      imageUrl
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.details || "WTB bot post failed");
  }

  return data;
}

function memberWtbAllowsConsignmentRequests(recordFields) {
  return (
    asText(recordFields["Purchase Status"]) === "Offers Sent" &&
    asText(recordFields["Fulfillment Status"]) === "Outsource"
  );
}

function getAllowedBuyingVatTypesFromLabel(label) {
  const clean = asText(label);

  if (clean === "B2B Only") return ["VAT0", "VAT21"];
  if (clean === "Margin Only") return ["Margin"];

  return ["Margin", "VAT0", "VAT21"];
}

function calculateMemberWtbConsignorOfferPrice({
  currentLowestSourcePrice,
  buyingInventoryFilter,
  consignorVatType
}) {
  const basePrice = Number(currentLowestSourcePrice || 0);
  const filter = asText(buyingInventoryFilter);
  const vatType = asText(consignorVatType);

  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return 0;
  }

  if (filter === "All Inventory") {
    if (vatType === "VAT0") {
      return Math.round(basePrice / 1.21);
    }

    return Math.round(basePrice);
  }

  if (filter === "B2B Only") {
    if (vatType === "VAT21") {
      return Math.round(basePrice * 1.21);
    }

    return Math.round(basePrice);
  }

  return Math.round(basePrice);
}

async function sendMemberWtbConsignmentRequests(memberWtbRecordId) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  if (!memberWtbAllowsConsignmentRequests(f)) {
    return {
      ok: false,
      skipped: true,
      reason: "member_wtb_not_open"
    };
  }

  const sku = normalizeSku(f["SKU"]);
  const size = getBuyingSizeKey(f["Size"]);
  const currentLowestSourcePrice = Number(f["Current Lowest Source Price"] || 0);
  const buyingInventoryFilter = asText(f["Buying Inventory Filter"]);
  const allowedVatTypes = getAllowedBuyingVatTypesFromLabel(f["Buying Inventory Filter"]);

  if (!sku || !size || !Number.isFinite(currentLowestSourcePrice) || currentLowestSourcePrice <= 0) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_sku_size_or_offer_price"
    };
  }

  const { data: inventoryRows, error: inventoryError } = await supabase
    .from("consignment_inventory")
    .select(`
      id,
      product_name,
      sku,
      size,
      brand,
      vat_type,
      selling_price_suggested,
      quantity,
      seller_id,
      seller_record_id
    `)
    .eq("sku", sku)
    .eq("size", size)
    .gt("quantity", 0)
    .in("vat_type", allowedVatTypes);

  if (inventoryError) throw inventoryError;

  const results = [];

  for (const row of inventoryRows || []) {
    const sellerPrice = Number(row.selling_price_suggested || 0);
    const rowOfferPrice = calculateMemberWtbConsignorOfferPrice({
      currentLowestSourcePrice,
      buyingInventoryFilter,
      consignorVatType: row.vat_type
    });

    if (!Number.isFinite(sellerPrice) || sellerPrice <= 0) {
      continue;
    }

    const { data: existingOffers, error: existingError } = await supabase
      .from("consignment_offers")
      .select("id")
      .eq("source_type", "member_wtb")
      .eq("member_wtb_record_id", memberWtbRecordId)
      .eq("seller_record_id", row.seller_record_id)
      .eq("inventory_id", row.id)
      .eq("status", "open")
      .limit(1);

    if (existingError) throw existingError;

    if (existingOffers?.length) {
      results.push({
        mode: "skipped_existing",
        offer_id: existingOffers[0].id
      });

      continue;
    }

    const offerPayload = {
      source_type: "member_wtb",
      member_wtb_record_id: memberWtbRecordId,

      order_record_id: null,
      order_id:
        asText(f["Member WTB ID"]) ||
        asText(f["WTB ID"]) ||
        memberWtbRecordId,

      sku: row.sku,
      size: row.size,
      product_name: row.product_name || asText(f["Product Name"]),
      brand: row.brand || asText(f["Brand"]),

      seller_record_id: row.seller_record_id,
      seller_id: row.seller_id,
      inventory_id: row.id,

      seller_price: sellerPrice,
      offer_price: rowOfferPrice,
      vat_type: row.vat_type,
      quantity_at_offer: Number(row.quantity || 0),

      status: "open",
      discord_channel_id: null,
      discord_message_id: null,
      discord_delivery_type: null,
      discord_delivery_error: null,
      updated_at: new Date().toISOString()
    };

    const { data: createdOffer, error: createError } = await supabase
      .from("consignment_offers")
      .insert(offerPayload)
      .select()
      .single();

    if (createError) throw createError;

    const sellerRecord = await airtable(SELLERS_TABLE).find(row.seller_record_id);
    const sellerRow = normalizeSeller(sellerRecord);

    let discordResult = null;

    try {
      discordResult = await sendConsignmentOfferDiscordMessage({
        seller: sellerRow,
        offer: createdOffer,
        calculatedOfferPrice: rowOfferPrice
      });

      await supabase
        .from("consignment_offers")
        .update({
          discord_channel_id: discordResult.channelId,
          discord_message_id: discordResult.messageId,
          discord_delivery_type: discordResult.deliveryType,
          discord_delivery_error: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", createdOffer.id);
    } catch (err) {
      console.error("Failed to deliver Member WTB consignment request:", {
        offerId: createdOffer.id,
        sellerId: createdOffer.seller_id,
        sellerRecordId: createdOffer.seller_record_id,
        error: err.message
      });

      await supabase
        .from("consignment_offers")
        .update({
          discord_delivery_error: err.message,
          updated_at: new Date().toISOString()
        })
        .eq("id", createdOffer.id);
    }

    results.push({
      mode: "created",
      offer_id: createdOffer.id,
      discord_channel_id: discordResult?.channelId || null,
      discord_message_id: discordResult?.messageId || null
    });
  }

  return {
    ok: true,
    count: results.length,
    results
  };
}

function getBuyingCurrentLowestSourcePriceForMemberWtb({
  selectedSource,
  inventoryType,
  maxPrice
}) {
  const sourceType = asText(selectedSource?.source_type);
  const vatType = asText(selectedSource?.vat_type);
  const sellerPrice = Number(selectedSource?.seller_price || 0);
  const displayPrice = Number(selectedSource?.display_price || 0);
  const filterLabel = getBuyingInventoryFilterLabel(inventoryType);

  if (sourceType !== "consignment") {
    return Math.round(Math.max(0, Number(maxPrice || 0) - 10));
  }

  if (filterLabel === "All Inventory") {
    if (vatType === "VAT0") {
      return Math.round(sellerPrice * 1.21);
    }

    return Math.round(sellerPrice);
  }

  if (filterLabel === "B2B Only") {
    return Math.round(sellerPrice);
  }

  return Math.round(sellerPrice || displayPrice);
}

app.post('/api/member-wtb/process-seller-offer', async (req, res) => {
  try {
    const secret = asText(req.headers['x-kc-secret']);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const sellerOfferRecordId = asText(req.body?.seller_offer_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: 'Missing member_wtb_record_id' });
    }

    if (!sellerOfferRecordId) {
      return res.status(400).json({ error: 'Missing seller_offer_record_id' });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const memberFields = memberWtb.fields || {};

    if (asText(memberFields['Fulfillment Status']) === 'Allocated') {
      return res.status(409).json({ error: 'Member WTB already allocated' });
    }
    
    const sellerOffer = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferRecordId);
    const offerFields = sellerOffer.fields || {};

    const sellerRecordId = Array.isArray(offerFields['Seller ID'])
      ? offerFields['Seller ID'][0]
      : '';

    if (!sellerRecordId) {
      return res.status(400).json({ error: 'Seller Offer missing Seller ID' });
    }

    // FIXED — CRITICAL: this always re-read the Seller Offer record's
    // own raw price, completely ignoring any counter-offer
    // negotiation — the seller's DM/channel could show a correctly
    // negotiated payout, but the actual payment/inventory processing
    // step here would silently fall back to the ORIGINAL, uncountered
    // price. The "Process Deal" button now carries the negotiated
    // payout through (see discord-wtb-bot-main), and an override here
    // takes priority when present — falls back to the exact existing
    // behavior otherwise, so the original (non-countered) accept flow
    // is completely unaffected.
    const overridePurchasePrice = req.body?.override_purchase_price != null
      ? Number(req.body.override_purchase_price)
      : null;
    const overrideVatTypeForProcessing = req.body?.override_vat_type
      ? asText(req.body.override_vat_type)
      : null;

    const purchasePrice = Number.isFinite(overridePurchasePrice) && overridePurchasePrice > 0
      ? overridePurchasePrice
      : Number(offerFields['Seller Offer'] || 0);

    const vatType = overrideVatTypeForProcessing || asText(offerFields['Offer VAT Type']);

    const isOpenWtbFlow = memberFields['Auto Accept Seller Offers?'] !== true;

    let finalBuyingPrice;

    if (isOpenWtbFlow) {
      const offerMargin = Number(memberFields['Offer Margin'] || 10);
      const offerToBuyer = Number(memberFields['Offer To Buyer'] || 0);

      if (vatType === 'VAT0') {
        finalBuyingPrice = purchasePrice + offerMargin;
      } else if (vatType === 'VAT21') {
        finalBuyingPrice = (purchasePrice / 1.21) + offerMargin;
      } else {
        finalBuyingPrice = offerToBuyer || purchasePrice + offerMargin;
      }

      finalBuyingPrice = Math.round(finalBuyingPrice * 100) / 100;
    } else {
      const maxPrice = Number(memberFields['Max Price'] || 0);

      finalBuyingPrice = getMemberWtbNetSalePrice(
        maxPrice,
        vatType,
        memberFields["Buying Inventory Filter"]
      );
    }

    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      return res.status(400).json({ error: 'Invalid seller offer price' });
    }

    const memberWtbId =
      asText(memberFields['Member WTB ID']) ||
      asText(memberFields['WTB ID']) ||
      memberWtbRecordId;

    const inventoryFields = {
      'Product Name': asText(memberFields['Product Name']),
      'SKU': asText(memberFields['SKU']),
      'Size': asText(memberFields['Size']),
      'Brand': asText(memberFields['Brand']),

      'VAT Type': vatType,
      'Purchase Price': purchasePrice,
      'Shipping Deduction': 0,
      'Purchase Date': new Date().toLocaleDateString('en-CA'),

      'Seller ID': [sellerRecordId],
      'Ticket Number': memberWtbId,

      'Type': 'Custom',
      'Source': 'Outsourced',
      'Verification Status': 'Verified',
      'Payment Note': `€${purchasePrice.toFixed(2)}`,
      'Payment Status': 'To Pay',
      'Availability Status': 'Sold',
      'Selling Price': finalBuyingPrice,
      'Selling Method': 'Kickz Caviar',
      'Member WTBs': [memberWtbRecordId]
    };

    const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).create(inventoryFields);

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      'Purchase Status': 'Confirmed',
      'Fulfillment Status': 'Allocated',
      'Linked Inventory Unit': [inventoryUnit.id],
      'Final Buying Price': finalBuyingPrice,
    });
    
    await disableMemberWtbKcOfferButtons(
      memberWtbRecordId,
      "❌ This Member WTB was already allocated to another seller."
    );

    const paymentGate = await handleMemberWtbPaymentGate(memberWtbRecordId);

    return res.json({
      ok: true,
      inventory_unit_record_id: inventoryUnit.id,
      member_wtb_record_id: memberWtbRecordId,
      seller_offer_record_id: sellerOfferRecordId,
      payment_gate: paymentGate
    });
  } catch (err) {
    console.error('Failed to process Member WTB seller offer:', err);

    return res.status(500).json({
      error: 'Failed to process Member WTB seller offer',
      details: err.message
    });
  }
});

app.post('/api/member-wtb/send-current-offer-to-buyer', async (req, res) => {
  try {
    const secret = asText(req.headers['x-kc-secret']);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: 'Missing member_wtb_record_id' });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const f = memberWtb.fields || {};

    if (asText(f["Fulfillment Status"]) === "Allocated") {
      return res.status(409).json({ error: "Member WTB already allocated" });
    }

    const buyerRecordId = firstLinkedRecordId(f["Buyer Seller ID"]);

    if (!buyerRecordId) {
      return res.status(400).json({ error: "Member WTB missing Buyer Seller ID" });
    }

    const currentSellerOfferId = firstLinkedRecordId(f["Current Lowest Seller Offer"]);

    if (!currentSellerOfferId) {
      return res.status(400).json({ error: "No current seller offer found" });
    }

    const offerToBuyer = Number(f["Offer To Buyer"] || 0);

    if (!Number.isFinite(offerToBuyer) || offerToBuyer <= 0) {
      return res.status(400).json({ error: "Offer To Buyer is empty or invalid" });
    }

    const buyerRecord = await airtable(SELLERS_TABLE).find(buyerRecordId);
    const buyer = normalizeSeller(buyerRecord);

    const discordUserId = asText(
      buyer.discord_id ||
      buyer.discord_user_id ||
      buyer.discord_id_raw ||
      buyerRecord.fields?.["Discord User ID"]
    );

    if (!discordUserId) {
      return res.status(400).json({ error: "Buyer is missing Discord ID" });
    }

    await disableMemberWtbBuyerOfferMessage(
      f,
      "❌ A better or newer offer is now available."
    ).catch(() => null);

    await initKickzDealDiscord();

    const user = await kickzDealDiscordClient.users.fetch(discordUserId);
    const dm = await user.createDM();

    const memberWtbId =
      asText(f["Member WTB ID"]) ||
      asText(f["WTB ID"]) ||
      memberWtbRecordId;

    const imageUrl =
      Array.isArray(f["Picture"]) && f["Picture"][0]?.url
        ? f["Picture"][0].url
        : "";

    const embed = {
      title: "🔥 New Offer Received",
      description: [
        `**Order Number:** ${memberWtbId}`,
        "",
        `**Product:** ${asText(f["Product Name"]) || "—"}`,
        `**SKU:** ${asText(f["SKU"]) || "—"}`,
        `**Size:** ${asText(f["Size"]) || "—"}`,
        "",
        `**Current Offer:** €${offerToBuyer.toFixed(2)}${asText(f["Buyer VAT ID"]) ? ` ${asText(f["Lowest Offer VAT Type"]) || ""}` : ""}`,
        "",
        "Accept this offer to continue with the order."
      ].join("\n"),
      color: 0xf1c40f,
      timestamp: new Date().toISOString(),
      ...(imageUrl ? { image: { url: imageUrl } } : {})
    };

    const message = await dm.send({
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Accept Offer",
              custom_id: `accept_member_wtb_buyer_offer:${memberWtbRecordId}:${currentSellerOfferId}`
            },
            {
              type: 2,
              style: 1,
              label: "Counter",
              custom_id: `counter_member_wtb_buyer:${memberWtbRecordId}:${currentSellerOfferId}`
            },
            {
              type: 2,
              style: 4,
              label: "Decline",
              custom_id: `decline_member_wtb_buyer_offer:${memberWtbRecordId}`
            }
          ]
        }
      ]
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Buyer Offer Channel ID": message.channelId,
      "Buyer Offer Message ID": message.id,
      "Offer Sent?": true,
      "New Offer Available": false
    });

    return res.json({
      ok: true,
      member_wtb_record_id: memberWtbRecordId,
      buyer_offer_channel_id: message.channelId,
      buyer_offer_message_id: message.id
    });
  } catch (err) {
    console.error("Failed to send current offer to buyer:", err);

    return res.status(500).json({
      error: "Failed to send current offer to buyer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: Step 1 of the Member WTB ping-pong (mirrors the
// Store Orders round-1 blueprint). The buyer counters the current
// lowest seller offer; fans out a Counter Offer record (Source Type
// "Member WTB") to every seller with an active offer on this WTB, same
// "maximize chance someone accepts" principle already used for Store
// Orders. Uses the flat €10 margin (calculateMemberWtbSellerPayout),
// not the dynamic Store Orders margin formula.
// ---------------------------------------------------------------------
app.post("/api/member-wtb-counter-offers/create", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const sellerOfferId = asText(req.body?.seller_offer_record_id);
    const buyerCounterPrice = Number(req.body?.price);

    if (!memberWtbRecordId || !sellerOfferId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id or seller_offer_record_id" });
    }

    if (!Number.isInteger(buyerCounterPrice) || buyerCounterPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const wtbFields = memberWtb.fields || {};

    const memberWtbId = asText(wtbFields["Member WTB ID"]) || memberWtbRecordId;
    const productName = asText(wtbFields["Product Name"]);
    const sku = asText(wtbFields["SKU"]);
    const size = asText(wtbFields["Size"]);

    // FIXED — was a broadcast to every seller with an offer on this
    // WTB, copied from the Store Orders pattern without re-checking
    // whether that made sense here. It doesn't: the buyer is reacting
    // to ONE specific offer they were shown, at that seller's specific
    // price and VAT type — broadcasting the same counter to other
    // sellers (who may have a different VAT type, e.g. "Margin") would
    // silently reinterpret the buyer's counter in a different context
    // than the one they actually responded to. Kept strictly 1-on-1.
    const sellerOfferRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferId).catch(() => null);

    if (!sellerOfferRecord) {
      return res.status(404).json({ error: "Seller offer not found." });
    }

    const sf = sellerOfferRecord.fields || {};

    if (sf["Delete Offer"] === true) {
      return res.status(409).json({ error: "This seller offer is no longer active." });
    }

    const sellerOriginalPrice = numberValue(sf["Seller Offer"]);
    const sellerVatType = asText(sf["Offer VAT Type"]);
    const sellerRecordId = firstLinkedRecordId(sf["Seller ID"]);

    if (!sellerOriginalPrice || !sellerRecordId) {
      return res.status(409).json({ error: "Seller offer is missing price or seller." });
    }

    // Scale mismatch guard: sellerOriginalPrice is in SELLER terms
    // (their raw ask), buyerCounterPrice is in BUYER terms (what the
    // buyer wants to pay, same scale as what was shown to them).
    // Convert the seller's ask UP to buyer terms first, then compare.
    const sellerAskInBuyerTerms = calculateMemberWtbBuyerEquivalent(
      sellerOriginalPrice,
      sellerVatType,
      wtbFields
    );

    if (!Number.isFinite(sellerAskInBuyerTerms) || buyerCounterPrice >= sellerAskInBuyerTerms) {
      return res.status(400).json({
        error: `Your counter must be lower than the current offer (€${Number(sellerAskInBuyerTerms).toFixed(2)}).`
      });
    }

    const recomputedPayout = calculateMemberWtbSellerPayout(buyerCounterPrice, sellerVatType, wtbFields);

    if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) {
      return res.status(400).json({ error: "Could not compute a valid payout for this counter." });
    }

    const createdCounter = await airtable(COUNTER_OFFERS_TABLE).create({
      "Member WTB": [memberWtbRecordId],
      "Seller ID": [sellerRecordId],
      "Seller Offer Record ID": sellerOfferId,
      "Source Type": "Member WTB",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": buyerCounterPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Status": "Open"
    });

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    let dmErrors = 0;

    if (sellerDiscordId) {
      const discordResult = await sendMemberWtbCounterOfferDiscordDM({
        counterOfferRecordId: createdCounter.id,
        sellerDiscordId,
        productName,
        sku,
        size,
        memberWtbId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType
      }).catch((err) => {
        dmErrors++;
        console.error("Failed to DM seller of member WTB counter (non-blocking):", err);
        return null;
      });

      if (discordResult) {
        await airtable(COUNTER_OFFERS_TABLE).update(createdCounter.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        });
      }
    }

    res.json({ ok: true, counter_offer_record_id: createdCounter.id, dm_errors: dmErrors });
  } catch (err) {
    console.error("Failed to create member WTB counter offers:", err);
    res.status(500).json({ error: "Failed to create counter offers", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: Step 2 of the Member WTB ping-pong. The seller
// counters back on the buyer's counter, mirroring the Store Orders
// seller-counter endpoint (same chain-aware own-reference lookup, same
// min-step validation), but converting between buyer/seller terms with
// the Member WTB flat-€10-margin functions instead of Store Orders'
// dynamic margin formula.
// ---------------------------------------------------------------------
app.post("/api/member-wtb-counter-offers/:id/seller-counter", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const previousRecordId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Counter must be a valid whole number." });
    }

    const previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const f = previousRecord.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
    const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);
    const buyerCounterPrice = numberValue(f["Store Counter Price"]);

    if (!memberWtbRecordId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing linked Member WTB or Seller." });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const wtbFields = memberWtb.fields || {};

    // Chain-aware own reference — same fix as Store Orders: if the
    // seller has already countered earlier in this back-and-forth, their
    // true own position is that counter, not the very original ask.
    let sellerOwnReference = sellerOriginalPrice;
    const priorRoundIdForSeller = asText(f["Previous Record ID"]);

    if (priorRoundIdForSeller) {
      const priorRoundForSeller = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundIdForSeller).catch(() => null);
      const priorSellerCounter = numberValue(priorRoundForSeller?.fields?.["Seller Counter Price"]);
      if (priorSellerCounter) {
        sellerOwnReference = priorSellerCounter;
      }
    }

    // Scale mismatch guard: buyerCounterPrice is in BUYER terms, must
    // convert to SELLER terms before comparing against the seller's own
    // reference (which is already seller-scale).
    const buyerPriceInSellerTerms = calculateMemberWtbSellerPayout(buyerCounterPrice, sellerVatType, wtbFields);

    if (!Number.isFinite(buyerPriceInSellerTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this WTB." });
    }

    const validation = validateNextCounterPrice(sellerOwnReference, buyerPriceInSellerTerms, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(previousRecordId, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Member WTB": [memberWtbRecordId],
      "Seller ID": [sellerRecordId],
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Source Type": "Member WTB",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Seller Counter Price": proposedPrice,
      "Previous Record ID": previousRecordId,
      "Status": "Open"
    });

    const buyerRecordId = firstLinkedRecordId(wtbFields["Buyer Seller ID"]);
    const buyerRecord = buyerRecordId ? await airtable(SELLERS_TABLE).find(buyerRecordId).catch(() => null) : null;
    const buyerDiscordId = asText(
      buyerRecord?.fields?.["Discord ID"] || buyerRecord?.fields?.["Discord User ID"]
    );

    let dmSent = false;

    if (buyerDiscordId) {
      // Proactive no-room check, mirroring Store Orders: is there any
      // valid step left for the buyer to counter again after this?
      const sellerCounterInBuyerTerms = calculateMemberWtbBuyerEquivalent(proposedPrice, sellerVatType, wtbFields);
      const noRoomToCounter =
        Number.isFinite(sellerCounterInBuyerTerms) &&
        !hasRoomForNextStep(buyerCounterPrice, sellerCounterInBuyerTerms);

      const discordResult = await sendMemberWtbBuyerCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        buyerDiscordId,
        productName: asText(wtbFields["Product Name"]),
        sku: asText(wtbFields["SKU"]),
        size: asText(wtbFields["Size"]),
        memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
        newPrice: sellerCounterInBuyerTerms,
        yourPreviousCounter: buyerCounterPrice,
        noRoomToCounter
      }).catch((err) => {
        console.error("Failed to DM buyer of seller counter-back (non-blocking):", err);
        return null;
      });

      if (discordResult) {
        dmSent = true;
        await airtable(COUNTER_OFFERS_TABLE).update(newRound.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        });
      }
    }

    res.json({ ok: true, counter_offer_record_id: newRound.id, dm_sent: dmSent });
  } catch (err) {
    console.error("Failed to process member WTB seller-counter:", err);
    res.status(500).json({ error: "Failed to process seller counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: buyer counters again on the seller's counter-
// back, mirroring the Store Orders store-counter endpoint (chain-aware
// own reference, one hop back via Previous Record ID since that always
// lands on the buyer's own prior round in an alternating chain).
// ---------------------------------------------------------------------
app.post("/api/member-wtb-counter-offers/:id/buyer-counter", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const previousRoundId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Counter must be a valid whole number." });
    }

    const previousRound = await airtable(COUNTER_OFFERS_TABLE).find(previousRoundId);
    const f = previousRound.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
    const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);
    const sellerCounterPrice = numberValue(f["Seller Counter Price"]);

    if (!memberWtbRecordId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing linked Member WTB or Seller." });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const wtbFields = memberWtb.fields || {};

    // One hop back via Previous Record ID always lands on the buyer's
    // own prior round in this alternating chain (same reasoning as the
    // Store Orders store-counter endpoint).
    const priorRoundId = asText(f["Previous Record ID"]);

    if (!priorRoundId) {
      return res.status(409).json({ error: "Missing previous round reference." });
    }

    const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId);
    const priorFields = priorRound.fields || {};
    const buyerOwnReference = numberValue(priorFields["Store Counter Price"]);

    // Scale mismatch guard: sellerCounterPrice is in SELLER terms, must
    // convert to BUYER terms before comparing.
    const sellerCounterInBuyerTerms = calculateMemberWtbBuyerEquivalent(sellerCounterPrice, sellerVatType, wtbFields);

    if (!Number.isFinite(sellerCounterInBuyerTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this WTB." });
    }

    const validation = validateNextCounterPrice(buyerOwnReference, sellerCounterInBuyerTerms, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(previousRoundId, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const recomputedPayout = calculateMemberWtbSellerPayout(proposedPrice, sellerVatType, wtbFields);

    if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) {
      return res.status(400).json({ error: "Could not compute a valid payout for this counter." });
    }

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Member WTB": [memberWtbRecordId],
      "Seller ID": [sellerRecordId],
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Source Type": "Member WTB",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": proposedPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": previousRoundId,
      "Status": "Open"
    });

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    let dmSent = false;

    if (sellerDiscordId) {
      const buyerOwnPosition = proposedPrice;
      const noRoomToCounter =
        Number.isFinite(recomputedPayout) &&
        !hasRoomForNextStep(sellerOriginalPrice, recomputedPayout);

      const discordResult = await sendMemberWtbCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(f["Product Name"]) || asText(wtbFields["Product Name"]),
        sku: asText(wtbFields["SKU"]),
        size: asText(wtbFields["Size"]),
        memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        noRoomToCounter
      }).catch((err) => {
        console.error("Failed to DM seller of buyer counter-back (non-blocking):", err);
        return null;
      });

      if (discordResult) {
        dmSent = true;
        await airtable(COUNTER_OFFERS_TABLE).update(newRound.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        });
      }
    }

    res.json({ ok: true, counter_offer_record_id: newRound.id, dm_sent: dmSent });
  } catch (err) {
    console.error("Failed to process member WTB buyer-counter:", err);
    res.status(500).json({ error: "Failed to process buyer counter", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: shared edit endpoint for Member WTB, mirroring
// the Store Orders edit endpoint exactly — same chain-aware own-
// reference lookup for both directions, same min-step rule as
// countering (per the earlier agreed consistency decision).
// ---------------------------------------------------------------------
app.post("/api/member-wtb-counter-offers/:id/edit", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (!process.env.KC_PORTAL_SECRET || secret !== process.env.KC_PORTAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const recordId = asText(req.params.id);
    const proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Counter must be a valid whole number." });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(recordId);
    const f = record.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer open." });
    }

    const previousRecordId = asText(f["Previous Record ID"]);

    if (!previousRecordId) {
      return res.status(409).json({ error: "Editing isn't supported for the very first counter yet." });
    }

    const hasSellerCounter =
      f["Seller Counter Price"] !== undefined &&
      f["Seller Counter Price"] !== null &&
      f["Seller Counter Price"] !== "";

    const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
    const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);

    if (!memberWtbRecordId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing linked Member WTB or Seller." });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const wtbFields = memberWtb.fields || {};

    const previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const previousFields = previousRecord.fields || {};

    let ownReferencePrice;
    let counterpartPrice;

    if (hasSellerCounter) {
      // Seller editing — chain-aware own reference, same lookup as the
      // seller-counter endpoint.
      let sellerOwnReference = sellerOriginalPrice;
      const grandparentIdForSeller = asText(previousFields["Previous Record ID"]);

      if (grandparentIdForSeller) {
        const grandparent = await airtable(COUNTER_OFFERS_TABLE).find(grandparentIdForSeller).catch(() => null);
        const priorSellerCounter = numberValue(grandparent?.fields?.["Seller Counter Price"]);
        if (priorSellerCounter) sellerOwnReference = priorSellerCounter;
      }

      ownReferencePrice = sellerOwnReference;

      const buyerPriceOnPreviousRound = numberValue(previousFields["Store Counter Price"]);
      counterpartPrice = calculateMemberWtbSellerPayout(buyerPriceOnPreviousRound, sellerVatType, wtbFields);
    } else {
      // Buyer editing — one hop back via the previous round's own
      // Previous Record ID lands on the buyer's own prior round (same
      // reasoning as the buyer-counter endpoint).
      const grandparentIdForBuyer = asText(previousFields["Previous Record ID"]);
      ownReferencePrice = grandparentIdForBuyer
        ? numberValue((await airtable(COUNTER_OFFERS_TABLE).find(grandparentIdForBuyer).catch(() => null))?.fields?.["Store Counter Price"])
        : null;

      const sellerCounterOnPreviousRound = numberValue(previousFields["Seller Counter Price"]);
      counterpartPrice = calculateMemberWtbBuyerEquivalent(sellerCounterOnPreviousRound, sellerVatType, wtbFields);
    }

    if (!Number.isFinite(ownReferencePrice) || !Number.isFinite(counterpartPrice)) {
      return res.status(500).json({ error: "Could not compute reference prices for this edit." });
    }

    const validation = validateNextCounterPrice(ownReferencePrice, counterpartPrice, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const priceField = hasSellerCounter ? "Seller Counter Price" : "Store Counter Price";
    const updates = { [priceField]: proposedPrice };
    let recomputedPayoutForNotify = null;

    if (!hasSellerCounter) {
      recomputedPayoutForNotify = calculateMemberWtbSellerPayout(proposedPrice, sellerVatType, wtbFields);

      if (!Number.isFinite(recomputedPayoutForNotify) || recomputedPayoutForNotify <= 0) {
        return res.status(400).json({ error: "Could not compute a valid payout for this counter." });
      }

      updates["Counter Payout"] = recomputedPayoutForNotify;
      updates["Counter Payout VAT Type"] = sellerVatType;
    }

    await airtable(COUNTER_OFFERS_TABLE).update(recordId, updates);

    if (hasSellerCounter) {
      // Seller edited — notify the buyer with the revised counter.
      const buyerRecordId = firstLinkedRecordId(wtbFields["Buyer Seller ID"]);
      const buyerRecord = buyerRecordId ? await airtable(SELLERS_TABLE).find(buyerRecordId).catch(() => null) : null;
      const buyerDiscordId = asText(
        buyerRecord?.fields?.["Discord ID"] || buyerRecord?.fields?.["Discord User ID"]
      );

      if (buyerDiscordId) {
        const sellerCounterInBuyerTerms = calculateMemberWtbBuyerEquivalent(proposedPrice, sellerVatType, wtbFields);

        await sendMemberWtbBuyerCounterOfferDiscordDM({
          counterOfferRecordId: recordId,
          buyerDiscordId,
          productName: asText(wtbFields["Product Name"]),
          sku: asText(wtbFields["SKU"]),
          size: asText(wtbFields["Size"]),
          memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
          newPrice: sellerCounterInBuyerTerms,
          yourPreviousCounter: numberValue(previousFields["Store Counter Price"])
        }).catch((err) => console.error("Failed to notify buyer of edited counter (non-blocking):", err));
      }
    } else {
      // Buyer edited — notify the seller with the revised counter.
      const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null);
      const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);

      if (sellerDiscordId) {
        await sendMemberWtbCounterOfferDiscordDM({
          counterOfferRecordId: recordId,
          sellerDiscordId,
          productName: asText(wtbFields["Product Name"]),
          sku: asText(wtbFields["SKU"]),
          size: asText(wtbFields["Size"]),
          memberWtbId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
          payout: recomputedPayoutForNotify,
          vatType: sellerVatType,
          sellerOriginalPrice,
          sellerOriginalVatType: sellerVatType
        }).catch((err) => console.error("Failed to notify seller of edited counter (non-blocking):", err));
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to edit member WTB counter offer:", err);
    res.status(500).json({ error: "Failed to edit counter offer", details: err.message });
  }
});

app.post("/api/buying/offers", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const sellerId = asText(req.body?.seller_id);
    const sku = normalizeSku(req.body?.sku);
    const size = getBuyingSizeKey(req.body?.size);
    const inventoryType = normalizeBuyingInventoryType(req.body?.inventory_type);
    const offerPrice = Number(req.body?.offer_price);

    if (!sellerRecordId || !sellerId || !sku || !size) {
      return res.status(400).json({
        error: "Missing buyer, SKU or size"
      });
    }

    if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
      return res.status(400).json({
        error: "Invalid offer price"
      });
    }

    const liveSources = await getLiveBuyingSources({ force: true });

    const matchingSources = (liveSources || []).filter((source) => {
      const sourceSku = normalizeSku(source.sku);
      const sourceSize = getBuyingSizeKey(source.size);

      if (sourceSku !== sku || sourceSize !== size) return false;

      const sourceType = asText(source.source_type);
      const vatType = asText(source.vat_type);

      if (inventoryType === "b2b") {
        return vatType === "VAT0" || vatType === "VAT21";
      }

      if (inventoryType === "private") {
        return vatType === "Margin";
      }

      return ["kc", "consignment"].includes(sourceType);
    });

    const product =
      matchingSources[0] ||
      (liveSources || []).find((source) =>
        normalizeSku(source.sku) === sku &&
        getBuyingSizeKey(source.size) === size
      ) ||
      {};

    const imageUrl = asText(product.image_url);

    const currentLowestSourcePrice = Math.max(
      0,
      Math.round(offerPrice - 10)
    );

    const internalNotes = [
      "Buying Portal Offer",
      "",
      `Filter: ${getBuyingInventoryFilterLabel(inventoryType)}`,
      `Buyer Offer Price: ${buyingMoneyValue(offerPrice)}`,
      `Matching Sources: ${matchingSources.length}`,
      "KC Priority: No"
    ].join("\n");

    const fields = {
      "Product Name": asText(product.product_name) || sku,
      "SKU": sku,
      "Size": size,
      "Brand": asText(product.brand),
      "Date": new Date().toISOString(),

      "Max Price": offerPrice,
      "Current Lowest Source Price": currentLowestSourcePrice,
      "Fulfillment Status": "Outsource",
      "Purchase Status": "Offers Sent",
      "Payment Status": "Pending",

      "Buyer Seller ID": [sellerRecordId],
      "Auto Accept Seller Offers?": true,

      "Buying Inventory Filter": getBuyingInventoryFilterLabel(inventoryType),
      "Buying Selected Source Type": "Buyer Offer",
      "Buying Selected Source ID": "",
      "Buying Source Snapshot": buildBuyingSourceSnapshot(matchingSources),

      "Internal Notes": internalNotes
    };

    if (imageUrl) {
      fields["Picture"] = [{ url: imageUrl }];
    }

    const created = await airtable(MEMBER_WTBS_TABLE).create(fields);

    let wtbPost = null;
    let consignmentRequests = null;
    let kcOfferRequest = null;

    try {
      wtbPost = await postMemberWtbToWtbBot({
        recordId: created.id,
        productName: fields["Product Name"],
        sku,
        size,
        brand: fields["Brand"],
        imageUrl
      });
    } catch (err) {
      console.error("Failed to post Member WTB offer to WTB bot:", err);
    }

    try {
      consignmentRequests = await sendMemberWtbConsignmentRequests(created.id);
    } catch (err) {
      console.error("Failed to send Member WTB offer consignment requests:", err);
    }

    const hasMatchingKcOwnedSource = (matchingSources || []).some((source) => {
    const sourceType = asText(source.source_type || source.sourceType || source.type).toLowerCase();
  
    return (
      sourceType.includes("kc") ||
      sourceType.includes("owned")
    );
  });
  
  if (hasMatchingKcOwnedSource) {
    try {
      kcOfferRequest = await sendBuyingKcOfferRequest({
        memberWtbRecordId: created.id,
        fields
      });
      
      if (kcOfferRequest?.channelId && kcOfferRequest?.messageId) {
        await airtable(MEMBER_WTBS_TABLE).update(created.id, {
          "KC Offer Channel ID": kcOfferRequest.channelId,
          "KC Offer Message ID": kcOfferRequest.messageId
        });
      }
      
    } catch (err) {
      console.error("Failed to send KC offer request:", err);
    }
  }

    return res.json({
      success: true,
      member_wtb_record_id: created.id,
      purchase_status: "Offers Sent",
      max_price: offerPrice,
      max_price_display: buyingMoneyValue(offerPrice),
      wtb_posted: !!wtbPost,
      wtb_post: wtbPost,
      consignment_requests_sent: !!consignmentRequests,
      consignment_requests: consignmentRequests,
      kc_offer_request_sent: !!kcOfferRequest,
      kc_offer_request: kcOfferRequest
    });
  } catch (err) {
    console.error("Failed to create buying offer:", err);

    return res.status(500).json({
      error: "Failed to create buying offer",
      details: err.message
    });
  }
});

async function createOpenMemberWtb({
  sellerRecordId,
  sellerId,
  sku: rawSku,
  size: rawSize,
  maxPrice: rawMaxPrice,
  inventoryType: rawInventoryType,
  createdFrom = "Buying Portal"
}) {
  const sku = normalizeSku(rawSku);
  const size = getBuyingSizeKey(rawSize);
  const maxPrice = Number(rawMaxPrice);
  const inventoryType =
    normalizeBuyingInventoryType(rawInventoryType);

  if (!sellerRecordId || !sellerId) {
    const error = new Error("Buyer could not be identified");
    error.statusCode = 401;
    throw error;
  }

  if (!sku || !size) {
    const error = new Error("SKU and size are required");
    error.statusCode = 400;
    throw error;
  }

  if (
    !Number.isFinite(maxPrice) ||
    maxPrice <= 0
  ) {
    const error = new Error("Invalid max price");
    error.statusCode = 400;
    throw error;
  }

  const liveSources =
    await getLiveBuyingSources({
      force: true
    });

  let product =
    (liveSources || []).find(
      (source) =>
        normalizeSku(source.sku) === sku
    ) || null;

  if (!product) {
    let skuMasterRecords = await airtable(
      SKU_MASTER_TABLE
    )
      .select({
        filterByFormula:
          `{SKU} = "${escapeFormulaValue(sku)}"`,
        maxRecords: 1
      })
      .firstPage();

    let skuMaster = skuMasterRecords[0];

    if (!skuMaster) {
      skuMaster =
        await createSkuMasterFromRetailedIfExactSku(
          sku
        );
    }

    if (skuMaster) {
      const fields = skuMaster.fields || {};

      product = {
        product_name:
          asText(fields["Product Name"]),
        brand:
          asText(fields["Brand"]),
        image_url:
          Array.isArray(fields["Picture"]) &&
          fields["Picture"][0]?.url
            ? fields["Picture"][0].url
            : ""
      };
    } else {
      const retailedProduct =
        await lookupProductFromRetailed(sku)
          .catch(() => null);

      if (retailedProduct) {
        product = {
          product_name:
            asText(
              retailedProduct.product_name
            ) || sku,
          brand:
            asText(retailedProduct.brand),
          image_url:
            asText(retailedProduct.image)
        };
      }
    }
  }

  product = product || {};

  const productName =
    asText(product.product_name) || sku;

  const brand =
    asText(product.brand);

  const imageUrl =
    asText(product.image_url);

  const fields = {
    "Product Name": productName,
    "SKU": sku,
    "Size": size,
    "Brand": brand,
    "Date": new Date().toISOString(),

    "Max Price": maxPrice,
    "Offer Margin": 10,
    "Current Lowest Source Price": maxPrice,

    "Fulfillment Status": "Outsource",
    "Purchase Status": "Offers Sent",
    "Payment Status": "Pending",

    "Buyer Seller ID": [sellerRecordId],
    "Auto Accept Seller Offers?": false,

    "Buying Inventory Filter":
      getBuyingInventoryFilterLabel(
        inventoryType
      ),

    "Buying Selected Source ID": "",

    "Offer Sent?": false,
    "New Offer Available": false,

    "Internal Notes": [
      "Open WTB",
      "",
      `Filter: ${getBuyingInventoryFilterLabel(
        inventoryType
      )}`,
      `Buyer Max Price: ${buyingMoneyValue(
        maxPrice
      )}`,
      `Created From: ${createdFrom}`
    ].join("\n")
  };

  if (imageUrl) {
    fields["Picture"] = [
      {
        url: imageUrl
      }
    ];
  }

  const created = await airtable(
    MEMBER_WTBS_TABLE
  ).create(fields);

  let wtbPost = null;

  try {
    wtbPost =
      await postMemberWtbToWtbBot({
        recordId: created.id,
        productName,
        sku,
        size,
        brand,
        imageUrl
      });
  } catch (error) {
    console.error(
      "Failed to post Open Member WTB to WTB bot:",
      error
    );
  }

  return {
    success: true,
    member_wtb_record_id: created.id,
    purchase_status: "Offers Sent",
    wtb_posted: Boolean(wtbPost),
    wtb_post: wtbPost,
    product_name: productName,
    sku,
    size,
    max_price: maxPrice,
    inventory_type: inventoryType
  };
}

function detectMemberWtbCsvDelimiter(
  headerLine
) {
  const line = String(headerLine || "");

  const commaCount =
    (line.match(/,/g) || []).length;

  const semicolonCount =
    (line.match(/;/g) || []).length;

  const tabCount =
    (line.match(/\t/g) || []).length;

  if (
    semicolonCount > commaCount &&
    semicolonCount >= tabCount
  ) {
    return ";";
  }

  if (
    tabCount > commaCount &&
    tabCount > semicolonCount
  ) {
    return "\t";
  }

  return ",";
}

function parseMemberWtbCsvLine(
  line,
  delimiter = ","
) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (
    let index = 0;
    index < line.length;
    index += 1
  ) {
    const character = line[index];
    const nextCharacter =
      line[index + 1];

    if (
      character === '"' &&
      insideQuotes &&
      nextCharacter === '"'
    ) {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (
      character === delimiter &&
      !insideQuotes
    ) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  result.push(current.trim());

  return result;
}

function parseMemberWtbCsvText(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error(
      "CSV must include a header row and at least one WTB row."
    );
  }

  const delimiter =
    detectMemberWtbCsvDelimiter(lines[0]);

  const headers =
    parseMemberWtbCsvLine(
      lines[0],
      delimiter
    ).map((header) =>
      String(header || "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
    );

  const requiredColumns = [
    "sku",
    "size",
    "max price"
  ];

  const missingColumns =
    requiredColumns.filter(
      (column) =>
        !headers.includes(column)
    );

  if (missingColumns.length) {
    throw new Error(
      `Missing required columns: ${missingColumns.join(
        ", "
      )}`
    );
  }

  const columnIndex = (name) =>
    headers.indexOf(name);

  const rows = lines
    .slice(1)
    .map((line, index) => {
      const values =
        parseMemberWtbCsvLine(
          line,
          delimiter
        );

      return {
        row_number: index + 2,

        sku: normalizeSku(
          values[columnIndex("sku")]
        ),

        size:
          getBuyingSizeKey(
            values[columnIndex("size")]
          ),

        max_price: Number(
          String(
            values[
              columnIndex("max price")
            ] || ""
          ).replace(/[^\d]/g, "")
        )
      };
    });

  const errors = [];

  rows.forEach((row) => {
    if (!row.sku) {
      errors.push(
        `Row ${row.row_number}: missing SKU`
      );
    }

    if (!row.size) {
      errors.push(
        `Row ${row.row_number}: missing Size`
      );
    }

    if (
      !Number.isInteger(row.max_price) ||
      row.max_price <= 0
    ) {
      errors.push(
        `Row ${row.row_number}: invalid Max Price`
      );
    }
  });

  return {
    rows,
    errors
  };
}

async function findSellerByDiscordUserId(
  discordUserId
) {
  const safeDiscordUserId =
    escapeFormulaValue(discordUserId);

  const records = await airtable(
    SELLERS_TABLE
  )
    .select({
      filterByFormula:
        `{Discord ID} = '${safeDiscordUserId}'`,
      maxRecords: 1
    })
    .firstPage();

  return records[0] || null;
}

async function postMemberWtbDiscordPanel() {
  if (!MEMBER_WTB_POST_CHANNEL_ID) {
    throw new Error(
      "Missing MEMBER_WTB_POST_CHANNEL_ID"
    );
  }

  await initKickzDealDiscord();

  const channel =
    await kickzDealDiscordClient.channels
      .fetch(
        MEMBER_WTB_POST_CHANNEL_ID
      )
      .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      "Member WTB post channel not found"
    );
  }

  const templateUrl =
  `${APP_URL}/templates/member-wtb-template.csv`;
  
  const message = await channel.send({
  
    embeds: [
      {
        title: "📋 Post Member Want To Buys",
  
        description: [
          "Create a single Want To Buy using the button below.",
          "",
          "To create multiple WTBs:",
          "1. Download the attached CSV template.",
          "2. Fill in the SKU, Size and Max Price.",
          "3. Upload the completed CSV directly in this channel.",
          "",
          "The uploaded file will be processed automatically and removed afterwards.",
          "",
          "**Buying Type**",
          "Use the dropdown below to choose which inventory types you want to receive offers from.",
          "",
          "Your selection applies to both single WTBs and CSV uploads."
        ].join("\n"),
  
        color: 0xFFD700,
  
        footer: {
          text: "Kickz Caviar Member Marketplace"
        },
  
        timestamp: new Date().toISOString()
      }
    ],
  
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Create Member WTB",
            custom_id:
              MEMBER_WTB_DISCORD_PANEL_BUTTON_ID
          },
          {
            type: 2,
            style: 5,
            label: "Download CSV Template",
            url: templateUrl
          }
        ]
      },
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id:
              MEMBER_WTB_DISCORD_INVENTORY_SELECT_ID,
            placeholder: "Choose Buying Type",
            min_values: 1,
            max_values: 1,
            options: [
              {
                label: "All Types",
                value: "all",
                description:
                  "Receive offers from all inventory types",
                default: true
              },
              {
                label: "B2B Only",
                value: "b2b",
                description:
                  "Only VAT0 and VAT21 inventory"
              },
              {
                label: "Margin Only",
                value: "private",
                description:
                  "Only margin inventory"
              }
            ]
          }
        ]
      }
    ]
  });

  return {
    channel_id: message.channelId,
    message_id: message.id
  };
}

app.post(
  "/api/member-wtb/open",
  async (req, res) => {
    try {
      const result =
        await createOpenMemberWtb({
          sellerRecordId:
            asText(
              req.body?.seller_record_id
            ),

          sellerId:
            asText(req.body?.seller_id),

          sku:
            req.body?.sku,

          size:
            req.body?.size,

          maxPrice:
            req.body?.max_price,

          inventoryType:
            req.body?.inventory_type,

          createdFrom:
            "Buying Portal"
        });

      return res.json(result);
    } catch (error) {
      console.error(
        "Failed to create Open Member WTB:",
        error
      );

      return res
        .status(error.statusCode || 500)
        .json({
          error:
            error.message ||
            "Failed to create Open WTB"
        });
    }
  }
);

app.post("/api/buying/requests", async (req, res) => {
  try {
    const sellerRecordId = asText(req.body?.seller_record_id);
    const sellerId = asText(req.body?.seller_id);
    const sku = normalizeSku(req.body?.sku);
    const size = getBuyingSizeKey(req.body?.size);
    const inventoryType = normalizeBuyingInventoryType(req.body?.inventory_type);

    if (!sellerRecordId || !sellerId || !sku || !size) {
      return res.status(400).json({
        error: "Missing buyer, SKU or size"
      });
    }

    const liveSources = await getLiveBuyingSources({ force: true });

    const {
      selectedSource,
      matchingSources,
      product
    } = selectBuyingSourceFromLiveSources({
      sources: liveSources,
      sku,
      size,
      inventoryType
    });

    if (!selectedSource) {
      return res.status(409).json({
        error: "Out Of Stock"
      });
    }

    const maxPrice = Number(selectedSource.display_price || 0);
    const purchaseStatus = getBuyingPurchaseStatusForSource(selectedSource);

    const imageUrl =
      selectedSource.image_url ||
      product?.image_url ||
      "";

    const internalNotes = [
      "Buying Portal Request",
      "",
      `Filter: ${getBuyingInventoryFilterLabel(inventoryType)}`,
      `Selected Source: ${selectedSource.source_type}`,
      `Selected Source ID: ${selectedSource.source_id}`,
      `Selected Seller: ${selectedSource.seller_id || "KC"}`,
      `Matching Sources: ${matchingSources.length}`,
      `Buy Now Price: ${buyingMoneyValue(maxPrice)}`
    ].join("\n");

    const fields = {
      "Product Name": selectedSource.product_name || product?.product_name || sku,
      "SKU": selectedSource.sku || sku,
      "Size": selectedSource.size || size,
      "Brand": selectedSource.brand || product?.brand || "",
      "Date": new Date().toISOString(),

      "Max Price": maxPrice,
      "Current Lowest Source Price": getBuyingCurrentLowestSourcePriceForMemberWtb({
        selectedSource,
        inventoryType,
        maxPrice
      }),
      "Fulfillment Status": purchaseStatus === "KC Pending"
        ? "Pending"
        : "Outsource",
      "Purchase Status": purchaseStatus,
      "Payment Status": "Pending",

      "Buyer Seller ID": [sellerRecordId],

      "Auto Accept Seller Offers?": true,
      "Buying Inventory Filter": getBuyingInventoryFilterLabel(inventoryType),
      "Buying Selected Source Type": getBuyingSourceTypeLabel(selectedSource.source_type),
      "Buying Selected Source ID": selectedSource.source_id,
      "Buying Source Snapshot": buildBuyingSourceSnapshot(matchingSources),

      "Internal Notes": internalNotes
    };

    if (imageUrl) {
      fields["Picture"] = [{ url: imageUrl }];
    }

    const created = await airtable(MEMBER_WTBS_TABLE).create(fields);

    let wtbPost = null;
    let kcConfirmation = null;
    let consignmentRequests = null;
    
    if (purchaseStatus === "KC Pending") {
      try {
        kcConfirmation = await sendBuyingKcConfirmationRequest({
          memberWtbRecordId: created.id,
          fields
        });
      } catch (err) {
        console.error("Failed to send KC confirmation request:", err);
      }
    }
    
    if (purchaseStatus === "Offers Sent") {
      try {
        wtbPost = await postMemberWtbToWtbBot({
          recordId: created.id,
          productName: selectedSource.product_name || product?.product_name || sku,
          sku: selectedSource.sku || sku,
          size: selectedSource.size || size,
          brand: selectedSource.brand || product?.brand || "",
          imageUrl
        });
      } catch (err) {
        console.error("Failed to post Member WTB to WTB bot:", err);
      }
    
      try {
        consignmentRequests = await sendMemberWtbConsignmentRequests(created.id);
      } catch (err) {
        console.error("Failed to send Member WTB consignment requests:", err);
      }
    }
    
    res.json({
      success: true,
      member_wtb_record_id: created.id,
      purchase_status: purchaseStatus,
      max_price: maxPrice,
      max_price_display: buyingMoneyValue(maxPrice),
      wtb_posted: !!wtbPost,
      wtb_post: wtbPost,
      kc_confirmation_sent: !!kcConfirmation,
      kc_confirmation: kcConfirmation,
      consignment_requests_sent: !!consignmentRequests?.ok,
      consignment_requests: consignmentRequests
    });
  } catch (err) {
    console.error("Failed to create buying request:", err);

    res.status(500).json({
      error: "Failed to create buying request",
      details: err.message
    });
  }
});

app.post("/api/consignment/offers/close-for-source", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.AIRTABLE_WEBHOOK_SECRET ||
      secret !== process.env.AIRTABLE_WEBHOOK_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sourceType = asText(req.body?.source_type);
    const recordId = asText(req.body?.record_id);

    if (!recordId) {
      return res.status(400).json({ error: "Missing record_id" });
    }

    let query = supabase
      .from("consignment_offers")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("status", "open");

    if (sourceType === "member_wtb") {
      query = query
        .eq("source_type", "member_wtb")
        .eq("member_wtb_record_id", recordId);
    } else {
      query = query
        .eq("order_record_id", recordId);
    }

    const { error } = await query;

    if (error) throw error;

    return res.json({
      ok: true,
      source_type: sourceType,
      record_id: recordId
    });
  } catch (err) {
    console.error("Failed to close consignment offers for source:", err);

    return res.status(500).json({
      error: "Failed to close consignment offers for source",
      details: err.message
    });
  }
});

app.post("/api/member-wtb/label-request-submit", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const trackingNumber = asText(req.body?.tracking_number);
    const labelFile = req.body?.label_file;

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id" });
    }

    if (!trackingNumber) {
      return res.status(400).json({ error: "Missing tracking_number" });
    }

    if (!labelFile?.data) {
      return res.status(400).json({ error: "Missing label_file" });
    }

    const upload = await uploadMemberWtbLabelFile({
      memberWtbRecordId,
      file: labelFile
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Shipping Label": upload.url,
      "Tracking Number": trackingNumber,
      "Label Uploaded At": new Date().toISOString()
    });

    res.json({
      ok: true,
      label_url: upload.url,
      tracking_number: trackingNumber
    });
  } catch (err) {
    console.error("Failed to submit Member WTB label:", err);

    res.status(500).json({
      error: "Failed to submit label",
      details: err.message
    });
  }
});

app.post("/api/dashboard/buying/cancel-wtb", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body.member_wtb_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({
        error: "Missing member_wtb_record_id"
      });
    }

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Purchase Status": "Cancelled",
      "Fulfillment Status": "Cancelled"
    });

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("Cancel Member WTB failed:", err);

    res.status(500).json({
      error: "Failed to cancel Member WTB",
      details: err.message
    });
  }
});

app.post(
  "/api/dashboard/buying/payment-link",
  async (req, res) => {
    try {
      const memberWtbRecordId = asText(
        req.body?.member_wtb_record_id
      );

      const buyerRecordId = asText(
        req.body?.buyer_record_id
      );

      if (!memberWtbRecordId) {
        return res.status(400).json({
          error: "Missing member_wtb_record_id"
        });
      }

      if (!buyerRecordId) {
        return res.status(400).json({
          error: "Missing buyer_record_id"
        });
      }

      const memberWtb = await airtable(
        MEMBER_WTBS_TABLE
      ).find(memberWtbRecordId);

      const actualBuyerRecordId =
        firstLinkedRecordId(
          memberWtb.fields?.["Buyer Seller ID"]
        );

      if (
        !actualBuyerRecordId ||
        actualBuyerRecordId !== buyerRecordId
      ) {
        return res.status(403).json({
          error:
            "This payment does not belong to this buyer"
        });
      }

      const result =
        await getMemberWtbCheckout(
          memberWtbRecordId
        );

      return res.json({
        ok: true,
        reused: result.reused === true,
        payment_url: result.payment_url
      });
    } catch (err) {
      console.error(
        "Failed to prepare Member WTB payment:",
        err
      );

      return res
        .status(err.statusCode || 500)
        .json({
          error:
            err.message ||
            "Failed to prepare payment"
        });
    }
  }
);

// --------------------------------------------------
// MEMBER WTB MOLLIE WEBHOOK
// Receives authoritative payment updates from Mollie.
// --------------------------------------------------

app.post(
  "/api/mollie/member-wtb-webhook",
  async (req, res) => {
    try {
      const paymentId = asText(
        req.body?.id ||
        req.query?.id
      );

      if (!paymentId) {
        return res.status(400).send(
          "Missing payment id"
        );
      }

      const payment = await mollieRequest(
        `/payments/${encodeURIComponent(paymentId)}`
      );

      const metadata = payment?.metadata || {};

      if (
        asText(metadata.payment_context) !==
        "member_wtb"
      ) {
        console.log(
          "Ignoring non-Member-WTB Mollie webhook:",
          paymentId
        );

        return res.status(200).send("ok");
      }

      const memberWtbRecordId = asText(
        metadata.member_wtb_record_id
      );

      const batchRecordId = asText(
        metadata.batch_record_id
      );

      if (!memberWtbRecordId || !batchRecordId) {
        console.error(
          "Member WTB Mollie webhook missing metadata:",
          {
            paymentId,
            metadata
          }
        );

        return res.status(200).send("ok");
      }

      const [memberWtb, batch] = await Promise.all([
        airtable(MEMBER_WTBS_TABLE).find(
          memberWtbRecordId
        ),
        airtable(PAYMENT_BATCHES_TABLE).find(
          batchRecordId
        )
      ]);

      const memberFields = memberWtb.fields || {};
      const batchFields = batch.fields || {};

      const storedMemberPaymentId = asText(
        memberFields["Mollie Payment ID"]
      );

      const storedBatchPaymentId = asText(
        batchFields["Mollie Payment ID"]
      );

      if (
        storedMemberPaymentId &&
        storedMemberPaymentId !== payment.id
      ) {
        console.error(
          "Member WTB Mollie payment ID mismatch:",
          {
            memberWtbRecordId,
            expected: storedMemberPaymentId,
            received: payment.id
          }
        );

        return res.status(200).send("ok");
      }

      if (
        storedBatchPaymentId &&
        storedBatchPaymentId !== payment.id
      ) {
        console.error(
          "Payment Batch Mollie payment ID mismatch:",
          {
            batchRecordId,
            expected: storedBatchPaymentId,
            received: payment.id
          }
        );

        return res.status(200).send("ok");
      }

      const mollieStatus = asText(
        payment.status
      ).toLowerCase();

      const currentPaymentStatus = asText(
        memberFields["Payment Status"]
      );

      console.log(
        "Member WTB Mollie webhook:",
        {
          paymentId: payment.id,
          mollieStatus,
          memberWtbRecordId,
          batchRecordId,
          currentPaymentStatus
        }
      );

      /*
        Mollie bank transfer submitted:
        payment exists, but money has not yet been confirmed.
      */
      if (mollieStatus === "pending") {
        await Promise.all([
          airtable(PAYMENT_BATCHES_TABLE).update(
            batchRecordId,
            {
              "Payment Status": "Pending Payment",
              "Mollie Payment ID": payment.id
            }
          ),

          airtable(MEMBER_WTBS_TABLE).update(
            memberWtbRecordId,
            {
              "Payment Status": "Pending Payment",
              "Mollie Payment ID": payment.id
            }
          )
        ]);

        await updateMemberWtbPaymentRequestMessage(
          memberWtbRecordId,
          "Pending Payment"
        );

        return res.status(200).send("ok");
      }

      /*
        Payment confirmed.
      */
      if (mollieStatus === "paid") {
        if (currentPaymentStatus === "Paid") {
          console.log(
            "Skipping already processed Member WTB payment:",
            {
              paymentId: payment.id,
              memberWtbRecordId
            }
          );

          return res.status(200).send("ok");
        }

        const paidAt =
          asText(payment.paidAt) ||
          new Date().toISOString();

        await Promise.all([
          airtable(PAYMENT_BATCHES_TABLE).update(
            batchRecordId,
            {
              "Payment Status": "Paid",
              "Paid At": paidAt,
              "Mollie Payment ID": payment.id
            }
          ),

          airtable(MEMBER_WTBS_TABLE).update(
            memberWtbRecordId,
            {
              "Payment Status": "Paid",
              "Paid At": paidAt,
              "Payment Confirmed At": paidAt,
              "Mollie Payment ID": payment.id
            }
          )
        ]);

        await updateMemberWtbPaymentRequestMessage(
          memberWtbRecordId,
          "Paid"
        );

        /*
          These are the same two actions that the old
          manual Confirm Payment button currently triggers.
        */
        const trustedBuyer =
          metadata.trusted_buyer === true ||
          asText(metadata.trusted_buyer)
            .toLowerCase() === "true";
        
        if (!trustedBuyer) {
          await sendMemberWtbPurchaseWebhook(
            memberWtbRecordId
          );
        
          await sendMemberWtbDealUpdateAfterPayment(
            memberWtbRecordId
          );
        }

        return res.status(200).send("ok");
      }

      const terminalStatusMap = {
        canceled: "Cancelled",
        cancelled: "Cancelled",
        expired: "Expired",
        failed: "Failed"
      };

      const airtableStatus =
        terminalStatusMap[mollieStatus];

      if (airtableStatus) {
        await Promise.all([
          airtable(PAYMENT_BATCHES_TABLE).update(
            batchRecordId,
            {
              "Payment Status": airtableStatus,
              "Mollie Payment ID": payment.id
            }
          ),

          airtable(MEMBER_WTBS_TABLE).update(
            memberWtbRecordId,
            {
              "Payment Status": airtableStatus,
              "Mollie Payment ID": payment.id
            }
          )
        ]);

        await updateMemberWtbPaymentRequestMessage(
          memberWtbRecordId,
          airtableStatus
        );

        return res.status(200).send("ok");
      }

      /*
        open, authorized or another non-final status:
        do not change Airtable yet.
      */
      console.log(
        "No Member WTB action required for Mollie status:",
        {
          paymentId: payment.id,
          mollieStatus
        }
      );

      return res.status(200).send("ok");
    } catch (err) {
      console.error(
        "Member WTB Mollie webhook failed:",
        err
      );

      return res.status(500).send(
        "webhook failed"
      );
    }
  }
);

// --------------------------------------------------
// MEMBER WTB MOLLIE PAYMENT TEST
// Temporary internal endpoint.
// --------------------------------------------------

app.post(
  "/api/internal/member-wtb/mollie/create-test",
  async (req, res) => {
    try {
      const providedSecret = asText(
        req.headers["x-kc-secret"]
      );

      const expectedSecret = asText(
        process.env.KC_PORTAL_SECRET
      );

      if (
        !expectedSecret ||
        providedSecret !== expectedSecret
      ) {
        return res.status(401).json({
          error: "Unauthorized"
        });
      }

      const memberWtbRecordId = asText(
        req.body?.member_wtb_record_id
      );

      if (!memberWtbRecordId) {
        return res.status(400).json({
          error:
            "Missing member_wtb_record_id"
        });
      }

      const result =
        await createMemberWtbMolliePayment(
          memberWtbRecordId
        );

      res.json({
        ok: true,
        ...result
      });
    } catch (err) {
      console.error(
        "Member WTB Mollie test failed:",
        err
      );

      res.status(500).json({
        error:
          "Failed to create Member WTB Mollie payment",
        details: err.message,
        mollie_response:
          err.mollieResponse || null
      });
    }
  }
);

app.post(
  "/api/internal/member-wtb/discord-panel",
  async (req, res) => {
    try {
      const providedSecret =
        asText(
          req.headers["x-kc-secret"]
        );

      const expectedSecret =
        asText(
          process.env.KC_PORTAL_SECRET
        );

      if (
        !expectedSecret ||
        providedSecret !== expectedSecret
      ) {
        return res.status(401).json({
          error: "Unauthorized"
        });
      }

      const result =
        await postMemberWtbDiscordPanel();

      return res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      console.error(
        "Failed to post Member WTB Discord panel:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to post Member WTB Discord panel",
        details: error.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Kickz Caviar Portal running on port ${PORT}`);

  initDiscord().catch((err) => {
    console.error("Failed to init Discord bot on startup:", err);
  });

  initKickzDealDiscord().catch((err) => {
    console.error("Failed to init Kickz Deal Discord bot on startup:", err);
  });
});
