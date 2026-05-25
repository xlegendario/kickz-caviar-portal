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
  SELLER_SIGNUP_URL = "https://discord.com/channels/922818998163361792/1444130166703128676",
  DISCORD_BOT_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RETAILED_STOCKX_SEARCH_URL,
  RETAILED_API_KEY
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
const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const STOCK_LEVELS_TABLE = process.env.AIRTABLE_STOCK_LEVELS_TABLE || "Stock Levels";
const MERCHANTS_TABLE = process.env.AIRTABLE_MERCHANTS_TABLE || "Merchants";

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
    "Base Costs": 5,

    "Unfulfilled Orders Log": [offer.order_record_id],
  };

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

  const sellerComparePrice =
    getConsignmentComparePrice(
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
    const discordUserId = asText(seller?.discord_id);

    if (!discordUserId) {
      throw new Error(
        `Missing Discord ID for seller ${seller?.seller_id || offer.seller_id}`
      );
    }

    const user = await discordClient.users.fetch(discordUserId);
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
            label: "Confirm",
            custom_id: `confirm_offer:${offer.id}`
          },
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

async function disableConsignmentDiscordButtons(channelId, messageId, note) {
  try {
    const channel = await discordClient.channels.fetch(channelId);

    if (!channel) return;

    const message = await channel.messages.fetch(messageId);

    if (!message) return;

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
  } catch (err) {
    console.error("Failed to disable consignment buttons:", err);
  }
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
  await initDiscord();

  const discordUserId = asText(seller?.discord_id);

  if (!discordUserId) return null;

  const user = await discordClient.users.fetch(discordUserId);
  const dm = await user.createDM();

  const message = await dm.send({
    content: `Your deal channel has been created: <#${channelId}>`
  });

  return {
    channelId: message.channelId,
    messageId: message.id
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
  await initDiscord();

  const discordUserId = asText(seller?.discord_id);

  if (!discordUserId) {
    throw new Error(`Missing Discord ID for seller ${seller?.seller_id}`);
  }

  const user = await discordClient.users.fetch(discordUserId);
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
    messageId: message.id
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
    "Fulfillment Status": "Label Requested"
  });

  return {
    ok: true
  };
}

function bindConsignmentDiscordButtons(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = String(interaction.customId || "");

    if (
      !customId.startsWith("confirm_offer:") &&
      !customId.startsWith("deny_offer:") &&
      !customId.startsWith("request_consignment_label:")
    ) {
      return;
    }
    
    await interaction.deferUpdate().catch(() => {});

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
            : "❌ This offer is no longer available."
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
            : "❌ This offer is no longer available."
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

    if (rows.length > 500) {
      return res.status(400).json({
        error: "CSV upload is limited to 500 rows"
      });
    }

    const results = [];

    for (const row of rows) {
      const sku = asText(row.sku).toUpperCase();
      const size = asText(row.size);
      const vatType = asText(row.vat_type);
      const sellingPriceSuggested = Number(row.selling_price_suggested);
      const quantity = Number(row.quantity);

      if (!sku || !size) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: missing SKU or Size`
        });
      }

      if (!["Margin", "VAT0", "VAT21"].includes(vatType)) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid VAT Type`
        });
      }

      if (!Number.isFinite(sellingPriceSuggested) || sellingPriceSuggested <= 0) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid Selling Price`
        });
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid Quantity`
        });
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

      results.push(result);
    }

    res.json({
      ok: true,
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Failed to add consignment inventory through CSV:", err);

    res.status(500).json({
      error: "Failed to add consignment inventory through CSV",
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

    if (rows.length > 500) {
      return res.status(400).json({
        error: "CSV upload is limited to 500 rows"
      });
    }

    const normalizedRows = rows.map((row) => ({
      row_number: row.row_number,
      sku: asText(row.sku).toUpperCase(),
      size: asText(row.size),
      vat_type: asText(row.vat_type),
      selling_price_suggested: Number(row.selling_price_suggested),
      quantity: Number(row.quantity)
    }));

    const csvKeys = new Set();

    for (const row of normalizedRows) {
      const key = getStockCounterKey(row.sku, row.size);

      if (!row.sku || !row.size) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: missing SKU or Size`
        });
      }

      if (csvKeys.has(key)) {
        return res.status(400).json({
          error: `Duplicate SKU + Size in CSV: ${row.sku} / ${row.size}`
        });
      }

      csvKeys.add(key);

      if (!["Margin", "VAT0", "VAT21"].includes(row.vat_type)) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid VAT Type`
        });
      }

      if (!Number.isFinite(row.selling_price_suggested) || row.selling_price_suggested <= 0) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid Selling Price`
        });
      }

      if (!Number.isInteger(row.quantity) || row.quantity < 0) {
        return res.status(400).json({
          error: `Invalid row ${row.row_number || ""}: invalid Quantity`
        });
      }
    }

    const { data: existingRows, error: existingError } = await supabase
      .from("consignment_inventory")
      .select("id, sku, size, quantity")
      .eq("seller_record_id", sellerRecordId);

    if (existingError) throw existingError;

    const touchedItems = new Map();

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

        touchedItems.set(key, {
          sku: existing.sku,
          size: existing.size
        });
      }
    }

    const results = [];

    for (const row of normalizedRows) {
      const result = await setConsignmentInventoryRow({
        sellerRecordId,
        sellerId,
        sku: row.sku,
        size: row.size,
        vatType: row.vat_type,
        sellingPriceSuggested: row.selling_price_suggested,
        quantity: row.quantity
      });

      results.push(result);
      
      touchedItems.set(getStockCounterKey(row.sku, row.size), {
        sku: row.sku,
        size: row.size
      });
    }

    for (const item of touchedItems.values()) {
      await refreshConsignmentStockLevel(item.sku, item.size);
    }

    res.json({
      ok: true,
      count: results.length,
      zeroed: Math.max(0, touchedItems.size - results.length),
      results
    });
  } catch (err) {
    console.error("Failed to replace consignment inventory through CSV:", err);

    res.status(500).json({
      error: "Failed to replace consignment inventory through CSV",
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

app.post("/api/consignment/offers/create", async (req, res) => {
  try {
    const orderRecordId = asText(req.body?.order_record_id);
    const orderId = asText(req.body?.order_id);
    const sku = asText(req.body?.sku).toUpperCase();
    const size = asText(req.body?.size);
    const maximumBuyingPrice = Number(req.body?.maximum_buying_price);

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
      calculateConsignmentOfferPrice(
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

function roundUpToStep(value, step = 2.5) {
  return Math.ceil(Number(value || 0) / step) * step;
}

function roundDownToStep(value, step = 2.5) {
  return Math.floor(Number(value || 0) / step) * step;
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
      `${APP_PUBLIC_BASE_URL.replace(/\/$/, "")}/label-request.html?record_id=${encodeURIComponent(orderRecord.id)}`;


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

app.listen(PORT, () => {
  console.log(`Kickz Caviar Portal running on port ${PORT}`);
});
