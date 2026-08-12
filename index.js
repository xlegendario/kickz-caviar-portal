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
  deniedAmount,
  isFirstStoreResponse = false
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
      `**${isFirstStoreResponse ? "Your Price" : "Your Previous Counter"}**`,
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

      // FIXED — same 3-second-acknowledgment issue found and fixed
      // elsewhere this session: this did slow work (a fetch to another
      // service) before ever acknowledging the interaction.
      await interaction.deferUpdate().catch(() => {});

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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

      // FIXED — the reopen-prior-round logic used to be duplicated
      // here; it now lives in /deny itself (shared with the Portal),
      // so this just calls it and updates the message.
      await fetch(`${APP_PUBLIC_BASE_URL}/api/consignment/offers/${offerId}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).catch((err) => console.error("Failed to deny consignment counter offer:", err));

      await safeEditInteractionMessage(interaction, {
        content: "❌ Counter offer denied.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

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

      // FIXED — same 3-second-acknowledgment issue found and fixed
      // repeatedly elsewhere this session: this never deferred before
      // the slow work below. This endpoint has grown significantly
      // slower since the reengageDeniedSellers broadcast work was
      // added (chain-tracing through every seller's history, creating
      // fresh rounds, sending Discord DMs to multiple sellers) —
      // confirmed via his live report: Discord showed a failure, but
      // the counter reached seller A successfully regardless. Deferring
      // immediately removes that race entirely.
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

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
        await interaction.editReply({
          content: `❌ ${data.error || "Failed to submit your counter."}`
        }).catch(() => {});
        return;
      }

      await interaction.editReply({
        content: `✅ Your counter of €${counterPrice} was sent to the seller(s).`
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

      // NEW — additive only: the round this embed points to may have
      // been deleted since this message was sent (e.g. the buyer
      // withdrew their pending counter via Delete in the Portal). A
      // deleted record makes .find() throw, which previously had no
      // handler anywhere in this dispatcher — the click silently did
      // nothing, no message shown at all. Now shows a clear, specific
      // message instead of a silent no-op or a generic crash.
      let counterOffer;
      try {
        counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      } catch (err) {
        if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
          await safeEditInteractionMessage(interaction, {
            content: "❌ This offer is no longer valid.",
            embeds: interaction.message.embeds,
            components: []
          }).catch(() => {});
          return;
        }
        throw err;
      }
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
        content: "✅ Counter offer accepted. Check the private channel that was just created for you to process the deal.",
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

      // NEW — additive only: same dead-round guard as
      // member_wtb_counter_accept above — see that comment for why.
      let deniedRecord;
      try {
        deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      } catch (err) {
        if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
          await safeEditInteractionMessage(interaction, {
            content: "❌ This offer is no longer valid.",
            embeds: interaction.message.embeds,
            components: []
          }).catch(() => {});
          return;
        }
        throw err;
      }
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

              // FIXED — a real, confirmed bug found via his sharp
              // pushback: this only checked "does ANY other seller
              // position exist at all" — but a WORSE fallback position
              // (e.g. another seller's stale, already-superseded raw
              // listing) would ALSO count here, incorrectly suppressing
              // the notification even when the denying seller was
              // genuinely the best available. His exact point: the
              // notification should ONLY be suppressed when another
              // seller is GENUINELY BETTER than what just got denied —
              // otherwise the denying seller effectively "drops out of
              // the running" and the buyer needs to know, since nobody
              // better is actually on the table. Chain-traces the
              // denying seller's own TRUE last position (not their
              // stale original ask) and normalizes it the same way
              // getCurrentGlobalLowestNormalized does internally, so
              // the comparison is apples-to-apples.
              const denyingSellerId = firstLinkedRecordId(deniedFields["Seller ID"]);
              const otherSellerExists = (await getCurrentGlobalLowestNormalized(
                "Member WTB",
                memberWtbRecordId,
                denyingSellerId
              )).normalized;

              const denyingSellerTruePosition = await findSellersTrueLastCounter(counterOfferRecordId);
              const denyingSellerVatType = asText(deniedFields["Seller Original VAT Type"]);
              const denyingSellerOwnNormalized = Number.isFinite(denyingSellerTruePosition)
                ? (denyingSellerVatType === "VAT0" ? denyingSellerTruePosition * 1.21 : denyingSellerTruePosition)
                : null;

              const shouldNotifyBuyer =
                !Number.isFinite(otherSellerExists) ||
                (Number.isFinite(denyingSellerOwnNormalized) && otherSellerExists >= denyingSellerOwnNormalized);

              if (shouldNotifyBuyer) {
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
        }
      } catch (reopenErr) {
        console.error("Failed to reopen prior round after member WTB seller-deny (non-blocking):", reopenErr);
      }

      // FIXED — a real, confirmed gap found via his live testing: when
      // the denied round was itself the buyer's VERY FIRST counter to
      // this seller (no Previous Record ID — nothing to reopen), the
      // block above was skipped entirely, meaning the buyer got NO
      // notification whatsoever, not even a simple "this was denied."
      // FIXED (again) — his follow-up correction: the first version of
      // this fallback was plain text with no way to act on it. This
      // seller's raw offer is untouched by the denial (only the
      // buyer's counter got denied, not the seller's own listing), so
      // resends the exact same Accept/Counter/Decline buttons the
      // original "New Offer Received" DM has, tied to that same raw
      // offer — same pattern, same custom_ids, so the existing button
      // handlers work without any changes.
      try {
        const priorRoundIdForFallback = asText(deniedFields["Previous Record ID"]);

        if (!priorRoundIdForFallback) {
          const memberWtbRecordIdForFallback = firstLinkedRecordId(deniedFields["Member WTB"]);
          const sellerOfferRecordIdForFallback = asText(deniedFields["Seller Offer Record ID"]);

          // NEW — additive only: his exact scenario — if ANOTHER
          // seller is genuinely BETTER (still active, not just
          // existing), the buyer's view has already silently moved to
          // them per the unified-thread visibility model, so denying
          // THIS (worse) seller shouldn't notify the buyer at all —
          // same suppression logic already used for the prior-round
          // branch above, just applied here too since round-1 denials
          // were skipping it entirely.
          const denyingSellerIdForFallback = firstLinkedRecordId(deniedFields["Seller ID"]);
          const otherSellerExistsForFallback = memberWtbRecordIdForFallback
            ? (await getCurrentGlobalLowestNormalized(
                "Member WTB",
                memberWtbRecordIdForFallback,
                denyingSellerIdForFallback
              )).normalized
            : null;

          const denyingSellerTruePositionForFallback = await findSellersTrueLastCounter(counterOfferRecordId);
          const denyingSellerVatTypeForFallback = asText(deniedFields["Seller Original VAT Type"]);
          const denyingSellerOwnNormalizedForFallback = Number.isFinite(denyingSellerTruePositionForFallback)
            ? (denyingSellerVatTypeForFallback === "VAT0" ? denyingSellerTruePositionForFallback * 1.21 : denyingSellerTruePositionForFallback)
            : null;

          const shouldNotifyBuyerForFallback =
            !Number.isFinite(otherSellerExistsForFallback) ||
            (Number.isFinite(denyingSellerOwnNormalizedForFallback) && otherSellerExistsForFallback >= denyingSellerOwnNormalizedForFallback);

          if (!shouldNotifyBuyerForFallback) {
            return;
          }

          const memberWtbForFallback = memberWtbRecordIdForFallback
            ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordIdForFallback).catch(() => null)
            : null;
          const wtbFieldsForFallback = memberWtbForFallback?.fields || {};
          const buyerRecordIdForFallback = firstLinkedRecordId(wtbFieldsForFallback["Buyer Seller ID"]);
          const buyerRecordForFallback = buyerRecordIdForFallback
            ? await airtable(SELLERS_TABLE).find(buyerRecordIdForFallback).catch(() => null)
            : null;
          const buyerDiscordIdForFallback = asText(
            buyerRecordForFallback?.fields?.["Discord ID"] || buyerRecordForFallback?.fields?.["Discord User ID"]
          );

          const sellerOfferRecordForFallback = sellerOfferRecordIdForFallback
            ? await airtable(SELLER_OFFERS_TABLE).find(sellerOfferRecordIdForFallback).catch(() => null)
            : null;
          const sof = sellerOfferRecordForFallback?.fields || {};
          const rawSellerAsk = numberValue(sof["Seller Offer"]);
          const rawSellerVatType = asText(sof["Offer VAT Type"]);
          const offerToBuyerForFallback = Number.isFinite(rawSellerAsk)
            ? calculateMemberWtbBuyerEquivalent(rawSellerAsk, rawSellerVatType, wtbFieldsForFallback)
            : null;

          if (buyerDiscordIdForFallback && sellerOfferRecordIdForFallback && Number.isFinite(offerToBuyerForFallback)) {
            const user = await kickzDealDiscordClient.users.fetch(buyerDiscordIdForFallback).catch(() => null);
            const dm = user ? await user.createDM().catch(() => null) : null;

            const imageUrlForFallback =
              Array.isArray(wtbFieldsForFallback["Picture"]) && wtbFieldsForFallback["Picture"][0]?.url
                ? wtbFieldsForFallback["Picture"][0].url
                : "";

            if (dm) {
              await dm.send({
                embeds: [{
                  title: "❌ Offer Denied",
                  description: [
                    `Your counter on **${asText(wtbFieldsForFallback["Product Name"]) || "this WTB"}** was denied by the seller.`,
                    "",
                    `**SKU:** ${asText(wtbFieldsForFallback["SKU"]) || "—"}`,
                    `**Size:** ${asText(wtbFieldsForFallback["Size"]) || "—"}`,
                    "",
                    `**Current Offer:** €${offerToBuyerForFallback.toFixed(2)}`,
                    "",
                    "You can accept this seller's offer, counter again, or decline."
                  ].join("\n"),
                  color: 0xE74C3C,
                  timestamp: new Date().toISOString(),
                  ...(imageUrlForFallback ? { image: { url: imageUrlForFallback } } : {})
                }],
                components: [
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        style: 3,
                        label: "Accept Offer",
                        custom_id: `accept_member_wtb_buyer_offer:${memberWtbRecordIdForFallback}:${sellerOfferRecordIdForFallback}`
                      },
                      {
                        type: 2,
                        style: 1,
                        label: "Counter",
                        custom_id: `counter_member_wtb_buyer:${memberWtbRecordIdForFallback}:${sellerOfferRecordIdForFallback}`
                      },
                      {
                        type: 2,
                        style: 4,
                        label: "Decline",
                        custom_id: `decline_member_wtb_buyer_offer:${memberWtbRecordIdForFallback}`
                      }
                    ]
                  }
                ]
              }).catch((err) => console.error("Failed to send round-1 denial fallback DM (non-blocking):", err));
            }
          }
        }
      } catch (fallbackErr) {
        console.error("Failed to send round-1 denial fallback notification (non-blocking):", fallbackErr);
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

      // NEW — additive only: this never deferred, so Discord's 3-
      // second acknowledgment window applied directly — the recently
      // added forward-search-for-denied-successor query (scans the
      // whole table, no narrow scoping available without hitting the
      // raw-ID/ARRAYJOIN pitfall) can add enough latency to exceed
      // that, showing "Something went wrong" to the user even though
      // the counter is created successfully server-side regardless.
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

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
        await interaction.editReply({
          content: `❌ ${data.error || "Failed to submit your counter."}`
        }).catch(() => {});
        return;
      }

      await interaction.editReply({
        content: `✅ Your counter of €${counterPrice} was sent to the buyer.`
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

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
        content: "✅ Counter offer accepted. Check the private channel that was just created for you to process the deal.",
        embeds: interaction.message.embeds,
        components: []
      }).catch(() => {});

      return;
    }

    // NEW — additive only: buyer denies the seller's counter-back. Kept
    // simple for this stage (no reopen-prior-round logic yet).
    if (customId.startsWith("member_wtb_buyer_counter_deny:")) {
      const counterOfferRecordId = customId.split(":")[1];

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

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
                sellerLastOfferPrice: deniedPrice,
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

      // FIXED — same 3-second-acknowledgment issue as the seller-facing
      // equivalent above.
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

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
        await interaction.editReply({
          content: `❌ ${data.error || "Failed to submit your counter."}`
        }).catch(() => {});
        return;
      }

      await interaction.editReply({
        content: `✅ Your counter of €${counterPrice} was sent to the seller.`
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});
      
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});
    
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});
    
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});
    
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

      // FIXED — same 3-second-acknowledgment issue found in the Member
      // WTB equivalents.
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

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
        await interaction.editReply({
          content: `❌ ${data.error || "Failed to submit your counter."}`
        }).catch(() => {});
        return;
      }

      await interaction.editReply({
        content: `✅ Your counter of €${counterPrice} was sent to the store.`
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

      // FIXED — same 3-second-acknowledgment issue.
      await interaction.deferUpdate().catch(() => {});

      // NEW — additive only: unlike counter_offer_accept, this handler
      // updates the record directly with no prior .find() — so a
      // deleted round (store withdrew their pending counter via
      // Delete) throws right here, on the .update() itself. Same dead-
      // round guard as accept above, just wrapped around the write
      // instead of a read.
      try {
        await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
          "Status": "Denied",
          "Denied At": new Date().toISOString(),
          "Closed At": new Date().toISOString()
        });
      } catch (err) {
        if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
          await disableCounterOfferDiscordButtons(
            interaction.channelId,
            interaction.message.id,
            "❌ This offer is no longer valid."
          );
          return;
        }
        throw err;
      }
    
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

          // FIXED — a real, confirmed bug found via his sharp
          // pushback on the Member WTB equivalent (same underlying
          // logic here): this only checked "does ANY other seller
          // position exist at all" — but a WORSE fallback position
          // would ALSO count, incorrectly suppressing the notification
          // even when the denying seller was genuinely the best
          // available. Now chain-traces the denying seller's own TRUE
          // last position and only suppresses when another seller is
          // GENUINELY BETTER than that.
          const denyingSellerIdForStore = firstLinkedRecordId(deniedFields["Seller ID"]);
          const otherSellerExistsForStore = (await getCurrentGlobalLowestNormalized(
            "Seller Offer",
            deniedOrderId,
            denyingSellerIdForStore
          )).normalized;

          const denyingSellerTruePositionForStore = await findSellersTrueLastCounter(counterOfferRecordId);
          const denyingSellerVatTypeForStore = asText(deniedFields["Seller Original VAT Type"]);
          const denyingSellerOwnNormalizedForStore = Number.isFinite(denyingSellerTruePositionForStore)
            ? (denyingSellerVatTypeForStore === "VAT0" ? denyingSellerTruePositionForStore * 1.21 : denyingSellerTruePositionForStore)
            : null;

          const shouldNotifyStore =
            !Number.isFinite(otherSellerExistsForStore) ||
            (Number.isFinite(denyingSellerOwnNormalizedForStore) && otherSellerExistsForStore >= denyingSellerOwnNormalizedForStore);

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

              // NEW — additive only: store-facing embed values in the
              // store's own VAT scale.
              const reopenEmbedDivisor = storeDisplayDivisor(priorVatType, orderFields);
              const reopenDeniedForDisplay = deniedPrice / reopenEmbedDivisor;
              const reopenSellerCounterForDisplay = computeSellerCounterForStoreDisplay(
                priorSellerCounter,
                priorVatType,
                orderFields
              );

              if (shouldNotifyStore) {
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
                    your_previous_counter: reopenDeniedForDisplay,
                    // FIXED — both numbers in the store's own VAT scale.
                    seller_counter_price: reopenSellerCounterForDisplay ?? priorSellerCounterInStoreTerms ?? priorSellerCounter,
                    denied_price: reopenDeniedForDisplay,
                    store_display_vat_type: priorVatType
                  })
                });
              }
            }
          } else if (shouldNotifyStore) {
            // FIXED — the store-facing "Your Denied Counter" was sent as
            // the internal all-in Store Counter Price (e.g. 195.20)
            // instead of the store's own VAT scale (€160 VAT0). Divide
            // by the same storeDisplayDivisor the reopen paths use, from
            // the denied round's own VAT type.
            const deniedVatTypeForDisplay = asText(deniedFields["Seller Original VAT Type"]);
            const deniedPriceForStoreDisplay = deniedPrice / storeDisplayDivisor(deniedVatTypeForDisplay, orderFields);
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
                denied_price: deniedPriceForStoreDisplay,
                denied_vat_type: deniedVatTypeForDisplay
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

      // FIXED — same class of bug found and fixed earlier this session
      // elsewhere: this handler does a long chain of slow, sequential
      // work (multiple Airtable reads/writes, an external webhook call)
      // before ever acknowledging the interaction. Discord shows "The
      // application didn't respond in time" to the user once that
      // takes longer than ~3 seconds — even though the code keeps
      // running and succeeds anyway, exactly what was reported (channel
      // got created fine, but the error still showed). Acknowledging
      // immediately here removes that race entirely; disableCounter-
      // OfferDiscordButtons further down edits the message directly via
      // the REST API, independent of this deferral, so it's unaffected.
      await interaction.deferUpdate().catch(() => {});

      // NEW — additive only: the round this embed points to may have
      // been deleted since this message was sent (e.g. the store
      // withdrew their pending counter via Delete in the Lojiq
      // Portal). A deleted record makes .find() throw, which
      // previously had no handler anywhere in this dispatcher — the
      // click silently did nothing. Reuses the same
      // disableCounterOfferDiscordButtons helper already used for the
      // "not open" case right below, just with a specific message.
      let counterOffer;
      try {
        counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
      } catch (err) {
        if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
          await disableCounterOfferDiscordButtons(
            interaction.channelId,
            interaction.message.id,
            "❌ This offer is no longer valid."
          );
          return;
        }
        throw err;
      }
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
      // FIXED — writing "Custom Offer" recalculates the "Offer To
      // Store" FORMULA field (it's derived from Custom Offer), which
      // is exactly what the pre-existing sendOfferRequestWebhook
      // automation watches — so this write was inadvertently
      // re-triggering a brand new "Offer Request" to the store for an
      // already-accepted deal. The Consignment accept flow (pre-
      // existing code) already sets "Offer Sent?": false for this
      // exact reason — mirroring that here closes the same gap for
      // Store Orders.
      // FIXED — a real, confirmed gap found via his careful questioning:
      // this only ever wrote "Custom Offer", never "Offer VAT Type" —
      // but calculateLinkedUnitPrice.js (the script that sets the real,
      // final invoiced price) decides whether to strip VAT ENTIRELY
      // based on that field. Without writing it here, that field just
      // kept whatever it was last set to by computeAndPushLowestOffer.js
      // (based on the RAW seller offer, not this negotiated deal) —
      // meaning a negotiated deal could get the wrong VAT type and the
      // wrong final price. Uses the exact same rule already proven
      // correct elsewhere in this codebase (computeAndPushLowestOffer.js
      // and the pre-existing Consignment accept flow): Margin sellers
      // stay "Margin"; otherwise it follows the CLIENT's country, not
      // the seller's own VAT type — Dutch clients always "VAT21", non-
      // Dutch clients always "VAT0".
      const sellerVatTypeForAcceptWrite = asText(f["Seller Original VAT Type"]);
      const offerVatTypeForAcceptWrite =
        sellerVatTypeForAcceptWrite === "Margin"
          ? "Margin"
          : (isDutchClientCountry(orderRecord.fields?.["Client Country"]) ? "VAT21" : "VAT0");


      try {
        await airtable(ORDERS_TABLE).update(linkedOrderId, {
          "Custom Offer": customOfferValueForAccept(
            offerVatTypeForAcceptWrite,
            numberValue(f["Store Counter Price"]),
            numberValue(f["Store Counter Price Excl VAT"])
          ),
          "Offer VAT Type": offerVatTypeForAcceptWrite,
          "Offer Accepted?": true,
          "Offer Sent?": false
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

    // FIXED — additive only: without this check, if autoAllocateBestUnit.js
    // runs more than once for the same order (which it can, while the
    // order stays in the Outsource/pending state — the same pattern
    // that caused duplicate rows earlier), this would create a fresh
    // Supabase row every time, resulting in multiple simultaneously
    // "active" rows for the same order in the Portal.
    const { data: existingActiveOffer } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("order_record_id", orderRecordId)
      .in("status", ["open", "store_pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const storeOfferPriceExclVatForRow =
      best.storeOfferVatType === "VAT21"
        ? Math.round((best.customOffer / 1.21) * 100) / 100
        : best.customOffer;

    // NEW — additive only: this pre-offer used to only write fields
    // directly onto the Order record, with no backing Supabase row —
    // meaning there was nothing for a later store Accept/Counter/Deny
    // to attach to. Shaped like a round the CONSIGNOR already
    // countered (status="store_pending", consignor_counter_price
    // populated, no store_counter_price) rather than a fresh "offer to
    // the consignor" round-1, since here the consignor's price is
    // already fixed (their listing price) and it's the STORE's turn
    // to respond — the same direction as an actual consignor counter
    // elsewhere in this system, not the original "store proposes,
    // consignor responds" shape.
    const nowIso = new Date().toISOString();

    const { data: newOffer, error: createOfferError } = existingActiveOffer
      ? { data: existingActiveOffer, error: null }
      : await supabase
      .from("consignment_offers")
      .insert({
        order_record_id: orderRecordId,
        order_id: asText(orderFields["Order ID"]),
        inventory_id: best.row.id,

        seller_record_id: best.row.seller_record_id,
        seller_id: best.row.seller_id,

        product_name: best.row.product_name,
        sku: best.row.sku,
        size: best.row.size,
        brand: best.row.brand,

        vat_type: best.row.vat_type,
        seller_price: best.sellerPrice,
        offer_price: best.sellerPrice,

        is_counter_offer: false,
        consignor_counter_price: best.sellerPrice,
        consignor_counter_store_price: best.customOffer,
        consignor_counter_store_price_excl_vat: storeOfferPriceExclVatForRow,
        consignor_counter_at: nowIso,

        status: "store_pending",
        store_response_status: "pending",
        source_type: "order",
        created_at: nowIso,
        updated_at: nowIso
      })
      .select()
      .single();

    if (createOfferError) {
      console.error("Failed to create backing consignment_offers row for pre-offer (non-blocking):", createOfferError);
    }

    res.json({
      ok: true,
      order_record_id: orderRecordId,
      sku,
      size,

      consignment_offer_id: newOffer?.id || null,

      custom_offer: best.customOffer,
      offer_vat_type: best.storeOfferVatType,
      // FIXED (again) — now that the consignment pre-offer writes to
      // "Lowest Offer" and competes in the same pool as regular
      // sellers, its Estimated Time should match that same convention
      // ("24 - 72 hours", exactly matching computeAndPushLowestOffer.js's
      // ESTIMATED_TIME_SELLER) rather than a separate consignment-only
      // string — the store shouldn't see a different time format just
      // because the current best offer happens to be from a consignor.
      estimated_time: "24 - 72 hours",

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
    let storeCounterPrice = Number(req.body?.store_counter_price);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    if (!Number.isFinite(storeCounterPrice) || storeCounterPrice <= 0) {
      return res.status(400).json({ error: "Invalid store_counter_price" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(orderRecordId);
    const orderFields = orderRecord.fields || {};

    // NEW — additive only: his refined design — a non-Dutch buyer sees
    // the CURRENTLY WINNING position (whichever seller's offer is
    // actually shown to them) as excl. VAT when it's VAT-sourced, or
    // already-inclusive when Margin-sourced, and types their counter
    // in that same scale. A Dutch buyer always types the plain all-in
    // figure, unchanged. Looks up the live current-best position (same
    // function every cross-seller comparison already uses) purely to
    // know which VAT type this typed number should be interpreted as,
    // then converts back to the internal all-in scale every
    // calculation below assumes.
    const currentWinnerForCreate = await getCurrentGlobalLowestNormalized("Seller Offer", orderRecordId, null);
    const isDutchBuyerForCreate = isDutchClientCountry(orderFields["Client Country"]);
    const respondingToVatSourceForCreate =
      currentWinnerForCreate.vatType === "VAT21" || currentWinnerForCreate.vatType === "VAT0";
    if (!isDutchBuyerForCreate && respondingToVatSourceForCreate) {
      storeCounterPrice = storeCounterPrice * storeInputMultiplier(orderFields); // client-rate, unrounded — so the store's exact typed number round-trips through Store Counter Price Excl VAT
    }

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

    // NEW — additive only: same stale-embed sweep as the per-round
    // store-counter — the store just countered the fresh offer(s), so
    // the original store-facing "Offer Request" embed for this order is
    // now stale and must stop being clickable (otherwise the store can
    // still Deny an offer they've already countered → stale round in
    // two pills at once).
    if (AIRTABLE_DISCORD_UPDATES_URL && orderRecordId) {
      fetch(AIRTABLE_DISCORD_UPDATES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: "disable-offer-messages",
          store_name: asText(orderFields["Store Name"]),
          record_id: orderRecordId
        })
      }).catch((err) => console.error("Failed to fire disable-offer-messages sweep (non-blocking):", err));
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
    let proposedPrice = Number(req.body?.price);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    // NEW — additive only: same reinterpretation as create — a non-
    // Dutch buyer editing their round-1 broadcast types in whatever
    // scale the CURRENTLY WINNING position implies (excl. for a VAT-
    // source, already-inclusive for Margin). Convert back to the
    // internal all-in scale before validation/anything below runs.
    const orderFieldsForInputInterpretation = (await airtable(ORDERS_TABLE).find(orderRecordId)).fields || {};
    const currentWinnerForEditBroadcast = await getCurrentGlobalLowestNormalized("Seller Offer", orderRecordId, null);
    const isDutchBuyerForEditBroadcast = isDutchClientCountry(orderFieldsForInputInterpretation["Client Country"]);
    const respondingToVatSourceForEditBroadcast =
      currentWinnerForEditBroadcast.vatType === "VAT21" || currentWinnerForEditBroadcast.vatType === "VAT0";
    // The scale the store actually typed in: for a non-Dutch buyer
    // responding to a VAT-source position, they type an excl.-VAT
    // (÷1.21) figure; otherwise the plain all-in figure. storeScaleTyped
    // keeps their original number for a correctly-worded error message;
    // proposedPrice gets converted to the internal all-in scale for
    // storage/payout.
    const editVatDivisor = (!isDutchBuyerForEditBroadcast && respondingToVatSourceForEditBroadcast) ? storeInputMultiplier(orderFieldsForInputInterpretation) : 1;
    const storeScaleTyped = proposedPrice;
    if (editVatDivisor !== 1) {
      proposedPrice = proposedPrice * editVatDivisor; // client-rate, unrounded — so the store's exact typed number round-trips
    }

    // NEW — additive only, same pattern as the other Store Orders
    // write endpoints: only enforced when store_name is provided, so
    // the existing Discord bot caller (which doesn't send it) is
    // unaffected.
    const requestedStoreNameForBroadcastEdit = asText(req.body?.store_name);
    if (requestedStoreNameForBroadcastEdit) {
      const ownsIt = await verifyStoreOwnsOrderForRound(orderRecordId, requestedStoreNameForBroadcastEdit);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
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

    // FIXED — his correction: don't reimplement this rule ad hoc — it
    // already exists, centrally, as validateNextCounterPrice, used by
    // every other price-change action in this system (store-counter,
    // seller-counter, the per-round edit endpoint). Round 1 has no
    // genuine seller counterpart yet (nobody's countered), so passing
    // Infinity as the counterpart price gives exactly the right
    // behavior: a floor of "current + MIN_COUNTER_STEP," no artificial
    // ceiling — same function, same band logic, same error wording as
    // everywhere else, not a separate reimplementation.
    // FIXED (2) — validate against the HIGHEST Store Counter Price
    // across ALL round-1 siblings, not just roundOneRecords[0]. If the
    // rows ever fall momentarily out of sync (e.g. an earlier edit
    // skipped one seller), checking a single arbitrary row could let a
    // non-increasing edit through against a stale sibling. The highest
    // is the true current position the edit must beat.
    const currentRoundOnePrice = Math.max(
      ...roundOneRecords
        .map((r) => numberValue(r.fields?.["Store Counter Price"]))
        .filter((n) => Number.isFinite(n))
    );

    if (Number.isFinite(currentRoundOnePrice)) {
      // Validate in the STORE's own scale (divide the internal current
      // price back by the same divisor, compare against what the store
      // literally typed) so the error message's amounts read in the
      // store's terms — e.g. "higher than €175 — minimum €178" rather
      // than the internal VAT-inclusive "€211.75 / €215". storeScaleTyped
      // is the whole number the store typed, so requireInteger stays on.
      const currentRoundOneInStoreScale = currentRoundOnePrice / editVatDivisor;
      const editValidation = validateNextCounterPrice(currentRoundOneInStoreScale, Infinity, storeScaleTyped);
      if (!editValidation.ok) {
        return res.status(400).json({ error: editValidation.reason, band: editValidation.band });
      }
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

      if (!sellerOriginalPrice) {
        skipped++;
        continue;
      }

      // FIXED — the skip-check must compare like-for-like. Both the
      // resulting payout AND the seller's own raw ask are in SELLER
      // terms, so compare those directly: skip only if this counter
      // wouldn't actually land below what the seller already asked.
      // (The earlier version compared proposedPrice — a store-scale,
      // margin-less, possibly ×1.21-adjusted number — against the
      // seller's ask converted to store terms WITH margin, i.e. two
      // different scales, which wrongly skipped VAT-source siblings.)
      const recomputedPayout = calculateCounterPayoutForVatType(proposedPrice, sellerVatType, orderFieldsForBroadcast);

      if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0 || recomputedPayout >= sellerOriginalPrice) {
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

    // NEW — additive only: same dead-round guard as the Member WTB
    // equivalent (/api/member-wtb-counter-offers/:id/seller-counter)
    // — see that endpoint's comment for why. The round being
    // countered may have been deleted since the Discord embed
    // offering this Counter button was sent (e.g. the store withdrew
    // their pending counter via Delete in the Lojiq Portal).
    let previousRecord;
    try {
      previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    } catch (err) {
      if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
        return res.status(404).json({ error: "This offer is no longer valid." });
      }
      throw err;
    }
    const f = previousRecord.fields || {};

    // NEW — additive only: this endpoint was only ever called from
    // Discord before, where the interaction itself implicitly proves
    // who's clicking (only the intended seller receives that specific
    // DM). Now that the Portal also calls it directly over HTTP, that
    // implicit protection doesn't carry over — anyone with network
    // access could otherwise submit a counter using someone else's
    // record ID. Only enforced when seller_record_id is provided, so
    // the existing Discord caller (which doesn't send it) is
    // unaffected.
    const requestingSellerRecordId = asText(req.body?.seller_record_id);
    if (requestingSellerRecordId && !linkedRecordIncludes(f["Seller ID"], requestingSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

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

    // FIXED — a real, confirmed bug found via his live testing on the
    // Member WTB side (same underlying endpoint pattern here): only
    // walking ONE hop back via Previous Record ID missed a seller's
    // true last position when it happened several supersessions
    // further back (e.g. broadcast-superseded more than once before
    // they got a chance to respond). Now uses the shared full
    // chain-walking helper (findSellersTrueLastCounter), which keeps
    // walking backward until it finds a round where this seller's
    // Seller Counter Price is genuinely set.
    let sellerOwnReference = await findSellersTrueLastCounter(previousRecordId);
    if (!Number.isFinite(sellerOwnReference) || sellerOwnReference <= 0) {
      sellerOwnReference = sellerOriginalPrice;
    }

    // FIXED — the check above only looks ONE hop back via this round's
    // OWN Previous Record ID — but after a deny-reopen, the round being
    // responded to is the REOPENED prior round, whose own Previous
    // Record ID points to whatever came before the seller's now-denied
    // counter, not to that denied counter itself (nothing links forward
    // to it). Without this, a seller could resubmit the exact same
    // price the store just denied. Searches forward for a denied round
    // that responded to this same round, using its price as the (more
    // recent, more restrictive) reference when one exists.
    const deniedSuccessorFormula = `AND(
      {Status} = 'Denied',
      OR({Source Type} = 'Seller Offer', {Source Type} = 'Member WTB')
    )`;
    const deniedSuccessors = await airtable(COUNTER_OFFERS_TABLE)
      .select({ filterByFormula: deniedSuccessorFormula, fields: ["Previous Record ID", "Seller Counter Price", "Denied At"] })
      .all();
    const deniedSuccessor = deniedSuccessors
      .filter((r) => asText(r.fields?.["Previous Record ID"]) === previousRecordId)
      .sort((a, b) => new Date(b.fields?.["Denied At"] || 0) - new Date(a.fields?.["Denied At"] || 0))[0];

    if (deniedSuccessor) {
      const deniedSellerCounter = numberValue(deniedSuccessor.fields?.["Seller Counter Price"]);
      if (deniedSellerCounter) {
        sellerOwnReference = deniedSellerCounter;
      }
    }

    // Move these up — needed for the cross-seller ceiling computation
    // before the combined validation below (previously computed after
    // the own-band check had already run and possibly failed).
    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);

    // FIXED — a real, confirmed bug found via his live testing (same
    // issue on the Member WTB side too): the seller's own narrowing
    // band and the cross-seller "beat the current lowest" ceiling used
    // to be validated as two separate, sequential gates — a proposed
    // price could fail the FIRST gate (own band) with a misleading
    // error that never mentioned the cross-seller constraint even
    // existed, and "No room left" only ever appeared when the own band
    // ALONE happened to be too narrow — never when the two constraints
    // COMBINED left no valid price at all. Now computes the
    // cross-seller ceiling FIRST and folds it into the own band before
    // validating, via the shared helper, giving one honest, combined
    // answer regardless of which specific price was tried.
    const globalLowestForValidation = (await getCurrentGlobalLowestNormalized("Seller Offer", linkedOrderId, linkedSellerId)).normalized;
    let crossSellerCeilingRaw = null;
    let crossSellerReferenceRaw = null;
    if (Number.isFinite(globalLowestForValidation)) {
      // FIXED — a real, confirmed bug found via his sharp catch: VAT21
      // and Margin are both already VAT-inclusive; only VAT0 is
      // exclusive and needs the /1.21 reversal to get back to this
      // seller's own raw terms. This previously checked "=== VAT21",
      // wrongly dividing Margin sellers too — this is the exact
      // computation behind the "Another seller already offers a
      // better price" message, so this bug directly produced wrong
      // (too-low) ceilings for Margin sellers.
      const rawThreshold = asText(sellerVatType) === "VAT0" ? globalLowestForValidation / 1.21 : globalLowestForValidation;
      crossSellerCeilingRaw = Math.floor(rawThreshold - MIN_COUNTER_STEP);
      crossSellerReferenceRaw = rawThreshold;
    }

    const validation = validateNextCounterPriceWithCrossSellerCeiling(
      sellerOwnReference,
      lastPrice,
      proposedPrice,
      crossSellerCeilingRaw,
      crossSellerReferenceRaw
    );
    if (!validation.ok) {
      if (
        validation.reason.startsWith("No room left") &&
        Number.isFinite(crossSellerCeilingRaw)
      ) {
        return res.status(400).json({
          error: `Another seller already offers a better price for this order — at most €${crossSellerCeilingRaw.toFixed(2)} (${sellerVatType}) to beat it — and the gap between that and the store's current position is too small for another step. Please accept or deny.`,
          band: validation.band
        });
      }
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [linkedOrderId],
      "Seller ID": linkedSellerId ? [linkedSellerId] : undefined,
      "Source Type": asText(f["Source Type"]) || "Seller Offer",
      // FIXED — this field was never carried forward past round 1,
      // which broke the duplicate-visibility exclusion in
      // wtb-open-offers (it looks for an active Counter Offers record
      // referencing the original Seller Offer — with this missing,
      // round 2+ was invisible to that check, so the same order showed
      // in Open twice: once as the stale "fresh" item, once as this
      // round).
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Seller Counter Price": proposedPrice,
      // FIXED — this never set Counter Payout on a seller-created
      // round (only buyer-counter/store-counter sets it, via a real
      // conversion). The seller's own new counter already IS what
      // they'd receive if accepted, no conversion needed — just
      // mirror it directly. Confirmed via the Airtable schema export
      // that "Counter Payout" is a plain currency field, not a
      // formula that would have auto-filled this on its own.
      "Counter Payout": proposedPrice,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": previousRecordId,
      // FIXED — only round 1 ever set this; every subsequent round
      // (seller-counter or store-counter) left it empty, showing "-"
      // in the Date column.
      "Created At": new Date().toISOString(),
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

      // NEW — additive only: the store-facing embed must show both
      // numbers in the STORE's own negotiating scale (e.g. VAT0 for a
      // non-Dutch store on a VAT-source position), not the internal
      // all-in scale. storeVatContext is the seller's VAT type, which
      // (per the store-facing relabel rule) drives whether the store
      // is in a VAT-source or Margin context.
      const storeVatContextForEmbed = sellerVatType;
      const embedDivisor = storeDisplayDivisor(storeVatContextForEmbed, orderFields);
      const yourPreviousCounterForDisplay = numberValue(f["Store Counter Price"]) / embedDivisor;
      const sellerNewCounterForDisplay = computeSellerCounterForStoreDisplay(
        proposedPrice,
        storeVatContextForEmbed,
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
          your_previous_counter: yourPreviousCounterForDisplay,
          // FIXED — this was sending the STORE-CONVERTED equivalent
          // (e.g. €155, seller's ask + margin) under "seller_counter_price",
          // which the embed displays as "Seller's New Counter" — making
          // it look like the seller asked for €155 when they actually
          // asked for €145. That's what led to real confusion tracing
          // an accepted deal (confirmed by comparing the raw Counter
          // Offers records). Now sends the seller's counter marked up
          // to store terms, in the store's own VAT scale.
          seller_counter_price: sellerNewCounterForDisplay ?? sellerCounterInStoreTerms ?? proposedPrice,
          store_display_vat_type: sellerVatType,
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
    let proposedPrice = Number(req.body?.price);

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    const f = previousRecord.fields || {};

    // NEW — additive only, see verifyStoreOwnsOrderForRound above.
    const requestedStoreNameForCounter = asText(req.body?.store_name);
    if (requestedStoreNameForCounter) {
      const ownsIt = await verifyStoreOwnsOrderForRound(firstLinkedRecordId(f["Order"]), requestedStoreNameForCounter);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
    }

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
    let priorStorePrice = numberValue(priorFields["Store Counter Price"]);
    const sellerCounterPrice = numberValue(f["Seller Counter Price"]);

    // FIXED — same gap as seller-counter/buyer-counter — after a
    // deny-reopen, the round being responded to is the reopened prior
    // round, whose own Previous Record ID points to whatever came
    // before the store's now-denied counter, not to that denied
    // counter itself. Without this, the store could resubmit the exact
    // same price the seller just denied.
    const deniedSuccessorFormulaForStore = `AND(
      {Status} = 'Denied',
      OR({Source Type} = 'Seller Offer', {Source Type} = 'Member WTB')
    )`;
    const deniedSuccessorsForStore = await airtable(COUNTER_OFFERS_TABLE)
      .select({ filterByFormula: deniedSuccessorFormulaForStore, fields: ["Previous Record ID", "Store Counter Price", "Denied At"] })
      .all();
    const deniedSuccessorForStore = deniedSuccessorsForStore
      .filter((r) => asText(r.fields?.["Previous Record ID"]) === previousRecordId)
      .sort((a, b) => new Date(b.fields?.["Denied At"] || 0) - new Date(a.fields?.["Denied At"] || 0))[0];

    if (deniedSuccessorForStore) {
      const deniedStorePrice = numberValue(deniedSuccessorForStore.fields?.["Store Counter Price"]);
      if (deniedStorePrice) {
        priorStorePrice = deniedStorePrice;
      }
    }

    const linkedOrderIdForBand = firstLinkedRecordId(f["Order"]);
    const orderRecordForBand = await airtable(ORDERS_TABLE).find(linkedOrderIdForBand);
    const orderFieldsForBand = orderRecordForBand.fields || {};
    const sellerVatTypeForBand = asText(f["Seller Original VAT Type"]);

    // NEW — additive only: his refined design — a non-Dutch buyer sees
    // a VAT-source offer (VAT21 or VAT0) as excl. VAT and types their
    // counter in that same excl. scale; they see a Margin-source offer
    // as already-inclusive (Margin goods are never truly excl.) and
    // type their counter in that scale directly. A Dutch buyer always
    // types the plain all-in figure, same as before. Converts whatever
    // was typed back into the internal all-in (Dutch-equivalent) scale
    // every calculation below already assumes, before anything else
    // runs — this is the exact root cause of tonight's reported bug
    // (a non-Dutch buyer's excl.-intended counter being treated as
    // already all-in, silently underpaying every seller).
    const isDutchBuyerForCounter = isDutchClientCountry(orderFieldsForBand["Client Country"]);
    const respondingToVatSourceForCounter = sellerVatTypeForBand === "VAT21" || sellerVatTypeForBand === "VAT0";

    // The scale the store actually sees and types in. For a non-Dutch
    // store responding to a VAT-source (VAT0/VAT21) offer, everything on
    // their screen is the excl. (÷1.21) figure; otherwise it's the plain
    // all-in figure. We run the whole band check in THIS scale so the
    // three numbers being compared are exactly what the store sees:
    //   - their previous counter  (e.g. €177.69, not the internal €215)
    //   - the seller's new counter (e.g. €195, the visible offer)
    //   - the price they just typed (e.g. €180)
    // Without this, the store's typed €180 was multiplied to €217.80 and
    // compared against the internal €215, wrongly rejecting a valid move.
    const storeScaleDivisor = (!isDutchBuyerForCounter && respondingToVatSourceForCounter) ? storeInputMultiplier(orderFieldsForBand) : 1;

    // The price the store typed, kept in the store's own scale (NOT
    // multiplied to internal all-in). This is what the band check and
    // its error message should use.
    const typedStorePrice = proposedPrice;

    // Convert the store's internal all-in "previous counter" back down to
    // the store's visible scale.
    const priorStorePriceInStoreScale = priorStorePrice / storeScaleDivisor;

    // The seller's new counter as the store SEES it (the same figure the
    // embed/Portal show), not the internal ÷1.21 all-in version.
    const sellerCounterAsStoreSees = computeSellerCounterForStoreDisplay(
      sellerCounterPrice,
      sellerVatTypeForBand,
      orderFieldsForBand
    );

    if (!Number.isFinite(sellerCounterAsStoreSees)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this order." });
    }

    const validation = validateNextCounterPrice(priorStorePriceInStoreScale, sellerCounterAsStoreSees, typedStorePrice, {
      requireInteger: !(!isDutchBuyerForCounter && respondingToVatSourceForCounter)
    });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    // Now convert the store's typed price UP to the internal all-in scale
    // that every calculation below (payouts, storage) already assumes.
    if (!isDutchBuyerForCounter && respondingToVatSourceForCounter) {
      proposedPrice = proposedPrice * storeInputMultiplier(orderFieldsForBand); // client-rate, unrounded — so Store Counter Price Excl VAT returns the store's exact typed number
    }

    // NEW — additive only: his explicit request — the store only ever
    // sees ONE unified thread (it may silently swap to a different,
    // better-offering seller behind the scenes), so their own counter
    // must never regress below the best position they've EVER offered
    // on this Order, regardless of which seller it went to originally
    // — otherwise it would look like they're backtracking to whichever
    // seller they'd previously countered, even though from the store's
    // perspective they're just continuing the same negotiation.
    const buyerHighestEver = await getBuyerHighestEverPosition("Seller Offer", linkedOrderIdForBand);
    if (Number.isFinite(buyerHighestEver) && proposedPrice < buyerHighestEver) {
      return res.status(400).json({
        error: `Your counter can't be lower than €${buyerHighestEver.toFixed(2)}, which you've already offered on this order.`
      });
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
      // FIXED — same carry-forward fix as seller-counter above.
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": proposedPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": previousRecordId,
      // FIXED — same Date fix as seller-counter above.
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    await airtable(COUNTER_OFFERS_TABLE).update(previousRecordId, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    // NEW — additive only: his explicit request — this new, higher
    // counter might also now beat what a PREVIOUSLY-denied seller was
    // denied at. Re-opens a fresh round for any such seller, giving
    // them a genuine second chance rather than being permanently out
    // just because they said no to an earlier, lower position.
    await reengageDeniedSellers({
      sourceType: "Seller Offer",
      recordId: linkedOrderId,
      newBuyerCounterPrice: proposedPrice,
      excludeSellerId: linkedSellerId
    }).catch((err) => console.error("Failed to re-engage previously denied sellers (non-blocking):", err));

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
        sellerLastOfferPrice: sellerOwnPosition,
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
// ---------------------------------------------------------------------
// NEW — additive only: his explicit, confirmed decision — Accept on a
// fresh (never-countered) offer must still finalize through the same
// single, already-fixed place a deal ever gets finalized: store-accept.
// This endpoint does ONLY the "shape a round for it" part — it does
// NOT close the deal itself. Creates one Open Counter Offers round for
// the given seller, with "Seller Counter Price" set to their own raw
// ask (mirroring exactly what a genuine seller-placed round looks
// like — store-accept already knows how to handle that shape
// correctly, untouched). The caller is expected to immediately call
// store-accept with the returned id.
//
// Re-verifies this seller is genuinely still the current best fresh
// position before creating anything — guards against a stale click
// (e.g. a better offer appeared in the meantime, or this seller
// already went into negotiation).
// ---------------------------------------------------------------------

app.post("/api/counter-offers/create-fresh-round", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderRecordId = asText(req.body?.order_record_id);
    const sellerOfferRecordId = asText(req.body?.seller_offer_record_id);
    const requestedStoreName = asText(req.body?.store_name);

    if (!orderRecordId || !sellerOfferRecordId) {
      return res.status(400).json({ error: "Missing order_record_id or seller_offer_record_id" });
    }

    const ownsIt = await verifyStoreOwnsOrderForRound(orderRecordId, requestedStoreName);
    if (!ownsIt) {
      return res.status(403).json({ error: "Not allowed for this store." });
    }

    const sellerOfferRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferRecordId);
    const sof = sellerOfferRecord.fields || {};

    if (sof["Delete Offer"] || sof["Denied?"] || sof["Withdrawn?"]) {
      return res.status(409).json({ error: "This offer is no longer available." });
    }

    const sellerRecordId = firstLinkedRecordId(sof["Seller ID"]);
    const sellerOriginalPrice = numberValue(sof["Seller Offer"]);
    const sellerVatType = asText(sof["Offer VAT Type"]);

    if (!sellerRecordId || !(sellerOriginalPrice > 0) || !sellerVatType) {
      return res.status(409).json({ error: "This offer is missing required pricing information." });
    }

    // Re-confirm this seller is genuinely still the current best fresh
    // position, using the one central function everything else in this
    // build already goes through — not a second, separately-derived
    // check.
    const best = await getCurrentGlobalLowestNormalized("Seller Offer", orderRecordId, null);
    if (best.winningSource === "counter_offer_round" || best.winningRecordId !== sellerOfferRecordId) {
      return res.status(409).json({ error: "This offer is no longer the current best position — please refresh." });
    }

    // FIXED — a real bug, his catch: this used to always accept the
    // seller's raw "Seller Offer" field (their very first-ever ask),
    // even when their TRUE current position was actually different —
    // e.g. a seller who countered a few times, got denied, and never
    // responded to the reopened round; getCurrentGlobalLowestNormalized
    // already correctly chain-traces to their real last position (via
    // findSellersTrueLastCounter) for DISPLAY, but this endpoint kept
    // re-deriving a separate, stale number for the actual accept —
    // exactly the "second, parallel computation" bug class flagged
    // repeatedly in this project. Now uses best.raw/best.vatType (the
    // same, already-validated computation) for the price that's
    // actually accepted. "Seller Original Price"/VAT Type still store
    // the seller's true, literal first-ever ask — untouched, since
    // that field's meaning elsewhere in this codebase depends on it
    // never being anything else.
    const currentTruePrice = numberValue(best.raw);
    const currentTrueVatType = asText(best.vatType);

    if (!(currentTruePrice > 0) || !currentTrueVatType) {
      return res.status(409).json({ error: "Could not determine this seller's current price." });
    }

    const createdRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [orderRecordId],
      "Seller ID": [sellerRecordId],
      "Source Type": "Seller Offer",
      "Seller Offer Record ID": sellerOfferRecordId,

      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,

      // Shaped exactly like a genuine seller-placed round — this is
      // what tells store-accept "the seller's number to honor is
      // this one," using the exact same branch it already uses for a
      // real seller counter-back. Uses the seller's TRUE current
      // price (see fix above), not necessarily their original ask.
      "Seller Counter Price": currentTruePrice,

      "Counter Payout": currentTruePrice,
      "Counter Payout VAT Type": currentTrueVatType,

      "Status": "Open",
      "Created At": new Date().toISOString()
    });

    res.json({ ok: true, counter_offer_record_id: createdRound.id });
  } catch (err) {
    console.error("Failed to create fresh round for instant accept:", err);
    res.status(500).json({ error: "Failed to prepare offer for acceptance", details: err.message });
  }
});

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

    // NEW — additive only, see verifyStoreOwnsOrderForRound above.
    // Reuses orderRecord (already being fetched here) instead of a
    // second lookup.
    const requestedStoreNameForAccept = asText(req.body?.store_name);
    if (requestedStoreNameForAccept && displayValue(orderRecord.fields?.["Store Name"]) !== requestedStoreNameForAccept) {
      return res.status(403).json({ error: "Not allowed for this store." });
    }
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


    // FIXED — his exact, repeated rule: on a store accept, Custom Offer
    // (and the accepted store price everywhere) must be EXACTLY the
    // value the store SEES as the offer — the same figure the embed /
    // Portal shows via computeSellerCounterForStoreDisplay — not the
    // internal all-in ÷1.21 version from calculateStoreCounterEquivalent.
    // For a non-Dutch VAT0-context store, seller's 180 VAT0 shows as
    // €195 (margin markup, no ÷1.21), so accepting must write 195 VAT0,
    // NOT 160. calculateLinkedUnitPrice.js takes Custom Offer 1:1, and
    // Final Buying Price for a VAT product is always VAT-excl, so the
    // visible VAT0 figure IS the excl price to bill.
    const acceptedStorePrice = isSellerPlacedRound
      ? computeSellerCounterForStoreDisplay(sellerCounterPriceForAccept, sellerVatTypeForAccept, orderFieldsForAccept)
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
    // FIXED — same fix as the other accept handler: writing "Custom
    // Offer" recalculates the "Offer To Store" formula field, which
    // re-triggers the pre-existing sendOfferRequestWebhook automation,
    // sending a fresh "Offer Request" for an already-accepted deal.
    // Setting "Offer Sent?": false prevents that (and matches the
    // pre-existing Consignment accept flow's own handling of this).
    // FIXED — a real, confirmed gap found via his careful questioning:
    // this only ever wrote "Custom Offer", never "Offer VAT Type" — but
    // calculateLinkedUnitPrice.js decides whether to strip VAT entirely
    // based on that field. Without writing it here, that field just
    // kept whatever it was last set to by computeAndPushLowestOffer.js
    // (based on the RAW seller offer, not this negotiated deal). Uses
    // the exact same rule already proven correct elsewhere (Margin
    // sellers stay "Margin"; otherwise it follows the CLIENT's
    // country, not the seller's own VAT type). sellerVatTypeForAccept
    // and orderFieldsForAccept are already computed just above.
    const offerVatTypeForAcceptWrite =
      sellerVatTypeForAccept === "Margin"
        ? "Margin"
        : (isDutchClientCountry(orderFieldsForAccept?.["Client Country"]) ? "VAT21" : "VAT0");

    try {
      if (Number.isFinite(acceptedStorePrice) && acceptedStorePrice > 0) {
        await airtable(ORDERS_TABLE).update(linkedOrderId, {
          "Custom Offer": acceptedStorePrice,
          "Offer VAT Type": offerVatTypeForAcceptWrite,
          "Offer Accepted?": true,
          "Offer Sent?": false
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

    // NEW — additive only, see verifyStoreOwnsOrderForRound above.
    // Computed here (before the write below) rather than where it used
    // to be computed further down, so a denial can't happen at all for
    // a store that doesn't own this order.
    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const requestedStoreNameForDeny = asText(req.body?.store_name);
    if (requestedStoreNameForDeny) {
      const ownsIt = await verifyStoreOwnsOrderForRound(linkedOrderId, requestedStoreNameForDeny);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

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
            sellerLastOfferPrice: deniedSellerCounter,
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

          // NEW — additive only: mirrors Member WTB's buyer-deny — denying
          // the store's currently-lowest seller is effectively a "no" to
          // everyone at their current positions too, since if the store
          // won't accept the lowest, they won't accept anything higher
          // either. Broadcasts the store's real floor (their highest-ever
          // position on this order, not just this one denied round) to
          // every OTHER seller still in the game, using the same
          // reengageDeniedSellers mechanism already proven for Counter/Edit.
          const storeFloorForBroadcast = await getBuyerHighestEverPosition("Seller Offer", linkedOrderId);

          if (Number.isFinite(storeFloorForBroadcast) && storeFloorForBroadcast > 0) {
            await reengageDeniedSellers({
              sourceType: "Seller Offer",
              recordId: linkedOrderId,
              newBuyerCounterPrice: storeFloorForBroadcast,
              excludeSellerId: sellerRecordId,
              isDenyBroadcast: true
            }).catch((err) => console.error("Failed to broadcast store floor to other sellers after store-deny (non-blocking):", err));
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
// ---------------------------------------------------------------------
// NEW — additive only: STORE-side retry-counter for Store Orders.
// Ported from the proven /api/dashboard/wtb-counter-offers/:offerId/
// retry-counter, but store-facing: when a seller denied the store's
// counter, the store can send a NEW counter from the Denied pill. The
// store-deny auto-reopened the store's prior round, so this places a
// fresh store round against the seller's denied position, validated in
// the STORE's own visible scale (client-rate), same as store-counter.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/:id/store-retry-counter", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);
    if (!process.env.COUNTER_OFFERS_SECRET || secret !== process.env.COUNTER_OFFERS_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const deniedRoundId = asText(req.params.id);
    const requestedStoreName = asText(req.body?.store_name);
    let proposedPrice = Number(req.body?.price);

    if (!deniedRoundId) {
      return res.status(400).json({ error: "Missing counter offer id" });
    }
    if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid number." });
    }

    const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(deniedRoundId);
    const f = deniedRecord.fields || {};

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    if (!linkedOrderId) {
      return res.status(500).json({ error: "Counter Offer missing linked Order" });
    }

    if (requestedStoreName) {
      const ownsIt = await verifyStoreOwnsOrderForRound(linkedOrderId, requestedStoreName);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};

    // The seller's denied counter (their last real position) and the
    // store's own last counter (the round the denied one was answering,
    // via Previous Record ID) — the band narrows between these two,
    // exactly like the seller-side retry. Both start on the internal
    // all-in scale.
    const sellerVatType = asText(f["Seller Original VAT Type"]);
    const deniedSellerCounter = numberValue(f["Seller Counter Price"]);
    const priorRoundId = firstLinkedRecordId(f["Previous Record ID"]);

    if (!priorRoundId) {
      return res.status(409).json({ error: "There's no prior position to retry against." });
    }

    const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId);
    const priorFields = priorRound.fields || {};
    const storeLastPosition = numberValue(priorFields["Store Counter Price"]);

    if (!Number.isFinite(storeLastPosition) || !Number.isFinite(deniedSellerCounter)) {
      return res.status(500).json({ error: "Missing price data to validate against." });
    }

    // Validate in the STORE's own visible scale (same as store-counter),
    // so the band the store sees matches what they can type. The seller's
    // denied counter as the store sees it, and the store's prior counter
    // in store scale, are the two ends; the typed price stays as typed.
    const isDutchBuyer = isDutchClientCountry(orderFields["Client Country"]);
    const respondingToVatSource = sellerVatType === "VAT21" || sellerVatType === "VAT0";
    const storeScaleDivisor = (!isDutchBuyer && respondingToVatSource) ? storeInputMultiplier(orderFields) : 1;

    const priorStorePriceInStoreScale = storeLastPosition / storeScaleDivisor;
    const sellerCounterAsStoreSees = computeSellerCounterForStoreDisplay(deniedSellerCounter, sellerVatType, orderFields);

    if (!Number.isFinite(sellerCounterAsStoreSees)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this order." });
    }

    const validation = validateNextCounterPrice(priorStorePriceInStoreScale, sellerCounterAsStoreSees, proposedPrice, {
      requireInteger: !(!isDutchBuyer && respondingToVatSource)
    });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    // Convert the typed price UP to the internal all-in scale for storage.
    if (!isDutchBuyer && respondingToVatSource) {
      proposedPrice = proposedPrice * storeInputMultiplier(orderFields);
    }

    const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);

    // Store's new counter → payout to the seller in the seller's own
    // VAT scale (same conversion the main store-counter uses).
    const storeCounterPayout = calculateCounterPayoutForVatType(proposedPrice, sellerVatType, orderFields);

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [linkedOrderId],
      "Seller ID": linkedSellerId ? [linkedSellerId] : undefined,
      "Source Type": asText(f["Source Type"]) || "Seller Offer",
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": proposedPrice,
      "Counter Payout": storeCounterPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": priorRoundId,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    // Notify the seller of the store's new counter — reuse the exact
    // same DM path the main store-counter endpoint uses.
    const sellerDiscordId = asText(f["Seller Discord ID"]);
    if (sellerDiscordId) {
      const sellerOwnPosition = deniedSellerCounter;
      const noRoomToCounter =
        Number.isFinite(sellerOwnPosition) &&
        Number.isFinite(storeCounterPayout) &&
        !hasRoomForNextStep(sellerOwnPosition, storeCounterPayout);

      const discordResult = await sendCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(f["Product Name"]),
        sku: asText(f["SKU"]),
        size: asText(f["Size"]),
        orderId: asText(orderFields["Order ID"]),
        payout: storeCounterPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        sellerLastOfferPrice: sellerOwnPosition,
        noRoomToCounter
      }).catch((err) => {
        console.error("Failed to DM seller of store retry counter (non-blocking):", err);
        return null;
      });

      if (discordResult) {
        await airtable(COUNTER_OFFERS_TABLE).update(newRound.id, {
          "Discord Channel ID": discordResult.channelId,
          "Discord Message ID": discordResult.messageId,
          "Discord Delivery Type": discordResult.deliveryType
        }).catch(() => {});
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Failed to store-retry-counter:", err);
    return res.status(500).json({ error: "Failed to retry counter", details: err.message });
  }
});


// NEW — additive only: store hides a denied FRESH seller offer (case
// A) from its Denied pill. Sets "Delete Offer" = true on the Seller
// Offer, which every portal listing already filters out — so it
// visually disappears for the store, but the seller can still make a
// new offer while the order is Outsource (no cascade, no hard delete).
app.post("/api/counter-offers/fresh-denied/:sellerOfferId/hide", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);
    if (!process.env.COUNTER_OFFERS_SECRET || secret !== process.env.COUNTER_OFFERS_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sellerOfferId = asText(req.params.sellerOfferId);
    const requestedStoreName = asText(req.body?.store_name);
    if (!sellerOfferId) {
      return res.status(400).json({ error: "Missing seller offer id" });
    }

    const offerRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferId);
    const of = offerRecord.fields || {};
    const linkedOrderId = firstLinkedRecordId(of["Linked Orders"]);

    if (requestedStoreName && linkedOrderId) {
      const ownsIt = await verifyStoreOwnsOrderForRound(linkedOrderId, requestedStoreName);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
    }

    await airtable(SELLER_OFFERS_TABLE).update(sellerOfferId, { "Delete Offer": true });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to hide denied fresh offer:", err);
    res.status(500).json({ error: "Failed to hide offer", details: err.message });
  }
});

// STORE-cancel: store withdraws their OWN pending counter.
app.post("/api/counter-offers/:id/store-cancel", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const offerId = asText(req.params.id);
    const requestedStoreName = asText(req.body?.store_name);

    if (!offerId || !requestedStoreName) {
      return res.status(400).json({ error: "Missing id or store_name" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId).catch((err) => {
      if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) return null;
      throw err;
    });

    if (!record) {
      return res.status(404).json({ error: "This offer is no longer valid." });
    }

    const linkedOrderId = firstLinkedRecordId(record.fields?.["Order"]);
    const ownsIt = await verifyStoreOwnsOrderForRound(linkedOrderId, requestedStoreName);

    if (!ownsIt) {
      return res.status(403).json({ error: "Not allowed for this store." });
    }

    await airtable(COUNTER_OFFERS_TABLE).destroy(offerId);

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to cancel store counter offer:", err);
    res.status(500).json({ error: "Failed to cancel offer", details: err.message });
  }
});

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
    let proposedPrice = Number(req.body?.price);

    if (!["seller", "store"].includes(actor)) {
      return res.status(400).json({ error: "actor must be 'seller' or 'store'" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(recordId);
    const f = record.fields || {};

    // NEW — additive only, same pattern as store-accept/store-deny/
    // store-counter: only enforced when store_name is provided (and
    // only relevant for actor="store" — a seller edit has no
    // store_name to check), so the existing Discord caller (which
    // doesn't send it) is unaffected.
    const requestedStoreNameForEdit = asText(req.body?.store_name);
    if (actor === "store" && requestedStoreNameForEdit) {
      const linkedOrderIdForEdit = firstLinkedRecordId(f["Order"]);
      const ownsIt = await verifyStoreOwnsOrderForRound(linkedOrderIdForEdit, requestedStoreNameForEdit);
      if (!ownsIt) {
        return res.status(403).json({ error: "Not allowed for this store." });
      }
    }

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
    let editConversionApplied = false;

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

      // NEW — additive only: same reinterpretation as store-counter —
      // a non-Dutch buyer editing their own counter against a VAT-
      // source round types in excl. terms; against a Margin-source
      // round they type the already-inclusive figure directly. Convert
      // back to the internal all-in scale before anything below runs.
      const isDutchBuyerForEdit = isDutchClientCountry(orderFieldsForEdit["Client Country"]);
      const respondingToVatSourceForEdit = sellerVatTypeForEdit === "VAT21" || sellerVatTypeForEdit === "VAT0";
      if (!isDutchBuyerForEdit && respondingToVatSourceForEdit) {
        proposedPrice = proposedPrice * storeInputMultiplier(orderFieldsForEdit); // client-rate, unrounded — so Store Counter Price Excl VAT returns the store's exact typed number
        editConversionApplied = true;
      }

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
    const validation = validateNextCounterPrice(ownReferencePrice, counterpartPrice, proposedPrice, {
      requireInteger: !editConversionApplied
    });
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
        // see the store-equivalent (margin-adjusted) price in their
        // own VAT scale, not the seller's raw edited ask nor the
        // internal all-in figure.
        const storeVatContextForEditEmbed = asText(f["Seller Original VAT Type"]);
        const editEmbedDivisor = storeDisplayDivisor(storeVatContextForEditEmbed, orderFields);
        const editedYourPreviousForDisplay = numberValue(previousFields["Store Counter Price"]) / editEmbedDivisor;
        const editedSellerPriceInStoreTerms = computeSellerCounterForStoreDisplay(
          proposedPrice,
          storeVatContextForEditEmbed,
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
            your_previous_counter: editedYourPreviousForDisplay,
            // FIXED — must show both numbers in the store's own VAT
            // scale (e.g. VAT0 for a non-Dutch store), not the internal
            // all-in figure.
            seller_counter_price: editedSellerPriceInStoreTerms ?? proposedPrice,
            store_display_vat_type: storeVatContextForEditEmbed
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

      // NEW — additive only: his explicit request — an edited counter
      // is still a new position, and should reach every other seller
      // still in the game the exact same way a fresh counter would —
      // otherwise Edit would quietly be an exception to the broadcast
      // rule, and a store editing because they got no response would
      // still leave every OTHER seller stuck on stale information.
      const linkedSellerIdForEdit = firstLinkedRecordId(f["Seller ID"]);
      await reengageDeniedSellers({
        sourceType: "Seller Offer",
        recordId: linkedOrderId,
        newBuyerCounterPrice: proposedPrice,
        excludeSellerId: linkedSellerIdForEdit
      }).catch((err) => console.error("Failed to re-engage other sellers after edit (non-blocking):", err));

      const sellerDiscordId = asText(f["Seller Discord ID"]);

      if (sellerDiscordId) {
        // Recomputed here (not reused from the earlier validation
        // block above — that's a separate if/else, this one's own
        // scope) — the seller's actual last raw counter, straight off
        // the previous round.
        const previousSellerCounterForNotify = numberValue(previousFields["Seller Counter Price"]);

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
          sellerOriginalVatType: asText(f["Seller Original VAT Type"]),
          sellerLastOfferPrice: previousSellerCounterForNotify
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

// ---------------------------------------------------------------------
// NEW — additive only: lets the store's Discord bot (airtable-discord-
// updates-main) check, before handling an Accept/Counter/Deny click on
// the standard "Offer Request" message, whether this order actually
// has an active consignment offer to route to — instead of always
// assuming it's a regular seller offer and going to the wrong backend.
// ---------------------------------------------------------------------
app.get("/api/consignment/offers/active-for-order", async (req, res) => {
  try {
    const orderRecordId = asText(req.query.order_record_id);

    if (!orderRecordId) {
      return res.status(400).json({ error: "Missing order_record_id" });
    }

    const { data, error } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("order_record_id", orderRecordId)
      .in("status", ["open", "store_pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    res.json({ ok: true, offer: data || null });
  } catch (err) {
    console.error("Failed to look up active consignment offer for order:", err);
    res.status(500).json({ error: "Failed to look up active consignment offer" });
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
    // NEW — additive only: supports the merged "Offers" tab with
    // Open/Counter/Denied pills. Defaults to "open" so any existing
    // caller that doesn't pass this keeps working unchanged.
    const filter = asText(req.query.filter) || "open";

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    let query = supabase
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
        consignor_counter_price,
        vat_type,
        status,
        is_counter_offer,
        source_type,
        member_wtb_record_id,
        previous_offer_id,
        denied_at,
        consignor_counter_at,
        created_at
      `)
      .eq("seller_record_id", sellerRecordId);

    if (filter === "counter") {
      // FIXED — this must mean "the consignor's OWN counter, currently
      // awaiting the store" (status=store_pending) — not "anything
      // that's ever been countered". The earlier is_counter_offer-based
      // split conflated "store's turn to act" (which belongs in Open,
      // since the consignor can accept/counter/deny it) with "my turn
      // to wait", which are opposite things.
      query = query.eq("status", "store_pending");
    } else if (filter === "denied") {
      query = query.in("status", ["denied", "store_denied"]);
    } else {
      // "open" — anything currently awaiting the CONSIGNOR's action:
      // a fresh offer they've never responded to, or the store's
      // counter-back on a round they already responded to once. Either
      // way, status=open means it's their move.
      query = query.eq("status", "open");
    }

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) throw error;

    // NEW — additive only: for the Countered pill specifically, look up
    // the previous round's store price so the Accept-Previous button
    // can show the actual amount ("Accept €150") instead of a generic
    // label — needed everywhere this button appears.
    let items = data || [];

    if (filter === "counter" && items.length) {
      const previousIds = items
        .map((item) => item.previous_offer_id)
        .filter(Boolean);

      if (previousIds.length) {
        const { data: previousRows } = await supabase
          .from("consignment_offers")
          .select("id, store_counter_price")
          .in("id", previousIds);

        const previousPriceById = new Map(
          (previousRows || []).map((row) => [row.id, row.store_counter_price])
        );

        items = items.map((item) => ({
          ...item,
          previous_store_price: item.previous_offer_id
            ? previousPriceById.get(item.previous_offer_id) ?? null
            : null
        }));
      }
    }

    res.json({
      ok: true,
      count: items.length,
      items
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

    // FIXED — the previous check/write pair here compared and wrote an
    // already-margined store price directly against/into "Lowest
    // Offer", which is meant to hold the PRE-margin figure (the same
    // scale a regular seller's raw offer uses) — the Airtable "Offer
    // To Store" formula applies margin to whatever's in Lowest Offer,
    // so writing an already-margined number there would double the
    // margin once that formula runs. Now compares against "Offer To
    // Store" (the correct, already-margined comparison point) and
    // writes storeBasePrice (pre-margin) instead.
    const lowestOfferCheck = await validateAndSyncConsignorPriceAgainstLowestOffer({
      orderRecordId: offer.order_record_id,
      orderFields,
      storeBasePrice,
      computedStoreOfferPrice: storeOfferPrice
    });

    if (!lowestOfferCheck.ok) {
      return res.status(409).json({ error: lowestOfferCheck.error });
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

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to submit counter offer",
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

    // NEW — additive only: a row with no store_counter_price anywhere in
    // its chain AND no previous_offer_id (e.g. AutoAllocateBestUnit's
    // pre-offer for a non-auto-accepting store) means the store has
    // never actually responded yet — there IS no prior store position to
    // validate a two-sided band against. This used to hard-error here
    // ("Could not determine the store's previous counter"), blocking the
    // store from ever countering this type of offer. Falls through to a
    // one-sided check below instead (same shape a genuine round-1 counter
    // uses elsewhere in this system) rather than requiring an own
    // reference that legitimately doesn't exist yet.
    const hasStoreOwnReference = storeOwnReference > 0;

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

    const validation = hasStoreOwnReference
      ? validateNextCounterPrice(storeOwnReference, consignorCounterInStoreTerms, proposedPrice)
      : (proposedPrice <= Math.floor(consignorCounterInStoreTerms - MIN_COUNTER_STEP)
          ? { ok: true, band: [1, Math.floor(consignorCounterInStoreTerms - MIN_COUNTER_STEP)] }
          : {
              ok: false,
              reason: `Your counter must be lower than the consignor's offer (€${fmtEuroAmount(consignorCounterInStoreTerms)}) — maximum €${Math.floor(consignorCounterInStoreTerms - MIN_COUNTER_STEP)}.`,
              band: [1, Math.floor(consignorCounterInStoreTerms - MIN_COUNTER_STEP)]
            });
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
        noRoomToCounter,
        isFirstStoreResponse: !hasStoreOwnReference
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
    // FIXED — the Portal calls this too, and can't safely embed
    // COUNTER_OFFERS_SECRET client-side (anyone could read it from the
    // page source and act on any seller's offers). Now accepts EITHER
    // the secret (for server-to-server calls, e.g. curl testing) OR a
    // seller_record_id that matches the offer's own owner — same
    // pattern already used by /deny, /confirm, and /counter.
    const secret = asText(req.headers["x-kc-secret"]);
    const hasValidSecret = !!COUNTER_OFFERS_SECRET && secret === COUNTER_OFFERS_SECRET;
    const requestingSellerRecordId = asText(req.body?.seller_record_id);

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

    if (!hasValidSecret) {
      if (!requestingSellerRecordId || requestingSellerRecordId !== previousOffer.seller_record_id) {
        return res.status(401).json({ error: "Unauthorized" });
      }
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

    // FIXED — replaces two redundant, wrongly-scaled checks (one of
    // which also wrote an already-margined price directly into
    // "Lowest Offer", which would double the margin once the Airtable
    // "Offer To Store" formula runs on it) with one correct call:
    // compares against "Offer To Store" and writes the pre-margin
    // storeBaseForProposed value, matching the scale a regular
    // seller's raw offer uses.
    const lowestOfferCheck = await validateAndSyncConsignorPriceAgainstLowestOffer({
      orderRecordId: previousOffer.order_record_id,
      orderFields,
      storeBasePrice: storeBaseForProposed,
      computedStoreOfferPrice: proposedInStoreTerms
    });

    if (!lowestOfferCheck.ok) {
      return res.status(409).json({ error: lowestOfferCheck.error });
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
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to process consignor counter",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: consignor submits a fresh counter from the
// Portal's Denied pill, after their counter was denied with nothing to
// reopen (a genuine dead end — commonly the very first consignor
// counter, since that one updates the round-1 row in place rather than
// creating a new row, so it never gets its own previous_offer_id).
// Portal-triggered only (no Discord RETRY button on this side per his
// direction) — the store still gets notified the normal way, via the
// same Discord mechanism used for every other consignor counter.
// Requires the new counter to be at least MIN_COUNTER_STEP higher than
// the denied one.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/consignor-retry", async (req, res) => {
  try {
    const deniedOfferId = asText(req.params.id);
    const retryPrice = Number(req.body?.price);
    const requestingSellerRecordId = asText(req.body?.seller_record_id);

    if (!Number.isFinite(retryPrice) || retryPrice <= 0) {
      return res.status(400).json({ error: "Invalid counter price" });
    }

    const { data: deniedOffer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", deniedOfferId)
      .single();

    if (fetchError || !deniedOffer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    // FIXED — this had no auth check at all; anyone who guessed/saw an
    // offer id could retry on someone else's behalf. Same
    // seller_record_id-ownership pattern used elsewhere in this file.
    if (!requestingSellerRecordId || requestingSellerRecordId !== deniedOffer.seller_record_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (deniedOffer.previous_offer_id) {
      return res.status(409).json({
        error: "This offer has a prior round to reopen instead — use the normal deny-reopen flow, not retry."
      });
    }

    const deniedPrice = Number(deniedOffer.consignor_counter_price);

    if (Number.isFinite(deniedPrice) && retryPrice < deniedPrice + MIN_COUNTER_STEP) {
      return res.status(400).json({
        error: `Your new counter must be at least €${MIN_COUNTER_STEP.toFixed(2)} higher than the denied €${deniedPrice.toFixed(2)}.`
      });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(deniedOffer.order_record_id);
    const orderFields = orderRecord.fields || {};
    const clientCountry = asText(orderFields["Client Country"]);

    const storeBasePrice = convertConsignorPriceToStoreBasePrice(
      retryPrice,
      deniedOffer.vat_type,
      clientCountry
    );

    const storeOfferVatType = getStoreOfferVatTypeFromConsignmentVat(
      deniedOffer.vat_type,
      clientCountry
    );

    const storeOfferPrice = calculateStoreCustomOfferFromConsignmentBase(
      storeBasePrice,
      orderFields
    );

    if (!Number.isFinite(storeBasePrice) || !Number.isFinite(storeOfferPrice)) {
      return res.status(400).json({ error: "Could not calculate store offer price" });
    }

    const storeOfferPriceExclVat =
      storeOfferVatType === "VAT21"
        ? Math.round((storeOfferPrice / 1.21) * 100) / 100
        : storeOfferPrice;

    // NEW — additive only: same shared-competition check as the other
    // consignor counter endpoints — a retry must still beat whatever's
    // currently the best price available from any source.
    const lowestOfferCheck = await validateAndSyncConsignorPriceAgainstLowestOffer({
      orderRecordId: deniedOffer.order_record_id,
      orderFields,
      storeBasePrice,
      computedStoreOfferPrice: storeOfferPrice
    });

    if (!lowestOfferCheck.ok) {
      return res.status(409).json({ error: lowestOfferCheck.error });
    }

    const nowIso = new Date().toISOString();

    // Genuinely fresh round — no previous_offer_id, exactly like the
    // original round-1 counter this replaces.
    const { data: newOffer, error: createError } = await supabase
      .from("consignment_offers")
      .insert({
        order_record_id: deniedOffer.order_record_id,
        order_id: deniedOffer.order_id,
        inventory_id: deniedOffer.inventory_id,

        seller_record_id: deniedOffer.seller_record_id,
        seller_id: deniedOffer.seller_id,

        product_name: deniedOffer.product_name,
        sku: deniedOffer.sku,
        size: deniedOffer.size,
        brand: deniedOffer.brand,

        vat_type: deniedOffer.vat_type,
        seller_price: deniedOffer.seller_price,
        offer_price: deniedOffer.offer_price,

        is_counter_offer: true,
        consignor_counter_price: retryPrice,
        consignor_counter_store_price: storeOfferPrice,
        consignor_counter_store_price_excl_vat: storeOfferPriceExclVat,
        consignor_counter_at: nowIso,

        status: "store_pending",
        store_response_status: "pending",
        created_at: nowIso,
        updated_at: nowIso
      })
      .select()
      .single();

    if (createError) throw createError;

    const discordResult = await postConsignmentCounterStoreOffer({
      offer: newOffer,
      orderFields,
      storeOfferPrice,
      storeOfferVatType
    }).catch((err) => {
      console.error("Failed to notify store of consignor retry (non-blocking):", err);
      return null;
    });

    if (discordResult) {
      await supabase
        .from("consignment_offers")
        .update({
          store_offer_channel_id: discordResult.channel_id || null,
          store_offer_message_id: discordResult.message_id || null,
          updated_at: new Date().toISOString()
        })
        .eq("id", newOffer.id);
    }

    res.json({
      ok: true,
      new_offer_id: newOffer.id,
      store_offer_price: storeOfferPrice,
      store_offer_vat_type: storeOfferVatType,
      dm_sent: !!discordResult
    });
  } catch (err) {
    console.error("Failed to process consignment consignor-retry:", err);
    res.status(500).json({ error: "Failed to process consignor retry", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: shared edit endpoint for Consignment, mirroring
// Store Orders/Member WTB exactly — same chain-aware own-reference
// lookup for both directions, same min-step rule as countering.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/edit", async (req, res) => {
  try {
    // FIXED — this endpoint is shared by both the store side (Discord,
    // uses the secret — stores have no seller_record_id to check
    // ownership against) and now also the consignor Portal, which
    // can't safely embed the secret client-side. Accepts either.
    const secret = asText(req.headers["x-kc-secret"]);
    const hasValidSecret = !!COUNTER_OFFERS_SECRET && secret === COUNTER_OFFERS_SECRET;
    const requestingSellerRecordId = asText(req.body?.seller_record_id);

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

    if (!hasValidSecret) {
      if (!requestingSellerRecordId || requestingSellerRecordId !== offer.seller_record_id) {
        return res.status(401).json({ error: "Unauthorized" });
      }
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

    // FIXED — reopen-the-prior-round logic used to live only in the
    // Discord button handler for this action, meaning anything else
    // that called this endpoint directly (like the Portal) would skip
    // it entirely. Moved here so both share the same behavior.
    const { data: deniedOfferForReopen } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", offerId)
      .single();

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

    try {
      if (deniedOfferForReopen?.previous_offer_id) {
        const { data: priorOffer, error: priorFetchError } = await supabase
          .from("consignment_offers")
          .select("*")
          .eq("id", deniedOfferForReopen.previous_offer_id)
          .single();

        if (priorFetchError) {
          console.error("Consignment reopen: failed to fetch prior offer:", deniedOfferForReopen.previous_offer_id, priorFetchError);
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
            deniedAmount: Number(deniedOfferForReopen.store_counter_price)
          });

          console.log("Consignment reopen: re-notification sent successfully for:", priorOffer.id);
        } else {
          console.error("Consignment reopen: priorOffer not found (no error, but empty result) for id:", deniedOfferForReopen.previous_offer_id);
        }
      } else {
        console.log("Consignment reopen: no previous_offer_id on denied offer, nothing to reopen:", offerId);
      }
    } catch (reopenErr) {
      console.error("Failed to reopen prior round after consignment deny (non-blocking):", reopenErr);
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

// ---------------------------------------------------------------------
// NEW — additive only: lets the consignor, while their own counter is
// still pending (shown in the Portal's Countered pill), fall back to
// accepting the store's PREVIOUS position instead of waiting on a
// response that may never come. Reuses the existing, already-verified
// confirmConsignmentOffer logic on the prior round — this is not a new
// accept mechanism, just a new way to reach the existing one.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/accept-previous", async (req, res) => {
  try {
    const pendingOfferId = asText(req.params.id);
    const requestingSellerRecordId = asText(req.body?.seller_record_id);

    const { data: pendingOffer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("*")
      .eq("id", pendingOfferId)
      .single();

    if (fetchError || !pendingOffer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (!requestingSellerRecordId || requestingSellerRecordId !== pendingOffer.seller_record_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (pendingOffer.status !== "store_pending") {
      return res.status(409).json({ error: "This counter is no longer pending." });
    }

    if (!pendingOffer.previous_offer_id) {
      return res.status(409).json({ error: "There is no previous offer to accept — this was a fresh counter with nothing before it." });
    }

    // Abandon the pending counter — the consignor is choosing the
    // store's earlier position instead, so this one is no longer live.
    await supabase
      .from("consignment_offers")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", pendingOfferId);

    const result = await confirmConsignmentOffer(pendingOffer.previous_offer_id);

    if (!result.ok) {
      return res.status(409).json({
        error: "The store's previous offer is no longer available to accept."
      });
    }

    res.json({
      ok: true,
      offer: result.offer
    });
  } catch (err) {
    console.error("Failed to accept previous consignment offer:", err);

    res.status(500).json({
      error: "Failed to accept previous offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets the consignor remove an item from their
// Countered or Denied pill that they no longer want to pursue (either
// their own pending counter, or a denied offer they don't want to
// retry). Soft-delete only — sets status to "cancelled" rather than
// destroying the row, so nothing downstream that might reference this
// record (audit trail, etc.) breaks.
// ---------------------------------------------------------------------
app.post("/api/consignment/offers/:id/cancel", async (req, res) => {
  try {
    const offerId = asText(req.params.id);
    const requestingSellerRecordId = asText(req.body?.seller_record_id);

    const { data: offer, error: fetchError } = await supabase
      .from("consignment_offers")
      .select("id, status, seller_record_id")
      .eq("id", offerId)
      .single();

    if (fetchError || !offer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    if (!requestingSellerRecordId || requestingSellerRecordId !== offer.seller_record_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!["store_pending", "denied", "store_denied"].includes(offer.status)) {
      return res.status(409).json({ error: "Only a pending counter or a denied offer can be cancelled." });
    }

    await supabase
      .from("consignment_offers")
      .update({ status: "cancelled", closed_at: new Date().toISOString() })
      .eq("id", offerId);

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to cancel consignment offer:", err);

    res.status(500).json({
      error: "Failed to cancel offer",
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

// NEW — additive only: format a money amount for an error message.
// Shows 2 decimals only when the value actually has a fractional part,
// so a store's VAT0-scale figure reads €181.82 (not €181.8181818…) but
// a whole-euro figure still reads €185 (not €185.00).
function fmtEuroAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function validateNextCounterPrice(ownReferencePrice, counterpartPrice, proposed, options = {}) {
  const { enforceMinStep = true, requireInteger = true } = options;

  // NEW — additive only: his exact catch — a non-Dutch buyer typing a
  // whole-number counter (e.g. 175) against a VAT-source position gets
  // multiplied by 1.21 for internal storage before reaching here,
  // which legitimately isn't a whole number anymore (211.75) even
  // though what the person actually typed was. requireInteger lets
  // the 4 VAT-context conversion call sites skip this specific check
  // without loosening it for every other, untouched caller.
  if (requireInteger && !Number.isInteger(proposed)) {
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
      ? `Your counter must be lower than your previous €${fmtEuroAmount(ownReferencePrice)} — maximum €${fmtEuroAmount(maxAllowed)}.`
      : `Your counter must be higher than your previous €${fmtEuroAmount(ownReferencePrice)} — minimum €${fmtEuroAmount(minAllowed)}.`;
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

// NEW — additive only: his explicit request — a seller's own narrowing
// band and the cross-seller "beat the current lowest" ceiling used to
// be validated as two completely independent, sequential gates. That
// let a proposed price fail the FIRST gate (own band) with a
// misleading error that never mentioned the SECOND gate (cross-seller)
// even existed — and, worse, meant "No room left" only ever appeared
// when the own band ALONE happened to be too narrow, never when the
// combination of both constraints left no valid price at all. His
// exact case: seller's own band allowed [82, 86], but another seller's
// genuinely lower position meant nothing above ~80 could ever be
// competitive — the true valid range was empty, but the seller never
// saw "No room left," just a confusing "maximum €86" that didn't
// mention the real, binding constraint. This computes the seller's own
// band exactly like validateNextCounterPrice does internally, then
// folds in the cross-seller ceiling as an ADDITIONAL cap on the upper
// bound before returning — giving one combined, honest answer.
function validateNextCounterPriceWithCrossSellerCeiling(ownReferencePrice, counterpartPrice, proposed, crossSellerCeiling, crossSellerReferencePrice = null) {
  const movingDown = ownReferencePrice > counterpartPrice;
  const low = Math.min(ownReferencePrice, counterpartPrice);
  const high = Math.max(ownReferencePrice, counterpartPrice);

  let minAllowed = low + 1;
  let maxAllowed = high - 1;

  if (movingDown) {
    maxAllowed = Math.floor(ownReferencePrice - MIN_COUNTER_STEP);
  } else {
    minAllowed = Math.ceil(ownReferencePrice + MIN_COUNTER_STEP);
  }

  // Fold in the cross-seller ceiling — only ever tightens the upper
  // bound further, never loosens it. A seller moving UP (asking for
  // more) is unaffected by this — the cross-seller ceiling only
  // matters when it's LOWER than what their own band would otherwise
  // allow, i.e. when they're trying to move DOWN toward it.
  // NEW — additive only: his exact, valid point — when the ceiling is
  // what ACTUALLY tightened the band, the error should say so ("the
  // current lowest offer"), not blame "your previous" position, which
  // makes the resulting gap look arbitrary (e.g. "previous €95 —
  // maximum €89" hides that the real reason for landing at 89 was
  // another seller's €92, not anything about the seller's own €95).
  const ownBandMaxAllowed = maxAllowed;
  let crossSellerIsBindingConstraint = false;
  if (Number.isFinite(crossSellerCeiling) && crossSellerCeiling < maxAllowed) {
    maxAllowed = crossSellerCeiling;
    crossSellerIsBindingConstraint = true;
  }

  if (minAllowed > maxAllowed) {
    return {
      ok: false,
      reason: "No room left to counter — the gap is too small for another step, please accept or deny.",
      band: [low, high]
    };
  }

  if (!Number.isInteger(proposed)) {
    return { ok: false, reason: "Counter offers must be a whole number.", band: [minAllowed, maxAllowed] };
  }

  if (proposed < minAllowed || proposed > maxAllowed) {
    let reason;
    if (movingDown && crossSellerIsBindingConstraint && proposed > maxAllowed) {
      // The proposed price failed specifically because of the
      // cross-seller ceiling (not the seller's own band) — say so,
      // using the actual reference price when given (avoids rounding
      // artifacts from reconstructing it off the computed ceiling).
      const displayPrice = Number.isFinite(crossSellerReferencePrice) ? crossSellerReferencePrice : (crossSellerCeiling + MIN_COUNTER_STEP);
      reason = `Your counter must be lower than the current lowest offer of €${fmtEuroAmount(displayPrice)} — maximum €${fmtEuroAmount(maxAllowed)}.`;
    } else {
      reason = movingDown
        ? `Your counter must be lower than your previous €${fmtEuroAmount(ownReferencePrice)} — maximum €${fmtEuroAmount(maxAllowed)}.`
        : `Your counter must be higher than your previous €${fmtEuroAmount(ownReferencePrice)} — minimum €${fmtEuroAmount(minAllowed)}.`;
    }
    return { ok: false, reason, band: [minAllowed, maxAllowed] };
  }

  return { ok: true, band: [minAllowed, maxAllowed] };
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

// NEW — additive only: his preference — sellers always enter whole
// numbers, so most prices ARE whole numbers and should look clean
// (€80, not €80,00). But a Member WTB buyer-facing price run through
// VAT21 conversion can genuinely land on a decimal (€102.10) — that
// must stay visible exactly as computed, never silently rounded away
// (moneyWholeValue's Math.floor would quietly turn that into €102,
// a real 10-cent discrepancy against what was actually agreed). This
// shows decimals only when the real number actually has them, making
// the VAT-conversion case visually distinct rather than hidden.
function moneySmartValue(value) {
  const n = numberValue(value);

  if (!n) return "";

  const isWhole = Math.abs(n - Math.round(n)) < 0.005;

  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: isWhole ? 0 : 2,
    minimumFractionDigits: isWhole ? 0 : 2
  }).format(n);
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

function getCounterEquivalentPriceForVatType(storeCounterAllInPrice, vatType, orderFields = {}) {
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
    // FIXED — must invert MAX(base+10, base*(1+pct)+5), same fix as
    // calculateStoreCounterEquivalent's forward direction, mirrored
    // using the same proven threshold-based approach already used in
    // calculateConsignmentBaseFromStoreOffer below (a naive
    // min(converted-10, converted/(1+percentage)) was both missing the
    // "-5" and less explicit about which branch actually applies).
    const threshold = 5 / percentage;
    const candidateFromFloor = converted - 10;
    const candidateFromPercentage = (converted - 5) / (1 + percentage);
    payout = candidateFromFloor <= threshold ? candidateFromFloor : candidateFromPercentage;
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
function calculateStoreCounterEquivalent(sellerAskPrice, vatType, orderFields = {}, preAdjustmentMultiplier = 1) {
  let converted = getCounterEquivalentPriceForVatType(sellerAskPrice, vatType);

  if (!Number.isFinite(converted) || converted <= 0) return null;

  // NEW — additive only: his exact catch — applying a non-Dutch
  // display adjustment AFTER this function's own internal rounding
  // (roundToNearestStep below) loses precision (e.g. €192.50 becoming
  // €193.60). Applying it here, before the margin math and before the
  // single rounding step at the end, gives the exact same figure the
  // store originally saw on the fresh-offer embed.
  converted = converted * preAdjustmentMultiplier;

  const margin = numberValue(orderFields["Offer Margin"]);
  const percentage = numberValue(orderFields["Offer Percentage"]);
  const method = asText(orderFields["Offer Method"]);

  let storePrice;

  if (method === "Firm Range" && Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else if (Number.isFinite(percentage) && percentage > 0) {
    // FIXED — his confirmed, deliberate design: the Airtable "Offer To
    // Store" formula's Percentage branch is
    // MAX(base+10, base*(1+pct)+5) — the "+5" was missing here,
    // producing a store price up to €5 lower than the formula would
    // give the exact same raw seller price for. Mirrors the already-
    // correct calculateStoreCustomOfferFromConsignmentBase below.
    storePrice = Math.max(
      converted + 10,
      converted * (1 + percentage) + 5
    );
  } else if (Number.isFinite(margin) && margin > 0) {
    storePrice = converted + margin;
  } else {
    return null;
  }

  return roundToNearestStep(storePrice, 2.5);
}

// NEW — additive only: the store types/sees/pays in the VAT-scale of
// the offer embed they're responding to. For a non-Dutch store
// responding to a VAT-source (VAT21/VAT0) position, that scale is
// excl.-VAT vs the internal all-in scale; for a Dutch store, or a
// Margin-source position, it's the plain all-in scale (÷1). This
// divisor converts an internal all-in figure back to what the store
// should SEE in a store-facing embed / the Portal.
// FIXED — the excl. divisor now uses the client's REAL VAT rate (e.g.
// 22% for Italy → ÷1.22) so the store's displayed "Your Previous
// Counter" matches the invoice's "Store Counter Price Excl VAT" (which
// also uses the real rate) instead of drifting by the 1.21-vs-1.22 gap
// (e.g. 220 all-in showed €181.82 but the invoice said €180.33). Falls
// back to 1.21 only if the rate field is missing. This is display-only
// — it does not touch any payout, band, or accept math.
function storeDisplayDivisor(storeVatContext, orderFields = {}) {
  const isDutch = isDutchClientCountry(orderFields["Client Country"]);
  const isVatSource = storeVatContext === "VAT21" || storeVatContext === "VAT0";
  if (isDutch || !isVatSource) return 1;
  const rate = numberValue(orderFields["Client VAT Rate"]);
  return (Number.isFinite(rate) && rate > 0) ? (1 + rate) : 1.21;
}

// NEW — additive only: the multiplier that converts a store's typed
// VAT0/VAT21 counter (in the store's own excl. scale) UP to the
// internal all-in scale for storage. Uses the client's REAL VAT rate
// (e.g. 22% Italy → ×1.22) so that "Store Counter Price Excl VAT"
// (which divides by that same real rate) comes back to EXACTLY what the
// store typed — e.g. store types €185 → stored 225.70 → excl €185, not
// the old ×1.21 → 223.85 → excl €183.48 mismatch. This is the exact
// inverse of storeDisplayDivisor, so input and display round-trip
// perfectly. Falls back to 1.21 if the rate field is missing. Does NOT
// affect the seller payout (that stays ÷1.21 — VAT21 is a real Dutch
// 21% and VAT0 payouts were already correct).
function storeInputMultiplier(orderFields = {}) {
  const rate = numberValue(orderFields["Client VAT Rate"]);
  return (Number.isFinite(rate) && rate > 0) ? (1 + rate) : 1.21;
}

// NEW — additive only: computes the "Seller's New Counter" figure a
// store-facing embed should show, in the STORE's own scale. The
// seller's counter is already in the same VAT context the store is
// negotiating in (VAT0→VAT0 for a non-Dutch store on a VAT-source
// position — no ÷1.21 — or all-in for a Dutch store / Margin), so we
// apply the store's margin markup directly via the Margin path (no
// VAT deling), then the store-display divisor stays 1 in that case.
// For a Dutch store the internal all-in figure IS what they see, so
// the divisor is 1 there too. This mirrors his confirmed rule:
// "Seller's New Counter is the margin formula on the seller's
// counter, without ×1.21 for VAT0→VAT0, but ×1.21 if the store is
// Dutch."
function computeSellerCounterForStoreDisplay(sellerCounterPrice, storeVatContext, orderFields = {}) {
  const isDutch = isDutchClientCountry(orderFields["Client Country"]);
  const isVatSource = storeVatContext === "VAT21" || storeVatContext === "VAT0";

  if (!isDutch && isVatSource) {
    // VAT0→VAT0 (or VAT21 excl.): seller's counter is already in the
    // store's excl. scale — apply margin markup with NO VAT deling by
    // routing through the Margin path.
    return calculateStoreCounterEquivalent(sellerCounterPrice, "Margin", orderFields);
  }

  // Dutch store, or Margin source: the store sees the plain all-in
  // figure, computed with the seller's real VAT type (which applies
  // ÷1.21 internally for VAT0, giving the incl. all-in the Dutch store
  // expects).
  return calculateStoreCounterEquivalent(sellerCounterPrice, storeVatContext, orderFields);
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

// NEW — additive only: the value to write into "Custom Offer" when a
// deal is accepted. calculateLinkedUnitPrice.js takes Custom Offer
// essentially 1:1 (it only divides by 1.21 for a NL + VAT21 order, to
// force the VAT-exclusive Final Buying Price a Dutch VAT product
// requires). So Custom Offer must ALREADY be on the right scale per
// VAT type:
//   - VAT21 (only ever a NL store): store was offered/accepted an
//     ALL-IN figure → write the all-in Store Counter Price; the
//     downstream script divides it by 1.21 itself.
//   - VAT0 (only ever a non-NL store): we invoice that store VAT-
//     EXCLUSIVE, and the downstream script does NOT divide for VAT0 →
//     so Custom Offer must already be the excl. figure. Use the
//     Airtable-computed "Store Counter Price Excl VAT" (which uses the
//     client's real VAT rate, e.g. 22% for Italy — more correct than a
//     hardcoded 1.21), falling back to the store all-in price if that
//     field is somehow empty.
//   - Margin: no VAT at all → the full Store Counter Price.
// This is the fix for "accepted a VAT0 deal but the store got invoiced
// the full incl. price": Custom Offer was the all-in figure with VAT
// type VAT0, and the downstream script took it as-is (no VAT0 branch
// there), so the store was billed the gross amount instead of the net.
function customOfferValueForAccept(vatType, storeAllInPrice, storeExclVatPrice) {
  const type = asText(vatType).toUpperCase().replace(/\s+/g, "");
  const allIn = Number(storeAllInPrice);

  if (type === "VAT0") {
    const excl = Number(storeExclVatPrice);
    if (Number.isFinite(excl) && excl > 0) return excl;
    // Fallback only if the Excl VAT formula field is unexpectedly empty.
    return Number.isFinite(allIn) ? allIn : null;
  }

  // VAT21 and Margin: write the all-in Store Counter Price unchanged.
  return Number.isFinite(allIn) ? allIn : null;
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
  sellerLastOfferPrice,
  noRoomToCounter,
  deniedAmount
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  // FIXED — his call: primary reference should be the seller's LAST
  // position, not their original ask — that's the only thing that
  // matters for the decision in front of them right now ("only €5
  // lower than what I last offered — I'll take it"), and it matches
  // the narrowing-band rule itself (always evaluated against the last
  // position, never the original). Falls back to the original when no
  // distinct last position exists yet (a genuine round-1 notification,
  // where last and original are the same number anyway).
  const effectiveLastOffer = Number.isFinite(Number(sellerLastOfferPrice)) && sellerLastOfferPrice !== null
    ? sellerLastOfferPrice
    : sellerOriginalPrice;

  const lastOfferText =
    effectiveLastOffer !== undefined && effectiveLastOffer !== null && effectiveLastOffer !== ""
      ? `€${Number(effectiveLastOffer).toFixed(2)} · ${sellerOriginalVatType || "—"}`
      : null;

  const diffText =
    lastOfferText && Number.isFinite(Number(effectiveLastOffer)) && Number.isFinite(Number(payout))
      ? ` (${Number(payout) - Number(effectiveLastOffer) >= 0 ? "+" : ""}€${(Number(payout) - Number(effectiveLastOffer)).toFixed(2)})`
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
  // FIXED — his correction: simplified from an earlier, overcomplicated
  // version that tried to distinguish "your own counter" wording from
  // "the current lowest was denied" wording, needing a specific euro
  // amount either way. Simpler and always correct: a plain "your offer
  // was denied," no amount — the rest of the embed already shows this
  // seller's OWN correct numbers (their last offer, the new counter
  // payout), so nothing is lost by not repeating a number here that
  // might not even be theirs.
  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? ["❌ Your offer was denied.", ""]
      : [];

  const message = await dm.send({
    embeds: [
      {
        // FIXED — when this notification is specifically a re-send
        // after the seller's own counter was denied (deniedAmount
        // present), it should look like the denial it actually is —
        // matching sendOfferDeniedDiscordDM's red "Offer Denied" style
        // — not the neutral yellow "Counter Offer" look a genuinely
        // fresh counter gets. Same content and buttons either way.
        title: deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== "" ? "❌ Offer Denied" : "🔁 Counter Offer",
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
          ...(lastOfferText ? [`**Your last offer**`, lastOfferText, ""] : []),
          `**Counter payout**`,
          `€${Number(payout).toFixed(2)} · ${vatType || "—"}${diffText}`,
          "",
          closingLine
        ].join("\n"),
        color: deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== "" ? 0xe74c3c : 0xf1c40f
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
  sellerLastOfferPrice,
  noRoomToCounter,
  deniedAmount
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  // FIXED — same change as sendCounterOfferDiscordDM (WTB): show the
  // seller's LAST position primarily, original ask as a small
  // secondary reference — consistent across both flows now.
  const effectiveLastOffer = Number.isFinite(Number(sellerLastOfferPrice)) && sellerLastOfferPrice !== null
    ? sellerLastOfferPrice
    : sellerOriginalPrice;

  const lastOfferText =
    effectiveLastOffer !== undefined && effectiveLastOffer !== null && effectiveLastOffer !== ""
      ? `€${Number(effectiveLastOffer).toFixed(2)} · ${sellerOriginalVatType || "—"}`
      : null;

  const diffText =
    lastOfferText && Number.isFinite(Number(effectiveLastOffer)) && Number.isFinite(Number(payout))
      ? ` (${Number(payout) - Number(effectiveLastOffer) >= 0 ? "+" : ""}€${(Number(payout) - Number(effectiveLastOffer)).toFixed(2)})`
      : "";

  const closingLine = noRoomToCounter
    ? "You're now very close to each other's price — there's no room for another counter. Please accept or deny."
    : "Accept if you can fulfill this at the counter price.";

  // FIXED — his correction: simplified from an earlier, overcomplicated
  // version that tried to distinguish "your own counter" wording from
  // "the current lowest was denied" wording, needing a specific euro
  // amount either way. Simpler and always correct: a plain "your offer
  // was denied," no amount — the rest of the embed already shows this
  // seller's OWN correct numbers (their last offer, the new counter
  // payout), so nothing is lost by not repeating a number here that
  // might not even be theirs.
  const deniedNote =
    deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== ""
      ? ["❌ Your offer was denied.", ""]
      : [];

  const message = await dm.send({
    embeds: [
      {
        // FIXED — same fix as sendCounterOfferDiscordDM (WTB) — this
        // was never applied here, so a re-send after the seller's own
        // counter was denied still looked like a neutral, fresh
        // counter instead of the denial it actually is.
        title: deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== "" ? "❌ Offer Denied" : "🔁 Counter Offer",
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
          ...(lastOfferText ? [`**Your last offer**`, lastOfferText, ""] : []),
          `**Counter payout**`,
          `€${Number(payout).toFixed(2)} · ${vatType || "—"}${diffText}`,
          "",
          closingLine
        ].join("\n"),
        color: deniedAmount !== undefined && deniedAmount !== null && deniedAmount !== "" ? 0xe74c3c : 0xf1c40f
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
  vatType,
  // NEW — additive only: this function is being reused for Member WTB
  // too (his exact scenario — denying a genuinely fresh, never-
  // countered Member WTB offer) — the button handler behind "Place New
  // Offer" already routes generically to the now Member-WTB-aware
  // /api/seller-offers/:offerId/edit-after-denial, so no new DM
  // function is needed, just this small label so the embed correctly
  // says "Member WTB" instead of "Order" in that context.
  contextLabel = "Order"
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
          `${contextLabel}: ${orderId || orderRecordId || "—"}`,
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
    if (!Number.isFinite(percentage)) return null;
    rawOffer = Math.max(base + 10, base * (1 + percentage) + 5);
  }

  // FIXED — a real, confirmed bug found via his live testing: this used
  // roundUpToStep (always rounds UP), but the actual "Offer To Store"
  // Airtable formula uses ROUND(value/2.5,0)*2.5 — round to NEAREST,
  // which can round DOWN. His exact incident: a consignment deal
  // negotiated/accepted around €157.10 (computed here, rounding up)
  // actually got charged €155 (from Offer To Store, rounding to
  // nearest) — the same raw number, two different rounding rules,
  // producing two different real amounts for the same deal. Using
  // roundToNearestStep here instead makes this function's result
  // always match Offer To Store exactly, for any raw value.
  return roundToNearestStep(rawOffer, 2.5);
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
    // FIXED (again) — must invert MAX(base+10, base*(1+pct)+5). The
    // floor branch (base+10) wins whenever base is at or below
    // 5/percentage (solve base+10 = base*(1+pct)+5); the percentage
    // branch wins above that threshold.
    if (!Number.isFinite(percentage) || percentage <= 0) return null;

    const threshold = 5 / percentage;
    const candidateFromFloor = store - 10;
    const candidateFromPercentage = (store - 5) / (1 + percentage);

    base = candidateFromFloor <= threshold ? candidateFromFloor : candidateFromPercentage;
  }

  return base;
}

// ---------------------------------------------------------------------
// NEW — additive only: lets consignors and regular sellers correctly
// compete on the SAME order without stepping on each other. "Lowest
// Offer" (Airtable) is the shared pool regular sellers already use —
// this makes consignment counters participate in it too, instead of
// running as a fully separate, unaware system.
//
// - Compares in STORE-FACING terms (reads "Offer To Store", the
//   formula field that's already correctly whichever price is
//   currently winning, from any source) — this is an apples-to-apples
//   comparison regardless of VAT type or margin method.
// - On success, writes storeBasePrice (the PRE-margin figure, same
//   scale as what a regular seller's raw offer represents) to "Lowest
//   Offer" — NOT the already-margined computedStoreOfferPrice, which
//   would double-apply margin once the Offer To Store formula runs.
// - Also clears "Offer Sent?" so this doesn't ALSO trigger a duplicate
//   "Offer Request" via the separate sendOfferRequestWebhook automation
//   — same fix pattern used at accept-time earlier this session.
// ---------------------------------------------------------------------
async function validateAndSyncConsignorPriceAgainstLowestOffer({
  orderRecordId,
  orderFields,
  storeBasePrice,
  computedStoreOfferPrice
}) {
  const currentOfferToStore = numberValue(orderFields["Offer To Store"]);

  // FIXED — Number.isFinite(0) is true in JS, so whenever "Offer To
  // Store" evaluated to exactly 0 (a known Airtable quirk: a Number-
  // typed formula field with no matching IF branch, e.g. both "Custom
  // Offer" and "Lowest Offer" empty, coerces to 0 instead of blank),
  // this treated it as "there's a real €0 offer to beat" — which no
  // positive counter can ever be lower than, blocking every counter
  // outright. Now correctly requires a genuinely positive value before
  // treating it as a real competing offer.
  if (Number.isFinite(currentOfferToStore) && currentOfferToStore > 0 && computedStoreOfferPrice >= currentOfferToStore) {
    return {
      ok: false,
      error: `Your counter isn't low enough — there's currently a better offer available to the store (€${currentOfferToStore.toFixed(2)}). You'll need to go lower than that.`
    };
  }

  try {
    await airtable(ORDERS_TABLE).update(orderRecordId, {
      "Lowest Offer": storeBasePrice,
      "Offer Sent?": false
    });
  } catch (err) {
    console.error("Failed to sync consignor counter to Lowest Offer (non-blocking):", err);
  }

  return { ok: true };
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
    // FIXED — must invert MAX(base+10, base*(1+pct)+5), matching the
    // fix in calculateConsignmentBaseFromStoreOffer. Previously used
    // max*(1-percentage)-5, an unrelated formula.
    if (!Number.isFinite(percentage) || percentage <= 0) {
      return null;
    }

    const threshold = 5 / percentage;
    const candidateFromFloor = max - 10;
    const candidateFromPercentage = (max - 5) / (1 + percentage);

    rawOffer = candidateFromFloor <= threshold ? candidateFromFloor : candidateFromPercentage;
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
          "Tracking URL",
          "Fulfillment Status"
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

function normalizeDeal(record, dealType) {
  const f = record.fields || {};

  return {
    id: record.id,
    source_type: "order",
    // NEW — additive only: a real, confirmed bug found via his live
    // report — the frontend used to decide "Claim Deal" vs "Make
    // Offer" purely from the currently-active TAB (a global UI
    // variable), not from what the deal itself actually is. If a
    // WTB fetch was still in flight when the user switched to the
    // Quick Deals tab, it could render with the wrong button —
    // letting a seller "claim" an order that was never meant to be
    // instantly claimable, since it isn't from an auto-accept store.
    // Every deal now carries its own reliable type, straight from the
    // query that fetched it, so rendering never has to guess.
    deal_type: dealType,
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
    // NEW — additive only: same reliable-type fix as normalizeDeal —
    // Member WTBs only ever appear under the WTB tab, so this is
    // always "wtb", but included for consistency so the frontend
    // never needs to special-case member_wtb deals separately.
    deal_type: "wtb",

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
    // NEW — additive only: supports the merged Offers tab's three
    // pills. "countered" = a counter FROM the store/buyer that the
    // seller needs to act on (Store Counter Price populated).
    // "own_counter" = the seller's OWN pending counter, awaiting the
    // store/buyer (Store Counter Price empty) — this belongs in the
    // Open pill alongside fresh, never-countered offers. "denied" =
    // anything denied. Defaults to "countered" so any existing caller
    // that doesn't pass this keeps working unchanged.
    const filter = asText(req.query.filter) || "countered";

    if (!sellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const statusFormula = filter === "denied" ? `{Status} = 'Denied'` : `{Status} = 'Open'`;

    const records = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(
          ${statusFormula},
          OR(
            {Source Type} = 'Seller Offer',
            {Source Type} = 'Member WTB'
          )
        )`
      })
      .all();

    const filteredRecords = records.filter((record) =>
      linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId)
    );

    const preFilteredByStatusRaw = filteredRecords.filter((record) => {
      if (filter === "denied") return true;

      const f = record.fields || {};
      const storeAlreadyCountered =
        f["Store Counter Price"] !== undefined &&
        f["Store Counter Price"] !== null &&
        f["Store Counter Price"] !== "";

      // "countered" wants rows where the STORE/buyer just moved
      // (seller must respond); "open" wants the opposite — the
      // seller's own pending counter, awaiting them.
      return filter === "countered" ? storeAlreadyCountered : !storeAlreadyCountered;
    });

    // FIXED — every deny-with-reopen action (the seller denying a
    // store counter) permanently leaves the just-denied round at
    // Status="Denied" — nothing ever cleans that up, since the
    // negotiation actually continues via the REOPENED round before it,
    // not through this one. That old, now-irrelevant denial stuck
    // around forever in the Denied pill alongside any genuinely final
    // denial later on, showing the same order twice. A denied round is
    // superseded if a different round shares its same "Previous Record
    // ID" (i.e., a sibling counter placed later from that same
    // reopened position) — only the round with no later sibling is the
    // real, current dead end.
    let preFilteredByStatus = preFilteredByStatusRaw;

    if (filter === "denied" && preFilteredByStatusRaw.length) {
      // FIXED — this used FIND(rawSellerRecordId, ARRAYJOIN({Seller ID})),
      // which never matches a raw record ID against a linked field's
      // ARRAYJOIN'd display value (a documented pitfall from earlier
      // this session) — so this silently matched nothing, and the
      // supersession exclusion below never actually excluded anything.
      // Fetches without ID-based formula matching and filters by
      // Seller ID in JS instead, the same reliable pattern used
      // elsewhere in this file.
      const allRoundsForSeller = await airtable(COUNTER_OFFERS_TABLE)
        .select({
          filterByFormula: `OR({Source Type} = 'Seller Offer', {Source Type} = 'Member WTB')`,
          fields: ["Seller ID", "Previous Record ID", "Created At"]
        })
        .all();

      const siblingsByPrevId = new Map();
      for (const r of allRoundsForSeller) {
        if (!linkedRecordIncludes(r.fields?.["Seller ID"], sellerRecordId)) continue;

        const prevId = firstLinkedRecordId(r.fields?.["Previous Record ID"]);
        if (!prevId) continue;
        if (!siblingsByPrevId.has(prevId)) siblingsByPrevId.set(prevId, []);
        siblingsByPrevId.get(prevId).push({
          id: r.id,
          createdAt: displayValue(r.fields?.["Created At"])
        });
      }

      preFilteredByStatus = preFilteredByStatusRaw.filter((record) => {
        const f = record.fields || {};
        const ownPrevId = firstLinkedRecordId(f["Previous Record ID"]);
        const ownCreatedAt = displayValue(f["Created At"]);

        if (!ownPrevId) return true;

        const siblings = siblingsByPrevId.get(ownPrevId) || [];
        const hasLaterSibling = siblings.some(
          (s) => s.id !== record.id && s.createdAt && ownCreatedAt && s.createdAt > ownCreatedAt
        );

        return !hasLaterSibling;
      });
    }

    // NEW — additive only: confirmed business rule — an offer should
    // only ever disappear from the Portal via an explicit Delete, or
    // because the order/Member WTB is no longer "Outsource" (fulfilled
    // elsewhere, by the store or by us via another channel). Nothing
    // previously kept Counter Offers records in sync with that — a
    // record could sit at Status="Open" forever even after the order
    // moved on. Excludes any item whose linked Order/Member WTB is no
    // longer Outsource.
    const orderIdsForStatusCheck = [...new Set(
      preFilteredByStatus
        .filter((r) => !firstLinkedRecordId(r.fields?.["Member WTB"]))
        .map((r) => firstLinkedRecordId(r.fields?.["Order"]))
        .filter(Boolean)
    )];
    const memberWtbIdsForStatusCheck = [...new Set(
      preFilteredByStatus
        .map((r) => firstLinkedRecordId(r.fields?.["Member WTB"]))
        .filter(Boolean)
    )];

    const statusCheckOrderMap = orderIdsForStatusCheck.length
      ? await loadOrderFieldsMap(orderIdsForStatusCheck)
      : new Map();

    let memberWtbStatusMap = new Map();
    if (memberWtbIdsForStatusCheck.length) {
      const mwtbFormula = `OR(${memberWtbIdsForStatusCheck.map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`).join(",")})`;
      const mwtbRecords = await airtable(MEMBER_WTBS_TABLE)
        .select({ filterByFormula: mwtbFormula, fields: ["Fulfillment Status"] })
        .all();
      memberWtbStatusMap = new Map(mwtbRecords.map((r) => [r.id, asText(r.fields?.["Fulfillment Status"])]));
    }

    // NEW — additive only: builds "am I still the lowest seller" for
    // Member WTB, which never existed before (only Store Orders had an
    // equivalent, via the "Current Lowest (Normalized)/(VAT0)" rollup).
    // FIXED — a real, confirmed bug found via his sharp catch: VAT21
    // and Margin are both already VAT-inclusive and stay as-is; only
    // VAT0 is exclusive and needs ×1.21 to land on the same comparable
    // scale. This previously checked "=== VAT21" (treating Margin the
    // same as VAT0), which unfairly inflated every Margin seller's
    // position by 21% in this comparison. Fetches every OTHER seller's
    // current position on the same Member WTB — a fresh, never-touched
    // Seller Offer if they haven't been countered yet, or their live
    // Counter Offers round's current price if they're mid-negotiation
    // — and takes the minimum. A seller is "Lowest" if their own
    // current price, normalized the same way, is at or below that.
    let memberWtbMinNormalizedPrice = new Map();
    if (memberWtbIdsForStatusCheck.length) {
      const normalize = (price, vatType) => {
        const p = Number(price);
        if (!Number.isFinite(p)) return null;
        return asText(vatType) === "VAT0" ? p * 1.21 : p;
      };

      const [competingSellerOffers, competingCounterRounds] = await Promise.all([
        airtable(SELLER_OFFERS_TABLE)
          .select({ fields: ["Member WTBs", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer"] })
          .all()
          .then((records) =>
            records.filter(
              (r) =>
                !r.fields?.["Delete Offer"] &&
                memberWtbIdsForStatusCheck.includes(firstLinkedRecordId(r.fields?.["Member WTBs"]))
            )
          ),
        airtable(COUNTER_OFFERS_TABLE)
          .select({
            filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Member WTB')`,
            fields: ["Member WTB", "Seller ID", "Seller Counter Price", "Seller Original Price", "Seller Original VAT Type"]
          })
          .all()
          .then((records) =>
            records.filter((r) => memberWtbIdsForStatusCheck.includes(firstLinkedRecordId(r.fields?.["Member WTB"])))
          )
      ]);

      // FIXED — corrects my own previous mistake this same session: I'd
      // switched this to use Counter Payout for EVERY active round,
      // which is wrong for seller-vs-seller competition specifically —
      // a round where only the BUYER's pending, unanswered ask is
      // sitting there (Seller Counter Price still empty) is NOT another
      // seller's real competing position, it's just the same baseline
      // offer mirrored to every seller at once. Confirmed directly by
      // him: "Sellers competeren alleen tegen de andere sellers en hun
      // eigen laatste laagste offer" — the buyer's own counter should
      // NEVER count as the thing sellers must beat against each other.
      // Only counts a round here once the seller has GENUINELY
      // countered (Seller Counter Price set); otherwise their raw,
      // still-untouched listing is their real position — never silently
      // excluded, and never replaced by the buyer's pending offer.
      const sellerIdsWithGenuineCounterForWtb = new Set(
        competingCounterRounds
          .filter((r) => numberValue(r.fields?.["Seller Counter Price"]) > 0)
          .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
          .filter(Boolean)
      );

      // FIXED — a real, confirmed bug found via his live testing: a
      // seller who hasn't yet responded to the LATEST buyer counter,
      // but DID counter earlier in the chain (that round has since
      // been superseded), was falling all the way back to their very
      // FIRST raw listing here — the exact same chain-tracing gap
      // already fixed for "Your Offer" and the Discord notification,
      // just never applied to THIS aggregate too. Produced the
      // reported symptom: seller B's own contribution to "the best
      // OTHER position" used their stale raw 92 instead of their real
      // last countered 89, while their OWN displayed position
      // (correctly chain-traced) showed 89 — two different sellers
      // could then both independently satisfy "am I at or below the
      // aggregate minimum," each shown as "Lowest" simultaneously.
      // Chain-traces every seller without a genuine CURRENT counter
      // too, not just a flat raw-offer fallback.
      const activeRoundIdBySeller = new Map();
      for (const cr of competingCounterRounds) {
        const sellerId = firstLinkedRecordId(cr.fields?.["Seller ID"]);
        if (sellerId && !activeRoundIdBySeller.has(sellerId)) {
          activeRoundIdBySeller.set(sellerId, cr.id);
        }
      }

      for (const so of competingSellerOffers) {
        const sellerId = firstLinkedRecordId(so.fields?.["Seller ID"]);
        if (sellerId && sellerIdsWithGenuineCounterForWtb.has(sellerId)) continue; // superseded by their genuine counter below

        const wtbId = firstLinkedRecordId(so.fields?.["Member WTBs"]);
        const activeRoundId = sellerId ? activeRoundIdBySeller.get(sellerId) : null;
        const chainTraced = activeRoundId ? await findSellersTrueLastCounter(activeRoundId) : null;
        const effectivePrice = chainTraced ?? numberValue(so.fields?.["Seller Offer"]);
        const normalized = normalize(effectivePrice, so.fields?.["Offer VAT Type"]);
        if (normalized == null) continue;

        const current = memberWtbMinNormalizedPrice.get(wtbId);
        if (current == null || normalized < current) memberWtbMinNormalizedPrice.set(wtbId, normalized);
      }

      for (const cr of competingCounterRounds) {
        const sellerCounter = numberValue(cr.fields?.["Seller Counter Price"]);
        if (!(sellerCounter > 0)) continue; // buyer's pending ask, not a genuine seller position — skip

        const wtbId = firstLinkedRecordId(cr.fields?.["Member WTB"]);
        const vatType = cr.fields?.["Seller Original VAT Type"];
        const normalized = normalize(sellerCounter, vatType);
        if (normalized == null) continue;

        const current = memberWtbMinNormalizedPrice.get(wtbId);
        if (current == null || normalized < current) memberWtbMinNormalizedPrice.set(wtbId, normalized);
      }
    }

    // NEW — additive only: his exact catch via live testing — the
    // Store Orders equivalent of memberWtbMinNormalizedPrice just
    // above, which already correctly handles this for Member WTB. The
    // OLD rollupLowest below (still used further down) only reads a
    // static Airtable rollup over raw Seller Offers — a DIFFERENT
    // seller's live Counter Offers round never touches it, so seller
    // B's fresh counter never showed up as "beating" seller A's own
    // stale, untouched raw offer, leaving A wrongly marked "Lowest".
    // Same exact pattern as the Member WTB block above: only counts a
    // competing round once genuinely countered (Seller Counter Price
    // set), chain-traces through supersessions, takes the true minimum
    // per order across every seller.
    let orderMinNormalizedPrice = new Map();
    if (orderIdsForStatusCheck.length) {
      const normalizeForOrders = (price, vatType) => {
        const p = Number(price);
        if (!Number.isFinite(p)) return null;
        return asText(vatType) === "VAT0" ? p * 1.21 : p;
      };

      const [competingSellerOffersForOrders, competingCounterRoundsForOrders] = await Promise.all([
        airtable(SELLER_OFFERS_TABLE)
          .select({ fields: ["Linked Orders", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer"] })
          .all()
          .then((records) =>
            records.filter(
              (r) =>
                !r.fields?.["Delete Offer"] &&
                orderIdsForStatusCheck.includes(firstLinkedRecordId(r.fields?.["Linked Orders"]))
            )
          ),
        airtable(COUNTER_OFFERS_TABLE)
          .select({
            filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Seller Offer')`,
            fields: ["Order", "Seller ID", "Seller Counter Price", "Seller Original Price", "Seller Original VAT Type"]
          })
          .all()
          .then((records) =>
            records.filter((r) => orderIdsForStatusCheck.includes(firstLinkedRecordId(r.fields?.["Order"])))
          )
      ]);

      const sellerIdsWithGenuineCounterForOrders = new Set(
        competingCounterRoundsForOrders
          .filter((r) => numberValue(r.fields?.["Seller Counter Price"]) > 0)
          .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
          .filter(Boolean)
      );

      const activeRoundIdBySellerForOrders = new Map();
      for (const cr of competingCounterRoundsForOrders) {
        const sellerId = firstLinkedRecordId(cr.fields?.["Seller ID"]);
        if (sellerId && !activeRoundIdBySellerForOrders.has(sellerId)) {
          activeRoundIdBySellerForOrders.set(sellerId, cr.id);
        }
      }

      for (const so of competingSellerOffersForOrders) {
        const sellerId = firstLinkedRecordId(so.fields?.["Seller ID"]);
        if (sellerId && sellerIdsWithGenuineCounterForOrders.has(sellerId)) continue;

        const orderId = firstLinkedRecordId(so.fields?.["Linked Orders"]);
        const activeRoundId = sellerId ? activeRoundIdBySellerForOrders.get(sellerId) : null;
        const chainTraced = activeRoundId ? await findSellersTrueLastCounter(activeRoundId) : null;
        const effectivePrice = chainTraced ?? numberValue(so.fields?.["Seller Offer"]);
        const normalized = normalizeForOrders(effectivePrice, so.fields?.["Offer VAT Type"]);
        if (normalized == null) continue;

        const current = orderMinNormalizedPrice.get(orderId);
        if (current == null || normalized < current) orderMinNormalizedPrice.set(orderId, normalized);
      }

      for (const cr of competingCounterRoundsForOrders) {
        const sellerCounter = numberValue(cr.fields?.["Seller Counter Price"]);
        if (!(sellerCounter > 0)) continue;

        const orderId = firstLinkedRecordId(cr.fields?.["Order"]);
        const vatType = cr.fields?.["Seller Original VAT Type"];
        const normalized = normalizeForOrders(sellerCounter, vatType);
        if (normalized == null) continue;

        const current = orderMinNormalizedPrice.get(orderId);
        if (current == null || normalized < current) orderMinNormalizedPrice.set(orderId, normalized);
      }
    }

    const preFiltered = preFilteredByStatus.filter((record) => {
      const f = record.fields || {};
      const memberWtbId = firstLinkedRecordId(f["Member WTB"]);

      if (memberWtbId) {
        return memberWtbStatusMap.get(memberWtbId) === "Outsource";
      }

      const orderId = firstLinkedRecordId(f["Order"]);
      const orderStatus = asText(statusCheckOrderMap.get(orderId)?.["Fulfillment Status"]);
      return orderStatus === "Outsource";
    });

    // NEW — additive only: for "open" (the seller's own pending
    // counter), also compute the same lowest-offer dot/comparison used
    // for fresh offers, and look up the previous round's amount so the
    // Accept-Previous button can show the actual price ("Accept
    // €150") — same pattern as Consignment. Reuses statusCheckOrderMap
    // (already fetched above, covers the same order IDs) instead of a
    // second redundant fetch.
    const orderMap = statusCheckOrderMap;

    // FIXED — needed for both "open" (Accept-Previous needs the
    // store's prior price) AND "countered" (the seller's own current
    // position — "Your Offer" — for a store-created round isn't on
    // that round itself; it's whatever the seller last placed on the
    // PRIOR round, which "Seller Original Price" alone doesn't
    // reliably capture once more than one round of back-and-forth has
    // happened, since that field never changes from the very first
    // ask).
    const previousIds = (filter === "open" || filter === "countered" || filter === "denied")
      ? [...new Set(preFiltered.map((r) => firstLinkedRecordId(r.fields?.["Previous Record ID"])).filter(Boolean))]
      : [];

    let previousPriceById = new Map();
    let previousSellerCounterById = new Map();
    if (previousIds.length) {
      const previousFormula = `OR(${previousIds.map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`).join(",")})`;
      const previousRecords = await airtable(COUNTER_OFFERS_TABLE)
        .select({ filterByFormula: previousFormula, fields: ["Store Counter Price", "Counter Payout", "Seller Counter Price"] })
        .all();
      // FIXED — "Buyer's Last Offer" must show what the SELLER would
      // actually receive, not the raw store-side price. "Store Counter
      // Price" is what the store pays; "Counter Payout" is that same
      // number already converted down to seller terms (fee/margin
      // removed) — the exact figure the seller sees everywhere else.
      // Using the raw store price made it look like the store's fee
      // had vanished (e.g. showing €200 instead of €195 with a flat €5
      // fee).
      previousPriceById = new Map(
        previousRecords.map((r) => [r.id, numberValue(r.fields?.["Counter Payout"])])
      );
      previousSellerCounterById = new Map(
        previousRecords.map((r) => [r.id, numberValue(r.fields?.["Seller Counter Price"])])
      );
    }

    // NEW — additive only: "Order ID" is a COMPUTED field (a formula,
    // SIMPLIFIED — no longer needs a separate Member WTB fetch: he's
    // added native lookup fields (Member WTB ID, Product Name (MWTB),
    // SKU (MWTB), Size (MWTB), Brand (MWTB)) through the "Member WTB"
    // link, mirroring how Order ID/Product Name/etc already resolve
    // natively for Store Orders rounds via the Order link. Reads them
    // directly in the mapping below instead.

    const items = await Promise.all(preFiltered
      .map(async (record) => {
        const f = record.fields || {};
        const linkedOrderId = firstLinkedRecordId(f["Order"]);
        const linkedMemberWtbId = firstLinkedRecordId(f["Member WTB"]);
        const isMemberWtb = !!linkedMemberWtbId;
        const orderFields = orderMap.get(linkedOrderId) || {};

        // FIXED — "Counter Payout VAT Type" is only ever set on a
        // STORE-created round (store-counter writes it, seller-counter
        // never does) — so an own_counter round (created by the
        // seller countering) always had this empty, showing "-" for
        // VAT Type. Falls back to "Seller Original VAT Type", which
        // every round consistently carries.
        const vatType = displayValue(f["Counter Payout VAT Type"]) || displayValue(f["Seller Original VAT Type"]);

        // FIXED — the rollup fields below ("Current Lowest ...") are
        // Airtable rollups over the raw Seller Offers table price,
        // which an in-progress Counter Offers negotiation never
        // touches — so a seller's own fresh counter (this round) never
        // showed up there, making it look like they were still
        // "Beaten" even when their new counter was actually the best
        // price on the table. This doesn't fix the full picture (a
        // DIFFERENT seller's own in-progress counter still won't be
        // reflected here either — that's a separate, bigger question),
        // but at minimum this seller's own current position is now
        // correctly factored in as a candidate for the lowest.
        const previousOfferId = firstLinkedRecordId(f["Previous Record ID"]);
        const previousStorePrice = previousOfferId ? previousPriceById.get(previousOfferId) : null;

        // FIXED — "Your Offer" must be the SELLER's actual current
        // position, not the fixed, never-updated "Seller Original
        // Price". For "open" (own_counter): this round's own "Seller
        // Counter Price" IS what the seller just placed. For
        // "countered" (store just moved): this round has no seller
        // counter on it — the seller's last position is whatever they
        // placed on the PRIOR round (its Seller Counter Price if they'd
        // countered before, else fall back to Seller Original Price
        // for a genuinely first-ever response).
        // FIXED — for "denied", THIS round can itself be the seller's
        // own counter that got denied directly (Status=Denied set on
        // it via store-deny) — in that case its OWN "Seller Counter
        // Price" is exactly what got rejected, and must be used first.
        // The previous-round fallback below is only for "countered"
        // semantics (where f is the STORE's round, and the seller's
        // real position lives on the round before it) — using it for
        // "denied" without checking this round's own value first was
        // showing the wrong (much older) amount as "Your Offer".
        // FIXED (again) — a real, confirmed bug found via his live
        // testing: this only looked ONE hop back via
        // previousSellerCounterById — if that immediately-prior round
        // was ITSELF a supersession where the seller never responded
        // (Seller Counter Price empty there too), their real last
        // countered position — from possibly several supersessions
        // back — was silently lost. Also hit the classic
        // Number.isFinite(numberValue(x))-is-always-true trap: an
        // empty field became 0, which IS finite, so it was always
        // "found" and then moneyValue(0) rendered as "-". Reuses the
        // full chain-walking helper (findSellersTrueLastCounter,
        // built for the same underlying bug in the Discord
        // notification) instead of a single, shallow lookup.
        const ownSellerCounter = numberValue(f["Seller Counter Price"]);
        let sellerLastOffer;
        if (filter === "open" || (filter === "denied" && ownSellerCounter > 0)) {
          sellerLastOffer = ownSellerCounter > 0 ? ownSellerCounter : numberValue(f["Seller Original Price"]);
        } else {
          const trueLastCounter = await findSellersTrueLastCounter(record.id);
          sellerLastOffer = trueLastCounter ?? numberValue(f["Seller Original Price"]);
        }

        // FIXED — a real, confirmed bug found via his live testing:
        // the rollup fields below ("Current Lowest ...") are Airtable
        // rollups over the raw Seller Offers table price, which an
        // in-progress Counter Offers negotiation never touches — so a
        // DIFFERENT seller's live counter (e.g. seller X countering to
        // 140) never showed up here, leaving seller Y wrongly marked
        // "Lowest" at their own stale, unbeaten-looking 145. Replaced
        // with orderMinNormalizedPrice (built above) — the exact same
        // live, cross-seller computation already proven for Member
        // WTB — instead of the stale rollup. Also drops the separate
        // "Lowest Offer Seller ID" field as a fallback signal for
        // isLowest, since it's the same class of stale, non-live field
        // and is no longer needed now this is computed live.
        const orderId = firstLinkedRecordId(f["Order"]);
        const orderCompetingMin = orderId ? orderMinNormalizedPrice.get(orderId) : null;
        const ownNormalizedForOrder = !isMemberWtb && Number.isFinite(sellerLastOffer)
          ? (asText(vatType) === "VAT0" ? sellerLastOffer * 1.21 : sellerLastOffer)
          : null;

        const orderLowest = Number.isFinite(orderCompetingMin) && Number.isFinite(ownNormalizedForOrder)
          ? Math.min(orderCompetingMin, ownNormalizedForOrder)
          : (orderCompetingMin ?? ownNormalizedForOrder);

        // NEW — additive only: the Member WTB equivalent of the above,
        // using memberWtbMinNormalizedPrice (built above from every
        // other seller's current position, normalized to the same
        // VAT21-equivalent scale). Own position gets normalized the
        // same way before comparing.
        const memberWtbId = isMemberWtb ? firstLinkedRecordId(f["Member WTB"]) : null;
        const memberWtbCompetingMin = memberWtbId ? memberWtbMinNormalizedPrice.get(memberWtbId) : null;
        const ownNormalizedForMemberWtb = isMemberWtb && Number.isFinite(sellerLastOffer)
          ? (asText(vatType) === "VAT0" ? sellerLastOffer * 1.21 : sellerLastOffer)
          : null;

        const memberWtbLowest = Number.isFinite(memberWtbCompetingMin) && Number.isFinite(ownNormalizedForMemberWtb)
          ? Math.min(memberWtbCompetingMin, ownNormalizedForMemberWtb)
          : (memberWtbCompetingMin ?? ownNormalizedForMemberWtb);

        const currentLowestShared = isMemberWtb ? memberWtbLowest : orderLowest;

        // FIXED — a real, confirmed bug found via his live testing,
        // introduced by today's earlier fix: currentLowestShared lives
        // on the shared normalized (VAT21-equivalent) scale, but this
        // was returned to the frontend as-is regardless of THIS row's
        // own vatType — a VAT0 seller was shown the raw normalized
        // number unconverted (e.g. 232 instead of their own
        // comparable 232/1.21=191.73), instead of de-normalized back
        // into their own terms. VAT21/Margin need no conversion since
        // they're already on that scale.
        const currentLowest = Number.isFinite(currentLowestShared)
          ? (asText(vatType) === "VAT0" ? currentLowestShared / 1.21 : currentLowestShared)
          : null;

        const isLowest = isMemberWtb
          ? (Number.isFinite(ownNormalizedForMemberWtb) &&
              (!Number.isFinite(memberWtbCompetingMin) || ownNormalizedForMemberWtb <= memberWtbCompetingMin))
          : (Number.isFinite(ownNormalizedForOrder) &&
              (!Number.isFinite(orderCompetingMin) || ownNormalizedForOrder <= orderCompetingMin));

        return {
          id: record.id,
          // NEW — additive only: a real, confirmed bug found via his
          // live testing — the frontend's WTB "Counter" button always
          // called the STORE ORDERS seller-counter endpoint
          // (/api/counter-offers/:id/seller-counter), regardless of
          // whether the item was actually a Member WTB round. For a
          // Member WTB item, that endpoint operates on the wrong
          // table/scope entirely (Order-linked data that doesn't
          // exist for a Member WTB round), producing a nonsensical
          // cross-seller threshold and the wrong error text ("for this
          // order" instead of "for this WTB"). Exposes which endpoint
          // family this item belongs to so the frontend can route
          // correctly.
          is_member_wtb: isMemberWtb,
          order_id: isMemberWtb
            ? (displayValue(f["Member WTB ID"]) || displayValue(f["Order ID"]))
            : (displayValue(f["Order ID"]) || displayValue(f["Order"])),
          product: isMemberWtb ? (displayValue(f["Product Name (MWTB)"]) || displayValue(f["Product Name"])) : displayValue(f["Product Name"]),
          sku: isMemberWtb ? (displayValue(f["SKU (MWTB)"]) || displayValue(f["SKU"])) : displayValue(f["SKU"]),
          size: isMemberWtb ? (displayValue(f["Size (MWTB)"]) || displayValue(f["Size"])) : displayValue(f["Size"]),
          brand: isMemberWtb ? (displayValue(f["Brand (MWTB)"]) || displayValue(f["Brand"])) : displayValue(f["Brand"]),
          original_offer: Number.isFinite(sellerLastOffer) ? moneyValue(sellerLastOffer) : moneyValue(f["Seller Original Price"]),
          counter_payout: moneyValue(f["Counter Payout"]),
          vat_type: vatType,
          previous_record_id: previousOfferId,
          previous_store_price: Number.isFinite(previousStorePrice) ? moneySmartValue(previousStorePrice) : null,
          current_lowest: Number.isFinite(currentLowest) ? moneySmartValue(currentLowest) : null,
          status: isLowest === null ? null : (isLowest ? "Lowest" : "Beaten"),
          raw_date: displayValue(f["Created At"]),
          denied_at: displayValue(f["Denied At"] || f["Last Modified"])
        };
      }));

    // NEW — additive only: "denied" must also include fresh,
    // never-countered offers that were denied outright — those never
    // touch the Counter Offers table at all, so the query above alone
    // always missed this whole category. Merged in with _kind:
    // "fresh_denied" so the frontend can route Retry/Delete correctly
    // (via the pre-existing edit-after-denial and wtb-open-offers
    // delete endpoints, which operate on Seller Offers, not Counter
    // Offers).
    let mergedItems = items;

    if (filter === "denied") {
      const deniedSellerOffersFormula = `{Denied?} = TRUE()`;
      const deniedSellerOfferRecords = await airtable(SELLER_OFFERS_TABLE)
        .select({ filterByFormula: deniedSellerOffersFormula })
        .all();

      const deniedFreshItems = deniedSellerOfferRecords
        .filter((record) => linkedRecordIncludes(record.fields?.["Seller ID"], sellerRecordId))
        // NEW — additive only: a soft-deleted ("Withdrawn?") offer must
        // never show anywhere in the Portal — it only survives
        // physically for the undercut-check in discord-wtb-bot-main.
        .filter((record) => !record.fields?.["Withdrawn?"])
        .map((record) => {
          const f = record.fields || {};

          return {
            id: record.id,
            _kind: "fresh_denied",
            order_id: displayValue(f["Member WTB ID"]) || displayValue(f["Order ID"]),
            product: displayValue(f["Product Name (MWTB)"]) || displayValue(f["Product Name"]),
            sku: displayValue(f["SKU (MWTB)"]) || displayValue(f["SKU"]),
            size: displayValue(f["Size (MWTB)"]) || displayValue(f["Size"]),
            brand: displayValue(f["Brand (MWTB)"]) || displayValue(f["Brand"]),
            original_offer: moneyValue(f["Denied Amount"]),
            vat_type: displayValue(f["Denied VAT Type"]),
            denied_at: displayValue(f["Denied At"])
          };
        });

      mergedItems = [...items, ...deniedFreshItems];
    }

    res.json({
      count: mergedItems.length,
      items: sortDashboardItemsNewestFirst(mergedItems)
    });
  } catch (err) {
    console.error("Failed to load WTB counter offers:", err);

    res.status(500).json({
      error: "Failed to load WTB counter offers",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller delete their own pending counter
// (Countered→Open pill) or a denied counter offer (Denied pill) they
// don't want to pursue further. Matches the same delete-permanently
// approach already used for wtb-open-offers (Seller Offers table) —
// these Counter Offers records aren't referenced anywhere downstream
// once denied/superseded, so a hard delete is safe here.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// NEW — additive only: deleting a seller's offer/counter previously
// only removed the ONE record clicked, leaving every OTHER round in
// that same negotiation's history (superseded siblings, reopened store
// rounds, etc.) sitting around and reappearing across pills — his
// point: withdrawing means the whole thing should disappear, not leave
// stray leftovers the seller has to keep deleting one at a time. This
// finds every Counter Offers round that belongs to the same underlying
// negotiation (matched via "Seller Offer Record ID" where available,
// falling back to an Order/Member-WTB + Seller match in JS — NOT a
// FIND()/ARRAYJOIN() formula on a raw record ID, which never matches),
// deletes all of them, deletes the underlying Seller Offer, and clears
// the linked Order's stale "Lowest Offer".
// ---------------------------------------------------------------------
async function cascadeDeleteWtbNegotiation({ seedCounterOfferId, seedSellerOfferId, sellerRecordId }) {
  let sellerOfferRecordId = seedSellerOfferId || null;
  let linkedOrderId = null;
  let linkedMemberWtbId = null;
  let isMemberWtb = false;

  if (seedCounterOfferId) {
    const seedRecord = await airtable(COUNTER_OFFERS_TABLE).find(seedCounterOfferId);
    const f = seedRecord.fields || {};
    sellerOfferRecordId = sellerOfferRecordId || asText(f["Seller Offer Record ID"]);
    linkedOrderId = firstLinkedRecordId(f["Order"]);
    linkedMemberWtbId = firstLinkedRecordId(f["Member WTB"]);
    isMemberWtb = !!linkedMemberWtbId;
  }

  if (!linkedOrderId && !linkedMemberWtbId && sellerOfferRecordId) {
    const sellerOfferRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferRecordId).catch(() => null);
    if (sellerOfferRecord) {
      linkedOrderId = firstLinkedRecordId(sellerOfferRecord.fields?.["Linked Orders"]);
      linkedMemberWtbId = firstLinkedRecordId(sellerOfferRecord.fields?.["Member WTBs"]);
      isMemberWtb = !!linkedMemberWtbId;
    }
  }

  // FIXED — the record the user actually clicked Delete on must be
  // guaranteed to disappear, no matter what happens afterward. This
  // was previously placed AFTER the broader "find every related round"
  // fetch below — if that fetch failed for any reason (a large table,
  // a transient API hiccup), the whole function threw before ever
  // reaching this, silently leaving the exact thing the seller asked
  // to delete still sitting there. Now happens first and is wrapped
  // safely on its own.
  if (seedCounterOfferId) {
    await airtable(COUNTER_OFFERS_TABLE).destroy(seedCounterOfferId).catch((err) =>
      console.error("Failed to delete the seed Counter Offers record (non-blocking):", err)
    );
  }

  if (sellerOfferRecordId) {
    // FIXED — this used to hard-destroy the Seller Offer record
    // entirely. His point: if a seller withdraws an offer that had
    // already been denied at, say, €235, then places a brand new offer
    // at that SAME €235 afterward, nothing should let that go through
    // silently — the store already said no to that price. A hard
    // delete leaves nothing to validate a future offer against. Now
    // soft-deletes instead (a "Withdrawn?" flag) — the record still
    // exists, so discord-wtb-bot-main's existing getCurrentLowest/
    // undercut-check (which scans ALL Seller Offer records with no
    // status filter) correctly keeps enforcing "at least €2.50 lower"
    // against it, while the Portal below hides it everywhere the
    // seller would see it, same as a real delete from their view.
    await airtable(SELLER_OFFERS_TABLE).update(sellerOfferRecordId, {
      "Withdrawn?": true
    }).catch((err) =>
      console.error("Failed to soft-delete underlying Seller Offer (non-blocking):", err)
    );
  }

  // Everything below is best-effort cleanup of the REST of this same
  // negotiation's history (superseded siblings, reopened rounds, etc.)
  // — valuable, but must never prevent the core deletion above, which
  // has already happened by this point regardless of what follows.
  try {
    // Fetch broadly (no ID-based formula), filter in JS — the reliable
    // pattern, not FIND()/ARRAYJOIN() on a raw record ID.
    const allCounterOffersForSeller = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `OR({Source Type} = 'Seller Offer', {Source Type} = 'Member WTB')`,
        fields: ["Seller ID", "Seller Offer Record ID", "Order", "Member WTB"]
      })
      .all()
      .then((records) => records.filter((r) => linkedRecordIncludes(r.fields?.["Seller ID"], sellerRecordId)));

    const relatedCounterOfferIds = allCounterOffersForSeller
      .filter((r) => {
        if (r.id === seedCounterOfferId) return false;

        const rSellerOfferId = asText(r.fields?.["Seller Offer Record ID"]);
        if (sellerOfferRecordId && rSellerOfferId === sellerOfferRecordId) return true;

        const rOrderId = firstLinkedRecordId(r.fields?.["Order"]);
        const rMemberWtbId = firstLinkedRecordId(r.fields?.["Member WTB"]);
        if (linkedOrderId && rOrderId === linkedOrderId) return true;
        if (linkedMemberWtbId && rMemberWtbId === linkedMemberWtbId) return true;

        return false;
      })
      .map((r) => r.id);

    if (!sellerOfferRecordId && (linkedOrderId || linkedMemberWtbId)) {
      const linkField = isMemberWtb ? "Member WTBs" : "Linked Orders";
      const targetId = linkedMemberWtbId || linkedOrderId;

      const candidateOffers = await airtable(SELLER_OFFERS_TABLE)
        .select({ fields: ["Seller ID", linkField] })
        .all();

      const match = candidateOffers.find(
        (r) =>
          linkedRecordIncludes(r.fields?.["Seller ID"], sellerRecordId) &&
          firstLinkedRecordId(r.fields?.[linkField]) === targetId
      );

      if (match?.id) {
        await airtable(SELLER_OFFERS_TABLE).update(match.id, {
          "Withdrawn?": true
        }).catch((err) =>
          console.error("Failed to soft-delete fallback-matched underlying Seller Offer (non-blocking):", err)
        );
      }
    }

    for (const id of relatedCounterOfferIds) {
      await airtable(COUNTER_OFFERS_TABLE).destroy(id).catch((err) =>
        console.error(`Failed to delete related Counter Offers round ${id} (non-blocking):`, err)
      );
    }
  } catch (err) {
    console.error("Failed to clean up the rest of the negotiation history (non-blocking, core delete already happened):", err);
  }

  if (linkedOrderId && !isMemberWtb) {
    await airtable(ORDERS_TABLE).update(linkedOrderId, {
      "Lowest Offer": null,
      "Offer Sent?": false
    }).catch((err) => console.error("Failed to clear stale Lowest Offer after cascade delete (non-blocking):", err));
  }
}

app.post("/api/dashboard/wtb-counter-offers/:offerId/cancel", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const f = record.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await cascadeDeleteWtbNegotiation({ seedCounterOfferId: offerId, sellerRecordId });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to cancel WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to cancel offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller fall back to accepting the
// store/buyer's PREVIOUS counter instead of waiting on a response to
// their own pending counter (Countered→Open pill, "Accept €X" button)
// — same idea as Consignment's accept-previous, reusing the core
// accept logic already used by the Discord counter_offer_accept:
// handler (status checks, the Make webhook, and the Custom-Offer
// write-back fix), just without the Discord-message-editing parts a
// Portal action doesn't need.
// ---------------------------------------------------------------------
app.post("/api/dashboard/wtb-counter-offers/:offerId/accept-previous", async (req, res) => {
  try {
    const pendingOfferId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);

    if (!pendingOfferId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const pendingOffer = await airtable(COUNTER_OFFERS_TABLE).find(pendingOfferId);
    const pendingFields = pendingOffer.fields || {};

    if (!linkedRecordIncludes(pendingFields["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const previousOfferId = firstLinkedRecordId(pendingFields["Previous Record ID"]);

    if (!previousOfferId) {
      return res.status(409).json({ error: "There is no previous offer to accept." });
    }

    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(previousOfferId);
    const f = counterOffer.fields || {};

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "That previous offer is no longer available." });
    }

    const linkedMemberWtbIdForPrevious = firstLinkedRecordId(f["Member WTB"]);

    // NEW — additive only: same fix as seller-accept above — this
    // always required an "Order" link and hard-failed for Member WTB.
    if (linkedMemberWtbIdForPrevious) {
      const sellerOfferRecordId = asText(f["Seller Offer Record ID"]);

      if (!sellerOfferRecordId) {
        return res.status(500).json({ error: "Counter Offer missing linked Seller Offer" });
      }

      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(linkedMemberWtbIdForPrevious);

      if (asText(memberWtb.fields?.["Fulfillment Status"]) === "Allocated") {
        return res.status(409).json({ error: "This Member WTB is no longer available." });
      }

      const acceptedPayout = numberValue(f["Counter Payout"]);
      const acceptedVatType = asText(f["Counter Payout VAT Type"] || f["Seller Original VAT Type"]);

      await airtable(COUNTER_OFFERS_TABLE).update(previousOfferId, {
        "Status": "Accepted",
        "Accepted At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      // Abandon the seller's own pending counter — they're choosing
      // the buyer's earlier position instead.
      await airtable(COUNTER_OFFERS_TABLE).update(pendingOfferId, {
        "Status": "Denied",
        "Denied At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      }).catch((err) => console.error("Failed to close abandoned own counter (non-blocking):", err));

      const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

      if (!wtbBotBaseUrl) {
        return res.status(500).json({ error: "KICKZ_WTB_BOT_BASE_URL is missing" });
      }

      const dealResponse = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET
        },
        body: JSON.stringify({
          member_wtb_record_id: linkedMemberWtbIdForPrevious,
          seller_offer_record_id: sellerOfferRecordId,
          override_price: acceptedPayout,
          override_vat_type: acceptedVatType
        })
      });

      const dealData = await dealResponse.json().catch(() => ({}));

      if (!dealResponse.ok) {
        return res.status(dealResponse.status).json({ error: dealData.error || "Failed to accept offer" });
      }

      await closeCompetingCountersForMemberWtb(linkedMemberWtbIdForPrevious, previousOfferId).catch((err) =>
        console.error("Failed to close competing counters (non-blocking):", err)
      );

      return res.json({ ok: true });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);

    if (!linkedOrderId) {
      return res.status(500).json({ error: "Counter Offer missing linked Order" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderStatus = asText(orderRecord.fields?.["Fulfillment Status"]);

    if (orderStatus !== "Outsource") {
      return res.status(409).json({ error: "This order is no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(previousOfferId, {
      "Status": "Accepted",
      "Accepted At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    // Abandon the seller's own pending counter — they're choosing the
    // buyer's earlier position instead.
    await airtable(COUNTER_OFFERS_TABLE).update(pendingOfferId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    }).catch((err) => console.error("Failed to close abandoned own counter (non-blocking):", err));

    if (COUNTER_OFFER_ACCEPT_WEBHOOK_URL) {
      await fetch(COUNTER_OFFER_ACCEPT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: "counter-offer-accepted",
          counter_offer_record_id: previousOfferId,
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
      }).catch((err) => console.error("Failed to fire accept webhook (non-blocking):", err));
    }

    // FIXED — same missing-VAT-Type bug as seller-accept: wrote Custom
    // Offer but never Offer VAT Type, leaving a stale (often Margin)
    // value that produced a wrong invoice VAT type. Margin stays
    // Margin; otherwise follow the client's country.
    const sellerVatTypeForAcceptPrevious = asText(f["Seller Original VAT Type"]);
    const offerVatTypeForAcceptPrevious =
      sellerVatTypeForAcceptPrevious === "Margin"
        ? "Margin"
        : (isDutchClientCountry(orderRecord.fields?.["Client Country"]) ? "VAT21" : "VAT0");

    try {
      await airtable(ORDERS_TABLE).update(linkedOrderId, {
        "Custom Offer": customOfferValueForAccept(
          offerVatTypeForAcceptPrevious,
          numberValue(f["Store Counter Price"]),
          numberValue(f["Store Counter Price Excl VAT"])
        ),
        "Offer VAT Type": offerVatTypeForAcceptPrevious,
        "Offer Accepted?": true,
        "Offer Sent?": false
      });
    } catch (priceWriteErr) {
      console.error("Failed to write accepted price to Order record (non-blocking):", priceWriteErr);
    }

    // NEW — additive only: same as seller-accept above — matches the
    // Discord accept handler's existing behavior of closing every
    // other competing seller's open counter for this order.
    await closeCompetingCountersForOrder(linkedOrderId, previousOfferId).catch((err) =>
      console.error("Failed to close competing counters (non-blocking):", err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to accept previous WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to accept previous offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller retry after a counter round dead-
// ends in denial (no reopen happened — either there was nothing to
// fall back to, or the denial was final). His requirement: the new
// price must still respect the normal narrowing-band rule against the
// STORE's last real position (the round this denied one was itself
// responding to via Previous Record ID) — not just "beat my own denied
// price" — so a retry can never accidentally go lower than what the
// store had already shown willingness to pay. Reuses the exact same
// band validation as the standard seller-counter endpoint by calling
// it internally against that prior round.
// ---------------------------------------------------------------------
app.post("/api/dashboard/wtb-counter-offers/:offerId/retry-counter", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const proposedPrice = Number(req.body?.price);

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const f = deniedRecord.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const priorRoundId = firstLinkedRecordId(f["Previous Record ID"]);

    if (!priorRoundId) {
      return res.status(409).json({ error: "There's no prior position to retry against." });
    }

    const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId);
    const priorFields = priorRound.fields || {};

    // The store's last real position — validated against directly, not
    // the prior round's own status, since it's expected to already be
    // Closed (correctly superseded by the denied round). His
    // requirement: the retry must respect the normal narrowing band
    // against THIS, not just beat the denied price, so it can never
    // accidentally go lower than what the store already offered.
    const storeLastPosition = numberValue(priorFields["Store Counter Price"]);
    const deniedSellerCounter = numberValue(f["Seller Counter Price"]);

    if (!Number.isFinite(storeLastPosition) || !Number.isFinite(deniedSellerCounter)) {
      return res.status(500).json({ error: "Missing price data to validate against." });
    }

    const validation = validateNextCounterPrice(deniedSellerCounter, storeLastPosition, proposedPrice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);
    const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderFields = orderRecord.fields || {};
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Order": [linkedOrderId],
      "Seller ID": linkedSellerId ? [linkedSellerId] : undefined,
      "Source Type": asText(f["Source Type"]) || "Seller Offer",
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Seller Counter Price": proposedPrice,
      // FIXED — same gap as the main seller-counter endpoint: this
      // never set Counter Payout on a seller-created round. The
      // seller's own new counter already IS what they'd receive, no
      // conversion needed.
      "Counter Payout": proposedPrice,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": priorRoundId,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    if (AIRTABLE_DISCORD_UPDATES_URL) {
      const sellerCounterInStoreTerms = calculateStoreCounterEquivalent(
        proposedPrice,
        sellerVatType,
        orderFields
      );

      // NEW — additive only: store-facing embed values in the store's
      // own VAT scale (see storeDisplayDivisor / computeSellerCounter-
      // ForStoreDisplay).
      const retryEmbedDivisor = storeDisplayDivisor(sellerVatType, orderFields);
      const retryYourPreviousForDisplay = storeLastPosition / retryEmbedDivisor;
      const retrySellerCounterForDisplay = computeSellerCounterForStoreDisplay(
        proposedPrice,
        sellerVatType,
        orderFields
      );

      const noRoomToCounter =
        Number.isFinite(storeLastPosition) &&
        Number.isFinite(sellerCounterInStoreTerms) &&
        !hasRoomForNextStep(storeLastPosition, sellerCounterInStoreTerms);

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
          your_previous_counter: retryYourPreviousForDisplay,
          seller_counter_price: retrySellerCounterForDisplay ?? sellerCounterInStoreTerms ?? proposedPrice,
          store_display_vat_type: sellerVatType,
          no_room_to_counter: noRoomToCounter
        })
      }).catch((err) => console.error("Failed to notify store of retry counter (non-blocking):", err));
    }

    res.json({ ok: true, band: validation.band, new_round_id: newRound.id });
  } catch (err) {
    console.error("Failed to retry WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to retry offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller directly Accept the store/buyer's
// current counter from the Countered pill — the last missing action
// for Want To Buys. Reuses the exact same core logic (status checks,
// the Make webhook, the Custom-Offer write-back fix) as the existing
// Discord counter_offer_accept: handler and the accept-previous
// endpoint above, just applied to THIS round directly.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// NEW — additive only: extracted from the Discord counter_offer_accept:
// handler, which already closes every OTHER open Counter Offers round
// for the same order once one seller/round is accepted — matching the
// "everyone competes on one shared price" architecture built earlier
// this session. The Portal's own accept endpoints (seller-accept,
// accept-previous) were missing this entirely: accepting via the
// Portal left every other competing seller's active negotiation
// dangling open, unlike accepting the exact same thing via Discord.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// NEW — additive only: his explicit request — a seller countering (or
// placing a fresh offer) should never be allowed to land at a price
// that's worse than what another seller ALREADY has on the table for
// the same Order/WTB, and this needs to hold continuously: a seller's
// own COUNTER also becomes the new bar for everyone else, not just
// their original raw offer. The existing "Current Lowest (Normalized)"
// rollup can't be reused for this — it only reflects raw, never-
// countered Seller Offers (rolled up from the Seller Offers table
// directly), so it goes stale the moment anyone starts negotiating.
// This fetches every OTHER seller's actual CURRENT position — their
// live Counter Offers round if they have one, else their raw offer —
// normalizes it the same way the WTB dot-indicator comparison already
// does (VAT21 stays, VAT0/Margin ×1.21), and returns the minimum.
// sourceType: "Seller Offer" (Store Orders) or "Member WTB".
// ---------------------------------------------------------------------
// NEW — additive only: his explicit request — since the buyer/store
// only ever sees ONE unified thread (even though it may silently swap
// between different sellers behind the scenes as better offers come
// in), their OWN counter must never regress below the best position
// they've EVER offered on this Order/WTB, regardless of which seller
// it was originally directed at. Without this, a buyer's counter to a
// newly-surfaced seller could accidentally undercut what they already
// told a PREVIOUS seller, which would look inconsistent to that
// seller even though the buyer never intended it (they don't know the
// seller silently changed). "Store Counter Price" is always in buyer-
// facing terms already (the buyer's own literal input, never VAT-
// converted), so it's directly comparable across different sellers'
// threads with no normalization needed.
async function getBuyerHighestEverPosition(sourceType, recordId) {
  const counterLinkField = sourceType === "Member WTB" ? "Member WTB" : "Order";

  const allRounds = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `{Source Type} = '${escapeFormulaValue(sourceType)}'`,
      fields: [counterLinkField, "Store Counter Price"]
    })
    .all()
    .then((records) => records.filter((r) => firstLinkedRecordId(r.fields?.[counterLinkField]) === recordId));

  let highest = null;
  for (const r of allRounds) {
    const price = numberValue(r.fields?.["Store Counter Price"]);
    if (price > 0 && (highest == null || price > highest)) highest = price;
  }

  return highest;
}

// ---------------------------------------------------------------------
// NEW — additive only: his explicit request — every time the buyer/
// store counters, ALL sellers still "in the game" get a shot at it,
// not just the one currently visible — maximizes the chance of a
// deal, and every response still has to beat the current global
// lowest (enforced elsewhere, in the seller-counter endpoints). Three
// groups get reached here:
// (1) Previously-DENIED sellers — "Deny" means "not at that price,"
//     not "goodbye forever." Once the buyer counters again HIGHER
//     than what a specific seller was denied at (better for them,
//     worse for nobody), they get a fresh Open round at this new
//     position. Only fires on genuine improvement over what THAT
//     seller last saw.
// (2) Fresh, never-yet-engaged sellers — a seller whose offer is just
//     sitting there untouched (never contacted, never denied) gets
//     reached on EVERY buyer counter too, not just the very first
//     round-1 broadcast — otherwise they'd never hear from the buyer
//     again once negotiation started with someone else.
// (3) Any seller with an ACTIVE round who isn't the one just
//     countered — covers BOTH a seller who's already countered back
//     (Seller Counter Price set, genuinely awaiting the buyer) AND a
//     seller whose round still just shows an EARLIER buyer ask they
//     never got around to answering. Both are now-outdated positions
//     the moment the buyer moves again — his exact catch: the second
//     case was originally missed entirely (didn't qualify as "fresh"
//     since they already had a round, didn't qualify as "pending
//     counter-back" under the original, narrower scope since they
//     never replied), leaving them permanently stuck showing a stale
//     price, and leaving an orphaned extra row in the buyer's own
//     Countered view too. Always unconditionally superseded — closes
//     their round, opens a fresh one at the new price, notifies them.
// NEW — additive only: a real, confirmed gap found via his live
// testing — when a seller's round gets superseded WITHOUT them ever
// responding (the merged category below), their true last position
// (if they'd countered in an EARLIER round, before that got itself
// superseded) has nowhere to live — "Seller Original Price" only ever
// tracks their VERY FIRST ask, by design, never anything more recent.
// Confirmed exactly: seller B countered to €89 (creating a round with
// Seller Counter Price=89), that round got superseded (buyer moved
// again) before seller B replied, and THAT superseding round's own
// Seller Counter Price is empty — so the notification fell all the
// way back to their original €92, silently losing the real €89.
// Walks backward through Previous Record ID until it finds a round
// where THIS seller's Seller Counter Price is genuinely set, or
// reaches the start of the chain with nothing found (a seller who's
// never actually countered at all).
async function findSellersTrueLastCounter(startRoundId, maxHops = 15) {
  let currentId = startRoundId;
  for (let hop = 0; hop < maxHops && currentId; hop++) {
    const round = await airtable(COUNTER_OFFERS_TABLE).find(currentId).catch(() => null);
    if (!round) return null;
    const f = round.fields || {};
    const sellerCounter = numberValue(f["Seller Counter Price"]);
    if (sellerCounter > 0) return sellerCounter;
    currentId = asText(f["Previous Record ID"]) || null;
  }
  return null;
}

async function reengageDeniedSellers({ sourceType, recordId, newBuyerCounterPrice, excludeSellerId, isDenyBroadcast = false }) {
  const counterLinkField = sourceType === "Member WTB" ? "Member WTB" : "Order";

  const deniedRounds = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `AND({Status} = 'Denied', {Source Type} = '${escapeFormulaValue(sourceType)}')`
    })
    .all()
    .then((records) => records.filter((r) => firstLinkedRecordId(r.fields?.[counterLinkField]) === recordId));

  // Per seller, only their MOST RECENT denied round matters.
  const latestDeniedBySeller = new Map();
  for (const r of deniedRounds) {
    const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
    if (!sellerId || sellerId === excludeSellerId) continue;

    const existing = latestDeniedBySeller.get(sellerId);
    const deniedAt = new Date(r.fields?.["Denied At"] || 0);
    if (!existing || deniedAt > new Date(existing.fields?.["Denied At"] || 0)) {
      latestDeniedBySeller.set(sellerId, r);
    }
  }

  const contextRecord =
    sourceType === "Member WTB"
      ? await airtable(MEMBER_WTBS_TABLE).find(recordId).catch(() => null)
      : await airtable(ORDERS_TABLE).find(recordId).catch(() => null);
  const contextFields = contextRecord?.fields || {};

  // NEW — additive only: his explicit request — this used to only
  // reach sellers who'd already been engaged and denied. Every time
  // the buyer counters, EVERY seller still "in the game" should get a
  // shot at it — including a seller who's never been contacted at
  // all, whose fresh offer is just sitting there untouched. Without
  // this, only previously-denied sellers ever got a second look;
  // someone who simply hadn't been reached yet never would be,
  // silently reducing the chance of a deal.
  const sellerLinkField = sourceType === "Member WTB" ? "Member WTBs" : "Linked Orders";
  const activeCounterSellerIdsForRecord = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `AND({Status} = 'Open', {Source Type} = '${escapeFormulaValue(sourceType)}')`,
      fields: [counterLinkField, "Seller ID"]
    })
    .all()
    .then((records) =>
      new Set(
        records
          .filter((r) => firstLinkedRecordId(r.fields?.[counterLinkField]) === recordId)
          .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
          .filter(Boolean)
      )
    );

  // NEW — additive only: a group covering BOTH sellers who've actually
  // countered back AND sellers whose round still just shows the
  // BUYER's earlier ask, never responded to — his exact follow-up
  // catch: a seller who never answered a PRIOR buyer counter was
  // falling through every category (not "fresh" — they already have
  // an active round; not "pending counter-back" as originally scoped
  // — their Seller Counter Price was never set since they never
  // replied), so their round just sat there showing a now-stale price
  // forever, and the buyer/store's own Countered view kept showing a
  // separate, orphaned row for them too. Fixed by dropping the
  // Seller-Counter-Price condition entirely — ANY active round for a
  // seller who isn't the one just countered represents an outdated
  // position now (whether they replied or not) and gets superseded.
  const pendingSellerCounterRounds = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `AND({Status} = 'Open', {Source Type} = '${escapeFormulaValue(sourceType)}')`,
      fields: [counterLinkField, "Seller ID", "Seller Counter Price", "Seller Original Price", "Seller Original VAT Type", "Seller Offer Record ID"]
    })
    .all()
    .then((records) =>
      records.filter((r) => {
        if (firstLinkedRecordId(r.fields?.[counterLinkField]) !== recordId) return false;
        const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
        if (!sellerId || sellerId === excludeSellerId) return false;
        return true;
      })
    );

for (const round of pendingSellerCounterRounds) {
    const rf = round.fields || {};
    const sellerId = firstLinkedRecordId(rf["Seller ID"]);
    const sellerOriginalPrice = numberValue(rf["Seller Original Price"]);
    const sellerVatType = asText(rf["Seller Original VAT Type"]);
    const sellerOfferRecordId = asText(rf["Seller Offer Record ID"]);
    if (!sellerVatType) continue;

    const recomputedPayout =
      sourceType === "Member WTB"
        ? calculateMemberWtbSellerPayout(newBuyerCounterPrice, sellerVatType, contextFields)
        : calculateCounterPayoutForVatType(newBuyerCounterPrice, sellerVatType, contextFields);

    if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) continue;

    await airtable(COUNTER_OFFERS_TABLE).update(round.id, {
      "Status": "Closed",
      "Closed At": new Date().toISOString()
    });

    const createFields = {
      "Seller ID": [sellerId],
      "Source Type": sourceType,
      "Seller Offer Record ID": sellerOfferRecordId,
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": newBuyerCounterPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": round.id,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    };
    createFields[sourceType === "Member WTB" ? "Member WTB" : "Order"] = [recordId];

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create(createFields);

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    if (!sellerDiscordId) continue;

    // FIXED — a related bug the loop-merge above surfaces: for a
    // seller who never actually countered on THIS specific round,
    // just checking rf["Seller Counter Price"] wasn't enough — if
    // they'd countered on an EARLIER round that itself got superseded
    // before they replied to the next one, that genuine last position
    // was getting silently lost, falling all the way back to their
    // original ask instead. Walks the full chain via
    // findSellersTrueLastCounter to find their real last position,
    // however many supersessions back it happened.
    const sellerLastOfferForNotify = await findSellersTrueLastCounter(round.id);

    // NEW — additive only: same proactive "no room" check as the
    // fresh-sellers category — is there any valid step left for this
    // seller given their own last position vs the new buyer offer?
    const pendingNoRoomToCounter = !hasRoomForNextStep(
      Number.isFinite(sellerLastOfferForNotify) ? sellerLastOfferForNotify : sellerOriginalPrice,
      recomputedPayout
    );

    if (sourceType === "Member WTB") {
      await sendMemberWtbCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        memberWtbId: asText(contextFields["Member WTB ID"]) || recordId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        sellerLastOfferPrice: sellerLastOfferForNotify,
        noRoomToCounter: pendingNoRoomToCounter,
        // NEW — additive only: same reasoning as the fresh-sellers
        // category — this seller's earlier position is being
        // superseded specifically because the buyer just denied the
        // currently-lowest offer, which is effectively a "no" to
        // everyone still in the game.
        deniedAmount: isDenyBroadcast ? recomputedPayout : undefined
      }).catch((err) => console.error("Failed to supersede pending seller counter (non-blocking):", err));
    } else {
      await sendCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        orderId: asText(contextFields["Order ID"]),
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        sellerLastOfferPrice: sellerLastOfferForNotify,
        noRoomToCounter: pendingNoRoomToCounter,
        deniedAmount: isDenyBroadcast ? recomputedPayout : undefined
      }).catch((err) => console.error("Failed to supersede pending seller counter (non-blocking):", err));
    }
  }

  const freshSellerOffers = await airtable(SELLER_OFFERS_TABLE)
    .select({ fields: [sellerLinkField, "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer", "Withdrawn?"] })
    .all()
    .then((records) =>
      records.filter((r) => {
        if (r.fields?.["Delete Offer"] || r.fields?.["Withdrawn?"]) return false;
        if (firstLinkedRecordId(r.fields?.[sellerLinkField]) !== recordId) return false;
        const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
        if (!sellerId || sellerId === excludeSellerId) return false;
        // Already actively engaged (their own live round exists) —
        // not "fresh," they're handled by the normal negotiation flow.
        return !activeCounterSellerIdsForRecord.has(sellerId);
      })
    );

  for (const so of freshSellerOffers) {
    const sf = so.fields || {};
    const sellerId = firstLinkedRecordId(sf["Seller ID"]);
    const sellerOriginalPrice = numberValue(sf["Seller Offer"]);
    const sellerVatType = asText(sf["Offer VAT Type"]);
    if (!sellerOriginalPrice || !sellerVatType) continue;

    const recomputedPayout =
      sourceType === "Member WTB"
        ? calculateMemberWtbSellerPayout(newBuyerCounterPrice, sellerVatType, contextFields)
        : calculateCounterPayoutForVatType(newBuyerCounterPrice, sellerVatType, contextFields);

    if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) continue;

    const createFields = {
      "Seller ID": [sellerId],
      "Source Type": sourceType,
      "Seller Offer Record ID": so.id,
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": newBuyerCounterPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    };
    createFields[sourceType === "Member WTB" ? "Member WTB" : "Order"] = [recordId];

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create(createFields);

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    if (!sellerDiscordId) continue;

    // NEW — additive only: same proactive "no room" check already
    // used elsewhere — is there any valid step left for THIS seller
    // to counter back with, given their own raw ask vs what the buyer
    // is now offering? If not, their DM shows Accept/Deny only,
    // instead of a Counter button that would always fail.
    const freshNoRoomToCounter = !hasRoomForNextStep(sellerOriginalPrice, recomputedPayout);

    if (sourceType === "Member WTB") {
      await sendMemberWtbCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        memberWtbId: asText(contextFields["Member WTB ID"]) || recordId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        noRoomToCounter: freshNoRoomToCounter,
        // NEW — additive only: his exact scenario — when the buyer
        // denies the CURRENTLY-LOWEST position, that's effectively a
        // "no" to EVERY seller still in the game, since if the buyer
        // won't accept the lowest, they won't accept anything higher
        // either. Every seller reached by this broadcast (except
        // previously-denied sellers being reopened with genuinely
        // good news below) sees this as a clear denial, not a neutral
        // "here's a new counter."
        deniedAmount: isDenyBroadcast ? recomputedPayout : undefined
      }).catch((err) => console.error("Failed to notify fresh seller of buyer counter (non-blocking):", err));
    } else {
      await sendCounterOfferDiscordDM({
        counterOfferRecordId: newRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        orderId: asText(contextFields["Order ID"]),
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        noRoomToCounter: freshNoRoomToCounter,
        deniedAmount: isDenyBroadcast ? recomputedPayout : undefined
      }).catch((err) => console.error("Failed to notify fresh seller of buyer counter (non-blocking):", err));
    }
  }

  for (const [sellerId, deniedRound] of latestDeniedBySeller.entries()) {
    const df = deniedRound.fields || {};
    const deniedBuyerPrice = numberValue(df["Store Counter Price"]);

    // Only re-engage on genuine improvement — strictly higher than
    // what this specific seller was denied at.
    if (!(newBuyerCounterPrice > deniedBuyerPrice)) continue;

    const sellerOriginalPrice = numberValue(df["Seller Original Price"]);
    const sellerVatType = asText(df["Seller Original VAT Type"]);
    const sellerOfferRecordId = asText(df["Seller Offer Record ID"]);

    const recomputedPayout =
      sourceType === "Member WTB"
        ? calculateMemberWtbSellerPayout(newBuyerCounterPrice, sellerVatType, contextFields)
        : calculateCounterPayoutForVatType(newBuyerCounterPrice, sellerVatType, contextFields);

    if (!Number.isFinite(recomputedPayout) || recomputedPayout <= 0) continue;

    const createFields = {
      "Seller ID": [sellerId],
      "Source Type": sourceType,
      "Seller Offer Record ID": sellerOfferRecordId,
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": newBuyerCounterPrice,
      "Counter Payout": recomputedPayout,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": deniedRound.id,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    };
    createFields[sourceType === "Member WTB" ? "Member WTB" : "Order"] = [recordId];

    const reopenedRound = await airtable(COUNTER_OFFERS_TABLE).create(createFields);

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    if (!sellerDiscordId) continue;

    if (sourceType === "Member WTB") {
      await sendMemberWtbCounterOfferDiscordDM({
        counterOfferRecordId: reopenedRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        memberWtbId: asText(contextFields["Member WTB ID"]) || recordId,
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType,
        sellerLastOfferPrice: deniedBuyerPrice > 0 ? sellerOriginalPrice : null
      }).catch((err) => console.error("Failed to re-engage previously denied seller (non-blocking):", err));
    } else {
      await sendCounterOfferDiscordDM({
        counterOfferRecordId: reopenedRound.id,
        sellerDiscordId,
        productName: asText(contextFields["Product Name"]),
        sku: asText(contextFields["SKU"]),
        size: asText(contextFields["Size"]),
        orderId: asText(contextFields["Order ID"]),
        payout: recomputedPayout,
        vatType: sellerVatType,
        sellerOriginalPrice,
        sellerOriginalVatType: sellerVatType
      }).catch((err) => console.error("Failed to re-engage previously denied seller (non-blocking):", err));
    }
  }
}

// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// NEW — additive only: his explicit, confirmed request — add the same
// per-action ownership check Member WTB's buyer-accept/buyer-deny/
// buyer-counter already have (not just the shared secret), now that
// Lojiq Portal calls these Store Orders endpoints too. Small, cheap,
// extra safety layer: confirms the store making the request actually
// owns the Order this round belongs to, before any write happens.
// ---------------------------------------------------------------------
async function verifyStoreOwnsOrderForRound(orderRecordId, requestedStoreName) {
  if (!orderRecordId || !asText(requestedStoreName)) return false;
  const order = await airtable(ORDERS_TABLE).find(orderRecordId);
  return displayValue(order.fields?.["Store Name"]) === asText(requestedStoreName);
}

async function getCurrentGlobalLowestNormalized(sourceType, recordId, excludeSellerId) {
  const linkField = sourceType === "Member WTB" ? "Member WTBs" : "Linked Orders";
  const counterLinkField = sourceType === "Member WTB" ? "Member WTB" : "Order";

  const normalize = (price, vatType) => {
    const p = Number(price);
    if (!Number.isFinite(p)) return null;
    // FIXED — a real, confirmed bug found via his sharp catch: VAT21
    // and Margin are both already VAT-inclusive and stay as-is; only
    // VAT0 is exclusive and needs ×1.21 to land on the same comparable
    // scale. This previously checked "=== VAT21", treating Margin the
    // same as VAT0 — unfairly inflating every Margin seller's position
    // by 21% in every cross-seller comparison this function powers.
    return asText(vatType) === "VAT0" ? p * 1.21 : p;
  };

  const [rawOffers, activeCounters, allRoundsAnyStatus] = await Promise.all([
    airtable(SELLER_OFFERS_TABLE)
      .select({ fields: [linkField, "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer"] })
      .all()
      .then((records) =>
        records.filter(
          (r) =>
            !r.fields?.["Delete Offer"] &&
            firstLinkedRecordId(r.fields?.[linkField]) === recordId
        )
      ),
    airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND({Status} = 'Open', {Source Type} = '${escapeFormulaValue(sourceType)}')`,
        fields: [counterLinkField, "Seller ID", "Counter Payout", "Counter Payout VAT Type", "Seller Original VAT Type", "Seller Counter Price"]
      })
      .all()
      .then((records) => records.filter((r) => firstLinkedRecordId(r.fields?.[counterLinkField]) === recordId)),
    // NEW — additive only: a real, confirmed bug found via his live
    // testing — after a seller's round is Denied, they have NO Open
    // round left at all, so the chain-trace starting point below
    // (previously only looked at Open rounds) never even started,
    // silently falling all the way back to their raw, very-first
    // listing instead of chain-tracing to their true last countered
    // position. Fetches every round regardless of status, so each
    // seller's MOST RECENT round (whatever its status) can serve as
    // the chain-trace starting point.
    airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `{Source Type} = '${escapeFormulaValue(sourceType)}'`,
        fields: [counterLinkField, "Seller ID", "Created At"]
      })
      .all()
      .then((records) => records.filter((r) => firstLinkedRecordId(r.fields?.[counterLinkField]) === recordId))
  ]);

  // FIXED — a real, confirmed related bug: this excluded a seller's
  // RAW offer from consideration the moment they had ANY active round
  // at all — including a round where only the BUYER's pending,
  // unanswered ask is sitting there (Seller Counter Price still
  // empty). That's wrong: until this seller actually counters, their
  // raw listing IS still their real, current competing position — not
  // "nothing" (which is what silently excluding them produced). His
  // exact example: seller A (raw 95, untouched) and seller B (raw 92,
  // untouched) both receive the same buyer broadcast at 72.90 — since
  // neither has genuinely countered yet, seller B's own narrowing-band
  // counter (e.g. to 89) must be checked against seller A's raw 95
  // (the only real competing seller position that exists), not
  // silently against nothing. Only excludes a seller here once they've
  // GENUINELY countered (Seller Counter Price set) — matching exactly
  // the same bar sellerHasActuallyCountered below already uses.
  const sellerIdsWithGenuineCounter = new Set(
    activeCounters
      .filter((r) => numberValue(r.fields?.["Seller Counter Price"]) > 0)
      .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
      .filter(Boolean)
  );

  let minNormalized = null;
  let winningRaw = null;
  let winningVatType = null;
  // NEW — additive only: his explicit request for the Lojiq Portal
  // store-view endpoint — callers that need to know exactly WHICH
  // record produced the winning price (to know which round to act
  // on, and whether it's a genuine counter-offer round vs. a still-
  // untouched raw seller offer) previously had no way to get that
  // from this function without re-deriving it themselves elsewhere,
  // risking the exact "second place with similar logic drifts out of
  // sync" bug already seen once in this project. Every existing
  // caller is unaffected — they only ever read .normalized/.raw/
  // .vatType, which are untouched.
  let winningRecordId = null;
  let winningSource = null;

  // FIXED — a real, confirmed bug found via his live testing: a seller
  // who genuinely countered EARLIER (e.g. seller A at 83) but whose
  // round then got superseded again by a LATER buyer broadcast before
  // they got a chance to respond (via reengageDeniedSellers' merged
  // "any active round" category) falls back here to their raw, very
  // FIRST listing (e.g. 95) instead of their true, more recent 83 —
  // the exact same staleness bug already fixed for the Portal's own
  // "Current Lowest" display and the Discord re-notification, just
  // never applied to THIS shared function too, which is what actual
  // seller-counter VALIDATION relies on. Chain-traces via the same
  // helper (findSellersTrueLastCounter) through each seller's active
  // round's full history before falling back to their raw offer.
  const activeRoundIdBySellerForGlobalLowest = new Map();
  const latestCreatedAtBySeller = new Map();
  for (const r of allRoundsAnyStatus) {
    const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
    if (!sellerId) continue;
    const createdAt = asText(r.fields?.["Created At"]);
    const currentLatest = latestCreatedAtBySeller.get(sellerId);
    if (!currentLatest || (createdAt && createdAt > currentLatest)) {
      latestCreatedAtBySeller.set(sellerId, createdAt);
      activeRoundIdBySellerForGlobalLowest.set(sellerId, r.id);
    }
  }

  // FIXED — a real, confirmed bug found via his live testing: this
  // never checked a round's Status at all, so a seller whose deal was
  // already ACCEPTED (permanently done) still had their old, closed
  // price chain-traced back as if it were a still-live competing
  // position — an already-completed deal could silently outrank a
  // brand new offer from a different seller. Open/Denied/Closed-via-
  // their-own-later-round all remain legitimately chain-traceable
  // (that's the whole point of the reengagement mechanic) — only
  // "Accepted" means done-forever and must be excluded entirely,
  // determined from each seller's OWN most recent round (the same one
  // activeRoundIdBySellerForGlobalLowest just picked above), not just
  // any accepted round anywhere in their history.
  const sellerIdsWithAcceptedDeal = new Set();
  for (const [sellerId, roundId] of activeRoundIdBySellerForGlobalLowest.entries()) {
    const round = allRoundsAnyStatus.find((r) => r.id === roundId);
    if (asText(round?.fields?.["Status"]) === "Accepted") {
      sellerIdsWithAcceptedDeal.add(sellerId);
    }
  }

  for (const so of rawOffers) {
    const sellerId = firstLinkedRecordId(so.fields?.["Seller ID"]);
    if (!sellerId || sellerId === excludeSellerId) continue;
    if (sellerIdsWithGenuineCounter.has(sellerId)) continue; // superseded by their genuine counter below
    if (sellerIdsWithAcceptedDeal.has(sellerId)) continue; // their deal is done, permanently — never a competing position

    const activeRoundId = activeRoundIdBySellerForGlobalLowest.get(sellerId);
    const chainTraced = activeRoundId ? await findSellersTrueLastCounter(activeRoundId) : null;
    const rawPrice = chainTraced ?? numberValue(so.fields?.["Seller Offer"]);
    const rawVatType = so.fields?.["Offer VAT Type"];
    const normalized = normalize(rawPrice, rawVatType);
    if (normalized == null) continue;
    if (minNormalized == null || normalized < minNormalized) {
      minNormalized = normalized;
      winningRaw = rawPrice;
      winningVatType = rawVatType;
      // NEW — additive only: findSellersTrueLastCounter only ever
      // returns a bare price (not a record id), so when it supplied
      // rawPrice there's no single record that genuinely holds this
      // seller's current, actionable position — their own active
      // round has no genuine counter sitting on it yet. Always point
      // callers at the raw Seller Offer record itself here, and mark
      // whether the price shown is that raw listing as-is or a
      // chain-traced historical one, so callers can tell the two
      // apart without re-deriving anything themselves.
      winningRecordId = so.id;
      winningSource = chainTraced != null ? "seller_offer_chain_traced" : "seller_offer_raw";
    }
  }

  for (const cr of activeCounters) {
    const sellerId = firstLinkedRecordId(cr.fields?.["Seller ID"]);
    if (!sellerId || sellerId === excludeSellerId) continue;

    // FIXED — a real, confirmed bug found via his live testing: this
    // counted ANY active round's Counter Payout as "a threshold to
    // beat," including a round where the SELLER hasn't responded yet
    // (Seller Counter Price still empty, only the buyer's identical
    // broadcast offer sitting there via reengageDeniedSellers). When
    // multiple sellers get the SAME buyer counter simultaneously, none
    // of their still-pending copies of that SAME offer are a genuine
    // competing ASK from one another — they're all just mirrors of
    // the one baseline position. Counting them against each other
    // meant neither seller could even respond without going BELOW
    // what the buyer had already offered, which made no sense (e.g.
    // seller A capped at 70 when their own band should have allowed
    // up to 89, purely because seller B had the identical, still-
    // unanswered 85 sitting on their own round too). Now only counts
    // a competitor's position once they've actually placed their OWN
    // counter (Seller Counter Price genuinely set) — that's the
    // earliest point a seller's position becomes a real, independent
    // ask another seller needs to beat.
    const sellerHasActuallyCountered = numberValue(cr.fields?.["Seller Counter Price"]) > 0;
    if (!sellerHasActuallyCountered) continue;

    const effectivePrice = numberValue(cr.fields?.["Counter Payout"]);
    const vatType = cr.fields?.["Counter Payout VAT Type"] || cr.fields?.["Seller Original VAT Type"];
    const normalized = normalize(effectivePrice, vatType);
    if (normalized == null) continue;
    if (minNormalized == null || normalized < minNormalized) {
      minNormalized = normalized;
      winningRaw = effectivePrice;
      winningVatType = vatType;
      // NEW — additive only: this IS a genuine, currently Open
      // Counter Offers round with the seller's own counter sitting
      // on it — the record a caller should actually act on
      // (accept/deny/counter against).
      winningRecordId = cr.id;
      winningSource = "counter_offer_round";
    }
  }

  // FIXED — this used to return a bare number, forcing every caller
  // needing the actual seller-scale price (not just the normalized
  // value used for comparisons) to convert the NORMALIZED number back
  // down — which produces a seller-payout-scale number, not the
  // buyer-facing price a seller's own dashboard needs to show when
  // displaying "what's the current best price in the market." Now
  // returns the winning raw price + its own VAT type too, so callers
  // can run it through the correct buyer-facing conversion themselves.
  // .normalized alone still works exactly like the old bare-number
  // return for every comparison-only caller.
  return {
    normalized: minNormalized,
    raw: winningRaw,
    vatType: winningVatType,
    // NEW — additive only, see comments above. Existing callers that
    // only destructure .normalized/.raw/.vatType are unaffected.
    winningRecordId,
    winningSource
  };
}

// ---------------------------------------------------------------------
// NEW — additive only: Lojiq Portal's Open pill, part 1 of 2 — fresh,
// never-countered Seller Offers for a store's orders. 1:1 mirror of
// /api/dashboard/buying-offers (Member WTB's equivalent), adapted:
//  - ownership by Store Name text match (Store Orders has no linked
//    buyer record the way Member WTB has Buyer Seller ID)
//  - price is read directly from the Order's own "Offer To Store"
//    field rather than recalculated — his explicit, confirmed choice,
//    on firmer footing now that both write-side bugs feeding that
//    field (rounding, missing Offer VAT Type on accept) are fixed
// Everything else — excluding Denied?/Withdrawn?/Delete Offer sellers,
// excluding sellers already mid-negotiation on this order, and hiding
// the whole order if some OTHER seller's active counter already beats
// the best fresh offer (that order belongs in Countered instead) — is
// carried over unchanged from the Member WTB pattern.
// Replaces the earlier, simpler store-view endpoint (his confirmed
// call — this is more thorough: proper Denied?/Withdrawn? exclusion,
// cross-seller comparison, no-room-to-counter).
// ---------------------------------------------------------------------
app.get("/api/dashboard/store-offers", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const storeName = asText(req.query.store_name);

    if (!storeName) {
      return res.status(400).json({ error: "Missing store_name" });
    }

    const safeStoreName = escapeFormulaValue(storeName);

    const orderRecords = await airtable(ORDERS_TABLE)
      .select({
        filterByFormula: `AND(
          TRIM({Store Name} & '') = '${safeStoreName}',
          OR({Fulfillment Status} = 'Pending', {Fulfillment Status} = 'Outsource'),
          {Offer To Store} > 0
        )`
      })
      .all();

    if (!orderRecords.length) {
      return res.json({ count: 0, items: [] });
    }

    const orderIds = orderRecords.map((r) => r.id);
    const orderIdSet = new Set(orderIds);

    // Per order, the set of seller IDs currently mid-negotiation — their
    // raw Seller Offer is stale (superseded by their own counter) and
    // must be skipped when picking the "fresh" winner below.
    const activeCountersForTheseOrders = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Seller Offer')`,
        fields: ["Order", "Seller ID"]
      })
      .all()
      .then((records) => records.filter((r) => orderIdSet.has(firstLinkedRecordId(r.fields?.["Order"]))));

    const sellerIdsWithActiveCounterByOrderId = new Map();
    for (const r of activeCountersForTheseOrders) {
      const orderId = firstLinkedRecordId(r.fields?.["Order"]);
      const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
      if (!orderId || !sellerId) continue;
      if (!sellerIdsWithActiveCounterByOrderId.has(orderId)) {
        sellerIdsWithActiveCounterByOrderId.set(orderId, new Set());
      }
      sellerIdsWithActiveCounterByOrderId.get(orderId).add(sellerId);
    }

    const allSellerOffersForTheseOrders = await airtable(SELLER_OFFERS_TABLE)
      .select({ fields: ["Linked Orders", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer", "Denied?", "Withdrawn?"] })
      .all()
      .then((records) =>
        records.filter(
          (r) =>
            !r.fields?.["Delete Offer"] &&
            !r.fields?.["Denied?"] &&
            !r.fields?.["Withdrawn?"] &&
            orderIdSet.has(firstLinkedRecordId(r.fields?.["Linked Orders"]))
        )
      );

    const winningSellerOfferByOrderId = new Map();
    for (const so of allSellerOffersForTheseOrders) {
      const orderId = firstLinkedRecordId(so.fields?.["Linked Orders"]);
      const sellerId = firstLinkedRecordId(so.fields?.["Seller ID"]);

      // Skip — this seller is already mid-negotiation on this order;
      // their raw offer is stale, doesn't belong in the "fresh" pool.
      if (sellerId && sellerIdsWithActiveCounterByOrderId.get(orderId)?.has(sellerId)) continue;

      const price = numberValue(so.fields?.["Seller Offer"]);
      if (!Number.isFinite(price)) continue;

      // FIXED — a real, confirmed bug: this compared RAW seller prices
      // across sellers, but different VAT types live on different
      // scales. VAT0 is exclusive and must be ×1.21 to compare against
      // Margin/VAT21 (both already inclusive) — the exact same
      // normalization getCurrentGlobalLowestNormalized uses. Without it,
      // e.g. 185 VAT0 (=223.85 normalized) was wrongly picked as
      // "winner" over 220 Margin (=220), AND then the beats-fresh
      // exclusion below compared that mis-picked 223.85 against the
      // correctly-normalized 220 from getCurrentGlobalLowestNormalized,
      // so the order EXCLUDED ITSELF from Open entirely (220 < 223.85).
      const vatType = asText(so.fields?.["Offer VAT Type"]);
      const normalizedPrice = vatType === "VAT0" ? price * 1.21 : price;

      const current = winningSellerOfferByOrderId.get(orderId);
      if (!current || normalizedPrice < current.normalizedPrice) {
        winningSellerOfferByOrderId.set(orderId, {
          price,
          normalizedPrice,
          id: so.id,
          vatType
        });
      }
    }

    // If some OTHER seller's active counter already beats the best
    // fresh offer, this order's true winner belongs in Countered
    // instead — exclude from Open entirely rather than show a worse
    // number.
    await Promise.all(
      Array.from(winningSellerOfferByOrderId.keys()).map(async (orderId) => {
        const bestActiveCounter = (await getCurrentGlobalLowestNormalized("Seller Offer", orderId, null)).normalized;
        const winner = winningSellerOfferByOrderId.get(orderId);
        const freshNormalized = winner.normalizedPrice;
        if (Number.isFinite(bestActiveCounter) && Number.isFinite(freshNormalized) && bestActiveCounter < freshNormalized) {
          winningSellerOfferByOrderId.delete(orderId);
        }
      })
    );

    // Same batching pattern as winningSellerOfferByOrderId above — one
    // broad fetch for ALL these orders' rounds (any status, needed since
    // the store's highest-ever position can live on a Closed/Denied
    // round too), then a per-order lookup, instead of one Airtable call
    // per order (getBuyerHighestEverPosition would otherwise run once
    // per item and risk Airtable's rate limit on a bigger list).
    const allRoundsForTheseOrders = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `{Source Type} = 'Seller Offer'`,
        fields: ["Order", "Store Counter Price"]
      })
      .all()
      .then((records) => records.filter((r) => orderIdSet.has(firstLinkedRecordId(r.fields?.["Order"]))));

    const myHighestEverByOrderId = new Map();
    for (const r of allRoundsForTheseOrders) {
      const orderId = firstLinkedRecordId(r.fields?.["Order"]);
      if (!orderId) continue;
      const price = numberValue(r.fields?.["Store Counter Price"]);
      if (!(price > 0)) continue;
      const current = myHighestEverByOrderId.get(orderId);
      if (current == null || price > current) {
        myHighestEverByOrderId.set(orderId, price);
      }
    }

    const items = orderRecords
      .filter((record) => winningSellerOfferByOrderId.has(record.id))
      .map((record) => {
        const f = record.fields || {};
        const winningSellerOffer = winningSellerOfferByOrderId.get(record.id);

        // His explicit, confirmed choice: read the price directly from
        // the Order's own trusted "Offer To Store" field rather than
        // recalculating it from winningSellerOffer.
        const offerAmount = numberValue(f["Offer To Store"]);

        const myHighestEver = myHighestEverByOrderId.get(record.id) ?? null;

        const noRoomToCounter =
          Number.isFinite(myHighestEver) &&
          myHighestEver > 0 &&
          Number.isFinite(offerAmount) &&
          (offerAmount - myHighestEver) < MIN_COUNTER_STEP;

        return {
          id: record.id,
          order_record_id: record.id,
          seller_offer_record_id: winningSellerOffer.id,
          order_number: displayValue(f["Shopify Order Number"]),
          product: displayValue(f["Shopify Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          // NEW — additive only: these three were present on every
          // other order-list view via the Lojiq Portal's own shared
          // mapping (selling_price, offer_date, eta) but missing here
          // — his own catch before live-testing, would have shown "—"
          // in those columns for every row.
          selling_price: Number.isFinite(numberValue(f["Selling Price"])) && numberValue(f["Selling Price"]) > 0
            ? moneySmartValue(numberValue(f["Selling Price"]))
            : "-",
          offer_date: formatDateEU(f["Offer Sent At"]),
          eta: displayValue(f["Estimated Time"]),
          offer: Number.isFinite(offerAmount) && offerAmount > 0
            ? moneySmartValue(offerAmount)
            : "-",
          my_offer: Number.isFinite(myHighestEver) && myHighestEver > 0
            ? moneySmartValue(myHighestEver)
            : null,
          no_room_to_counter: noRoomToCounter,
          vat_type: winningSellerOffer.vatType || null,
          status: "Offer Received",
          date: formatDateEU(f["Order Date"]),
          raw_date: f["Order Date"]
        };
      });

    res.json({
      count: items.length,
      items: sortDashboardItemsNewestFirst(items)
    });
  } catch (err) {
    console.error("Failed to load store offers:", err);
    res.status(500).json({
      error: "Failed to load store offers",
      details: err.message
    });
  }
});
// ---------------------------------------------------------------------
// NEW — additive only: Lojiq Portal's Open pill, part 2 of 2 — genuine
// back-and-forth rounds where the SELLER just moved and the store needs
// to respond. 1:1 mirror of /api/dashboard/buying-counter-offers,
// adapted the same way as store-offers above (store_name text match
// instead of a linked buyer record, x-kc-secret since this is called
// server-to-server by Lojiq Portal rather than from a logged-in
// browser session).
//
// Only filter=open is built right now, on purpose — matches the
// agreed small-steps approach; filter=countered/denied come with
// their own phases later. Requesting anything else returns a clear
// "not built yet" response rather than silently doing the wrong
// thing.
// ---------------------------------------------------------------------
app.get("/api/dashboard/store-counter-offers", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const storeName = asText(req.query.store_name);
    const filter = asText(req.query.filter) || "open";

    if (!storeName) {
      return res.status(400).json({ error: "Missing store_name" });
    }

    if (filter !== "open" && filter !== "countered" && filter !== "denied") {
      return res.status(400).json({ error: `filter=${filter} isn't built yet — only filter=open, filter=countered, and filter=denied are available so far` });
    }

    const safeStoreName = escapeFormulaValue(storeName);

    const myOrders = await airtable(ORDERS_TABLE)
      .select({
        filterByFormula: `AND(
          TRIM({Store Name} & '') = '${safeStoreName}',
          OR({Fulfillment Status} = 'Pending', {Fulfillment Status} = 'Outsource')
        )`
      })
      .all();

    const myOrderIds = new Set(myOrders.map((r) => r.id));

    if (!myOrderIds.size) {
      return res.json({ count: 0, items: [] });
    }

    const statusForQuery = filter === "denied" ? "Denied" : "Open";
    const records = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND({Status} = '${statusForQuery}', {Source Type} = 'Seller Offer')`
      })
      .all()
      .then((records) =>
        records.filter((r) => myOrderIds.has(firstLinkedRecordId(r.fields?.["Order"])))
      );

    // "open" wants rows where the SELLER just moved (store must
    // respond); "countered" wants the opposite — the store's own
    // pending counter, awaiting the seller. "denied" wants every
    // denied round (no seller-moved inversion). Same inversion as
    // buying-counter-offers.
    let preFiltered = records.filter((record) => {
      if (filter === "denied") return true;
      const f = record.fields || {};
      const sellerAlreadyCountered =
        f["Seller Counter Price"] !== undefined && f["Seller Counter Price"] !== null && f["Seller Counter Price"] !== "";
      return filter === "open" ? sellerAlreadyCountered : !sellerAlreadyCountered;
    });

    // NEW — additive only: same supersession-collapse the buying-side
    // Denied pill uses. A deny-with-reopen permanently leaves the
    // just-denied round at Status="Denied"; the negotiation continues
    // via the REOPENED round before it, not through this one, so that
    // old denial would show the same order twice. A denied round is
    // superseded if a later sibling shares its "Previous Record ID"
    // (another round placed later from that same reopened position) —
    // only the round with no later sibling is the real, current dead
    // end. Fetch broadly and match by Order ID in JS (never
    // FIND(rawId, ARRAYJOIN(...)), a documented pitfall).
    if (filter === "denied" && preFiltered.length) {
      const allSellerRounds = await airtable(COUNTER_OFFERS_TABLE)
        .select({
          filterByFormula: `{Source Type} = 'Seller Offer'`,
          fields: ["Order", "Previous Record ID", "Created At"]
        })
        .all();

      const siblingsByPrevId = new Map();
      for (const r of allSellerRounds) {
        if (!myOrderIds.has(firstLinkedRecordId(r.fields?.["Order"]))) continue;
        const prevId = firstLinkedRecordId(r.fields?.["Previous Record ID"]);
        if (!prevId) continue;
        if (!siblingsByPrevId.has(prevId)) siblingsByPrevId.set(prevId, []);
        siblingsByPrevId.get(prevId).push({
          id: r.id,
          createdAt: displayValue(r.fields?.["Created At"])
        });
      }

      preFiltered = preFiltered.filter((record) => {
        const f = record.fields || {};
        const ownPrevId = firstLinkedRecordId(f["Previous Record ID"]);
        const ownCreatedAt = displayValue(f["Created At"]);
        if (!ownPrevId) return true;
        const siblings = siblingsByPrevId.get(ownPrevId) || [];
        const hasLaterSibling = siblings.some(
          (s) => s.id !== record.id && s.createdAt && ownCreatedAt && s.createdAt > ownCreatedAt
        );
        return !hasLaterSibling;
      });
    }

    const previousIds = [...new Set(preFiltered.map((r) => firstLinkedRecordId(r.fields?.["Previous Record ID"])).filter(Boolean))];

    let previousSellerCounterById = new Map();
    let previousStoreCounterById = new Map();
    if (previousIds.length) {
      const previousFormula = `OR(${previousIds.map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`).join(",")})`;
      const previousRecords = await airtable(COUNTER_OFFERS_TABLE)
        .select({ filterByFormula: previousFormula, fields: ["Seller Counter Price", "Seller Original Price", "Store Counter Price"] })
        .all();

      previousSellerCounterById = new Map(
        previousRecords.map((r) => {
          const sellerCounter = numberValue(r.fields?.["Seller Counter Price"]);
          return [r.id, sellerCounter > 0 ? sellerCounter : numberValue(r.fields?.["Seller Original Price"])];
        })
      );
      previousStoreCounterById = new Map(
        previousRecords.map((r) => [r.id, numberValue(r.fields?.["Store Counter Price"])])
      );
    }

    const orderFieldsById = new Map(myOrders.map((r) => [r.id, r.fields || {}]));

    const items = await Promise.all(preFiltered.map(async (record) => {
      const f = record.fields || {};
      const orderId = firstLinkedRecordId(f["Order"]);
      const orderFields = orderFieldsById.get(orderId) || {};
      const vatType = asText(f["Seller Original VAT Type"]);

      const previousOfferId = firstLinkedRecordId(f["Previous Record ID"]);

      const ownStoreCounter = numberValue(f["Store Counter Price"]);
      const myLastOffer = ownStoreCounter > 0
        ? ownStoreCounter
        : (previousOfferId ? previousStoreCounterById.get(previousOfferId) : null);

      const sellerCounter = numberValue(f["Seller Counter Price"]);
      let sellersOffer;
      if (sellerCounter > 0) {
        sellersOffer = sellerCounter;
      } else {
        const chainTraced = await findSellersTrueLastCounter(record.id);
        sellersOffer = chainTraced ?? numberValue(f["Seller Original Price"]);
      }

      const isDutchStoreForDisplay = isDutchClientCountry(orderFields["Client Country"]);
      const isVatSourceForDisplay = vatType === "VAT21" || vatType === "VAT0";
      const needsConversionForDisplay = !isDutchStoreForDisplay && isVatSourceForDisplay;

      const sellersOfferInStoreTerms = calculateStoreCounterEquivalent(
        sellersOffer,
        vatType,
        orderFields,
        needsConversionForDisplay ? 1.21 : 1
      );

      // my_offer is the store's OWN typed input — it was multiplied by
      // 1.21 on the way IN (to reach the internal all-in scale before
      // storing, kept unrounded there for exactly this reason), so
      // showing it back means reversing that: divide.
      const myLastOfferForDisplay = Number.isFinite(myLastOffer) && myLastOffer > 0
        ? (needsConversionForDisplay ? myLastOffer / storeDisplayDivisor(vatType, orderFields) : myLastOffer)
        : null;

      // sellersOfferInStoreTerms above already applied the non-Dutch
      // adjustment BEFORE its own internal rounding (via
      // preAdjustmentMultiplier) — no further conversion needed here.
      const sellersOfferInStoreTermsForDisplay = sellersOfferInStoreTerms;

      return {
        id: record.id,
        order_record_id: orderId,
        seller_offer_record_id: asText(f["Seller Offer Record ID"]),
        order_number: displayValue(orderFields["Shopify Order Number"]),
        product: displayValue(orderFields["Shopify Product Name"]),
        sku: displayValue(orderFields["SKU"]),
        size: displayValue(orderFields["Size"]),
        brand: displayValue(orderFields["Brand"]),
        // NEW — additive only: matching the same fields added to
        // store-offers just now — his own catch before live-testing.
        selling_price: Number.isFinite(numberValue(orderFields["Selling Price"])) && numberValue(orderFields["Selling Price"]) > 0
          ? moneySmartValue(numberValue(orderFields["Selling Price"]))
          : "-",
        offer_date: formatDateEU(orderFields["Offer Sent At"]),
        eta: displayValue(orderFields["Estimated Time"]),
        date: formatDateEU(orderFields["Order Date"]),
        my_offer: Number.isFinite(myLastOfferForDisplay) && myLastOfferForDisplay > 0 ? moneySmartValue(myLastOfferForDisplay) : null,
        sellers_offer: Number.isFinite(sellersOfferInStoreTermsForDisplay) ? moneySmartValue(sellersOfferInStoreTermsForDisplay) : null,
        sellers_offer_payout: Number.isFinite(sellersOffer) ? sellersOffer : null,
        vat_type: vatType,
        previous_record_id: previousOfferId,
        previous_seller_counter: previousOfferId && Number.isFinite(previousSellerCounterById.get(previousOfferId))
          ? moneySmartValue(previousSellerCounterById.get(previousOfferId))
          : null,
        previous_seller_counter_payout: previousOfferId && Number.isFinite(previousSellerCounterById.get(previousOfferId))
          ? previousSellerCounterById.get(previousOfferId)
          : null,
        raw_date: asText(f["Created At"]),
        denied_at: filter === "denied" ? formatDateEU(f["Denied At"]) : null,
        // Kept only for the visibility filter right below — not part
        // of the response shape.
        __sellerId: firstLinkedRecordId(f["Seller ID"])
      };
    }));

    // Same "single best position only" rule as buying-counter-offers —
    // if some OTHER seller's active round on this order already beats
    // this one, hide this one (it belongs to whichever seller is
    // actually winning right now).
    const visibleItems = await Promise.all(
      items.map(async (item) => {
        // Denied rounds are closed records — always show them in the
        // Denied pill; the "single best position only" rule only makes
        // sense for live Open/Countered rounds.
        if (filter === "denied") return item;

        const betterElsewhere = (await getCurrentGlobalLowestNormalized(
          "Seller Offer",
          item.order_record_id,
          item.__sellerId
        )).normalized;
        if (!Number.isFinite(betterElsewhere)) return item;

        const ownRawPrice = item.sellers_offer_payout;
        const ownVatType = item.vat_type;
        const ownNormalized = Number.isFinite(Number(ownRawPrice))
          ? (asText(ownVatType) === "VAT0" ? Number(ownRawPrice) * 1.21 : Number(ownRawPrice))
          : null;

        if (ownNormalized == null) return item;

        return betterElsewhere < ownNormalized ? null : item;
      })
    ).then((results) => results.filter(Boolean));

    const finalItems = visibleItems.map(({ __sellerId, ...rest }) => rest);

    // NEW — additive only: "denied" must also include fresh,
    // never-countered offers the STORE denied outright — those never
    // touch the Counter Offers table (they're marked Denied? on the
    // Seller Offer itself by notifySellerOfferDeniedCore), so the query
    // above alone always missed this whole category (case A). Merged in
    // with round_type "denied" + _kind "fresh_denied" so the Lojiq
    // frontend can offer Accept/Counter/Delete on the raw seller offer.
    let mergedItems = finalItems;
    if (filter === "denied") {
      const deniedSellerOfferRecords = await airtable(SELLER_OFFERS_TABLE)
        .select({ filterByFormula: `{Denied?} = TRUE()` })
        .all();

      const deniedFreshItems = deniedSellerOfferRecords
        .filter((record) => myOrderIds.has(firstLinkedRecordId(record.fields?.["Linked Orders"])))
        .filter((record) => !record.fields?.["Withdrawn?"])
        .filter((record) => !record.fields?.["Delete Offer"])
        .map((record) => {
          const f = record.fields || {};
          const orderId = firstLinkedRecordId(f["Linked Orders"]);
          const orderFields = orderFieldsById.get(orderId) || {};
          const deniedVatType = displayValue(f["Denied VAT Type"]) || asText(f["Offer VAT Type"]);
          const rawDeniedAmount = numberValue(f["Denied Amount"]) || numberValue(f["Seller Offer"]);

          // Show the seller's denied fresh offer in the store's own
          // scale (marked up + VAT-converted), same as everywhere else.
          const sellersOfferInStoreTerms = calculateStoreCounterEquivalent(
            rawDeniedAmount,
            deniedVatType,
            orderFields,
            (!isDutchClientCountry(orderFields["Client Country"]) && (deniedVatType === "VAT0" || deniedVatType === "VAT21")) ? 1.21 : 1
          );

          return {
            id: record.id,
            _kind: "fresh_denied",
            round_type: "denied",
            order_record_id: orderId,
            seller_offer_record_id: asText(f["Seller Offer Record ID"]) || record.id,
            order_number: displayValue(orderFields["Shopify Order Number"]),
            product: displayValue(f["Product Name"]) || displayValue(orderFields["Shopify Product Name"]),
            sku: displayValue(f["SKU"]) || displayValue(orderFields["SKU"]),
            size: displayValue(f["Size"]) || displayValue(orderFields["Size"]),
            brand: displayValue(f["Brand"]) || displayValue(orderFields["Brand"]),
            selling_price: Number.isFinite(numberValue(orderFields["Selling Price"])) && numberValue(orderFields["Selling Price"]) > 0
              ? moneySmartValue(numberValue(orderFields["Selling Price"]))
              : "-",
            // No store counter existed (store denied a fresh offer), so
            // there is no "my_offer" — only the seller's offer.
            my_offer: null,
            sellers_offer: Number.isFinite(sellersOfferInStoreTerms) ? moneySmartValue(sellersOfferInStoreTerms) : null,
            sellers_offer_payout: Number.isFinite(rawDeniedAmount) ? rawDeniedAmount : null,
            vat_type: deniedVatType,
            denied_at: formatDateEU(f["Denied At"])
          };
        });

      mergedItems = [...finalItems, ...deniedFreshItems];
    }

    res.json({
      count: mergedItems.length,
      items: sortDashboardItemsNewestFirst(mergedItems)
    });
  } catch (err) {
    console.error("Failed to load store counter offers:", err);
    res.status(500).json({
      error: "Failed to load store counter offers",
      details: err.message
    });
  }
});
// ---------------------------------------------------------------------
async function closeCompetingCountersForOrder(orderRecordId, acceptedCounterOfferRecordId) {
  const openCountersForOrderMatch = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `AND(
        {Status} = 'Open',
        RECORD_ID() != '${acceptedCounterOfferRecordId}'
      )`
    })
    .all();

  const competingCounters = openCountersForOrderMatch.filter((r) =>
    firstLinkedRecordId(r.fields?.["Order"]) === orderRecordId
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
      ).catch((err) => console.error("Failed to disable competing counter's Discord buttons (non-blocking):", err));
    }
  }
}

app.post("/api/dashboard/wtb-counter-offers/:offerId/seller-accept", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);

    if (!counterOfferRecordId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const f = counterOffer.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer available." });
    }

    const linkedMemberWtbId = firstLinkedRecordId(f["Member WTB"]);

    // NEW — additive only: this endpoint previously always required an
    // "Order" link and hard-failed for every Member WTB round (they
    // only ever link via "Member WTB", never "Order") — meaning a
    // seller could never successfully Accept a Member WTB deal via the
    // Portal. Routes Member WTB rounds through the same
    // /member-wtb/deal-channel + override mechanism Buying's own
    // accept flow already correctly uses, instead of the Order-based
    // Make webhook path below (which stays completely unchanged for
    // Store Orders).
    if (linkedMemberWtbId) {
      const sellerOfferRecordId = asText(f["Seller Offer Record ID"]);

      if (!sellerOfferRecordId) {
        return res.status(500).json({ error: "Counter Offer missing linked Seller Offer" });
      }

      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(linkedMemberWtbId);

      if (asText(memberWtb.fields?.["Fulfillment Status"]) === "Allocated") {
        return res.status(409).json({ error: "This Member WTB is no longer available." });
      }

      const acceptedPayout = numberValue(f["Counter Payout"]);
      const acceptedVatType = asText(f["Counter Payout VAT Type"] || f["Seller Original VAT Type"]);

      await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
        "Status": "Accepted",
        "Accepted At": new Date().toISOString(),
        "Closed At": new Date().toISOString()
      });

      const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

      if (!wtbBotBaseUrl) {
        return res.status(500).json({ error: "KICKZ_WTB_BOT_BASE_URL is missing" });
      }

      const dealResponse = await fetch(`${wtbBotBaseUrl}/member-wtb/deal-channel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kc-secret": process.env.KC_PORTAL_SECRET
        },
        body: JSON.stringify({
          member_wtb_record_id: linkedMemberWtbId,
          seller_offer_record_id: sellerOfferRecordId,
          override_price: acceptedPayout,
          override_vat_type: acceptedVatType
        })
      });

      const dealData = await dealResponse.json().catch(() => ({}));

      if (!dealResponse.ok) {
        return res.status(dealResponse.status).json({ error: dealData.error || "Failed to accept offer" });
      }

      await closeCompetingCountersForMemberWtb(linkedMemberWtbId, counterOfferRecordId).catch((err) =>
        console.error("Failed to close competing counters (non-blocking):", err)
      );

      return res.json({ ok: true });
    }

    const linkedOrderId = firstLinkedRecordId(f["Order"]);

    if (!linkedOrderId) {
      return res.status(500).json({ error: "Counter Offer missing linked Order" });
    }

    const orderRecord = await airtable(ORDERS_TABLE).find(linkedOrderId);
    const orderStatus = asText(orderRecord.fields?.["Fulfillment Status"]);

    if (orderStatus !== "Outsource") {
      return res.status(409).json({ error: "This order is no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Accepted",
      "Accepted At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

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
          store_counter_price: numberValue(f["Store Counter Price"]),
          store_counter_price_excl_vat: numberValue(f["Store Counter Price Excl VAT"]),
          counter_payout: numberValue(f["Counter Payout"]),
          counter_payout_vat_type: asText(f["Counter Payout VAT Type"]),
          seller_original_price: numberValue(f["Seller Original Price"]),
          seller_original_vat_type: asText(f["Seller Original VAT Type"]),
          accepted_at_iso: new Date().toISOString()
        })
      }).catch((err) => console.error("Failed to fire accept webhook (non-blocking):", err));
    }

    // FIXED — the exact bug behind "accepted VAT0 seller but Custom
    // Offer stayed VAT Type Margin": this endpoint wrote "Custom Offer"
    // but NEVER "Offer VAT Type", unlike store-accept and the Discord
    // counter_offer_accept handler. So Custom Offer became the right
    // price (215) but Offer VAT Type kept its stale value (Margin).
    // Same rule as every other accept path: Margin stays Margin;
    // otherwise follow the CLIENT's country (Dutch → VAT21, non-Dutch
    // → VAT0).
    const sellerVatTypeForSellerAccept = asText(f["Seller Original VAT Type"]);
    const offerVatTypeForSellerAccept =
      sellerVatTypeForSellerAccept === "Margin"
        ? "Margin"
        : (isDutchClientCountry(orderRecord.fields?.["Client Country"]) ? "VAT21" : "VAT0");

    try {
      await airtable(ORDERS_TABLE).update(linkedOrderId, {
        "Custom Offer": customOfferValueForAccept(
          offerVatTypeForSellerAccept,
          numberValue(f["Store Counter Price"]),
          numberValue(f["Store Counter Price Excl VAT"])
        ),
        "Offer VAT Type": offerVatTypeForSellerAccept,
        "Offer Accepted?": true,
        "Offer Sent?": false
      });
    } catch (priceWriteErr) {
      console.error("Failed to write accepted price to Order record (non-blocking):", priceWriteErr);
    }

    // NEW — additive only: matches the Discord accept handler, which
    // already closes every other competing seller's open counter for
    // this same order once one is accepted.
    await closeCompetingCountersForOrder(linkedOrderId, counterOfferRecordId).catch((err) =>
      console.error("Failed to close competing counters (non-blocking):", err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to accept WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to accept offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller Deny the store/buyer's current
// counter from the Countered pill. Reuses the exact same reopen-prior-
// round logic as the existing Discord counter_offer_deny: handler —
// if this counter was itself responding to an earlier seller counter,
// that prior round reopens (back to Open) instead of just dead-ending,
// and the store gets notified via the same Discord mechanism the
// Discord-side deny already uses.
// ---------------------------------------------------------------------
app.post("/api/dashboard/wtb-counter-offers/:offerId/seller-deny", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);

    if (!counterOfferRecordId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const deniedFields = deniedRecord.fields || {};

    if (!linkedRecordIncludes(deniedFields["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (asText(deniedFields["Status"]) !== "Open") {
      return res.status(409).json({ error: "This counter offer is no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    const deniedOrderId = firstLinkedRecordId(deniedFields["Order"]);
    const deniedPrice = numberValue(deniedFields["Store Counter Price"]);
    const priorRoundId = asText(deniedFields["Previous Record ID"]);

    if (deniedOrderId && AIRTABLE_DISCORD_UPDATES_URL) {
      const orderRecord = await airtable(ORDERS_TABLE).find(deniedOrderId);
      const orderFields = orderRecord.fields || {};

      // NEW — additive only: same gate the other seller-deny path
      // (counter_offer_deny) already has. Only touch the store side
      // (reopen the store's prior round + send a denied/reopen embed)
      // when the seller who just denied was the CURRENT BEST across all
      // sellers. A higher, non-lowest seller denying must do nothing
      // store-side — the current lowest seller stays active, the store
      // keeps its Countered row and can still Edit. Without this the
      // store gets a denied embed for every non-winning seller's deny.
      const denyingSellerIdForStore = firstLinkedRecordId(deniedFields["Seller ID"]);
      const otherSellerExistsForStore = (await getCurrentGlobalLowestNormalized(
        "Seller Offer",
        deniedOrderId,
        denyingSellerIdForStore
      )).normalized;

      const denyingSellerTruePositionForStore = await findSellersTrueLastCounter(counterOfferRecordId);
      const denyingSellerVatTypeForStore = asText(deniedFields["Seller Original VAT Type"]);
      const denyingSellerOwnNormalizedForStore = Number.isFinite(denyingSellerTruePositionForStore)
        ? (denyingSellerVatTypeForStore === "VAT0" ? denyingSellerTruePositionForStore * 1.21 : denyingSellerTruePositionForStore)
        : null;

      const shouldNotifyStore =
        !Number.isFinite(otherSellerExistsForStore) ||
        (Number.isFinite(denyingSellerOwnNormalizedForStore) && otherSellerExistsForStore >= denyingSellerOwnNormalizedForStore);

      if (!shouldNotifyStore) {
        // Non-lowest seller denied — done. Their own round is already
        // marked Denied above; nothing happens store-side.
        return res.json({ ok: true, notified_store: false });
      }

      if (priorRoundId) {
        const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

        if (priorRound) {
          await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, { "Status": "Open" });

          const priorFields = priorRound.fields || {};
          const priorSellerCounter = numberValue(priorFields["Seller Counter Price"]);
          const priorVatType = asText(priorFields["Seller Original VAT Type"] || deniedFields["Seller Original VAT Type"]);
          const priorSellerCounterInStoreTerms = calculateStoreCounterEquivalent(
            priorSellerCounter,
            priorVatType,
            orderFields
          );

          // NEW — additive only: store-facing embed values in the
          // store's own VAT scale.
          const reopen2EmbedDivisor = storeDisplayDivisor(priorVatType, orderFields);
          const reopen2DeniedForDisplay = deniedPrice / reopen2EmbedDivisor;
          const reopen2SellerCounterForDisplay = computeSellerCounterForStoreDisplay(
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
              your_previous_counter: reopen2DeniedForDisplay,
              seller_counter_price: reopen2SellerCounterForDisplay ?? priorSellerCounterInStoreTerms ?? priorSellerCounter,
              denied_price: reopen2DeniedForDisplay,
              store_display_vat_type: priorVatType
            })
          }).catch((err) => console.error("Failed to notify store of reopened round (non-blocking):", err));
        }
      } else {
        // FIXED — same as path 1: show the denied counter in the
        // store's own VAT scale, not the internal all-in value.
        const deniedVatTypeForDisplay2 = asText(deniedFields["Seller Original VAT Type"]);
        const deniedPriceForStoreDisplay2 = deniedPrice / storeDisplayDivisor(deniedVatTypeForDisplay2, orderFields);
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
            denied_price: deniedPriceForStoreDisplay2,
            denied_vat_type: deniedVatTypeForDisplay2
          })
        }).catch((err) => console.error("Failed to notify store of denial (non-blocking):", err));
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to deny WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to deny offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets a seller edit their own already-placed
// counter (own_counter items in the Open pill) to a lower amount. The
// existing /api/counter-offers/:id/edit endpoint already supports this
// (actor: "seller") but is secured with a server-side secret header,
// not something the Portal can safely call directly — this wrapper
// checks Portal ownership (seller_record_id) first, then calls that
// endpoint internally with the secret added server-side, so the
// secret never reaches the browser.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// NEW — additive only: Portal-safe wrapper for a seller countering on a
// Member WTB round from the seller-side Want To Buys "Countered" pill.
// A real, confirmed bug found via his live testing: the frontend's
// "Counter" button always called the STORE ORDERS seller-counter
// endpoint, regardless of item type — for a Member WTB round, that
// endpoint operates on the wrong table/scope entirely (no "Order" link
// exists there), producing nonsense cross-seller thresholds and the
// wrong error text. This wrapper checks Portal ownership then calls
// the correct, secret-protected /api/member-wtb-counter-offers/:id/
// seller-counter internally, same pattern as seller-edit above.
// ---------------------------------------------------------------------
app.post("/api/dashboard/wtb-counter-offers/:offerId/seller-counter-mwtb", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const price = req.body?.price;

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const f = record.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const response = await fetch(`http://localhost:${PORT}/api/member-wtb-counter-offers/${offerId}/seller-counter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
      },
      body: JSON.stringify({ price })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Failed to submit Member WTB seller counter:", err);

    res.status(500).json({
      error: "Failed to submit counter",
      details: err.message
    });
  }
});

app.post("/api/dashboard/wtb-counter-offers/:offerId/seller-edit", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const sellerRecordId = asText(req.body?.seller_record_id);
    const price = req.body?.price;

    if (!offerId || !sellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const f = record.fields || {};

    if (!linkedRecordIncludes(f["Seller ID"], sellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const response = await fetch(`http://localhost:${PORT}/api/counter-offers/${offerId}/edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.COUNTER_OFFERS_SECRET || ""
      },
      body: JSON.stringify({ actor: "seller", price })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Failed to edit WTB counter offer:", err);

    res.status(500).json({
      error: "Failed to edit offer",
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

    // FIXED — a real, confirmed bug: this endpoint (a seller accepting
    // the STORE's counter on a Store Order) never wrote "Custom Offer"/
    // "Offer VAT Type" back onto the Order — it only fired the webhook.
    // So the accepted price/VAT was never frozen on the order the way
    // store-accept does it, and whatever stale value another automation
    // last wrote (e.g. a raw Margin figure from a different round) stuck
    // — his exact symptom: accepting Seller B (VAT0) left Custom Offer
    // at 210 with VAT Type Margin. Mirrors store-accept's proven logic:
    // this is a store-placed round (the seller is accepting the store's
    // counter), so the accepted store price is "Store Counter Price"
    // directly, and the VAT type follows the seller's own type / the
    // client-country rule. sellerVatTypeForAccept / orderFieldsForAccept
    // computed here for the write below.
    const orderFieldsForAccept = orderRecord.fields || {};
    const sellerVatTypeForAccept = asText(f["Seller Original VAT Type"]);
    const acceptedStorePrice = numberValue(f["Store Counter Price"]);
    const offerVatTypeForAcceptWrite =
      sellerVatTypeForAccept === "Margin"
        ? "Margin"
        : (isDutchClientCountry(orderFieldsForAccept?.["Client Country"]) ? "VAT21" : "VAT0");


    try {
      if (Number.isFinite(acceptedStorePrice) && acceptedStorePrice > 0) {
        await airtable(ORDERS_TABLE).update(linkedOrderId, {
          "Custom Offer": acceptedStorePrice,
          "Offer VAT Type": offerVatTypeForAcceptWrite,
          "Offer Accepted?": true,
          "Offer Sent?": false
        });
      } else {
        console.error("Could not compute a valid accepted store price to write back for order:", linkedOrderId);
      }
    } catch (writeErr) {
      console.error("Failed to write Custom Offer on seller-accept (non-blocking):", writeErr);
    }

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
          "Brand (MWTB)",
          "Denied?",
          "Withdrawn?"
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

    // FIXED — a Seller Offer's own "Fulfillment Status" stays
    // "Outsource" for the entire duration of a counter-offer
    // negotiation (it only changes at final accept/deny), so this
    // endpoint kept showing it as "still fresh" even after a counter
    // chain had already started on it — causing the SAME item to show
    // in both Open (from here) and Countered (from wtb-counter-offers)
    // at once. Excludes any Seller Offer that already has a currently-
    // open Counter Offers record referencing it.
    const activeCounterFormula = `AND(
      {Status} = 'Open',
      OR({Source Type} = 'Seller Offer', {Source Type} = 'Member WTB')
    )`;
    const activeCounterRecords = await airtable(COUNTER_OFFERS_TABLE)
      .select({ filterByFormula: activeCounterFormula, fields: ["Seller Offer Record ID", "Order", "Member WTB", "Seller ID"] })
      .all();
    const sellerOfferIdsWithActiveCounter = new Set(
      activeCounterRecords
        .map((r) => asText(r.fields?.["Seller Offer Record ID"]))
        .filter(Boolean)
    );
    // FIXED — "Seller Offer Record ID" is only reliably set on a
    // round's very first row (round 1) — every subsequent counter
    // round (seller-counter or store-counter) never carried it
    // forward, so this exclusion alone missed anything past round 1,
    // showing the same order in both Open and Countered at once. Now
    // also cross-references by Order+Seller, which every round always
    // has set correctly, covering existing records too (not just ones
    // created after the carry-forward fix above).
    const orderSellerKeysWithActiveCounter = new Set(
      activeCounterRecords
        .map((r) => {
          const orderId = firstLinkedRecordId(r.fields?.["Order"]) || firstLinkedRecordId(r.fields?.["Member WTB"]);
          const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
          return orderId && sellerId ? `${orderId}::${sellerId}` : null;
        })
        .filter(Boolean)
    );

    const filteredOffersWithoutActiveCounter = filteredOffers.filter((record) => {
      const f = record.fields || {};

      // FIXED — a Seller Offer explicitly marked "Denied?" (via the
      // structured-denial fix) was still matching this endpoint's own
      // "Fulfillment Status = Outsource" filter (the order itself can
      // stay Outsource for other sellers even after denying this one),
      // so a denied offer kept showing in Open too, alongside Denied.
      if (f["Denied?"]) return false;

      // NEW — additive only: a soft-deleted ("Withdrawn?") Seller
      // Offer must never show in the Portal at all — it only survives
      // physically so discord-wtb-bot-main's undercut-check can still
      // validate a future re-offer against it.
      if (f["Withdrawn?"]) return false;

      if (sellerOfferIdsWithActiveCounter.has(record.id)) return false;

      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]) || firstLinkedRecordId(f["Member WTBs"]);
      const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);
      const key = linkedOrderId && linkedSellerId ? `${linkedOrderId}::${linkedSellerId}` : null;

      return !(key && orderSellerKeysWithActiveCounter.has(key));
    });

    const linkedOrderIds = [
      ...new Set(
        filteredOffersWithoutActiveCounter
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const items = await Promise.all(filteredOffersWithoutActiveCounter.map(async (record) => {
      const f = record.fields || {};
      const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
      const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);
      const isMemberWtb = !!linkedMemberWtbId;
      const linkedSellerId = firstLinkedRecordId(f["Seller ID"]);

      const orderFields = orderMap.get(linkedOrderId) || {};

      const vatType = displayValue(f["Offer VAT Type"]);
      const offerAmount = numberValue(f["Seller Offer"]);

      // FIXED — "Current Lowest Offer (MWTB)"/"Current Lowest Source
      // Price (MWTB)" are Airtable rollups sourced from the raw Seller
      // Offers table only — the exact same staleness pattern found and
      // fixed elsewhere this session: they never reflect anyone's
      // ACTIVE Counter Offers position, only their original, un-
      // countered listing. A seller who'd already countered down still
      // showed their old, higher raw price here. Reuses the already-
      // proven live computation instead — correctly accounts for every
      // seller's actual current position (their live counter if they
      // have one, else their raw offer).
      let currentLowest;
      let isLowest;

      if (isMemberWtb) {
        const normalize = (price, vt) => {
          const p = Number(price);
          if (!Number.isFinite(p)) return null;
          return asText(vt) === "VAT0" ? p * 1.21 : p;
        };
        const othersResult = await getCurrentGlobalLowestNormalized("Member WTB", linkedMemberWtbId, linkedSellerId);
        const othersMin = othersResult.normalized;
        const ownNormalized = normalize(offerAmount, vatType);

        // FIXED — this converted the winning NORMALIZED value back to
        // seller-payout scale (dividing by 1.21 for non-VAT21), which
        // is the wrong target entirely — this column is meant to show
        // the current best price in BUYER-FACING terms (what the
        // market is currently offering), matching what the Discord
        // embed and the Buying portal both correctly show. Now
        // identifies WHICH position actually wins (his own raw offer,
        // or whichever other seller's raw price/VAT type
        // getCurrentGlobalLowestNormalized already tracked) and runs
        // THAT through the real buyer-facing conversion.
        const ownWins = Number.isFinite(ownNormalized) && (!Number.isFinite(othersMin) || ownNormalized <= othersMin);
        const winningRaw = ownWins ? offerAmount : othersResult.raw;
        const winningVatType = ownWins ? vatType : othersResult.vatType;

        if (Number.isFinite(winningRaw)) {
          const wtbRecordForBuyerPrice = await airtable(MEMBER_WTBS_TABLE).find(linkedMemberWtbId).catch(() => null);
          const wtbFieldsForBuyerPrice = wtbRecordForBuyerPrice?.fields || {};
          currentLowest = calculateMemberWtbBuyerEquivalent(winningRaw, winningVatType, wtbFieldsForBuyerPrice);
        } else {
          currentLowest = null;
        }
        isLowest = ownWins;
      } else {
        // FIXED — a real, confirmed bug found via his live testing:
        // the exact same stale-rollup pattern already fixed elsewhere
        // today, just never applied to THIS endpoint (a separate,
        // parallel implementation of the same "current lowest"
        // concept for Store Orders' fresh/open offers). Reuses the
        // same live, already-proven getCurrentGlobalLowestNormalized
        // function the Member WTB branch right above already calls,
        // instead of the stale "Current Lowest (VAT0)/(Normalized)"
        // rollup fields and the separate stale "Lowest Offer Seller
        // ID" field. De-normalizes the winning shared-scale value back
        // into THIS seller's own vatType before display (only VAT0
        // needs the /1.21 reversal — VAT21/Margin are already on that
        // scale).
        const othersResultForOrder = await getCurrentGlobalLowestNormalized("Seller Offer", linkedOrderId, linkedSellerId);
        const othersMinForOrder = othersResultForOrder.normalized;
        const ownNormalizedForOrder = asText(vatType) === "VAT0" ? offerAmount * 1.21 : offerAmount;

        const ownWinsForOrder = Number.isFinite(ownNormalizedForOrder) && (!Number.isFinite(othersMinForOrder) || ownNormalizedForOrder <= othersMinForOrder);
        const winningSharedForOrder = ownWinsForOrder ? ownNormalizedForOrder : othersMinForOrder;

        currentLowest = Number.isFinite(winningSharedForOrder)
          ? (asText(vatType) === "VAT0" ? winningSharedForOrder / 1.21 : winningSharedForOrder)
          : null;
        isLowest = ownWinsForOrder;
      }

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
        offer: moneySmartValue(offerAmount),
        offer_raw: offerAmount,
        vat_type: vatType,
        current_lowest: Number.isFinite(currentLowest) ? moneySmartValue(currentLowest) : null,
        status: isLowest ? "Lowest" : "Beaten",
        date: formatDateEU(f["Offer Date"]),
        raw_date: f["Offer Date"]
      };
    }));

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

    // FIXED — now uses the shared cascade helper (see
    // cascadeDeleteWtbNegotiation above) instead of only deleting this
    // one Seller Offer record. Withdrawing an offer must clean up the
    // WHOLE negotiation history tied to it — any Counter Offers rounds
    // that ever existed for it too — not leave stray rounds that
    // reappear across pills afterward. Also still clears the linked
    // Order's stale "Lowest Offer" so the next genuine offer isn't
    // incorrectly compared against a now-defunct number.
    await cascadeDeleteWtbNegotiation({ seedSellerOfferId: offerId, sellerRecordId });

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
          "Date",
          "Buyer VAT ID",
          "Buyer Country"
        ],
        filterByFormula: `OR(
          {Fulfillment Status} = 'Pending',
          {Fulfillment Status} = 'Outsource'
        )`
      })
      .all();

    const relevantMemberWtbIds = records
      .filter((record) => linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId))
      .map((r) => r.id);

    // FIXED — a real, confirmed bug, same root cause as buying-offers:
    // this only ever looked at raw Seller Offers table prices, never
    // accounting for anyone's ACTIVE counter position — so a seller
    // who'd already countered down to a genuinely better price than
    // everyone's raw asks still showed the WORSE raw number here. Now
    // reuses the proven cross-seller helper, which correctly picks up
    // Counter Payout for anyone mid-negotiation.
    const winningPositionByWtbId = new Map();
    await Promise.all(
      relevantMemberWtbIds.map(async (wtbId) => {
        const result = await getCurrentGlobalLowestNormalized("Member WTB", wtbId, null);
        if (Number.isFinite(result.raw)) {
          winningPositionByWtbId.set(wtbId, { price: result.raw, vatType: result.vatType });
        }
      })
    );

    const items = records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId)
      )
      .map((record) => {
        const f = record.fields || {};
        const winningSellerOffer = winningPositionByWtbId.get(record.id);

        const currentLowest = winningSellerOffer
          ? calculateMemberWtbBuyerEquivalent(winningSellerOffer.price, winningSellerOffer.vatType, f)
          : numberValue(f["Current Lowest Offer"]);

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
            ? moneySmartValue(currentLowest)
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

// ---------------------------------------------------------------------
// NEW — additive only: mirror of wtb-counter-offers, but from the
// BUYER's (Member's) side of a Member WTB negotiation instead of the
// seller's. Same underlying Counter Offers table and fields — a buyer
// plays the "Store" role there (Store Counter Price = the BUYER's
// counter), a seller plays the "Seller" role (Seller Counter Price =
// the SELLER's counter) — so the pill logic is the exact opposite of
// wtb-counter-offers: "open" here means the SELLER just moved (Seller
// Counter Price populated, buyer must respond); "countered" means the
// BUYER's own pending counter (Store Counter Price populated, no
// Seller Counter Price on this round yet).
// ---------------------------------------------------------------------
app.get("/api/dashboard/buying-counter-offers", async (req, res) => {
  try {
    const buyerSellerRecordId = asText(req.query.seller_record_id);
    const filter = asText(req.query.filter) || "open";

    if (!buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing seller_record_id" });
    }

    const myMemberWtbs = await airtable(MEMBER_WTBS_TABLE)
      .select({
        fields: [
          "Buyer Seller ID",
          "Member WTB ID",
          "Product Name",
          "SKU",
          "Size",
          "Brand",
          "Buyer VAT ID",
          "Buyer Country",
          "Max Price"
        ]
      })
      .all()
      .then((records) =>
        records.filter((r) => linkedRecordIncludes(r.fields?.["Buyer Seller ID"], buyerSellerRecordId))
      );

    const myMemberWtbIds = new Set(myMemberWtbs.map((r) => r.id));

    if (!myMemberWtbIds.size) {
      return res.json({ count: 0, items: [] });
    }

    const statusFormula = filter === "denied" ? `{Status} = 'Denied'` : `{Status} = 'Open'`;

    const records = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND(${statusFormula}, {Source Type} = 'Member WTB')`
      })
      .all()
      .then((records) =>
        records.filter((r) => myMemberWtbIds.has(firstLinkedRecordId(r.fields?.["Member WTB"])))
      );

    const preFilteredByStatusRaw = records.filter((record) => {
      if (filter === "denied") return true;

      const f = record.fields || {};
      const sellerAlreadyCountered =
        f["Seller Counter Price"] !== undefined &&
        f["Seller Counter Price"] !== null &&
        f["Seller Counter Price"] !== "";

      // "open" wants rows where the SELLER just moved (buyer must
      // respond); "countered" wants the opposite — the buyer's own
      // pending counter, awaiting the seller.
      return filter === "open" ? sellerAlreadyCountered : !sellerAlreadyCountered;
    });

    // Same supersession-exclusion fix as wtb-counter-offers: a denied
    // round that's been superseded by a later sibling (same Previous
    // Record ID) shouldn't keep showing forever.
    let preFilteredByStatus = preFilteredByStatusRaw;

    if (filter === "denied" && preFilteredByStatusRaw.length) {
      const allRoundsForMyWtbs = await airtable(COUNTER_OFFERS_TABLE)
        .select({
          filterByFormula: `{Source Type} = 'Member WTB'`,
          fields: ["Member WTB", "Previous Record ID", "Created At"]
        })
        .all()
        .then((records) =>
          records.filter((r) => myMemberWtbIds.has(firstLinkedRecordId(r.fields?.["Member WTB"])))
        );

      const siblingsByPrevId = new Map();
      for (const r of allRoundsForMyWtbs) {
        const prevId = firstLinkedRecordId(r.fields?.["Previous Record ID"]);
        if (!prevId) continue;
        if (!siblingsByPrevId.has(prevId)) siblingsByPrevId.set(prevId, []);
        siblingsByPrevId.get(prevId).push({
          id: r.id,
          createdAt: displayValue(r.fields?.["Created At"])
        });
      }

      preFilteredByStatus = preFilteredByStatusRaw.filter((record) => {
        const f = record.fields || {};
        const ownPrevId = firstLinkedRecordId(f["Previous Record ID"]);
        const ownCreatedAt = displayValue(f["Created At"]);

        if (!ownPrevId) return true;

        const siblings = siblingsByPrevId.get(ownPrevId) || [];
        const hasLaterSibling = siblings.some(
          (s) => s.id !== record.id && s.createdAt && ownCreatedAt && s.createdAt > ownCreatedAt
        );

        return !hasLaterSibling;
      });
    }

    // Same "only Delete or no-longer-Outsource makes it disappear"
    // rule — excludes anything whose Member WTB is no longer Outsource.
    const memberWtbStatusMap = new Map(myMemberWtbs.map((r) => [r.id, asText(r.fields?.["Fulfillment Status"])]));
    const freshMemberWtbStatuses = await airtable(MEMBER_WTBS_TABLE)
      .select({
        filterByFormula: `OR(${[...myMemberWtbIds].map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`).join(",")})`,
        fields: ["Fulfillment Status"]
      })
      .all()
      .catch(() => []);
    freshMemberWtbStatuses.forEach((r) => memberWtbStatusMap.set(r.id, asText(r.fields?.["Fulfillment Status"])));

    const preFiltered = preFilteredByStatus.filter((record) => {
      const memberWtbId = firstLinkedRecordId(record.fields?.["Member WTB"]);
      return memberWtbStatusMap.get(memberWtbId) === "Outsource";
    });

    const previousIds = [...new Set(preFiltered.map((r) => firstLinkedRecordId(r.fields?.["Previous Record ID"])).filter(Boolean))];

    let previousSellerCounterById = new Map();
    let previousBuyerCounterById = new Map();
    if (previousIds.length) {
      const previousFormula = `OR(${previousIds.map((id) => `RECORD_ID() = '${escapeFormulaValue(id)}'`).join(",")})`;
      const previousRecords = await airtable(COUNTER_OFFERS_TABLE)
        .select({ filterByFormula: previousFormula, fields: ["Seller Counter Price", "Seller Original Price", "Seller Original VAT Type", "Store Counter Price"] })
        .all();
      // FIXED — same underlying issue as the Consignment €0.00 bug:
      // numberValue() always returns a finite number (0 for a blank
      // field), so Number.isFinite(numberValue(x)) is ALWAYS true —
      // the intended fallback to "Seller Original Price" never
      // actually ran. This specifically breaks a prior round that was
      // itself a genuine round-1 seller offer (never countered, so
      // "Seller Counter Price" is blank) — showed €0.00 there instead
      // of correctly falling back. Now checks the value is genuinely
      // positive before using it.
      previousSellerCounterById = new Map(
        previousRecords.map((r) => {
          const sellerCounter = numberValue(r.fields?.["Seller Counter Price"]);
          return [
            r.id,
            sellerCounter > 0 ? sellerCounter : numberValue(r.fields?.["Seller Original Price"])
          ];
        })
      );
      // NEW — additive only: his request — Open needs a "My Last
      // Offer" column showing the buyer's own prior counter (from the
      // round before this one), so they can weigh a fresh seller
      // counter against what they last offered.
      previousBuyerCounterById = new Map(
        previousRecords.map((r) => [r.id, numberValue(r.fields?.["Store Counter Price"])])
      );
    }

    const memberWtbFieldsById = new Map(myMemberWtbs.map((r) => [r.id, r.fields || {}]));

    const items = await Promise.all(preFiltered.map(async (record) => {
      const f = record.fields || {};
      const memberWtbId = firstLinkedRecordId(f["Member WTB"]);
      const wtbFields = memberWtbFieldsById.get(memberWtbId) || {};
      const vatType = asText(f["Seller Original VAT Type"]);

      const previousOfferId = firstLinkedRecordId(f["Previous Record ID"]);

      // FIXED — Number.isFinite(numberValue(x)) is always true (the
      // same anti-pattern found and fixed elsewhere), so "myOffer"
      // here was always this round's own Store Counter Price even
      // when genuinely blank (a seller_counter round, where the
      // SELLER just moved and this round never carries the buyer's
      // own price) — showing €0.00 instead of correctly falling back
      // to the buyer's actual last position on the prior round.
      const ownStoreCounter = numberValue(f["Store Counter Price"]);
      const myLastOffer = ownStoreCounter > 0
        ? ownStoreCounter
        : (previousOfferId ? previousBuyerCounterById.get(previousOfferId) : null);

      // FIXED — this used to only look ONE hop back via
      // previousSellerCounterById (the round's own Previous Record
      // ID), which misses a seller's true position after MULTIPLE
      // supersessions (e.g. their round got closed/denied, then the
      // buyer's later counter superseded it again before they could
      // even respond) — same class of staleness bug already fixed
      // elsewhere via the shared chain-walking helper, just never
      // applied to this specific "Seller's Last Offer" computation.
      const sellerCounter = numberValue(f["Seller Counter Price"]);
      let sellersOffer;
      if (sellerCounter > 0) {
        sellersOffer = sellerCounter;
      } else {
        const chainTraced = await findSellersTrueLastCounter(record.id);
        sellersOffer = chainTraced ?? numberValue(f["Seller Original Price"]);
      }

      const sellersOfferInBuyerTerms = calculateMemberWtbBuyerEquivalent(sellersOffer, vatType, wtbFields);

      return {
        id: record.id,
        member_wtb_record_id: memberWtbId,
        seller_offer_record_id: asText(f["Seller Offer Record ID"]),
        order_id: asText(wtbFields["Member WTB ID"]) || memberWtbId,
        product: asText(wtbFields["Product Name"]),
        sku: asText(wtbFields["SKU"]),
        size: asText(wtbFields["Size"]),
        brand: asText(wtbFields["Brand"]),
        // FIXED — Max Price was already being fetched (via wtbFields)
        // but never actually included in the returned item, so it
        // always showed "-" in the Portal once an item moved past the
        // "fresh" stage (which gets it from a different endpoint).
        max_price: Number.isFinite(numberValue(wtbFields["Max Price"])) ? moneyWholeValue(wtbFields["Max Price"]) : null,
        my_offer: Number.isFinite(myLastOffer) && myLastOffer > 0 ? moneySmartValue(myLastOffer) : null,
        sellers_offer: Number.isFinite(sellersOfferInBuyerTerms) ? moneySmartValue(sellersOfferInBuyerTerms) : null,
        // NEW — additive only: raw seller-payout-scale value (not the
        // buyer-facing display price above) for the Accept button to
        // submit as override_price — matches exactly what the "Counter
        // Payout" field itself is computed with, so accepting always
        // honors the actual negotiated position instead of silently
        // falling back to the seller's raw, un-negotiated listing.
        // FIXED — this ran sellersOffer through calculateMemberWtbSellerPayout,
        // which expects a BUYER-facing price as input (it strips margin+VAT
        // to get what the seller receives). But sellersOffer is ALWAYS
        // already a seller-native raw number (from Seller Counter Price or
        // Seller Original Price) — never buyer-facing — so this was
        // silently double-converting: stripping margin+VAT from a number
        // that was never buyer-facing to begin with. E.g. a seller's own
        // untouched original ask of €80 became €67.90 instead of staying
        // €80. The raw seller-scale value IS the correct override_price
        // directly, no conversion needed.
        sellers_offer_payout: Number.isFinite(sellersOffer) ? sellersOffer : null,
        vat_type: vatType,
        previous_record_id: previousOfferId,
        previous_seller_counter: previousOfferId && Number.isFinite(previousSellerCounterById.get(previousOfferId))
          ? moneySmartValue(previousSellerCounterById.get(previousOfferId))
          : null,
        previous_seller_counter_payout: previousOfferId && Number.isFinite(previousSellerCounterById.get(previousOfferId))
          ? previousSellerCounterById.get(previousOfferId)
          : null,
        raw_date: asText(f["Created At"]),
        denied_at: asText(f["Denied At"] || f["Last Modified"]),
        // Kept only for the visibility filter right below — not part
        // of the response shape.
        __sellerId: firstLinkedRecordId(f["Seller ID"])
      };
    }));

    // NEW — additive only: his explicit request — the buyer should
    // only ever see the SINGLE best available position, never two
    // parallel threads. Without this, an "open" item (either a
    // seller's own counter-back, or the buyer's own pending counter)
    // kept showing even after a genuinely better position appeared
    // from a completely different seller — which is exactly what
    // should make THIS item disappear, as if that other seller's
    // position had simply replaced it.
    // FIXED — this used to explicitly SKIP the "denied" filter,
    // showing every denied seller side by side. His exact reasoning:
    // the buyer/store should always feel like they're negotiating
    // with just ONE seller — seeing two (or more) Denied rows at once
    // breaks that illusion and gets confusing fast, especially across
    // several WTBs at once. getCurrentGlobalLowestNormalized already
    // chain-traces through Denied rounds too (fixed earlier this
    // session), so this comparison correctly finds each seller's TRUE
    // position regardless of their round's current status — applying
    // the same filter to Denied now just works, no separate logic
    // needed.
    const visibleItems = await Promise.all(
      items.map(async (item) => {
        // FIXED — a real, confirmed bug: this checked "does
        // ANY value exist from other sellers" instead of "is
        // that value actually BETTER than this item's own
        // position" — so a WORSE fresh offer from another
        // seller (e.g. seller B's raw 90) incorrectly hid
        // seller A's genuinely-better counter-back (87), just
        // because 90 was *a* number, not because it beat 87.
        const betterElsewhere = (await getCurrentGlobalLowestNormalized(
          "Member WTB",
          item.member_wtb_record_id,
          item.__sellerId
        )).normalized;
        if (!Number.isFinite(betterElsewhere)) return item;

        const ownRawPrice = item.sellers_offer_payout;
        const ownVatType = item.vat_type;
        const ownNormalized = Number.isFinite(Number(ownRawPrice))
          ? (asText(ownVatType) === "VAT0" ? Number(ownRawPrice) * 1.21 : Number(ownRawPrice))
          : null;

        if (ownNormalized == null) return item; // can't compare — don't hide

        return betterElsewhere < ownNormalized ? null : item;
      })
    ).then((results) => results.filter(Boolean));

    const finalItems = visibleItems.map(({ __sellerId, ...rest }) => rest);

    // NEW — additive only: a real, confirmed gap found via his live
    // testing — a fresh, never-countered offer denied via
    // /api/dashboard/buying-offers/:id/deny (the "fresh_no_floor" deny
    // path) only ever marked the underlying Seller Offer as Denied? —
    // this endpoint reads exclusively from the Counter Offers table,
    // so that denial had nowhere to surface for the BUYER. His exact
    // expectation: it must show up here too, in the buyer's own
    // Denied pill, with Accept (the seller's original ask), Counter
    // (a fresh first counter), and Delete — mirroring exactly the
    // same "fresh_denied" pattern already proven for the SELLER's own
    // wtb-counter-offers Denied pill.
    let mergedFinalItems = finalItems;

    if (filter === "denied") {
      const deniedSellerOfferRecordsRaw = await airtable(SELLER_OFFERS_TABLE)
        .select({ filterByFormula: `{Denied?} = TRUE()`, fields: ["Member WTBs", "Seller ID", "Seller Offer", "Offer VAT Type", "Denied At", "Withdrawn?"] })
        .all()
        .then((records) =>
          records.filter(
            (r) =>
              !r.fields?.["Withdrawn?"] &&
              myMemberWtbIds.has(firstLinkedRecordId(r.fields?.["Member WTBs"]))
          )
        );

      // NEW — additive only: his explicit catch — since a Deny on a
      // fresh offer now denies every OTHER untouched fresh seller on
      // the same WTB too (not just the one clicked), a WTB can have
      // several simultaneously-denied Seller Offer records. Without
      // this, the buyer's Denied pill showed one row per denied
      // record instead of one row per WTB — same "pick the single
      // best" collapse already proven for the Open pill's fresh
      // offers (winningSellerOfferByWtbId above), same raw-price
      // comparison for consistency.
      const bestDeniedByWtbId = new Map();
      for (const record of deniedSellerOfferRecordsRaw) {
        const wtbId = firstLinkedRecordId(record.fields?.["Member WTBs"]);
        const price = numberValue(record.fields?.["Seller Offer"]);
        if (!wtbId || !Number.isFinite(price)) continue;

        const current = bestDeniedByWtbId.get(wtbId);
        if (!current || price < numberValue(current.fields?.["Seller Offer"])) {
          bestDeniedByWtbId.set(wtbId, record);
        }
      }

      const deniedSellerOfferRecords = Array.from(bestDeniedByWtbId.values());

      const freshDeniedItems = deniedSellerOfferRecords.map((record) => {
        const f = record.fields || {};
        const memberWtbId = firstLinkedRecordId(f["Member WTBs"]);
        const wtbFields = memberWtbFieldsById.get(memberWtbId) || {};
        const rawSellerAsk = numberValue(f["Seller Offer"]);
        const vatType = asText(f["Offer VAT Type"]);
        const sellersOfferInBuyerTerms = calculateMemberWtbBuyerEquivalent(rawSellerAsk, vatType, wtbFields);

        return {
          id: record.id,
          _kind: "fresh_denied",
          member_wtb_record_id: memberWtbId,
          seller_offer_record_id: record.id,
          order_id: asText(wtbFields["Member WTB ID"]) || memberWtbId,
          product: asText(wtbFields["Product Name"]),
          sku: asText(wtbFields["SKU"]),
          size: asText(wtbFields["Size"]),
          brand: asText(wtbFields["Brand"]),
          max_price: Number.isFinite(numberValue(wtbFields["Max Price"])) ? moneyWholeValue(wtbFields["Max Price"]) : null,
          sellers_offer: Number.isFinite(sellersOfferInBuyerTerms) ? moneySmartValue(sellersOfferInBuyerTerms) : null,
          sellers_offer_payout: Number.isFinite(rawSellerAsk) ? rawSellerAsk : null,
          vat_type: vatType,
          raw_date: asText(f["Denied At"]),
          denied_at: asText(f["Denied At"])
        };
      });

      mergedFinalItems = [...finalItems, ...freshDeniedItems];
    }

    res.json({
      count: mergedFinalItems.length,
      items: sortDashboardItemsNewestFirst(mergedFinalItems)
    });
  } catch (err) {
    console.error("Failed to load buying counter offers:", err);
    res.status(500).json({
      error: "Failed to load buying counter offers",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: mirror of closeCompetingCountersForOrder, keyed
// by Member WTB instead of Order — closes every other seller's open
// counter on the SAME Member WTB once the buyer accepts one.
// ---------------------------------------------------------------------
async function closeCompetingCountersForMemberWtb(memberWtbRecordId, acceptedCounterOfferRecordId) {
  const openCounters = await airtable(COUNTER_OFFERS_TABLE)
    .select({
      filterByFormula: `AND(
        {Status} = 'Open',
        {Source Type} = 'Member WTB',
        RECORD_ID() != '${acceptedCounterOfferRecordId}'
      )`
    })
    .all();

  const competingCounters = openCounters.filter((r) =>
    firstLinkedRecordId(r.fields?.["Member WTB"]) === memberWtbRecordId
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
        "❌ Offer closed — you accepted another seller."
      ).catch((err) => console.error("Failed to disable competing counter's Discord buttons (non-blocking):", err));
    }
  }
}

// NEW — additive only: buyer accepts the seller's current position on
// this round (Open pill). Mirrors member_wtb_buyer_counter_accept:.
app.post("/api/dashboard/buying-counter-offers/:offerId/buyer-accept", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);

    if (!counterOfferRecordId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const counterOffer = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const f = counterOffer.fields || {};

    const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (asText(f["Status"]) !== "Open") {
      return res.status(409).json({ error: "This offer is no longer available." });
    }

    const sellerOfferRecordId = asText(f["Seller Offer Record ID"]);
    const acceptedPayout = numberValue(f["Seller Counter Price"]);
    const acceptedVatType = asText(f["Seller Original VAT Type"]);

    if (!sellerOfferRecordId) {
      return res.status(500).json({ error: "Missing linked Seller Offer" });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Accepted",
      "Accepted At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    const wtbBotBaseUrl = KICKZ_WTB_BOT_BASE_URL || DISCORD_BOT_BASE_URL;

    if (!wtbBotBaseUrl) {
      return res.status(500).json({ error: "KICKZ_WTB_BOT_BASE_URL is missing" });
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
      return res.status(response.status).json({ error: data.error || "Failed to accept offer" });
    }

    await closeCompetingCountersForMemberWtb(memberWtbRecordId, counterOfferRecordId).catch((err) =>
      console.error("Failed to close competing counters (non-blocking):", err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to accept buying counter offer:", err);
    res.status(500).json({ error: "Failed to accept offer", details: err.message });
  }
});

// NEW — additive only: buyer denies the seller's current position on
// this round — reopens the prior round if there is one, matching
// member_wtb_counter_deny:'s reopen behavior (that one is the SELLER
// denying the BUYER; this is the reverse).
app.post("/api/dashboard/buying-counter-offers/:offerId/buyer-deny", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);

    if (!counterOfferRecordId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(counterOfferRecordId);
    const deniedFields = deniedRecord.fields || {};

    const memberWtbRecordId = firstLinkedRecordId(deniedFields["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (asText(deniedFields["Status"]) !== "Open") {
      return res.status(409).json({ error: "This offer is no longer available." });
    }

    await airtable(COUNTER_OFFERS_TABLE).update(counterOfferRecordId, {
      "Status": "Denied",
      "Denied At": new Date().toISOString(),
      "Closed At": new Date().toISOString()
    });

    const priorRoundId = asText(deniedFields["Previous Record ID"]);

    if (priorRoundId) {
      const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId).catch(() => null);

      if (priorRound) {
        await airtable(COUNTER_OFFERS_TABLE).update(priorRoundId, { "Status": "Open" });

        const priorFields = priorRound.fields || {};
        const sellerRecordId = firstLinkedRecordId(priorFields["Seller ID"]);
        const sellerRecord = sellerRecordId ? await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null) : null;
        const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);

        if (sellerDiscordId && AIRTABLE_DISCORD_UPDATES_URL) {
          await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trigger_type: "member-wtb-counter-denied-reopened",
              counter_offer_record_id: priorRoundId,
              product_name: asText(deniedFields["Product Name"]),
              sku: asText(deniedFields["SKU"]),
              size: asText(deniedFields["Size"]),
              denied_price: numberValue(deniedFields["Seller Counter Price"])
            })
          }).catch((err) => console.error("Failed to notify seller of reopened round (non-blocking):", err));
        }

        // FIXED — a real, confirmed gap found via his live testing: this
        // only ever reopened THIS ONE seller's own prior round — every
        // OTHER seller still in the game (e.g. a seller with their own
        // pending counter still awaiting the buyer, or a fresh, never-
        // engaged seller) heard nothing at all. His exact point: denying
        // the CURRENTLY-LOWEST seller is effectively a "no" to everyone,
        // since if the buyer won't accept the lowest, they won't accept
        // anything higher either. Broadcasts to every OTHER seller too,
        // using the buyer's real floor (not just this one denied price,
        // in case they've offered higher elsewhere before) — same
        // deny-styled notification as the fresh-offer deny flow.
        const buyerFloorForBroadcast = await getBuyerHighestEverPosition("Member WTB", memberWtbRecordId);

        if (Number.isFinite(buyerFloorForBroadcast) && buyerFloorForBroadcast > 0) {
          await reengageDeniedSellers({
            sourceType: "Member WTB",
            recordId: memberWtbRecordId,
            newBuyerCounterPrice: buyerFloorForBroadcast,
            excludeSellerId: sellerRecordId,
            isDenyBroadcast: true
          }).catch((err) => console.error("Failed to broadcast buyer floor to other sellers after deny (non-blocking):", err));
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to deny buying counter offer:", err);
    res.status(500).json({ error: "Failed to deny offer", details: err.message });
  }
});

// NEW — additive only: Portal-safe wrapper for the buyer placing a
// counter on the seller's current position. Checks ownership
// (buyer_record_id must match this Member WTB's buyer) then calls the
// existing secret-protected /api/member-wtb-counter-offers/:id/buyer-
// counter internally, same pattern as the WTB seller-counter wrapper.
app.post("/api/dashboard/buying-counter-offers/:offerId/buyer-counter", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);
    const price = req.body?.price;

    if (!offerId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const memberWtbRecordId = firstLinkedRecordId(record.fields?.["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const response = await fetch(`http://localhost:${PORT}/api/member-wtb-counter-offers/${offerId}/buyer-counter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
      },
      body: JSON.stringify({ price })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Failed to submit buying counter:", err);
    res.status(500).json({ error: "Failed to submit counter", details: err.message });
  }
});

// NEW — additive only: Portal-safe wrapper for the buyer editing their
// own already-placed counter (raise it), same ownership-check pattern.
app.post("/api/dashboard/buying-counter-offers/:offerId/buyer-edit", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);
    const price = req.body?.price;

    if (!offerId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const memberWtbRecordId = firstLinkedRecordId(record.fields?.["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const response = await fetch(`http://localhost:${PORT}/api/member-wtb-counter-offers/${offerId}/edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
      },
      body: JSON.stringify({ price })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Failed to edit buying counter:", err);
    res.status(500).json({ error: "Failed to edit counter", details: err.message });
  }
});

// NEW — additive only: mirror of WTB's retry-counter, for a buyer's
// counter that dead-ended in denial (no reopen happened). Validates
// the new price using the same narrowing-band rule against the
// seller's last real position — his requirement: the retry must never
// go lower than what the seller had already asked for.
app.post("/api/dashboard/buying-counter-offers/:offerId/retry-counter", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);
    const proposedPrice = Number(req.body?.price);

    if (!offerId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    if (!Number.isInteger(proposedPrice) || proposedPrice <= 0) {
      return res.status(400).json({ error: "Offer must be a valid whole number." });
    }

    const deniedRecord = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const f = deniedRecord.fields || {};

    const memberWtbRecordId = firstLinkedRecordId(f["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const priorRoundId = firstLinkedRecordId(f["Previous Record ID"]);

    if (!priorRoundId) {
      return res.status(409).json({ error: "There's no prior position to retry against." });
    }

    const priorRound = await airtable(COUNTER_OFFERS_TABLE).find(priorRoundId);
    const priorFields = priorRound.fields || {};

    // FIXED — a real, confirmed bug found via his live testing: this
    // endpoint had never received the fixes applied to the main
    // seller-counter/buyer-counter endpoints. Three separate issues:
    // (1) sellerLastPosition only looked ONE hop back (this round's
    // own Previous Record ID), missing the seller's TRUE last
    // position after multiple supersessions — now chain-traces via
    // the shared helper; (2) sellerLastPosition (seller-scale) and
    // deniedBuyerCounter (buyer-scale) were compared directly with no
    // conversion — now converts the seller's true position to
    // buyer-facing terms first, so both sides of the comparison are
    // on the same scale; (3) no cross-seller ceiling was applied at
    // all, so a retry could pass this endpoint's own band check even
    // when a genuinely BETTER seller elsewhere made the retry
    // pointless — now folds that in too, matching the seller-side
    // fix.
    const sellerLastPositionRaw = await findSellersTrueLastCounter(priorRoundId);
    const sellerLastPosition = Number.isFinite(sellerLastPositionRaw) && sellerLastPositionRaw > 0
      ? sellerLastPositionRaw
      : numberValue(priorFields["Seller Original Price"]);
    const sellerVatTypeForRetry = asText(priorFields["Seller Original VAT Type"] || f["Seller Original VAT Type"]);
    const deniedBuyerCounter = numberValue(f["Store Counter Price"]);

    if (!Number.isFinite(sellerLastPosition) || !Number.isFinite(deniedBuyerCounter)) {
      return res.status(500).json({ error: "Missing price data to validate against." });
    }

    const sellerLastPositionInBuyerTerms = calculateMemberWtbBuyerEquivalent(
      sellerLastPosition,
      sellerVatTypeForRetry,
      memberWtb.fields || {}
    );

    if (!Number.isFinite(sellerLastPositionInBuyerTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this WTB." });
    }

    // Cross-seller ceiling — is there a DIFFERENT, genuinely better
    // seller the buyer should be aiming for instead? Computed in
    // seller-payout scale (matching getCurrentGlobalLowestNormalized's
    // native output), then converted to buyer-facing terms for a
    // consistent comparison here.
    const thisSellerId = firstLinkedRecordId(f["Seller ID"]);
    const globalLowestForRetry = (await getCurrentGlobalLowestNormalized("Member WTB", memberWtbRecordId, thisSellerId)).normalized;
    let crossSellerCeilingBuyerTerms = null;
    if (Number.isFinite(globalLowestForRetry)) {
      // globalLowestForRetry is already normalized (VAT21-equivalent,
      // seller-payout scale) across every OTHER seller — convert
      // straight to buyer-facing terms via the flat €10 margin,
      // treating it as VAT21 since that's what "normalized" means.
      crossSellerCeilingBuyerTerms = calculateMemberWtbBuyerEquivalent(globalLowestForRetry, "VAT21", memberWtb.fields || {});
    }

    // Reversed narrowing band: the buyer's retry must land strictly
    // between the seller's last position and the buyer's own denied
    // counter (never below what the seller already asked for).
    const validation = validateNextCounterPriceWithCrossSellerCeiling(
      deniedBuyerCounter,
      sellerLastPositionInBuyerTerms,
      proposedPrice,
      Number.isFinite(crossSellerCeilingBuyerTerms) ? Math.floor(crossSellerCeilingBuyerTerms - MIN_COUNTER_STEP) : null,
      Number.isFinite(crossSellerCeilingBuyerTerms) ? Math.round(crossSellerCeilingBuyerTerms * 100) / 100 : null
    );
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason, band: validation.band });
    }

    const sellerRecordId = firstLinkedRecordId(f["Seller ID"]);
    const sellerOriginalPrice = numberValue(f["Seller Original Price"]);
    const sellerVatType = asText(f["Seller Original VAT Type"]);

    const newRound = await airtable(COUNTER_OFFERS_TABLE).create({
      "Member WTB": [memberWtbRecordId],
      "Seller ID": sellerRecordId ? [sellerRecordId] : undefined,
      "Seller Offer Record ID": asText(f["Seller Offer Record ID"]),
      "Source Type": "Member WTB",
      "Seller Original Price": sellerOriginalPrice,
      "Seller Original VAT Type": sellerVatType,
      "Store Counter Price": proposedPrice,
      "Previous Record ID": priorRoundId,
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    if (AIRTABLE_DISCORD_UPDATES_URL) {
      const recomputedPayout = calculateMemberWtbSellerPayout(proposedPrice, sellerVatType, memberWtb.fields || {});

      await fetch(AIRTABLE_DISCORD_UPDATES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: "member-wtb-buyer-retried",
          counter_offer_record_id: newRound.id,
          product_name: asText(f["Product Name"]),
          sku: asText(f["SKU"]),
          size: asText(f["Size"]),
          your_previous_counter: sellerLastPosition,
          buyer_counter_payout: recomputedPayout
        })
      }).catch((err) => console.error("Failed to notify seller of retry counter (non-blocking):", err));
    }

    res.json({ ok: true, band: validation.band, new_round_id: newRound.id });
  } catch (err) {
    console.error("Failed to retry buying counter offer:", err);

    res.status(500).json({
      error: "Failed to retry offer",
      details: err.message
    });
  }
});

// NEW — additive only: buyer deletes their own pending counter or a
// denied one. Simpler than WTB's cascade-delete — there's no
// equivalent "stale Lowest Offer" field on this side to worry about.
app.post("/api/dashboard/buying-counter-offers/:offerId/buyer-cancel", async (req, res) => {
  try {
    const offerId = asText(req.params.offerId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);

    if (!offerId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing offerId or seller_record_id" });
    }

    const record = await airtable(COUNTER_OFFERS_TABLE).find(offerId);
    const memberWtbRecordId = firstLinkedRecordId(record.fields?.["Member WTB"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await airtable(COUNTER_OFFERS_TABLE).destroy(offerId);

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to cancel buying counter offer:", err);
    res.status(500).json({ error: "Failed to cancel offer", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: lets the buyer delete a "fresh_denied" item
// from their own Denied pill — a Seller Offer marked Denied? via the
// fresh_no_floor deny path (no Counter Offers record exists for these,
// so the regular buyer-cancel above doesn't apply). Soft-deletes via
// the same "Withdrawn?" flag already used for the seller-side delete,
// so it disappears from BOTH the buyer's and seller's views
// consistently, while discord-wtb-bot-main's undercut-check can still
// see it if needed.
// ---------------------------------------------------------------------
app.post("/api/dashboard/buying-offers/:sellerOfferId/buyer-delete-denied", async (req, res) => {
  try {
    const sellerOfferId = asText(req.params.sellerOfferId);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);

    if (!sellerOfferId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing sellerOfferId or seller_record_id" });
    }

    const sellerOfferRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferId).catch(() => null);

    if (!sellerOfferRecord) {
      return res.status(404).json({ error: "Offer not found." });
    }

    const memberWtbRecordId = firstLinkedRecordId(sellerOfferRecord.fields?.["Member WTBs"]);
    const memberWtb = memberWtbRecordId ? await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null) : null;

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await airtable(SELLER_OFFERS_TABLE).update(sellerOfferId, {
      "Withdrawn?": true
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete denied buying offer:", err);
    res.status(500).json({ error: "Failed to delete offer", details: err.message });
  }
});

// NEW — additive only: Portal-safe wrapper for the buyer's FIRST-EVER
// counter on a fresh seller offer (no Counter Offers round exists
// yet) — calls the existing secret-protected create endpoint.
app.post("/api/dashboard/buying-counter-offers/create-from-fresh", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const sellerOfferRecordId = asText(req.body?.seller_offer_record_id);
    const buyerSellerRecordId = asText(req.body?.seller_record_id);
    const price = req.body?.price;

    if (!memberWtbRecordId || !sellerOfferRecordId || !buyerSellerRecordId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId).catch(() => null);

    if (!memberWtb || !linkedRecordIncludes(memberWtb.fields?.["Buyer Seller ID"], buyerSellerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const response = await fetch(`http://localhost:${PORT}/api/member-wtb-counter-offers/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": process.env.KC_PORTAL_SECRET || ""
      },
      body: JSON.stringify({
        member_wtb_record_id: memberWtbRecordId,
        seller_offer_record_id: sellerOfferRecordId,
        price
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Failed to create first buying counter:", err);
    res.status(500).json({ error: "Failed to submit counter", details: err.message });
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
          "Date",
          "Buyer VAT ID",
          "Buyer Country"
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

    const memberWtbIds = records
      .filter((record) => linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId))
      .map((r) => r.id);

    // FIXED — his explicit request: a genuinely better fresh offer
    // from ANOTHER seller should always reach the buyer, even while
    // they're already negotiating with someone else — "only ever good
    // news." This previously excluded the WHOLE Member WTB from Open
    // the moment ANY seller had an active counter round, hiding a
    // completely different, untouched, possibly-better seller's fresh
    // offer along with it. Now tracks WHICH seller has an active
    // round (per Member WTB) instead of just whether ANY seller does.
    const activeCountersForTheseWtbs = memberWtbIds.length
      ? await airtable(COUNTER_OFFERS_TABLE)
          .select({
            filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Member WTB')`,
            fields: ["Member WTB", "Seller ID"]
          })
          .all()
          .then((records) =>
            records.filter((r) => memberWtbIds.includes(firstLinkedRecordId(r.fields?.["Member WTB"])))
          )
      : [];

    // Per Member WTB, the set of seller IDs currently mid-negotiation
    // — their raw Seller Offer is stale (superseded by their counter)
    // and must be skipped when picking the "fresh" winner below.
    const sellerIdsWithActiveCounterByWtbId = new Map();
    for (const r of activeCountersForTheseWtbs) {
      const wtbId = firstLinkedRecordId(r.fields?.["Member WTB"]);
      const sellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
      if (!wtbId || !sellerId) continue;
      if (!sellerIdsWithActiveCounterByWtbId.has(wtbId)) {
        sellerIdsWithActiveCounterByWtbId.set(wtbId, new Set());
      }
      sellerIdsWithActiveCounterByWtbId.get(wtbId).add(sellerId);
    }

    // FIXED — this previously never looked up the winning Seller
    // Offer at all, so "fresh" items had no VAT Type to show, AND the
    // Counter button had no seller_offer_record_id to submit against
    // (silently broken). Finds, per Member WTB, whichever linked
    // Seller Offer currently has the lowest price — matching what
    // "Current Lowest Offer" already rolls up — and reads its own
    // "Offer VAT Type" directly, the same field the existing, working
    // create-first-counter endpoint already relies on.
    const allSellerOffersForTheseWtbs = memberWtbIds.length
      ? await airtable(SELLER_OFFERS_TABLE)
          .select({ fields: ["Member WTBs", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer", "Denied?"] })
          .all()
          .then((records) =>
            records.filter(
              (r) =>
                !r.fields?.["Delete Offer"] &&
                // FIXED — a real, confirmed gap found via his live
                // testing: this checked "Delete Offer" but never
                // "Denied?", so a fresh Seller Offer just marked
                // Denied by the buyer (the fresh_no_floor deny path)
                // still counted as a valid, winning "fresh" candidate
                // here — it kept showing in the buyer's own Open pill
                // as if the deny had done nothing at all.
                !r.fields?.["Denied?"] &&
                memberWtbIds.includes(firstLinkedRecordId(r.fields?.["Member WTBs"]))
            )
          )
      : [];

    const winningSellerOfferByWtbId = new Map();
    for (const so of allSellerOffersForTheseWtbs) {
      const wtbId = firstLinkedRecordId(so.fields?.["Member WTBs"]);
      const sellerId = firstLinkedRecordId(so.fields?.["Seller ID"]);

      // Skip — this seller is already mid-negotiation on this WTB;
      // their raw offer is stale, doesn't belong in the "fresh" pool.
      if (sellerId && sellerIdsWithActiveCounterByWtbId.get(wtbId)?.has(sellerId)) continue;

      const price = numberValue(so.fields?.["Seller Offer"]);
      if (!Number.isFinite(price)) continue;

      const current = winningSellerOfferByWtbId.get(wtbId);
      if (!current || price < current.price) {
        winningSellerOfferByWtbId.set(wtbId, {
          price,
          id: so.id,
          vatType: asText(so.fields?.["Offer VAT Type"])
        });
      }
    }

    // FIXED — a real, confirmed bug: even after finding the best
    // FRESH, un-countered offer, this never checked whether some OTHER
    // seller's ACTIVE counter position (someone already mid-
    // negotiation) was actually BETTER. E.g. seller A's live counter
    // at 87 genuinely beats seller B's fresh 90 — but seller B kept
    // showing here in Open regardless, since active-counter sellers
    // were only ever excluded from winning FRESH, never compared
    // against. Per the "buyer only ever sees the single best position"
    // design, if an active counter beats the best fresh offer, this
    // WTB's true winner belongs in Countered instead — so it must be
    // excluded from Open entirely, not shown with a worse number.
    const normalizeForCompare = (price, vt) => {
      const p = Number(price);
      if (!Number.isFinite(p)) return null;
      return asText(vt) === "VAT0" ? p * 1.21 : p;
    };
    await Promise.all(
      Array.from(winningSellerOfferByWtbId.entries()).map(async ([wtbId, winner]) => {
        const bestActiveCounter = (await getCurrentGlobalLowestNormalized("Member WTB", wtbId, null)).normalized;
        const freshNormalized = normalizeForCompare(winner.price, winner.vatType);
        if (Number.isFinite(bestActiveCounter) && Number.isFinite(freshNormalized) && bestActiveCounter < freshNormalized) {
          winningSellerOfferByWtbId.delete(wtbId);
        }
      })
    );

    const items = await Promise.all(records
      .filter((record) =>
        linkedRecordIncludes(record.fields?.["Buyer Seller ID"], sellerRecordId) &&
        // Only hide from Open if NO seller has an untouched fresh
        // offer left (i.e. every seller on this WTB is already mid-
        // negotiation) — otherwise a genuinely fresh, possibly-better
        // offer from someone else must still surface here.
        winningSellerOfferByWtbId.has(record.id)
      )
      .map(async (record) => {
        const f = record.fields || {};
        const winningSellerOffer = winningSellerOfferByWtbId.get(record.id);

        // FIXED — this showed the RAW seller price directly (from
        // "Current Lowest Offer"), leaking Lojiq's margin to the buyer
        // — e.g. a seller's raw €90 ask showed as "€90" here, instead
        // of the correctly converted €102.10 (margin + VAT) the buyer
        // actually sees on Discord. Now computed the same way
        // everywhere else in this flow: calculateMemberWtbBuyerEquivalent.
        const offerAmount = winningSellerOffer
          ? calculateMemberWtbBuyerEquivalent(winningSellerOffer.price, winningSellerOffer.vatType, f)
          : numberValue(f["Current Lowest Offer"]);

        // NEW — additive only: his explicit request — "My Last Offer"
        // must show the buyer's GLOBAL historical high on this WHOLE
        // WTB, not just their position on THIS specific, never-yet-
        // negotiated seller (which is always empty for a fresh item).
        // Without this, a buyer who'd already countered seller A at
        // €100 saw a blank "My Last Offer" here for seller B, even
        // though €100 is still their real, binding position — same
        // getBuyerHighestEverPosition helper already used to VALIDATE
        // this, now also used to correctly DISPLAY it.
        const myHighestEver = await getBuyerHighestEverPosition("Member WTB", record.id);

        // NEW — additive only: his exact scenario — the buyer's own
        // historical floor on this WTB (getBuyerHighestEverPosition)
        // can leave NO valid room to counter THIS seller's fresh ask
        // at all, e.g. floor €100 vs ask €102.10 — a gap under the
        // €2.50 min-step, so literally no whole-number counter could
        // ever satisfy both "must beat my own floor" and "must be
        // lower than the seller's ask" simultaneously. Proactively
        // flags this so the frontend can show only Accept/Deny,
        // instead of a Counter button that would always fail.
        const sellerAskInBuyerTermsForRoomCheck = offerAmount;
        const noRoomToCounter =
          Number.isFinite(myHighestEver) &&
          myHighestEver > 0 &&
          Number.isFinite(sellerAskInBuyerTermsForRoomCheck) &&
          (sellerAskInBuyerTermsForRoomCheck - myHighestEver) < MIN_COUNTER_STEP;

        return {
          id: record.id,
          member_wtb_record_id: record.id,
          seller_offer_record_id: winningSellerOffer?.id || null,
          order_id: displayValue(f["Member WTB ID"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          brand: displayValue(f["Brand"]),
          max_price: moneyWholeValue(f["Max Price"]),
          offer: Number.isFinite(offerAmount) && offerAmount > 0
            ? moneySmartValue(offerAmount)
            : "-",
          my_offer: Number.isFinite(myHighestEver) && myHighestEver > 0
            ? moneySmartValue(myHighestEver)
            : null,
          no_room_to_counter: noRoomToCounter,
          vat_type: winningSellerOffer?.vatType || null,
          status: "Offer Received",
          date: formatDateEU(f["Date"]),
          raw_date: f["Date"]
        };
      }));

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
    // NEW — additive only: this endpoint always accepted the raw
    // "Current Lowest Seller Offer" price, ignoring any negotiated
    // position entirely — correct for a fresh, never-countered offer,
    // but silently wrong for the Countered/Denied pills' "Accept €X"
    // button, which shows a specific negotiated price that this never
    // actually honored. Now accepts an optional override, matching the
    // exact pattern the already-tested Discord accept handlers use.
    const overridePrice = req.body?.override_price;
    const overrideVatType = asText(req.body?.override_vat_type);
    // NEW — additive only: this endpoint never closed other sellers'
    // competing counters on the same Member WTB at all — meaning if
    // multiple sellers had offers/negotiations open, accepting one via
    // the Portal would leave the others dangling, still open, still
    // actionable. Optional so the frontend doesn't have to change for
    // the "fresh offer, no specific round" case (empty string safely
    // matches nothing, so every open round gets closed).
    const acceptedCounterOfferRecordId = asText(req.body?.counter_offer_record_id);
    // FIXED — CRITICAL: this endpoint ALWAYS used
    // "Current Lowest Seller Offer" (a plain Airtable field on the
    // Member WTB record) to decide WHICH SELLER gets the deal —
    // completely regardless of which specific row's Accept button was
    // actually clicked, or what negotiation history existed. That
    // field is only ever set by the original, pre-negotiation
    // "place-offer" flow and is NEVER updated as counters/denials
    // happen — so clicking "Accept €95.10" (seller A's genuinely
    // negotiated position, correctly shown after the chain-tracing
    // fixes) could silently create a deal channel with a COMPLETELY
    // DIFFERENT seller (seller B) instead, confirmed via his exact
    // live report. Now accepts an explicit seller_offer_record_id from
    // the frontend (which already has the correct value available on
    // every item) and uses THAT when provided, falling back to the
    // stale field only for the genuinely-fresh, never-negotiated case
    // where no override applies at all.
    const explicitSellerOfferRecordId = asText(req.body?.seller_offer_record_id);

    if (!memberWtbRecordId) {
      return res.status(400).json({ error: "Missing member_wtb_record_id" });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const f = memberWtb.fields || {};

    const sellerOfferRecordId = explicitSellerOfferRecordId || firstLinkedRecordId(f["Current Lowest Seller Offer"]);

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
        seller_offer_record_id: sellerOfferRecordId,
        ...(Number.isFinite(Number(overridePrice)) && overridePrice > 0
          ? { override_price: Number(overridePrice), override_vat_type: overrideVatType }
          : {})
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error || "Failed to accept offer",
        details: data.details || ""
      });
    }

    await closeCompetingCountersForMemberWtb(memberWtbRecordId, acceptedCounterOfferRecordId || "").catch((err) =>
      console.error("Failed to close competing counters (non-blocking):", err)
    );

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
    // NEW — additive only: this endpoint previously only ever supported
    // Store Orders (required Linked Orders) — extending it to also
    // accept a Member WTB-linked Seller Offer, for his exact scenario:
    // a buyer denying a genuinely fresh Member WTB offer they've never
    // countered before, where the retry needs this exact same
    // mechanism (Denied? flag cleared, price updated) rather than the
    // Counter Offers table's broadcast machinery.
    const linkedMemberWtbId = firstLinkedRecordId(f["Member WTBs"]);

    if (!linkedOrderId && !linkedMemberWtbId) {
      return res.status(409).json({ error: "This offer is not linked to an order or Member WTB" });
    }

    const normalizedOffer = vatType === "VAT0" ? offerAmount * 1.21 : offerAmount;

    await airtable(SELLER_OFFERS_TABLE).update(offerId, {
      "Seller Offer": offerAmount,
      "Offer VAT Type": vatType,
      "Offer Cost (Normalized)": normalizedOffer,
      "Offer Date": new Date().toISOString(),
      // FIXED — this never cleared "Denied?", so a successful Retry
      // still displayed in the Denied pill forever afterward (using
      // the stale "Denied Amount", not the fresh price just placed),
      // instead of correctly moving to Open with the new amount —
      // same fix already applied to fresh-offer placement.
      "Denied?": false
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
// NEW — additive only: pure extraction of the logic that used to live
// directly inside the /api/notify-seller-offer-denied route below — no
// behavior changed, only moved into a callable function so a second
// caller (the new deny-fresh endpoint, for the Lojiq Portal) can use
// the exact same code in-process instead of a second, separately
// written copy.
async function notifySellerOfferDeniedCore({
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
  if (!sellerDiscordId || !orderRecordId || !sellerRecordId) {
    const err = new Error("Missing sellerDiscordId, orderRecordId, or sellerRecordId");
    err.statusCode = 400;
    throw err;
  }

  let resolvedSellerOfferRecordId = asText(sellerOfferRecordId);

  if (!resolvedSellerOfferRecordId) {
    const candidateOffers = await airtable(SELLER_OFFERS_TABLE)
      .select({ fields: ["Seller ID", "Linked Orders"] })
      .all();

    const match = candidateOffers.find(
      (r) =>
        linkedRecordIncludes(r.fields?.["Seller ID"], sellerRecordId) &&
        firstLinkedRecordId(r.fields?.["Linked Orders"]) === orderRecordId
    );

    resolvedSellerOfferRecordId = match?.id || null;
  }

  if (resolvedSellerOfferRecordId) {
    await airtable(SELLER_OFFERS_TABLE).update(resolvedSellerOfferRecordId, {
      "Denied?": true,
      "Denied At": new Date().toISOString(),
      "Denied Amount": Number(deniedAmount) || null,
      "Denied VAT Type": asText(vatType)
    }).catch((err) => console.error("Failed to write structured denial to Seller Offer (non-blocking):", err));
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
}

app.post("/api/notify-seller-offer-denied", async (req, res) => {
  try {
    await notifySellerOfferDeniedCore(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Failed to notify seller of offer denial:", err);
    res.status(500).json({ error: "Failed to notify seller", details: err.message });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: Lojiq Portal's Deny on a fresh (never-countered)
// offer. Resolves the info notifySellerOfferDeniedCore needs (seller's
// Discord ID via the Sellers Database) and calls that exact same
// function in-process — the store-side write path already proven for
// Store Orders, no separate deny logic.
// ---------------------------------------------------------------------
app.post("/api/counter-offers/deny-fresh", async (req, res) => {
  try {
    const secret = asText(req.headers["x-kc-secret"]);

    if (
      !process.env.COUNTER_OFFERS_SECRET ||
      secret !== process.env.COUNTER_OFFERS_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderRecordId = asText(req.body?.order_record_id);
    const sellerOfferRecordId = asText(req.body?.seller_offer_record_id);
    const requestedStoreName = asText(req.body?.store_name);

    if (!orderRecordId || !sellerOfferRecordId) {
      return res.status(400).json({ error: "Missing order_record_id or seller_offer_record_id" });
    }

    const ownsIt = await verifyStoreOwnsOrderForRound(orderRecordId, requestedStoreName);
    if (!ownsIt) {
      return res.status(403).json({ error: "Not allowed for this store." });
    }

    const [orderRecord, sellerOfferRecord] = await Promise.all([
      airtable(ORDERS_TABLE).find(orderRecordId),
      airtable(SELLER_OFFERS_TABLE).find(sellerOfferRecordId)
    ]);

    const orderFields = orderRecord.fields || {};
    const sof = sellerOfferRecord.fields || {};

    const sellerRecordId = firstLinkedRecordId(sof["Seller ID"]);

    if (!sellerRecordId) {
      return res.status(409).json({ error: "This offer has no linked seller." });
    }

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId);
    const sellerDiscordId = asText(sellerRecord.fields?.["Discord ID"]);

    if (!sellerDiscordId) {
      return res.status(409).json({ error: "Seller has no Discord ID on file." });
    }

    await notifySellerOfferDeniedCore({
      orderRecordId,
      orderId: asText(orderFields["Order ID"]),
      sellerOfferRecordId,
      sellerRecordId,
      sellerDiscordId,
      productName: asText(orderFields["Shopify Product Name"]),
      sku: asText(orderFields["SKU"]),
      size: asText(orderFields["Size"]),
      shopifyOrderNumber: asText(orderFields["Shopify Order Number"]),
      deniedAmount: numberValue(sof["Seller Offer"]),
      vatType: asText(sof["Offer VAT Type"])
    });

    // NEW — additive only: his explicit rule — denying one seller's
    // fresh offer means the store isn't happy with ANY current fresh
    // asking price on this order, not just this one seller's. Every
    // OTHER seller who still has a genuinely untouched, fresh offer
    // here (not already mid-negotiation, not already denied/withdrawn)
    // gets denied + notified too, so as many sellers as possible know
    // they need to come back with something better. Mirrors the
    // multi-seller broadcast already proven for Counter/Edit, but for
    // Deny specifically at the fresh, no-floor-yet stage.
    try {
      const [allSellerOffersForThisOrder, activeCounterRoundsForOrder] = await Promise.all([
        airtable(SELLER_OFFERS_TABLE)
          .select({ fields: ["Linked Orders", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer", "Denied?", "Withdrawn?"] })
          .all(),
        airtable(COUNTER_OFFERS_TABLE)
          .select({
            filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Seller Offer')`,
            fields: ["Order", "Seller ID"]
          })
          .all()
      ]);

      const sellerIdsMidNegotiationForThisOrder = new Set(
        activeCounterRoundsForOrder
          .filter((r) => firstLinkedRecordId(r.fields?.["Order"]) === orderRecordId)
          .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
          .filter(Boolean)
      );

      const otherFreshSellerOffers = allSellerOffersForThisOrder.filter((r) => {
        if (r.id === sellerOfferRecordId) return false;
        if (firstLinkedRecordId(r.fields?.["Linked Orders"]) !== orderRecordId) return false;
        if (r.fields?.["Delete Offer"] || r.fields?.["Denied?"] || r.fields?.["Withdrawn?"]) return false;
        const otherSellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
        if (otherSellerId && sellerIdsMidNegotiationForThisOrder.has(otherSellerId)) return false;
        return true;
      });

      for (const otherOffer of otherFreshSellerOffers) {
        const otherFields = otherOffer.fields || {};
        const otherSellerRecordId = firstLinkedRecordId(otherFields["Seller ID"]);
        if (!otherSellerRecordId) continue;

        const otherSellerRecord = await airtable(SELLERS_TABLE).find(otherSellerRecordId).catch(() => null);
        const otherSellerDiscordId = asText(otherSellerRecord?.fields?.["Discord ID"]);
        if (!otherSellerDiscordId) continue;

        await notifySellerOfferDeniedCore({
          orderRecordId,
          orderId: asText(orderFields["Order ID"]),
          sellerOfferRecordId: otherOffer.id,
          sellerRecordId: otherSellerRecordId,
          sellerDiscordId: otherSellerDiscordId,
          productName: asText(orderFields["Shopify Product Name"]),
          sku: asText(orderFields["SKU"]),
          size: asText(orderFields["Size"]),
          shopifyOrderNumber: asText(orderFields["Shopify Order Number"]),
          deniedAmount: numberValue(otherFields["Seller Offer"]),
          vatType: asText(otherFields["Offer VAT Type"])
        }).catch((err) => console.error("Failed to notify other fresh seller of denial (non-blocking):", err));
      }
    } catch (broadcastErr) {
      console.error("Failed to broadcast fresh-offer deny to other sellers (non-blocking):", broadcastErr);
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Failed to deny fresh offer:", err);
    res.status(500).json({ error: "Failed to deny offer", details: err.message });
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
    let deals = records.map((record) => normalizeDeal(record, type));
    
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

    // NEW — additive only: a real, confirmed gap found via his live
    // testing — this "create" endpoint handles BOTH a genuinely fresh,
    // first-ever counter to a seller AND a retry after THIS SAME
    // seller just denied (via the Denied embed's reused Counter
    // button). getBuyerHighestEverPosition alone doesn't distinguish
    // these — it only blocks going BELOW the historical high, so
    // resubmitting the EXACT price this seller just denied (e.g. €90
    // again) passed, since €90 isn't LESS than the €90 historical
    // high. His explicit expectation: a retry against a seller who
    // just denied must be STRICTLY higher than what they denied —
    // finds the most recent Denied round for THIS specific seller
    // offer and, if found, enforces the standard narrowing-band
    // minimum step above that denied price.
    const recentDeniedRoundForThisSeller = await airtable(COUNTER_OFFERS_TABLE)
      .select({
        filterByFormula: `AND({Status} = 'Denied', {Source Type} = 'Member WTB', {Seller Offer Record ID} = '${escapeFormulaValue(sellerOfferId)}')`,
        fields: ["Member WTB", "Store Counter Price", "Denied At"],
        sort: [{ field: "Denied At", direction: "desc" }],
        maxRecords: 1
      })
      .firstPage()
      .then((records) =>
        records.find((r) => firstLinkedRecordId(r.fields?.["Member WTB"]) === memberWtbRecordId)
      )
      .catch(() => null);

    if (recentDeniedRoundForThisSeller) {
      const deniedPriceForThisSeller = numberValue(recentDeniedRoundForThisSeller.fields?.["Store Counter Price"]);
      const minAllowedRetry = Math.ceil(deniedPriceForThisSeller + MIN_COUNTER_STEP);

      if (Number.isFinite(deniedPriceForThisSeller) && deniedPriceForThisSeller > 0 && buyerCounterPrice < minAllowedRetry) {
        return res.status(400).json({
          error: `This seller already denied €${deniedPriceForThisSeller.toFixed(2)} — your retry must be at least €${minAllowedRetry.toFixed(2)}.`
        });
      }
    }

    // FIXED — a real, confirmed gap found via his live testing:
    // getBuyerHighestEverPosition was only ever wired into the
    // round-2+ buyer-counter endpoint, never into THIS one — the
    // buyer's very FIRST counter to a seller they haven't negotiated
    // with before (e.g. a fresh, previously-untouched seller B, while
    // the buyer already countered seller A higher earlier on this
    // same WTB). Without this, a buyer could regress below their own
    // historical best simply by countering a DIFFERENT, fresh seller
    // for the first time — exactly his live scenario.
    const buyerHighestEver = await getBuyerHighestEverPosition("Member WTB", memberWtbRecordId);

    // NEW — additive only: his exact scenario — even when the
    // proposed price technically satisfies "beats my own floor" AND
    // "beats the seller's ask" individually, the GAP between the
    // buyer's floor and the seller's ask can itself be too small for
    // the standard €2.50 min-step (e.g. floor €100, ask €102.10 — a
    // €2.10 gap). No whole-number counter could ever land validly in
    // between, so this rejects the attempt with a clear "no room"
    // message rather than a confusing per-price rejection depending
    // on exactly what was typed.
    if (
      Number.isFinite(buyerHighestEver) &&
      buyerHighestEver > 0 &&
      (sellerAskInBuyerTerms - buyerHighestEver) < MIN_COUNTER_STEP
    ) {
      return res.status(400).json({
        error: "No room to counter — the gap between your own previous position and this seller's ask is too small for another step. Please accept or deny.",
        no_room_to_counter: true
      });
    }

    if (Number.isFinite(buyerHighestEver) && buyerCounterPrice < buyerHighestEver) {
      return res.status(400).json({
        error: `Your counter can't be lower than €${buyerHighestEver.toFixed(2)}, which you've already offered on this WTB.`
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
      // SIMPLIFIED — Product Name/SKU/Size/Brand/Member WTB ID no
      // longer need to be written here: he's added native lookup
      // fields (Product Name (MWTB), SKU (MWTB), Size (MWTB), Brand
      // (MWTB), Member WTB ID) through the "Member WTB" link above,
      // mirroring how Product Name/SKU/etc already resolve natively
      // for Store Orders rounds via the Order link. One less set of
      // fields to remember to carry forward on every new round.
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    // FIXED — a real, confirmed gap: this endpoint (the buyer's VERY
    // FIRST counter, before any negotiation exists) never called the
    // broadcast at all — only round-2+ (buyer-counter) and Edit did.
    // Confirmed via his live test: seller B got the counter, seller A
    // (a completely untouched fresh offer) got nothing. His explicit
    // rule applies here too: every buyer counter reaches everyone
    // still in the game, round 1 included.
    await reengageDeniedSellers({
      sourceType: "Member WTB",
      recordId: memberWtbRecordId,
      newBuyerCounterPrice: buyerCounterPrice,
      excludeSellerId: sellerRecordId
    }).catch((err) => console.error("Failed to re-engage other sellers on first counter (non-blocking):", err));

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
// NEW — additive only: lets the buyer explicitly Deny a fresh, never-
// yet-negotiated seller offer — needed for his exact scenario: the
// buyer's own historical floor on this WTB (getBuyerHighestEverPosition)
// leaves NO valid room to counter this specific seller's ask at all
// (the gap is under the €2.50 min-step), so Accept/Deny are the only
// genuine options — a Counter attempt would always fail. "Deny" here
// means "I won't go higher than my floor for this seller specifically"
// — creates a round for THIS seller at the buyer's floor, immediately
// marked Denied, then reuses reengageDeniedSellers (same broadcast
// already used everywhere else) to reopen whichever OTHER seller has a
// stale, superseded position at that same floor — giving them a fresh
// chance to accept or counter, exactly like any other deny-reopen.
// ---------------------------------------------------------------------
app.post("/api/dashboard/buying-offers/:memberWtbRecordId/deny", async (req, res) => {
  try {
    const memberWtbRecordId = asText(req.params.memberWtbRecordId);
    const sellerOfferId = asText(req.body?.seller_offer_record_id);
    const buyerRecordId = asText(req.body?.seller_record_id);

    if (!memberWtbRecordId || !sellerOfferId) {
      return res.status(400).json({ error: "Missing memberWtbRecordId or seller_offer_record_id" });
    }

    const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
    const wtbFields = memberWtb.fields || {};

    if (buyerRecordId && !linkedRecordIncludes(wtbFields["Buyer Seller ID"], buyerRecordId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const sellerOfferRecord = await airtable(SELLER_OFFERS_TABLE).find(sellerOfferId).catch(() => null);

    if (!sellerOfferRecord) {
      return res.status(404).json({ error: "Seller offer not found." });
    }

    const sf = sellerOfferRecord.fields || {};
    const sellerOriginalPrice = numberValue(sf["Seller Offer"]);
    const sellerVatType = asText(sf["Offer VAT Type"]);
    const sellerRecordId = firstLinkedRecordId(sf["Seller ID"]);

    if (!sellerOriginalPrice || !sellerRecordId) {
      return res.status(409).json({ error: "Seller offer is missing price or seller." });
    }

    const buyerHighestEver = await getBuyerHighestEverPosition("Member WTB", memberWtbRecordId);

    // FIXED — his exact correction, found via live testing: this used
    // to hard-reject with "nothing to deny against" whenever the buyer
    // had never made ANY counter yet on this whole WTB — a completely
    // reasonable, common case (a buyer's very first reaction to a
    // fresh offer being "no thanks"). His clear direction: this should
    // simply deny THIS seller's fresh offer outright — same mechanism
    // already proven for Store Orders (mark the Seller Offer "Denied?",
    // send an "Offer Denied" DM with a Retry button, surface it in the
    // seller's own Want To Buys Denied pill with Retry + Delete) —
    // not the broader multi-seller broadcast, since there's no
    // established buyer floor yet to broadcast in the first place.
    if (!Number.isFinite(buyerHighestEver) || buyerHighestEver <= 0) {
      const nowIsoForFreshDeny = new Date().toISOString();

      await airtable(SELLER_OFFERS_TABLE).update(sellerOfferId, {
        "Denied?": true,
        "Denied At": nowIsoForFreshDeny,
        "Denied Amount": sellerOriginalPrice,
        "Denied VAT Type": sellerVatType
      });

      const sellerRecordForFreshDeny = await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null);
      const sellerDiscordIdForFreshDeny = asText(sellerRecordForFreshDeny?.fields?.["Discord ID"]);

      if (sellerDiscordIdForFreshDeny) {
        await sendOfferDeniedDiscordDM({
          orderId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
          sellerOfferRecordId: sellerOfferId,
          sellerRecordId,
          sellerDiscordId: sellerDiscordIdForFreshDeny,
          productName: asText(wtbFields["Product Name"]),
          sku: asText(wtbFields["SKU"]),
          size: asText(wtbFields["Size"]),
          deniedAmount: sellerOriginalPrice,
          vatType: sellerVatType,
          contextLabel: "Member WTB"
        }).catch((err) => console.error("Failed to send fresh-offer denial DM (non-blocking):", err));
      }

      // NEW — additive only: his explicit rule — denying one seller's
      // fresh offer means the buyer isn't happy with ANY current fresh
      // asking price on this WTB, not just this one seller's. Every
      // OTHER seller who still has a genuinely untouched, fresh offer
      // here (not already mid-negotiation, not already denied/withdrawn)
      // gets denied + notified too, so as many sellers as possible know
      // they need to come back with something better. Mirrors the
      // Store Orders fresh-deny broadcast (same fix, same reasoning).
      try {
        const [allSellerOffersForThisWtb, activeCounterRoundsForWtb] = await Promise.all([
          airtable(SELLER_OFFERS_TABLE)
            .select({ fields: ["Member WTBs", "Seller ID", "Seller Offer", "Offer VAT Type", "Delete Offer", "Denied?", "Withdrawn?"] })
            .all(),
          airtable(COUNTER_OFFERS_TABLE)
            .select({
              filterByFormula: `AND({Status} = 'Open', {Source Type} = 'Member WTB')`,
              fields: ["Member WTB", "Seller ID"]
            })
            .all()
        ]);

        const sellerIdsMidNegotiationForThisWtb = new Set(
          activeCounterRoundsForWtb
            .filter((r) => firstLinkedRecordId(r.fields?.["Member WTB"]) === memberWtbRecordId)
            .map((r) => firstLinkedRecordId(r.fields?.["Seller ID"]))
            .filter(Boolean)
        );

        const otherFreshSellerOffers = allSellerOffersForThisWtb.filter((r) => {
          if (r.id === sellerOfferId) return false;
          if (firstLinkedRecordId(r.fields?.["Member WTBs"]) !== memberWtbRecordId) return false;
          if (r.fields?.["Delete Offer"] || r.fields?.["Denied?"] || r.fields?.["Withdrawn?"]) return false;
          const otherSellerId = firstLinkedRecordId(r.fields?.["Seller ID"]);
          if (otherSellerId && sellerIdsMidNegotiationForThisWtb.has(otherSellerId)) return false;
          return true;
        });

        for (const otherOffer of otherFreshSellerOffers) {
          const otherFields = otherOffer.fields || {};
          const otherSellerRecordId = firstLinkedRecordId(otherFields["Seller ID"]);
          if (!otherSellerRecordId) continue;

          const otherPrice = numberValue(otherFields["Seller Offer"]);
          if (!otherPrice) continue;

          const otherSellerRecord = await airtable(SELLERS_TABLE).find(otherSellerRecordId).catch(() => null);
          const otherSellerDiscordId = asText(otherSellerRecord?.fields?.["Discord ID"]);
          if (!otherSellerDiscordId) continue;

          await airtable(SELLER_OFFERS_TABLE).update(otherOffer.id, {
            "Denied?": true,
            "Denied At": new Date().toISOString(),
            "Denied Amount": otherPrice,
            "Denied VAT Type": asText(otherFields["Offer VAT Type"])
          }).catch((err) => console.error("Failed to mark other fresh seller offer denied (non-blocking):", err));

          await sendOfferDeniedDiscordDM({
            orderId: asText(wtbFields["Member WTB ID"]) || memberWtbRecordId,
            sellerOfferRecordId: otherOffer.id,
            sellerRecordId: otherSellerRecordId,
            sellerDiscordId: otherSellerDiscordId,
            productName: asText(wtbFields["Product Name"]),
            sku: asText(wtbFields["SKU"]),
            size: asText(wtbFields["Size"]),
            deniedAmount: otherPrice,
            vatType: asText(otherFields["Offer VAT Type"]),
            contextLabel: "Member WTB"
          }).catch((err) => console.error("Failed to notify other fresh seller of denial (non-blocking):", err));
        }
      } catch (broadcastErr) {
        console.error("Failed to broadcast fresh-offer deny to other sellers (non-blocking):", broadcastErr);
      }

      return res.json({ ok: true, denied_type: "fresh_no_floor" });
    }

    // FIXED — his exact correction: this used to silently create a
    // pre-Denied round for THIS seller (no Discord notification at
    // all) while separately reopening every OTHER seller — meaning
    // the seller being denied never actually heard anything. Instead,
    // this seller should be treated exactly like any other seller
    // "in the game": reached via the SAME broadcast (reengageDeniedSellers),
    // via its "fresh, never-yet-engaged" category (their raw offer is
    // still untouched) — genuinely notified with the buyer's floor,
    // Accept/Deny available, Counter automatically hidden if there's
    // truly no room for them either. No exclusion — the buyer's
    // "Deny" here means "this is my real floor for everyone," not
    // "silently reject this one seller and only tell the others."
    await reengageDeniedSellers({
      sourceType: "Member WTB",
      recordId: memberWtbRecordId,
      newBuyerCounterPrice: buyerHighestEver,
      excludeSellerId: null,
      isDenyBroadcast: true
    }).catch((err) => console.error("Failed to broadcast buyer floor after fresh-offer deny (non-blocking):", err));

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to deny fresh buying offer:", err);
    res.status(500).json({ error: "Failed to deny offer", details: err.message });
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

    // NEW — additive only: the round being countered may have been
    // deleted since the Discord embed offering this Counter button was
    // sent (e.g. the buyer withdrew their pending counter via Delete).
    // Previously fell through to the generic 500 handler at the bottom
    // of this endpoint ("Failed to process seller counter") — accurate
    // but not helpful. Now returns a specific, friendly message the
    // Discord modal handler already knows how to display.
    let previousRecord;
    try {
      previousRecord = await airtable(COUNTER_OFFERS_TABLE).find(previousRecordId);
    } catch (err) {
      if ((err.statusCode === 404 || err.error === "NOT_FOUND" || err.statusCode === 403 || err.error === "NOT_AUTHORIZED")) {
        return res.status(404).json({ error: "This offer is no longer valid." });
      }
      throw err;
    }
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

    // FIXED — a real, confirmed bug found via his live testing: this
    // only walked ONE hop back via this round's OWN Previous Record
    // ID — but after MULTIPLE supersessions (e.g. this seller
    // countered once, got superseded by a later buyer broadcast
    // before responding, more than once), their true last position
    // could be several hops further back than that, and this fell
    // all the way back to their very first, stale original ask
    // instead. Now uses the same full chain-walking helper already
    // built for the equivalent display/notification bug
    // (findSellersTrueLastCounter), which keeps walking backward
    // until it finds a round where this seller's Seller Counter
    // Price is genuinely set, however many supersessions back that
    // happened.
    let sellerOwnReference = await findSellersTrueLastCounter(previousRecordId);
    if (!Number.isFinite(sellerOwnReference) || sellerOwnReference <= 0) {
      sellerOwnReference = sellerOriginalPrice;
    }

    // FIXED — the check above only looks ONE hop back via this round's
    // OWN Previous Record ID — but after a deny-reopen, the round being
    // responded to is the REOPENED prior round, whose own Previous
    // Record ID points to whatever came before the seller's now-denied
    // counter, not to that denied counter itself (nothing links
    // forward to it). Without this, a seller could resubmit the exact
    // same price the store just denied — his point: this also means a
    // seller could otherwise spam the buyer with a price already
    // rejected. Searches forward for a denied round that responded to
    // this same round, and uses ITS price as the (more recent, more
    // restrictive) reference instead when one exists.
    const deniedSuccessorFormula = `AND(
      {Status} = 'Denied',
      {Source Type} = 'Member WTB'
    )`;
    const deniedSuccessors = await airtable(COUNTER_OFFERS_TABLE)
      .select({ filterByFormula: deniedSuccessorFormula, fields: ["Previous Record ID", "Seller Counter Price", "Denied At"] })
      .all();
    const deniedSuccessor = deniedSuccessors
      .filter((r) => asText(r.fields?.["Previous Record ID"]) === previousRecordId)
      .sort((a, b) => new Date(b.fields?.["Denied At"] || 0) - new Date(a.fields?.["Denied At"] || 0))[0];

    if (deniedSuccessor) {
      const deniedSellerCounter = numberValue(deniedSuccessor.fields?.["Seller Counter Price"]);
      if (deniedSellerCounter) {
        sellerOwnReference = deniedSellerCounter;
      }
    }

    // Scale mismatch guard: buyerCounterPrice is in BUYER terms, must
    // convert to SELLER terms before comparing against the seller's own
    // reference (which is already seller-scale).
    const buyerPriceInSellerTerms = calculateMemberWtbSellerPayout(buyerCounterPrice, sellerVatType, wtbFields);

    if (!Number.isFinite(buyerPriceInSellerTerms)) {
      return res.status(500).json({ error: "Could not compute margin conversion for this WTB." });
    }

    // FIXED — a real, confirmed bug found via his live testing: the
    // seller's own narrowing band and the cross-seller "beat the
    // current lowest" ceiling used to be validated as two separate,
    // sequential gates — a proposed price could fail the FIRST gate
    // (own band) with a misleading error that never mentioned the
    // cross-seller constraint even existed, and "No room left" only
    // ever appeared when the own band ALONE happened to be too narrow
    // — never when the two constraints COMBINED left no valid price
    // at all. Now folds the cross-seller ceiling into the own band
    // before validating, via the shared helper, giving one honest,
    // combined answer regardless of which specific price was tried.
    const globalLowestForValidation = (await getCurrentGlobalLowestNormalized("Member WTB", memberWtbRecordId, sellerRecordId)).normalized;
    let crossSellerCeilingRaw = null;
    let crossSellerReferenceRaw = null;
    if (Number.isFinite(globalLowestForValidation)) {
      // FIXED — same bug and fix as the Store Orders equivalent: only
      // VAT0 needs the /1.21 reversal, VAT21 and Margin stay as-is.
      const rawThreshold = asText(sellerVatType) === "VAT0" ? globalLowestForValidation / 1.21 : globalLowestForValidation;
      crossSellerCeilingRaw = Math.floor(rawThreshold - MIN_COUNTER_STEP);
      crossSellerReferenceRaw = rawThreshold;
    }

    const validation = validateNextCounterPriceWithCrossSellerCeiling(
      sellerOwnReference,
      buyerPriceInSellerTerms,
      proposedPrice,
      crossSellerCeilingRaw,
      crossSellerReferenceRaw
    );
    if (!validation.ok) {
      // Distinguishes a genuine "no room combining both constraints"
      // from a price that's simply outside the (already-combined)
      // valid band, so the cross-seller-specific wording still shows
      // when relevant, without ever hiding behind the own-band error.
      if (
        validation.reason.startsWith("No room left") &&
        Number.isFinite(crossSellerCeilingRaw)
      ) {
        return res.status(400).json({
          error: `Another seller already offers a better price for this WTB — at most €${crossSellerCeilingRaw.toFixed(2)} (${sellerVatType}) to beat it — and the gap between that and the buyer's current position is too small for another step. Please accept or deny.`,
          band: validation.band
        });
      }
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
      // FIXED — same gap as WTB's seller-counter: this never set
      // Counter Payout on a seller-created round. Confirmed via the
      // Airtable schema export that "Counter Payout" is a plain
      // currency field, not a formula — nothing was auto-filling it.
      "Counter Payout": proposedPrice,
      "Counter Payout VAT Type": sellerVatType,
      "Previous Record ID": previousRecordId,
      // FIXED — this never set Created At, so Date went blank as soon
      // as a seller-created round became the current one in the chain
      // (the same recurring gap found and fixed elsewhere this session
      // for other round-creation endpoints).
      "Created At": new Date().toISOString(),
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
    let buyerOwnReference = numberValue(priorFields["Store Counter Price"]);

    // FIXED — same gap as seller-counter above, mirrored: after a
    // deny-reopen, the round being responded to is the reopened prior
    // round, whose own Previous Record ID points to whatever came
    // before the buyer's now-denied counter, not to that denied
    // counter itself. Without this, the buyer could resubmit the exact
    // same price the seller just denied.
    const deniedSuccessorFormulaForBuyer = `AND(
      {Status} = 'Denied',
      {Source Type} = 'Member WTB'
    )`;
    const deniedSuccessorsForBuyer = await airtable(COUNTER_OFFERS_TABLE)
      .select({ filterByFormula: deniedSuccessorFormulaForBuyer, fields: ["Previous Record ID", "Store Counter Price", "Denied At"] })
      .all();
    const deniedSuccessorForBuyer = deniedSuccessorsForBuyer
      .filter((r) => asText(r.fields?.["Previous Record ID"]) === previousRoundId)
      .sort((a, b) => new Date(b.fields?.["Denied At"] || 0) - new Date(a.fields?.["Denied At"] || 0))[0];

    if (deniedSuccessorForBuyer) {
      const deniedBuyerCounter = numberValue(deniedSuccessorForBuyer.fields?.["Store Counter Price"]);
      if (deniedBuyerCounter) {
        buyerOwnReference = deniedBuyerCounter;
      }
    }

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

    // NEW — additive only: same "never regress below own historical
    // best" consistency rule as Store Orders — the buyer only ever
    // sees ONE unified thread, so their own counter must never go
    // below the best position they've EVER offered on this WTB,
    // regardless of which seller it originally went to.
    const buyerHighestEver = await getBuyerHighestEverPosition("Member WTB", memberWtbRecordId);
    if (Number.isFinite(buyerHighestEver) && proposedPrice < buyerHighestEver) {
      return res.status(400).json({
        error: `Your counter can't be lower than €${buyerHighestEver.toFixed(2)}, which you've already offered on this WTB.`
      });
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
      // SIMPLIFIED — no longer needs to carry Product Name/SKU/Size/
      // Brand forward at all: "Member WTB" is already linked above, and
      // the new native lookup fields (Product Name (MWTB) etc.)
      // resolve through that link automatically on every round, so
      // there's nothing left to remember to carry forward here.
      "Created At": new Date().toISOString(),
      "Status": "Open"
    });

    // NEW — additive only: his explicit request — this new, higher
    // counter might also now beat what a PREVIOUSLY-denied seller was
    // denied at. Re-opens a fresh round for any such seller, giving
    // them a genuine second chance rather than being permanently out
    // just because they said no to an earlier, lower position.
    await reengageDeniedSellers({
      sourceType: "Member WTB",
      recordId: memberWtbRecordId,
      newBuyerCounterPrice: proposedPrice,
      excludeSellerId: sellerRecordId
    }).catch((err) => console.error("Failed to re-engage previously denied sellers (non-blocking):", err));

    const sellerRecord = await airtable(SELLERS_TABLE).find(sellerRecordId).catch(() => null);
    const sellerDiscordId = asText(sellerRecord?.fields?.["Discord ID"]);
    let dmSent = false;

    if (sellerDiscordId) {
      const buyerOwnPosition = proposedPrice;
      // FIXED — this compared against sellerOriginalPrice (the seller's
      // very first ask, unchanged for the whole chain) instead of
      // their actual last/current position (sellerCounterPrice, already
      // available on this same round) — made the gap look artificially
      // large, so "no room left" almost never correctly triggered here.
      // The Store Orders equivalent already correctly uses the
      // counterpart's actual last position for this same check.
      const noRoomToCounter =
        Number.isFinite(sellerCounterInBuyerTerms) &&
        !hasRoomForNextStep(buyerOwnPosition, sellerCounterInBuyerTerms);

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
        sellerLastOfferPrice: sellerCounterPrice,
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

    // NEW — additive only: round-1 edits (the buyer's very first
    // counter, no Previous Record ID yet) previously always got
    // rejected outright. Unlike Consignment's pre-offer (an automatic
    // snapshot of an existing listing price, edited elsewhere) — a
    // buyer's first counter here is a deliberate negotiation move with
    // nowhere else to revise it, so blocking Edit made no sense.
    // There's no "own prior position" to narrow-band against yet
    // (this IS the first position), so it reuses the exact same,
    // simpler validation the original round-1 creation already uses:
    // just needs to stay lower than the seller's current ask.
    if (!previousRecordId) {
      const sellerOfferRecordIdForFirstRound = asText(f["Seller Offer Record ID"]);
      const memberWtbRecordIdForFirstRound = firstLinkedRecordId(f["Member WTB"]);

      if (!memberWtbRecordIdForFirstRound) {
        return res.status(400).json({ error: "Missing linked Member WTB." });
      }

      const memberWtbForFirstRound = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordIdForFirstRound);
      const wtbFieldsForFirstRound = memberWtbForFirstRound.fields || {};

      const sellerOriginalPriceForFirstRound = numberValue(f["Seller Original Price"]);
      const sellerVatTypeForFirstRound = asText(f["Seller Original VAT Type"]);

      const sellerAskInBuyerTerms = calculateMemberWtbBuyerEquivalent(
        sellerOriginalPriceForFirstRound,
        sellerVatTypeForFirstRound,
        wtbFieldsForFirstRound
      );

      if (!Number.isFinite(sellerAskInBuyerTerms) || proposedPrice >= sellerAskInBuyerTerms) {
        return res.status(400).json({
          error: `Your counter must be lower than the current offer (€${Number(sellerAskInBuyerTerms).toFixed(2)}).`
        });
      }

      const recomputedPayoutForFirstRound = calculateMemberWtbSellerPayout(proposedPrice, sellerVatTypeForFirstRound, wtbFieldsForFirstRound);

      await airtable(COUNTER_OFFERS_TABLE).update(recordId, {
        "Store Counter Price": proposedPrice,
        "Counter Payout": recomputedPayoutForFirstRound,
        "Counter Payout VAT Type": sellerVatTypeForFirstRound
      });

      // FIXED — this update landed correctly but never notified the
      // seller at all, unlike every other edit/counter action in this
      // flow. Reuses the exact same notification the later-round
      // "buyer edited" branch below already sends.
      const sellerRecordIdForFirstRound = firstLinkedRecordId(f["Seller ID"]);
      const sellerRecordForFirstRound = sellerRecordIdForFirstRound
        ? await airtable(SELLERS_TABLE).find(sellerRecordIdForFirstRound).catch(() => null)
        : null;
      const sellerDiscordIdForFirstRound = asText(sellerRecordForFirstRound?.fields?.["Discord ID"]);

      if (sellerDiscordIdForFirstRound) {
        await sendMemberWtbCounterOfferDiscordDM({
          counterOfferRecordId: recordId,
          sellerDiscordId: sellerDiscordIdForFirstRound,
          productName: asText(wtbFieldsForFirstRound["Product Name"]),
          sku: asText(wtbFieldsForFirstRound["SKU"]),
          size: asText(wtbFieldsForFirstRound["Size"]),
          memberWtbId: asText(wtbFieldsForFirstRound["Member WTB ID"]) || memberWtbRecordIdForFirstRound,
          payout: recomputedPayoutForFirstRound,
          vatType: sellerVatTypeForFirstRound,
          sellerOriginalPrice: sellerOriginalPriceForFirstRound,
          sellerOriginalVatType: sellerVatTypeForFirstRound
        }).catch((err) => console.error("Failed to notify seller of edited first-round counter (non-blocking):", err));
      }

      // NEW — additive only: his explicit request — an edited counter
      // is still a new position, and should reach every other seller
      // still in the game the exact same way a fresh counter would.
      const sellerIdForFirstRound = firstLinkedRecordId(f["Seller ID"]);
      await reengageDeniedSellers({
        sourceType: "Member WTB",
        recordId: memberWtbRecordIdForFirstRound,
        newBuyerCounterPrice: proposedPrice,
        excludeSellerId: sellerIdForFirstRound
      }).catch((err) => console.error("Failed to re-engage other sellers after edit (non-blocking):", err));

      return res.json({ ok: true });
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

      // NEW — additive only: his explicit request — an edited counter
      // is still a new position, and should reach every other seller
      // still in the game the exact same way a fresh counter would.
      await reengageDeniedSellers({
        sourceType: "Member WTB",
        recordId: memberWtbRecordId,
        newBuyerCounterPrice: proposedPrice,
        excludeSellerId: sellerRecordId
      }).catch((err) => console.error("Failed to re-engage other sellers after edit (non-blocking):", err));

      if (sellerDiscordId) {
        // Recomputed fresh here (not reused from the earlier
        // validation block — separate if/else, different scope) — the
        // seller's actual last raw counter, off the previous round.
        const sellerCounterOnPreviousRoundForNotify = numberValue(previousFields["Seller Counter Price"]);

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
          sellerOriginalVatType: sellerVatType,
          sellerLastOfferPrice: sellerCounterOnPreviousRoundForNotify
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

    // FIXED — a real, confirmed gap found via his live testing: when
    // Retailed fails to find an exact match, this used to fall
    // straight to a broader, non-exact Retailed lookup — StockX was
    // never tried at all, even though a working Retailed→StockX
    // fallback chain already exists elsewhere in this file
    // (lookupSkuMasterProduct). His exact report: a real, existing
    // SKU not yet in SKU Master came back with the SKU itself as the
    // product name and an empty brand, since Retailed alone couldn't
    // find it. Tries an exact StockX match here too, before falling
    // back further — same pattern as lookupSkuMasterProduct (checks
    // is_exact_sku_match, auto-creates the SKU Master entry on
    // success so future lookups for this SKU are instant).
    if (!skuMaster) {
      const stockxProduct = await lookupProductFromStockx(sku).catch((err) => {
        console.error("StockX SKU lookup failed (Open WTB creation):", {
          sku,
          error: err.message
        });
        return null;
      });

      if (stockxProduct && stockxProduct.is_exact_sku_match) {
        const stockxProductName = stockxProduct.product_name || sku;

        skuMaster = await airtable(SKU_MASTER_TABLE).create({
          "SKU": sku,
          "Product Name": stockxProductName,
          "Brand": stockxProduct.brand || "",
          "Picture": stockxProduct.image
            ? [{ url: stockxProduct.image }]
            : []
        });
      }
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
      // FIXED — his explicit decision: if NEITHER Retailed nor StockX
      // could confirm an exact SKU match, silently falling back to a
      // loose, non-exact Retailed lookup risked creating a WTB with
      // the WRONG product name/brand — worse than no WTB at all,
      // since a buyer would never know it happened. Now rejects the
      // request outright with a clear, actionable error instead of
      // ever guessing.
      const error = new Error(
        `SKU "${sku}" could not be found or confirmed in our database. Please double-check the SKU and try again.`
      );
      error.statusCode = 404;
      throw error;
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
      // FIXED — this only closed status="open" rows. Anything sitting
      // in "store_pending" (a consignor's counter awaiting the store,
      // including every pre-offer row built today) would never get
      // closed here, so it would keep showing in the Portal forever
      // even after the order was fulfilled through a different
      // channel entirely.
      .in("status", ["open", "store_pending"]);

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
