/**
 * Queue source selector. Routes to either local SQLite (legacy) or the
 * WordPress REST API (canonical) based on the QUEUE_SOURCE config.
 *
 * Default = 'sqlite' so production behavior is unchanged until the
 * shadow validation in Phase 6 confirms parity, then flip to 'wp'.
 *
 * Both adapters expose the same async interface — see lib/wp-queue.js
 * and lib/sqlite-queue.js for method shapes.
 */

import config from '../config.js';
import * as sqliteQueue from './sqlite-queue.js';
import * as wpQueue from './wp-queue.js';

const source = config.QUEUE_SOURCE === 'wp' ? wpQueue : sqliteQueue;

export const queueSource = source;
export const isWordPressSource = config.QUEUE_SOURCE === 'wp';

// Re-export each method directly so callers can use either form:
//   import { getActiveQueue } from '../lib/queue-source.js';
//   import { queueSource } from '../lib/queue-source.js'; queueSource.getActiveQueue();
export const getActiveQueue = (...args) => source.getActiveQueue(...args);
export const getQueueById = (...args) => source.getQueueById(...args);
export const createQueue = (...args) => source.createQueue(...args);
export const closeQueue = (...args) => source.closeQueue(...args);
export const claimForRace = (...args) => source.claimForRace(...args);
export const setDuckRaceWinner = (...args) => source.setDuckRaceWinner(...args);
export const setChannelMessage = (...args) => source.setChannelMessage(...args);
export const setDuckRaceChannelMessage = (...args) => source.setDuckRaceChannelMessage(...args);
export const addEntry = (...args) => source.addEntry(...args);
export const getEntries = (...args) => source.getEntries(...args);
export const getUniqueBuyers = (...args) => source.getUniqueBuyers(...args);
export const getRecentQueues = (...args) => source.getRecentQueues(...args);
export const updateEntry = (...args) => source.updateEntry(...args);
export const markEntryRefundedBySession = (...args) => source.markEntryRefundedBySession(...args);
export const getActiveEntry = (...args) => source.getActiveEntry(...args);
export const getNextQueuedEntry = (...args) => source.getNextQueuedEntry(...args);
export const getQueuedEntries = (...args) => source.getQueuedEntries(...args);
export const resetAll = (...args) => source.resetAll(...args);
