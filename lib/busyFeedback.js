// lib/busyFeedback.js
//
// A press that is answered with deferUpdate() looks like nothing happened.
// Discord takes the acknowledgement silently, and the message only changes
// once the portal is done - which on a slow Airtable minute was close to two
// minutes. ORD-033976 on 21-11-2026: the store pressed Counter, saw nothing,
// pressed again, and the seller got the same counter twice.
//
// So the moment a press is deferred, the message says it is being worked on
// and its buttons are greyed out. When the handler is finished and has not
// put its own answer on the message, the original buttons come back - a
// failure then reads as "try again", not as a dead message.
//
// The same helper as the Lojiq bot's src/busyFeedback.js, for the presses
// this portal answers itself (seller and consignor buttons). One difference:
// here several listeners receive the same press, so the listener whose
// handler deferred is the one that settles it - tracked with
// AsyncLocalStorage, because a listener that ignores the press finishes
// first and would otherwise put the buttons back while the work runs.

import { AsyncLocalStorage } from "node:async_hooks";

const listenerScope = new AsyncLocalStorage();
let nextListenerId = 1;

export const BUSY_LINE = "⏳ **Working on it…** this can take a moment.";

const LINK_STYLE = 5;
const MAX_CONTENT = 2000;

function plain(component) {
  return typeof component?.toJSON === "function" ? component.toJSON() : component;
}

/* The message's rows as plain JSON, every control disabled except links. */
export function busyRows(rows) {
  return (rows || []).map((row) => {
    const json = plain(row);

    return {
      ...json,
      components: (json.components || []).map((component) =>
        component.style === LINK_STYLE ? component : { ...component, disabled: true }
      )
    };
  });
}

export function busyContent(content) {
  const original = String(content || "");
  const joined = original ? `${BUSY_LINE}\n${original}` : BUSY_LINE;

  return joined.length > MAX_CONTENT ? BUSY_LINE : joined;
}

/* What a set of rows looks like for comparing: which control, enabled or not. */
export function rowsSignature(rows) {
  return JSON.stringify(
    (rows || []).map((row) =>
      (plain(row).components || []).map((c) => `${c.custom_id || c.url || ""}:${Boolean(c.disabled)}`)
    )
  );
}

/*
 * What to put back after the handler ran, or null when the handler already
 * answered on the message itself.
 *
 * The busy line is taken off whatever the handler left, and the buttons
 * come back only when they are still the greyed-out copy we put there.
 */
export function restorePatch(current, original, busy) {
  const patch = {};

  if (String(current.content || "") === busy.content) {
    patch.content = String(original.content || "");
  }

  if (rowsSignature(current.components) === busy.signature) {
    patch.components = (original.components || []).map(plain);
  }

  return Object.keys(patch).length ? patch : null;
}

function hasControls(message) {
  return (message?.components || []).some((row) =>
    (plain(row).components || []).some((c) => c.style !== LINK_STYLE)
  );
}

/*
 * Patch interaction.deferUpdate so that deferring also shows the busy state.
 *
 * Awaited inside the patched call, so the busy edit has landed before the
 * handler goes on and makes its own edit - the order can never flip.
 */
export function armBusyFeedback(interaction) {
  const isPress = interaction?.isButton?.() || interaction?.isStringSelectMenu?.() || interaction?.isModalSubmit?.();
  const message = interaction?.message;

  if (!isPress || !message || !hasControls(message) || interaction.__busyArmed) return;

  interaction.__busyArmed = true;

  const original = {
    content: message.content,
    components: (message.components || []).map(plain)
  };

  const deferUpdate = interaction.deferUpdate.bind(interaction);

  interaction.deferUpdate = async (...args) => {
    const result = await deferUpdate(...args);

    const rows = busyRows(message.components);
    const content = busyContent(message.content);

    try {
      await interaction.editReply({ content, components: rows });
      interaction.__busy = {
        original,
        content,
        signature: rowsSignature(rows),
        owner: listenerScope.getStore()?.id ?? null
      };
    } catch (err) {
      console.error("busy feedback: could not mark the message:", err.message);
    }

    return result;
  };
}

/* After the handler: give the message back if nobody else answered on it. */
export async function settleBusyFeedback(interaction, ownerId = null) {
  const busy = interaction?.__busy;

  if (!busy) return;
  if (ownerId !== null && busy.owner !== ownerId) return;

  interaction.__busy = null;

  try {
    const current = await interaction.fetchReply();
    const patch = restorePatch(
      { content: current.content, components: current.components },
      busy.original,
      busy
    );

    if (patch) await interaction.editReply(patch);
  } catch (err) {
    // Deleted by the handler, or the token ran out: nothing to give back.
    if (err?.code !== 10008) {
      console.error("busy feedback: could not restore the message:", err.message);
    }
  }
}

/*
 * Wrap one InteractionCreate listener.
 *
 * Every listener on a client gets wrapped; the press is armed once, and only
 * the listener whose handler deferred it gives the message back afterwards.
 */
export function withBusyFeedback(handler) {
  const id = nextListenerId++;

  return (interaction) =>
    listenerScope.run({ id }, async () => {
      armBusyFeedback(interaction);

      try {
        return await handler(interaction);
      } finally {
        await settleBusyFeedback(interaction, id);
      }
    });
}
