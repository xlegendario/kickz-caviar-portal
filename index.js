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
  SENDGRID_API_KEY,
  RESET_EMAIL_FROM,
  APP_PUBLIC_BASE_URL = "https://kickz-caviar-portal.onrender.com",
  LOJIQ_WMS_BASE_URL = "https://lojiq-wms.onrender.com",
  SELLER_SIGNUP_URL = "https://discord.com/channels/922818998163361792/1444130166703128676",
  DISCORD_BOT_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RETAILED_STOCKX_SEARCH_URL,
  RETAILED_API_KEY,
  AIRTABLE_DISCORD_UPDATES_URL = "https://airtable-discord-updates.onrender.com",
  COUNTER_OFFERS_SECRET,
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
const STOCK_LEVELS_TABLE = process.env.AIRTABLE_STOCK_LEVELS_TABLE || "Stock Levels";
const MERCHANTS_TABLE = process.env.AIRTABLE_MERCHANTS_TABLE || "Merchants";
const MEMBER_WTBS_TABLE = process.env.AIRTABLE_MEMBER_WTBS_TABLE || "Member WTBs";

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
    GatewayIntentBits.Guilds
  ]
});

let discordReady = false;
let kickzDealDiscordReady = false;
let consignmentButtonsBound = false;
let kickzDealButtonsBound = false;

async function initDiscord() {
  if (discordReady) return;

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
}

async function initKickzDealDiscord() {
  if (kickzDealDiscordReady) return;

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

  console.log("✅ Kickz deal Discord bot logged in");
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

async function sendMemberWtbDealUpdateAfterPayment(memberWtbRecordId) {
  console.log("TODO: send Member WTB deal update + label request", {
    memberWtbRecordId
  });

  return true;
}

async function sendMemberWtbPaymentRequest(memberWtbRecordId, memberFields, buyerSeller) {
  await initKickzDealDiscord();

  const discordUserId = asText(buyerSeller.discord_id || buyerSeller.discord_user_id || buyerSeller.discord_id_raw);

  if (!discordUserId) {
    throw new Error("Buyer is missing Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(discordUserId);
  const dm = await user.createDM();

  const amount = Number(memberFields["Final Buying Price"] || memberFields["Max Price"] || 0);
  const memberWtbId =
    asText(memberFields["Member WTB ID"]) ||
    asText(memberFields["WTB ID"]) ||
    memberWtbRecordId;

  const message = await dm.send({
    embeds: [{
      title: "💳 Payment Required",
      description: [
        `**Member WTB:** ${memberWtbId}`,
        "",
        `**Product:** ${asText(memberFields["Product Name"]) || "—"}`,
        `**SKU:** ${asText(memberFields["SKU"]) || "—"}`,
        `**Size:** ${asText(memberFields["Size"]) || "—"}`,
        "",
        `**Amount:** €${amount.toFixed(2)}`,
        "",
        "**Payment details**",
        "Name: Kickz Caviar",
        "IBAN: NL21INGB0109644271",
        `Reference: ${memberWtbId}`,
        "",
        "OR",
        "",
        "Paypal: financial@payoutbykickzcaviar.com",
        `Reference: ${memberWtbId}`,
        "",
        "After payment, click **Confirm Payment** below."
      ].join("\n"),
      color: 0xf1c40f,
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 3,
        label: "Confirm Payment",
        custom_id: `confirm_member_wtb_payment:${memberWtbRecordId}`
      }]
    }]
  });

  await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
    "Payment Status": "Requested",
    "Payment Request Channel ID": message.channelId,
    "Payment Request Message ID": message.id
  });

  return {
    channelId: message.channelId,
    messageId: message.id
  };
}

async function handleMemberWtbPaymentGate(memberWtbRecordId) {
  const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
  const f = memberWtb.fields || {};

  const currentPaymentStatus = asText(f["Payment Status"]);

  if (
    currentPaymentStatus === "Requested" ||
    currentPaymentStatus === "Paid" ||
    currentPaymentStatus === "Trusted"
  ) {
    return {
      status: "already_processed",
      payment_status: currentPaymentStatus
    };
  }

  const buyerRecordId = Array.isArray(f["Buyer Seller ID"])
    ? f["Buyer Seller ID"][0]
    : null;

  if (!buyerRecordId) {
    throw new Error("Member WTB missing Buyer Seller ID");
  }

  const buyerRecord = await airtable(SELLERS_TABLE).find(buyerRecordId);
  const buyerFields = buyerRecord.fields || {};
  const buyer = normalizeSeller(buyerRecord);

  const trustedBuyer = buyerFields["Trusted Buyer?"] === true;

  if (trustedBuyer) {
    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      "Payment Status": "Trusted",
      "Payment Confirmed At": new Date().toISOString()
    });

    await sendMemberWtbDealUpdateAfterPayment(memberWtbRecordId);

    return {
      status: "trusted"
    };
  }

  await sendMemberWtbPaymentRequest(memberWtbRecordId, f, buyer);

  return {
    status: "requested"
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
  await initDiscord();

  const wasOfferDeliveredByDm = offer.discord_delivery_type === "dm";

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
      selling_price: maxPrice,
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
      "Final Buying Price": maxPrice
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
      !customId.startsWith("confirm_member_wtb_kc:") &&
      !customId.startsWith("deny_member_wtb_kc:") &&
      !customId.startsWith("accept_member_wtb_kc_offer:") &&
      !customId.startsWith("deny_member_wtb_kc_offer:") &&
      !customId.startsWith("confirm_member_wtb_payment:")
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

    await interaction.deferUpdate().catch(() => {});

    if (customId.startsWith("confirm_member_wtb_payment:")) {
      const memberWtbRecordId = customId.split(":")[1];
    
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const f = memberWtb.fields || {};
    
      if (!["Requested", "Pending"].includes(asText(f["Payment Status"]))) {
        await interaction.message.edit({
          content: "❌ Payment is already processed or this request is no longer active.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Payment Status": "Paid",
        "Payment Confirmed At": new Date().toISOString()
      });
    
      await interaction.message.edit({
        content: "✅ Payment confirmed.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      await sendMemberWtbDealUpdateAfterPayment(memberWtbRecordId);
    
      return;
    }

    if (customId.startsWith("confirm_member_wtb_kc:")) {
      const memberWtbRecordId = customId.split(":")[1];
    
      const memberWtb = await airtable(MEMBER_WTBS_TABLE).find(memberWtbRecordId);
      const f = memberWtb.fields || {};
    
      if (asText(f["Purchase Status"]) !== "KC Pending") {
        await interaction.message.edit({
          content: "❌ This KC confirmation is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      const inventoryUnitId = asText(f["Buying Selected Source ID"]);
      const maxPrice = Number(f["Max Price"] || 0);
    
      if (!inventoryUnitId) {
        await interaction.message.edit({
          content: "❌ Missing selected KC Inventory Unit.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).find(inventoryUnitId);
      const inventoryStatus = asText(inventoryUnit.fields?.["Availability Status"]);
    
      if (inventoryStatus !== "Available") {
        await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
          "Purchase Status": "Out Of Stock"
        });
    
        await interaction.message.edit({
          content: "❌ KC stock is no longer available.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      await airtable(INVENTORY_UNITS_TABLE).update(inventoryUnitId, {
        "Availability Status": "Reserved",
        "Selling Method": "Kickz Caviar",
        "Selling Price": maxPrice
      });
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Purchase Status": "Confirmed",
        "Fulfillment Status": "Allocated",
        "Linked Inventory Unit": [inventoryUnitId],
        "Final Buying Price": maxPrice
      });
    
      await interaction.message.edit({
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
        await interaction.message.edit({
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
    
      await interaction.message.edit({
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
        await interaction.message.edit({
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
        await interaction.message.edit({
          content: "❌ No available KC stock found for this SKU / size.",
          embeds: interaction.message.embeds,
          components: []
        });
        return;
      }
    
      await airtable(INVENTORY_UNITS_TABLE).update(inventoryUnit.id, {
        "Availability Status": "Reserved",
        "Selling Method": "Kickz Caviar",
        "Selling Price": maxPrice,
        "Member WTBs": [memberWtbRecordId]
      });
    
      await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
        "Purchase Status": "Confirmed",
        "Fulfillment Status": "Allocated",
        "Linked Inventory Unit": [inventoryUnit.id],
        "Final Buying Price": maxPrice
      });

      await closeCompetingMemberWtbOffers(memberWtbRecordId, null);

      await handleMemberWtbPaymentGate(memberWtbRecordId);
    
      await interaction.message.edit({
        content: "✅ KC stock accepted and allocated.",
        embeds: interaction.message.embeds,
        components: []
      });
    
      return;
    }
    
    if (customId.startsWith("deny_member_wtb_kc_offer:")) {
      await interaction.message.edit({
        content: "❌ KC denied this Member WTB offer.",
        embeds: interaction.message.embeds,
        components: []
      });
    
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
    
      await disableCounterOfferDiscordButtons(
        interaction.channelId,
        interaction.message.id,
        "✅ Counter offer accepted."
      );
    
      const competingCounters = await airtable(COUNTER_OFFERS_TABLE)
        .select({
          filterByFormula: `AND(
            {Status} = 'Open',
            RECORD_ID() != '${counterOfferRecordId}',
            FIND('${linkedOrderId}', ARRAYJOIN({Order}))
          )`
        })
        .all();
      
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
      
        await interaction.message.edit({
          content: interaction.message.content,
          embeds: interaction.message.embeds,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Label Requested",
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
        const result = await confirmConsignmentOffer(offerId);

        await disableConsignmentDiscordButtons(
          interaction.channelId,
          interaction.message.id,
          result.ok
            ? `✅ Confirmed by ${result.offer.seller_id}.`
            : "❌ This offer is no longer available.",
          client
        );

        return;
      }
    } catch (err) {
      console.error("Consignment Discord button error:", err);
    }
  });
}

app.use(compression());
app.use(express.json({ limit: "25mb" }));

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

          await refreshConsignmentStockLevel(existing.sku, existing.size);
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

        await refreshConsignmentStockLevel(row.sku, row.size);
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
      }

      processed = i + 1;

      await updateCsvImportJob(job.id, {
        processed_rows: processed
      });
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
          vatType: sellerVatType
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

function firstLinkedRecordId(value) {
  return Array.isArray(value) && value.length ? value[0] : "";
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

async function sendCounterOfferDiscordDM({
  counterOfferRecordId,
  sellerDiscordId,
  productName,
  sku,
  size,
  orderId,
  payout,
  vatType
}) {
  await initKickzDealDiscord();

  if (!sellerDiscordId) {
    throw new Error("Missing seller Discord ID");
  }

  const user = await kickzDealDiscordClient.users.fetch(sellerDiscordId);
  const dm = await user.createDM();

  const message = await dm.send({
    embeds: [
      {
        title: `🔁 Counter Offer: ${sku} / ${size}`,
        description: [
          `**${productName || "—"}**`,
          "",
          `Order: ${orderId || "—"}`,
          "",
          `The store sent a counter offer.`,
          "",
          `**Your payout**`,
          `€${Number(payout).toFixed(2)} · ${vatType || "—"}`,
          "",
          "Accept if you can fulfill this order at the counter price."
        ].join("\n"),
        color: 0xf1c40f
      }
    ],
    components: [
      {
        type: 1,
        components: [
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
      }
    ]
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
    deliveryType: "dm"
  };
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

async function postConsignmentCounterStoreOffer({
  offer,
  orderFields,
  storeOfferPrice,
  storeOfferVatType
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
      consignor_vat_type: offer.vat_type
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

    const productName = [
      asText(match.name),
      asText(match.colorway)
    ].filter(Boolean).join(" ");

    return {
      product_name: productName || cleanSku,
      brand: asText(match.brand),
      image: asText(match.image),
      slug: asText(match.slug),
      raw: match
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupSkuMasterProduct(sku) {
  const cleanSku = asText(sku).toUpperCase();

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

  const retailedProduct = await lookupProductFromRetailed(cleanSku);

  await airtable(SKU_MASTER_TABLE).create({
    "SKU": cleanSku,
    "Product Name": retailedProduct.product_name,
    "Brand": retailedProduct.brand,
    "Picture": retailedProduct.image
      ? [{ url: retailedProduct.image }]
      : [],
    "Seller Generated?": true
  });

  return {
    product_name: retailedProduct.product_name,
    brand: retailedProduct.brand
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

    const linkedOrderIds = [
      ...new Set(
        filteredOffers
          .map((record) => firstLinkedRecordId(record.fields?.["Linked Orders"]))
          .filter(Boolean)
      )
    ];

    const orderMap = await loadOrderFieldsMap(linkedOrderIds);

    const acceptedOffers = filteredOffers.filter((record) => {
      const linkedOrderId = firstLinkedRecordId(record.fields?.["Linked Orders"]);
      const orderFields = orderMap.get(linkedOrderId) || {};
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
      const orderFields = orderMap.get(linkedOrderId) || {};

      const offerAmount = numberValue(f["Seller Offer"]);

      return {
        id: record.id,
        order_record_id: linkedOrderId,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"] || orderFields["Product Name"]),
        sku: displayValue(f["SKU"] || orderFields["SKU"]),
        size: displayValue(f["Size"] || orderFields["Size"]),
        brand: displayValue(f["Brand"] || orderFields["Brand"]),
        offer: moneyWholeValue(offerAmount),
        vat_type: displayValue(f["Offer VAT Type"]),
        date: formatDateEU(f["Offer Date"]),
        raw_date: f["Offer Date"],
        status: "Offer accepted, waiting processing.."
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
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
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
          {Fulfillment Status (UOL)} = 'Allocated'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
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
      const channelId = displayValue(orderFields["WTB Created Channel ID"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
        order_record_id: linkedOrderId,
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

    const offerRecords = await airtable(SELLER_OFFERS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Linked Orders",
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
        const linkedOrderId = firstLinkedRecordId(record.fields?.["Linked Orders"]);
        const orderFields = offerOrderMap.get(linkedOrderId) || {};
    
        return orderFields["Channel Created?"] === true;
      })
      .map((record) => {
        const f = record.fields || {};
        const linkedOrderId = firstLinkedRecordId(f["Linked Orders"]);
        const orderFields = offerOrderMap.get(linkedOrderId) || {};
        const channelId = displayValue(orderFields["WTB Created Channel ID"]);
    
        return {
          id: record.id,
          order_id: displayValue(orderFields["Order ID"]),
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
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
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
          {Fulfillment Status (UOL)} = 'Requested Label'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
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
      const channelId = displayValue(orderFields["WTB Created Channel ID"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
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
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
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
          {Fulfillment Status (UOL)} = 'Ready to Ship'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
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
      const channelId = displayValue(orderFields["WTB Created Channel ID"]);

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
          "Shipping Status",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
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
          {Shipping Status} = 'Shipped'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
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
      const channelId = displayValue(orderFields["WTB Created Channel ID"]);
      const trackingUrl = displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
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
          "Payment Status",
          "Seller Offer",
          "Final Purchase Price",
          "Unfulfilled Orders Log",
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
          {Shipping Status} = 'Delivered',
          {Payment Status} = 'To Pay'
        )`
      })
      .all();

    const filteredInventory = inventoryRecords.filter((record) => {
      const f = record.fields || {};

      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
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
      const channelId = displayValue(orderFields["WTB Created Channel ID"]);
      const trackingUrl = displayValue(orderFields["Tracking URL"]);

      return {
        id: record.id,
        order_id: displayValue(orderFields["Order ID"]),
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
          "Seller Offer",
          "Offer VAT Type",
          "Offer Date",
          "Fulfillment Status",
          "Product Name",
          "SKU",
          "Size",
          "Brand"
        ],
        filterByFormula: `{Fulfillment Status} = 'Outsource'`
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
      const orderFields = orderMap.get(linkedOrderId) || {};

      const vatType = displayValue(f["Offer VAT Type"]);
      const offerAmount = numberValue(f["Seller Offer"]);

      const currentLowest =
        vatType === "VAT0"
          ? numberValue(orderFields["Current Lowest (VAT0)"])
          : numberValue(orderFields["Current Lowest (Normalized)"]);

      const isLowest =
        displayValue(orderFields["Lowest Offer Seller ID"]) ===
        displayValue(req.query.seller_id);

      return {
        id: record.id,
        order_record_id: linkedOrderId,
        order_id: displayValue(orderFields["Order ID"]),
        product: displayValue(f["Product Name"] || orderFields["Product Name"]),
        sku: displayValue(f["SKU"] || orderFields["SKU"]),
        size: displayValue(f["Size"] || orderFields["Size"]),
        brand: displayValue(f["Brand"] || orderFields["Brand"]),
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
          filterByFormula: `{Fulfillment Status} = 'Outsource'`
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
          fields: ["Seller ID", "Linked Orders"],
          filterByFormula: `{Fulfillment Status} = 'Confirmed'`
        })
        .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Allocated'
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Requested Label'
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Fulfillment Status (UOL)} = 'Ready to Ship'
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Shipping Status} = 'Shipped'
        )`
      })
      .all(),

      airtable(INVENTORY_UNITS_TABLE)
      .select({
        fields: [
          "Seller ID",
          "Seller Offer"
        ],
        filterByFormula: `AND(
          LEFT({Item ID} & '', 4) = 'OUT-',
          {Type} = 'Custom',
          {Shipping Status} = 'Delivered',
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
      const linkedOrderId = firstLinkedRecordId(record.fields?.["Linked Orders"]);
      const orderFields = wtbAcceptedOrderMap.get(linkedOrderId) || {};
    
      return (
        displayValue(orderFields["Partner or Seller"]) === "Seller" &&
        displayValue(orderFields["Lowest Offer Seller ID"]) === sellerCode
      );
    }).length;

    const wtbConfirmed = wtbConfirmedRecords.filter((record) => {
      const f = record.fields || {};
    
      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
      );
    }).length;

    const wtbLabelRequested = wtbLabelRequestedRecords.filter((record) => {
      const f = record.fields || {};
    
      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
      );
    }).length;

    const wtbReadyToShip = wtbReadyToShipRecords.filter((record) => {
      const f = record.fields || {};
    
      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
      );
    }).length;

    const wtbShipped = wtbShippedRecords.filter((record) => {
      const f = record.fields || {};
    
      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
      );
    }).length;

    const wtbDelivered = wtbDeliveredRecords.filter((record) => {
      const f = record.fields || {};
    
      return (
        linkedRecordIncludes(f["Seller ID"], sellerRecordId) &&
        !linkedRecordIsEmpty(f["Seller Offer"])
      );
    }).length;

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
      `AND({Type} = 'Consignment', {Fulfillment Status (UOL)} = 'Allocated')`,
      false
    );
    
    const consignmentLabelRequestedCount = await loadInventoryCount(
      `AND({Type} = 'Consignment', {Fulfillment Status (UOL)} = 'Requested Label')`,
      false
    );
    
    const consignmentReadyToShipCount = await loadInventoryCount(
      `AND({Type} = 'Consignment', {Fulfillment Status (UOL)} = 'Ready to Ship')`,
      false
    );
    
    const consignmentShippedCount = await loadInventoryCount(
      `AND({Type} = 'Consignment', {Shipping Status} = 'Shipped')`,
      false
    );
    
    const consignmentDeliveredCount = await loadInventoryCount(
      `AND({Type} = 'Consignment', {Shipping Status} = 'Delivered', {Payment Status} = 'To Pay')`,
      false
    );

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
        {Fulfillment Status (UOL)} = '${escapeFormulaValue(status)}'
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
    const linkedOrderId =
      firstLinkedRecordId(f["Unfulfilled Orders Log"]);

    const orderFields =
      orderMap.get(linkedOrderId) || {};

    const labelUrl =
      displayValue(orderFields["Shipping Label URL (Permanent)"]) ||
      displayValue(orderFields["Shipping Label"]);
    
    const trackingUrl =
      displayValue(orderFields["Tracking URL"]);
    
    return {
      id: record.id,
      order_id: displayValue(orderFields["Order ID"]),
      order_record_id: linkedOrderId,
      product: displayValue(f["Product Name"]),
      sku: displayValue(f["SKU"]),
      size: displayValue(f["Size"]),
      brand: displayValue(f["Brand"]),
      payout: moneyWholeValue(f["Purchase Price"]),
      vat_type: displayValue(f["VAT Type"]),
      date: formatDateEU(f["Purchase Date"]),
      raw_date: f["Purchase Date"],
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
          {Fulfillment Status (UOL)} = 'Allocated'
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
        order_record_id: linkedOrderId,
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        payout: moneyWholeValue(f["Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        date: formatDateEU(f["Purchase Date"]),
        raw_date: f["Purchase Date"]
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
      vatType
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
        vatType
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
    const deals = records.map(normalizeDeal);
    
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

    const rawConsignmentRows = await fetchAllConsignmentInventoryRows();

    const consignmentStockKeys = [
      ...new Set(
        (rawConsignmentRows || [])
          .map((row) => getStockCounterKey(row.sku, row.size))
          .filter(Boolean)
      )
    ];

    let consignmentStockLevelMap = new Map();

    if (consignmentStockKeys.length) {
      const { data: consignmentStockLevels, error: consignmentStockLevelError } =
        await supabase
          .from("consignment_stock_levels")
          .select("stock_counter_key, stock_level, lowest_suggested_price")
          .in("stock_counter_key", consignmentStockKeys);

      if (consignmentStockLevelError) throw consignmentStockLevelError;

      consignmentStockLevelMap = new Map(
        (consignmentStockLevels || []).map((row) => [
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

    const purchasePrice = Number(offerFields['Seller Offer'] || 0);
    const vatType = asText(offerFields['Offer VAT Type']);
    const maxPrice = Number(memberFields['Max Price'] || 0);

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
      'Selling Price': maxPrice,
      'Selling Method': 'Kickz Caviar',
      'Member WTBs': [memberWtbRecordId]
    };

    const inventoryUnit = await airtable(INVENTORY_UNITS_TABLE).create(inventoryFields);

    await fetch("https://hook.eu2.make.com/cmq6wlbq5sa9spmwogy4pdordvjzuz4i", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: "member_wtb_seller_inventory_unit_created",
        inventory_unit_record_id: inventoryUnit.id,
        seller_offer_record_id: sellerOfferRecordId,
        member_wtb_record_id: memberWtbRecordId,
    
        product_name: inventoryFields["Product Name"],
        sku: inventoryFields["SKU"],
        size: inventoryFields["Size"],
        brand: inventoryFields["Brand"],
        vat_type: vatType,
    
        purchase_price: purchasePrice,
        shipping_deduction: 0,
        purchase_date: inventoryFields["Purchase Date"],
    
        seller_record_id: sellerRecordId,
        ticket_number: memberWtbId,
        order_id: memberWtbId,
    
        type: "Custom",
        source: "Outsourced",
        verification_status: "Verified",
        payment_note: `€${purchasePrice.toFixed(2)}`,
        payment_status: "To Pay",
        availability_status: "Sold",
        selling_price: maxPrice,
        selling_method: "Kickz Caviar",
    
        airtable_fields: inventoryFields,
        created_at: new Date().toISOString()
      })
    });

    await airtable(MEMBER_WTBS_TABLE).update(memberWtbRecordId, {
      'Purchase Status': 'Confirmed',
      'Fulfillment Status': 'Allocated',
      'Linked Inventory Unit': [inventoryUnit.id],
      'Final Buying Price': maxPrice
    });
    
    await disableMemberWtbKcOfferButtons(
      memberWtbRecordId,
      "❌ This Member WTB was already allocated to another seller."
    );

    await handleMemberWtbPaymentGate(memberWtbRecordId);

    return res.json({
      ok: true,
      inventory_unit_record_id: inventoryUnit.id,
      member_wtb_record_id: memberWtbRecordId,
      seller_offer_record_id: sellerOfferRecordId
    });
  } catch (err) {
    console.error('Failed to process Member WTB seller offer:', err);

    return res.status(500).json({
      error: 'Failed to process Member WTB seller offer',
      details: err.message
    });
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
      "Date": new Date().toLocaleDateString("en-CA"),

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
      "Date": new Date().toLocaleDateString("en-CA"),

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

app.listen(PORT, () => {
  console.log(`Kickz Caviar Portal running on port ${PORT}`);
});
