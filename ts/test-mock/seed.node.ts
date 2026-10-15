// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Sequential sends preserve sessions and message order; this is an interactive CLI.
/* oxlint-disable no-await-in-loop, no-console */
// window references below execute inside Playwright renderer callbacks.
/* oxlint-disable no-undef */

// Usage (after pnpm install and pnpm generate):
//   pnpm seed:mock           Launch; r wipes/reseeds, q deletes the mock session.
//   pnpm seed:mock --smoke   Verify two fresh seeds and exit.
// Only Bootstrap-owned temporary profiles are removed. Real accounts are untouched.

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { StorageState, Proto } from '@signalapp/mock-server';
import type { Group, PrimaryDevice } from '@signalapp/mock-server';
import { Bootstrap } from './bootstrap.node.ts';
import type { App } from './bootstrap.node.ts';

const names = [
  'Alex Morgan',
  'Blair Chen',
  'Casey Patel',
  'Drew Rivera',
  'Emery Kim',
  'Finley Brooks',
  'Gray Wilson',
  'Harper Singh',
  'Indigo Park',
  'Jordan Reed',
  'Kai Thompson',
  'Logan Garcia',
  'Morgan Ellis',
  'Noel Ahmed',
  'Oakley Ross',
  'Parker Diaz',
  'Quinn Taylor',
  'Reese Evans',
  'Sage Martin',
  'Taylor Nguyen',
  'Uma Shah',
  'Val Cruz',
  'Winter Lee',
  'Xan Baker',
  'Zuri Davis',
];
const titles = [
  'Weekend Walks',
  'Book Club',
  'Dinner Plans',
  'Design Studio',
  'Game Night',
  'Garden Club',
  'Road Trip',
  'Coffee Crew',
  'Movie Club',
  'Music Makers',
];

async function seed(bootstrap: Bootstrap): Promise<App> {
  await bootstrap.init();
  const { phone, unknownContacts: users } = bootstrap;
  let state = StorageState.getEmpty();
  for (const [index, user] of users.entries()) {
    user.setPhoneNumberSharing(index < 20);
    state = state.addContact(user, {
      whitelisted: true,
      profileKey: user.profileKey.serialize(),
      identityKey: user.publicKey.serialize(),
      // Don't import hidden numbers as address-book contacts.
      e164: index < 20 ? user.device.number : null,
    });
  }

  const groups: Array<{ group: Group; members: Array<PrimaryDevice> }> = [];
  for (const [index, title] of titles.entries()) {
    const members = Array.from({ length: 4 + (index % 6) }, (_, offset) => {
      const member = users[(index * 3 + offset) % users.length];
      assert(member);
      return member;
    });
    // Group size includes Myself; the first other member is always an admin.
    const first = members[0];
    assert(first);
    const group = await phone.createGroup({
      title: index < 8 ? `[admin] ${title}` : title,
      members: [phone, ...members],
      administrators: index < 8 ? [phone, first] : [first],
    });
    state = state.addGroup(group, { whitelisted: true });
    groups.push({ group, members });
  }
  assert.equal(new Set(groups.flatMap(({ members }) => members)).size, 25);
  await phone.setStorageState(state);
  const app = await bootstrap.link();
  const { desktop } = bootstrap;

  const timestamps: Array<number> = [];
  function timestamp(): number {
    const value = bootstrap.getTimestamp();
    timestamps.push(value);
    return value;
  }
  for (const user of users.slice(0, 5)) {
    for (const text of [
      'Hey! How is your week going?',
      'Want to catch up soon?',
      'Saturday afternoon works for me.',
    ]) {
      await user.sendText(desktop, text, {
        timestamp: timestamp(),
        withProfileKey: true,
      });
    }
  }
  for (const { group, members } of groups) {
    for (const [index, text] of [
      'Welcome, everyone!',
      'Shall we meet this weekend?',
      'Sounds good — looking forward to it.',
    ].entries()) {
      const sender = members[index];
      assert(sender);
      await sender.sendText(desktop, text, {
        group,
        timestamp: timestamp(),
        withProfileKey: true,
      });
    }
  }

  const page = await app.getWindow();
  const userIds = users.map(user => user.device.aci);
  await page.waitForFunction(
    async sentAt => {
      const messages = await Promise.all(
        sentAt.map(async value => window.SignalCI?.getMessagesBySentAt(value))
      );
      return messages.every(
        list => list?.length === 1 && list[0]?.type === 'incoming'
      );
    },
    timestamps,
    { timeout: 60_000 }
  );
  const contacts = await page.evaluate(async ids => {
    const result = [];
    for (const id of ids) {
      result.push(await window.SignalCI?.getConversationAttributes(id, true));
    }
    return result;
  }, userIds);
  assert.deepEqual(
    contacts.map(c => c?.sharingPhoneNumber),
    users.map((_, index) => index < 20)
  );
  for (const contact of contacts.slice(20)) {
    assert.equal(
      contact?.e164 == null,
      true,
      'Nobody users must not expose a number'
    );
  }
  const messageConversationIds = await page.evaluate(async sentAt => {
    const messages = await Promise.all(
      sentAt.map(async value => window.SignalCI?.getMessagesBySentAt(value))
    );
    return messages.map(list => list?.[0]?.conversationId);
  }, timestamps);
  const counts = new Map<string | undefined, number>();
  for (const id of messageConversationIds)
    counts.set(id, (counts.get(id) ?? 0) + 1);
  assert.equal(counts.size, 15);
  assert([...counts.values()].every(count => count === 3));
  const seededGroups = await page.evaluate(
    async ids =>
      Promise.all(
        ids.map(async id => window.SignalCI?.getConversationAttributes(id))
      ),
    groups.map(({ group }) => group.id)
  );
  assert.equal(seededGroups.length, 10);
  let adminCount = 0;
  for (const group of seededGroups) {
    assert(group);
    assert(
      group.membersV2 &&
        group.membersV2.length >= 5 &&
        group.membersV2.length <= 10
    );
    const admin =
      group.membersV2.find(member => member.aci === phone.device.aci)?.role ===
      Proto.Member.Role.ADMINISTRATOR;
    if (admin) adminCount += 1;
    assert.equal(admin, group.name?.startsWith('[admin]'));
  }
  assert.equal(adminCount, 8);
  return app;
}

async function main(): Promise<void> {
  // Electron-hosted terminals may export this; the child must launch as an app.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const smoke = process.argv.includes('--smoke');
  let bootstrap: Bootstrap | undefined;
  let app: App | undefined;
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const stopController = new AbortController();
  let stopping = false;
  let seedCount = 0;
  async function cleanup(): Promise<void> {
    // Close SQLite before deleting the disposable profile.
    await app?.close();
    app = undefined;
    await bootstrap?.teardown();
    bootstrap = undefined;
  }
  function requestStop(): void {
    stopping = true;
    stopController.abort();
    input.close();
  }
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    do {
      await cleanup();
      bootstrap = new Bootstrap({
        contactCount: 0,
        unknownContactCount: 25,
        linkedDevices: 0,
        contactNames: names.map((name, index) =>
          index < 20 ? `[p] ${name}` : name
        ),
      });
      app = await seed(bootstrap);
      console.log(
        'Seed verified: 5 DMs, 10 groups, 25 users, 45 messages; 8 admin groups; 20 Everybody / 5 Nobody.'
      );
      seedCount += 1;
      if (stopping || (smoke && seedCount === 2)) break;
      if (smoke) continue;
      let command: string;
      try {
        command = await input.question(
          'Enter r to wipe and reseed, or q to quit and delete the mock profile: ',
          { signal: stopController.signal }
        );
      } catch (error) {
        if (stopping) break;
        throw error;
      }
      if (command.trim().toLowerCase() !== 'r') break;
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    input.close();
    await cleanup();
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
void run();
