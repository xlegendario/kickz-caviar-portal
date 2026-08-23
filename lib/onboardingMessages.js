// lib/onboardingMessages.js
//
// De berichten die voorheen door de losse seller-registration bot werden
// verstuurd. Die service kan uit: registreren gebeurt nu op de portal, en de
// twee dingen die overblijven — een welkomst-DM en de DM's die Make aanroept —
// draaien hier mee in de portal, die al een Discord-client heeft.
//
// Alleen de tekst zit hier, zonder Discord- of Airtable-aanroepen, zodat de
// inhoud te testen is zonder een bot te starten.

// Het oude registratiekanaal stuurde mensen door een reeks Discord-modals.
// Dat is vervangen door één formulier op de portal, dus elke verwijzing naar
// "klik SIGN UP hieronder" wijst nu naar die pagina.
export function buildWelcomeMessage({ username, signupUrl, dealsUrl }) {
  return {
    title: "👋 Welcome to Kickz Caviar",
    description: [
      `Hey **${username}**!`,
      "",
      "Glad to have you here 🤝",
      "",
      "This is where sellers get:",
      "• ⚡ Daily WTB's & Quick Deals",
      "• 💸 Fast payouts",
      "• 🏆 Monthly leaderboards for top sellers & inviters",
      "",
      `👀 **[See what we're buying right now](${dealsUrl})**`,
      "",
      "Found something you can supply? Create your profile once, and after that it's two clicks per deal.",
      "",
      `👉 **[Create your seller profile](${signupUrl})**`,
      "",
      "Sold with us before? Use the same page to log in."
    ].join("\n")
  };
}

// Wordt door Make aangeroepen wanneer iemand het volledige Sales Agreement-
// formulier invult terwijl hij allang een profiel heeft.
export function buildExistingSellerMessage({ username, sellerId, email, orderId, inviteUrl }) {
  const lines = [`Hey **${username}**!`, ""];

  lines.push(
    "We noticed you just filled in the full **Sales Agreement** form, but you already have an active Seller Profile with **Payout by Kickz Caviar**.",
    ""
  );

  lines.push(`Your **Seller ID** is: \`${sellerId}\`.`);
  if (email) lines.push(`This seller profile is registered on: \`${email}\`.`);
  if (orderId) lines.push(`This message is about order **${orderId}**.`);
  lines.push("");

  lines.push("Next time, you don't need to fill a form again.", "");

  if (inviteUrl) {
    lines.push(
      "Join the **Payout by Kickz Caviar** server below to benefit from **instant deals and many more sales opportunities**!",
      "",
      `👉 [Click here](${inviteUrl})`
    );
  }

  lines.push(
    "",
    "If you think this is a mistake or you need help with something, just contact support in the server.",
    "",
    "Thanks for selling with us 🙌"
  );

  return lines.join("\n");
}

// Wordt door Make aangeroepen als een deal rond is.
export function buildDealConfirmationMessage({
  name,
  sellerId,
  orderId,
  sku,
  size,
  payout,
  orderDate,
  inviteUrl
}) {
  const lines = [`Hey **${name}**!`, ""];

  lines.push(
    "Thank you for choosing to deal with **Payout by Kickz Caviar**!",
    "We're happy to have completed this order with you.",
    ""
  );

  const summary = [];
  if (orderId) summary.push(`• **Order ID:** ${orderId}`);
  if (sku) summary.push(`• **SKU:** ${sku}`);
  if (size) summary.push(`• **Size:** ${size}`);
  if (payout) summary.push(`• **Payout:** €${payout}`);
  if (orderDate) summary.push(`• **Date:** ${orderDate}`);

  if (summary.length) {
    lines.push("**Deal Summary**", "", ...summary, "");
  }

  lines.push("Next time, you can make deals much faster.", "");

  if (inviteUrl) {
    lines.push(
      "Join the **Payout by Kickz Caviar** server below to benefit from **instant deals and many more sales opportunities**!",
      "",
      `👉 [Click here](${inviteUrl})`,
      ""
    );
  }

  lines.push(
    `Your **Seller ID** is: \`${sellerId}\`.`,
    "",
    "If you ever lose your Seller ID, just use **Seller ID Check** inside the server to retrieve it again.",
    "",
    "Thanks for selling with us 🙌"
  );

  return lines.join("\n");
}

// Het embed in het registratiekanaal. De knop die vroeger een reeks modals
// opende is een gewone link naar de portal geworden; Seller ID Check blijft,
// want dat is de snelste manier voor iemand die zijn ID kwijt is.
export function buildRegistrationChannelMessage({ signupUrl, dealsUrl }) {
  return {
    title: "🖊️ Become a Seller",
    description: [
      "Want to sell to **Kickz Caviar**? You register once, and after that every deal is two clicks.",
      "",
      `👀 **[See what we're buying right now](${dealsUrl})**`,
      "",
      "**Registering**",
      "One form with your details, then link your Discord in a single click. That link is what lets us open a private channel with you the moment a deal is accepted.",
      "",
      `👉 **[Create your seller profile](${signupUrl})**`,
      "",
      "**Already sold with us before?**",
      "Use the same page to log in. And if you want to know which Seller ID is on your account, click below — you don't need it to make deals any more, we recognise you by your Discord."
    ].join("\n")
  };
}

// De DM met het Seller ID direct na registratie.
//
// Deze tekst kwam uit de Discord-module van het Make-scenario, en werd daardoor
// verstuurd door Make's eigen Discord-app ("Integromat") in plaats van door de
// bot van Kickz Caviar. De portal weet op het moment van koppelen zowel het
// Seller ID als het Discord ID, dus die kan het net zo goed zelf sturen — met
// de juiste afzender.
export function buildSellerIdMessage({ sellerId }) {
  return [
    "Hey! Your seller profile has been created successfully.",
    "",
    `Your **Seller ID** is: \`${sellerId}\``,
    "",
    "Please keep this ID safe, you'll need it whenever you sell through Payout by Kickz Caviar.",
    "",
    "If you ever lose it, just use **Seller ID Check** in the server to retrieve it again.",
    "",
    "Welcome aboard! 🚀"
  ].join("\n");
}
