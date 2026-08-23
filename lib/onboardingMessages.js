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
export function buildWelcomeMessage({ username, signupUrl }) {
  return {
    title: "👋 Welcome to Kickz Caviar",
    description: [
      `Hey **${username}**!`,
      "",
      "Glad to have you here 🤝",
      "",
      "This server is where verified sellers get access to:",
      "• ⚡ Daily WTB's & Quick Deals",
      "• 💸 Fast payouts",
      "• 🏆 Monthly Leaderboards for Top Sellers & Inviters",
      "",
      "🚨 **Before you can make a deal**",
      "You need a **Seller ID**. It takes one form, and you only ever do it once.",
      "",
      `👉 **[Create your seller profile](${signupUrl})**`,
      "",
      "Sold with us before? Use the same page to log in — your Seller ID is already there.",
      "",
      "Once that's done, you're ready to start dealing 🚀"
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
export function buildRegistrationChannelMessage({ signupUrl }) {
  return {
    title: "🖊️ Seller Registration",
    description: [
      "Welcome to the **Kickz Caviar** seller onboarding.",
      "",
      "To make deals with us you need a **Seller ID**. Creating one takes a single form:",
      "",
      `👉 **[Create your seller profile](${signupUrl})**`,
      "",
      "You fill in your details, link your Discord in one click, and you're done. After that you can offer on any deal straight away.",
      "",
      "Not sure whether you already have a Seller ID, or forgot what it was?",
      "",
      "Click **Seller ID Check** below. If your profile is linked to this Discord, it will show you your Seller ID."
    ].join("\n")
  };
}
