import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Airtable from "airtable";
import compression from "compression";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID
} = process.env;

if (!AIRTABLE_TOKEN) {
  throw new Error("Missing AIRTABLE_TOKEN");
}

if (!AIRTABLE_BASE_ID) {
  throw new Error("Missing AIRTABLE_BASE_ID");
}

const airtable = new Airtable({
  apiKey: AIRTABLE_TOKEN
}).base(AIRTABLE_BASE_ID);

app.use(compression());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Kickz Caviar Portal"
  });
});

const ORDERS_TABLE = process.env.AIRTABLE_ORDERS_TABLE || "Unfulfilled Orders Log";

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

function getImageUrl(value) {
  if (!Array.isArray(value) || !value[0]?.url) return "";
  return value[0].url;
}

function hoursSince(value) {
  if (!value) return 0;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;

  return (Date.now() - date.getTime()) / 1000 / 60 / 60;
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

    max_offer: moneyValue(f["Maximum Buying Price"])
  };
}

app.get("/api/deals", async (req, res) => {
  try {
    const type = asText(req.query.type) || "quick";

    let formula;

    if (type === "quick") {
      formula = `AND(
        {Fulfillment Status} = 'Outsource',
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

    const records = await airtable(ORDERS_TABLE)
      .select({
        filterByFormula: formula,
        sort: [
          {
            field: "Outsource Start Time",
            direction: "desc"
          }
        ],
        maxRecords: 50
      })
      .all();

    const deals = records.map(normalizeDeal);

    res.json({
      type,
      count: deals.length,
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
