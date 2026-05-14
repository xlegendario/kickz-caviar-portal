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

app.listen(PORT, () => {
  console.log(`Kickz Caviar Portal running on port ${PORT}`);
});
