/**
 * discord-gate.js — the "link your Discord" dialog, shared by both pages.
 *
 * WHY ITS OWN FILE
 *
 * The dashboard and the home page both need this, and the home page needs
 * it most: Quick Deals are claimed there. Writing it twice is how the two
 * drift apart - one gets the new wording, the other keeps the old, and
 * nobody notices because each looks fine on its own. That has already
 * happened here more than once.
 *
 * So: one file, loaded by both. It brings its own markup and its own
 * styling, which is also why it does not reuse .dashboard-modal - those
 * rules live in dashboard.css and the home page does not load it.
 *
 * WHAT IT DOES
 *
 *   window.kcDiscordGate.schedule(seller)  reminder, after a delay
 *   window.kcDiscordGate.open(reason)      straight away
 *
 * The delay is the point. Straight after loading it read as a door slamming
 * shut before you had done anything. Half a minute in, the same words read
 * as a reminder. A refused action opens it immediately instead - waiting
 * there would mean clicking and having nothing happen.
 *
 * Refusals are caught by wrapping fetch once, rather than at each call
 * site. The dashboard alone makes over a hundred; whoever adds the next one
 * would have to remember, and would not.
 */
(function () {
  const VERTRAGING_MS = 10000;

  const TEKST = {
    not_linked: {
      titel: "Link your Discord",
      uitleg:
        "Your profile is not linked to our Discord server. Linking is required to trade on Kickz Caviar.",
      knop: "Link Discord"
    },
    left_server: {
      titel: "Rejoin the Discord server",
      uitleg:
        "You are no longer in our Discord server, so claiming and offering are paused. Being in the server is required to trade.",
      knop: "Rejoin Discord"
    }
  };

  const LOGO =
    "M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0," +
    "45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7," +
    "0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39," +
    "2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09," +
    "29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Z" +
    "m42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z";

  const STIJL = `
    /* Eigen box-sizing, niet die van de pagina eromheen. Zonder deze regel
       telde de binnenmarge bij de breedte op en stak de kaart 26 pixels
       buiten het scherm op een telefoon. Een gedeeld onderdeel moet er niet
       van afhangen welke reset de pagina toevallig heeft. */
    #kcGate, #kcGate * { box-sizing: border-box; }

    #kcGate {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: none;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 24px;
      background: rgba(0, 0, 0, .72);
    }

    #kcGate.kc-gate-open { display: block; }

    #kcGate .kc-gate-card {
      position: relative;
      width: min(460px, 100%);
      margin: auto;
      padding: 30px;
      border-radius: 26px;
      border: 1px solid #2a2a2a;
      background:
        radial-gradient(circle at top left, rgba(255,204,0,0.035), transparent 42%),
        linear-gradient(180deg, #181818, #101010);
      box-shadow: 0 10px 30px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.03);
      color: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
    }

    /* Grid rather than fixed margins: the card is centred while it fits and
       drops to the top the moment it does not, so a small screen scrolls
       instead of cutting the button off. */
    #kcGate.kc-gate-open { display: grid; place-items: center; align-items: start; }

    #kcGate .kc-gate-close {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 36px;
      height: 36px;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      background: #161616;
      color: #cfcfcf;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }

    #kcGate .kc-gate-close:hover { color: #ffffff; border-color: #3a3a3a; }

    #kcGate h2 {
      margin: 0 44px 10px 0;
      font-size: 24px;
      font-weight: 900;
      letter-spacing: -0.01em;
    }

    #kcGate p {
      margin: 0 0 22px;
      font-size: 15px;
      line-height: 1.6;
      color: #cfcfcf;
    }

    #kcGate .kc-gate-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 15px 20px;
      border-radius: 14px;
      background: #5865f2;
      color: #ffffff;
      font-weight: 900;
      font-size: 15px;
      text-decoration: none;
    }

    #kcGate .kc-gate-btn:hover { background: #4752c4; }
    #kcGate .kc-gate-btn svg { width: 22px; height: auto; flex: 0 0 auto; }

    @media (max-width: 620px) {
      #kcGate { padding: 16px; }

      #kcGate .kc-gate-card {
        width: 100%;
        padding: 24px 20px;
        border-radius: 20px;
        /* Room underneath for the browser's own bar, so the button is never
           the thing hiding behind it. */
        margin: 18px auto 90px;
      }

      #kcGate h2 { font-size: 21px; }

      /* 36 pixels is prima voor een muis en te klein voor een duim. */
      #kcGate .kc-gate-close {
        width: 44px;
        height: 44px;
        top: 12px;
        right: 12px;
      }

      #kcGate h2 { margin-right: 52px; }
    }
  `;

  let venster = null;
  let timer = null;
  let getoond = false;

  function bouw() {
    if (venster) return venster;

    const stijl = document.createElement("style");
    stijl.textContent = STIJL;
    document.head.appendChild(stijl);

    venster = document.createElement("div");
    venster.id = "kcGate";

    // No close on the backdrop, deliberately. This dialog appears on its
    // own, ten seconds in. Click anywhere at that exact moment and it would
    // vanish again - you would have seen a flash, which reads as a glitch
    // rather than as a message. The cross closes it.
    venster.innerHTML =
      '<div class="kc-gate-card">' +
      '<button type="button" class="kc-gate-close" aria-label="Close">&times;</button>' +
      '<h2></h2><p></p>' +
      '<a class="kc-gate-btn" href="/auth/discord">' +
      '<svg viewBox="0 0 127.14 96.36" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="' + LOGO + '"/></svg><span></span></a>' +
      "</div>";

    venster.querySelector(".kc-gate-close").addEventListener("click", () => {
      venster.classList.remove("kc-gate-open");
    });

    document.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") venster.classList.remove("kc-gate-open");
    });

    document.body.appendChild(venster);

    return venster;
  }

  function open(reason) {
    const tekst = TEKST[reason] || TEKST.not_linked;
    const el = bouw();

    clearTimeout(timer);
    getoond = true;

    el.querySelector("h2").textContent = tekst.titel;
    el.querySelector("p").textContent = tekst.uitleg;
    el.querySelector(".kc-gate-btn span").textContent = tekst.knop;

    el.classList.add("kc-gate-open");
  }

  function isOpen() {
    return Boolean(venster && venster.classList.contains("kc-gate-open"));
  }

  function schedule(seller) {
    if (!seller) return;

    const reason = !seller.discord_id
      ? "not_linked"
      : seller.discord_in_server === false
        ? "left_server"
        : null;

    if (!reason) return;

    clearTimeout(timer);

    timer = setTimeout(() => {
      // Ten seconds is long enough for a refused action to have opened it
      // already, and long enough to have logged out again.
      if (getoond) return;
      if (!localStorage.getItem("kc_seller")) return;

      open(reason);
    }, VERTRAGING_MS);
  }

  // One wrapper for every request the page makes.
  //
  // Two codes mean the same thing here: the middleware sends
  // discord_not_linked with a reason, the older guard on /api/place-offer
  // sends discord_left_server. Missing either leaves the dialog shut on
  // exactly one path.
  const origineel = window.fetch;

  window.fetch = async function (...args) {
    const response = await origineel.apply(this, args);

    if (response.status === 403) {
      try {
        const data = await response.clone().json();

        if (data?.code === "discord_not_linked") open(data.reason);
        else if (data?.code === "discord_left_server") open("left_server");
      } catch {
        /* geen JSON - dan gaat die 403 ergens anders over */
      }
    }

    return response;
  };

  window.kcDiscordGate = { open, schedule, isOpen };
})();
