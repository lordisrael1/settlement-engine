import type { Pool } from 'pg';

import type { Config } from './config.js';

/**
 * What every route is handed: a database, a configuration, and a clock.
 *
 * The clock is an argument here for the same reason it is one throughout the packages
 * (ADR-0007). This layer is where `new Date()` is finally allowed to be called — an
 * HTTP request genuinely does happen at a moment — and passing it in is what lets a test
 * pin the moment and assert that a settlement window opened when it should have, without
 * waiting a day for it.
 */
export interface Services {
  readonly pool: Pool;
  readonly config: Config;
  readonly now: () => Date;
}
