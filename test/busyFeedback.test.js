import test from "node:test";
import assert from "node:assert/strict";

import {
  BUSY_LINE,
  armBusyFeedback,
  busyContent,
  busyRows,
  restorePatch,
  rowsSignature,
  settleBusyFeedback,
  withBusyFeedback
} from "../lib/busyFeedback.js";

const ROWS = [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label: "Accept Offer", custom_id: "offer_accept_rec1" },
      { type: 2, style: 1, label: "Counter", custom_id: "offer_counter_rec1" },
      { type: 2, style: 5, label: "Open", url: "https://example.com" }
    ]
  }
];

function fakePress({ content = "New offer", components = ROWS, afterDefer } = {}) {
  let shown = { content, components };
  const edits = [];

  const interaction = {
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    message: { content, components },
    deferUpdate: async () => {},
    editReply: async (patch) => {
      edits.push(patch);
      shown = { ...shown, ...patch };
      return shown;
    },
    fetchReply: async () => shown
  };

  return { interaction, edits, shown: () => shown, handlerEdit: (patch) => { shown = { ...shown, ...patch }; } };
}

test("busy rows grey out every control but leave links alone", () => {
  const rows = busyRows(ROWS);

  assert.equal(rows[0].components[0].disabled, true);
  assert.equal(rows[0].components[1].disabled, true);
  assert.equal(rows[0].components[2].disabled, undefined);
});

test("busy content puts the line above what was there", () => {
  assert.equal(busyContent("New offer"), `${BUSY_LINE}\nNew offer`);
  assert.equal(busyContent(""), BUSY_LINE);
  assert.equal(busyContent("x".repeat(1999)), BUSY_LINE);
});

test("deferring shows the busy state straight away", async () => {
  const { interaction, edits } = fakePress();

  armBusyFeedback(interaction);
  await interaction.deferUpdate();

  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Working on it/);
  assert.equal(edits[0].components[0].components[1].disabled, true);
});

test("a handler that only replied privately gets the original message back", async () => {
  const { interaction, shown } = fakePress();

  armBusyFeedback(interaction);
  await interaction.deferUpdate();
  await settleBusyFeedback(interaction);

  assert.equal(shown().content, "New offer");
  assert.equal(rowsSignature(shown().components), rowsSignature(ROWS));
});

test("a handler that answered on the message is left alone", async () => {
  const { interaction, edits, handlerEdit, shown } = fakePress();

  armBusyFeedback(interaction);
  await interaction.deferUpdate();

  const answered = [{ type: 1, components: [{ type: 2, style: 1, label: "Edit", custom_id: "offer_counter_edit:rec1" }] }];
  handlerEdit({ content: "🔁 Counter offer submitted: € 110", components: answered });

  await settleBusyFeedback(interaction);

  assert.equal(edits.length, 1);
  assert.equal(shown().content, "🔁 Counter offer submitted: € 110");
});

test("a handler that changed only the buttons still loses the busy line", () => {
  const original = { content: "New offer", components: ROWS };
  const rows = busyRows(ROWS);
  const busy = { content: busyContent("New offer"), signature: rowsSignature(rows) };

  const patch = restorePatch({ content: busy.content, components: [] }, original, busy);

  assert.deepEqual(patch, { content: "New offer" });
});

test("presses without buttons on the message are not touched", async () => {
  const { interaction, edits } = fakePress({ components: [] });

  armBusyFeedback(interaction);
  await interaction.deferUpdate();
  await settleBusyFeedback(interaction);

  assert.equal(edits.length, 0);
});

test("a listener that ignores the press does not hand the buttons back early", async () => {
  const { interaction, shown } = fakePress();
  let busyWhileWorking = null;

  const ignores = withBusyFeedback(async () => {});
  const works = withBusyFeedback(async (i) => {
    await i.deferUpdate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    busyWhileWorking = /Working on it/.test(shown().content);
  });

  await Promise.all([ignores(interaction), works(interaction)]);

  assert.equal(busyWhileWorking, true);
  assert.equal(shown().content, "New offer");
});
